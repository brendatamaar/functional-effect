// Property tests for the boundary. parseEvent is the only door from the
// outside world into the core, so it gets three properties (the Go example
// adds a native fuzz target as a fourth):
//
//   round trip      parseEvent(encodeEvent(e)) equals e for every valid event
//   accepted⇒valid  whatever parseEvent accepts satisfies validEvent, a predicate
//                   written independently of the parser (never by calling it)
//   rejects rules   breaking any one rule of a valid event gets it rejected

import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/Arbitrary"
import { MAX_PAYMENT_ATTEMPTS } from "../core/order.js"
import { type Event, EventSchema, encodeEvent, parseEvent } from "./boundary.js"

const parse = (raw: unknown) => Effect.runSync(parseEvent(raw).pipe(Effect.result))

/** What "valid" means, stated independently of the parser. */
const validEvent = (e: Event): string | undefined => {
  if (e.id === "") return "empty event ID"
  const i = e.input
  const attempt = (a: number) => (Number.isInteger(a) && a >= 1 && a <= MAX_PAYMENT_ATTEMPTS ? undefined : `attempt ${a}`)
  if (i.tag !== "Retry" && i.orderId === "") return "empty order ID"
  switch (i.tag) {
    case "Submit": return Number.isSafeInteger(i.amount) && i.amount > 0 ? undefined : `amount ${i.amount}`
    case "PaymentSucceeded": return attempt(i.attempt)
    case "PaymentFailed": return attempt(i.attempt)
    case "ShipmentCreated": return i.trackingNo === "" ? "empty tracking number" : undefined
    case "Retry": return i.orderId === "" ? "empty order ID" : undefined
    case "PaymentTimedOut": return "internal input accepted from outside"
  }
}

const check = async <A>(arb: Arbitrary.Arbitrary<A>, property: (a: A) => string | undefined, runs = 2000) => {
  const result = await Effect.runPromise(Arbitrary.checkEffect(arb, (a) => property(a) === undefined, { runs }))
  if (result._tag === "Falsified")
    assert.fail(`${property(result.shrunkInput)}\nminimal input: ${JSON.stringify(result.shrunkInput)}`)
  assert.equal(result._tag, "Passed", Arbitrary.formatCheckFailure(result) ?? "")
}

/** Valid wire events, derived from the boundary schema itself. */
const wire = Arbitrary.schema(EventSchema)

test("round trip: parse(encode(e)) equals e", () =>
  check(wire, (w) => {
    const first = parse(w)
    if (first._tag === "Failure") return `a schema-generated event was rejected: ${first.failure}`
    const encoded = encodeEvent(first.success)
    // Through real JSON, as a producer would send it.
    const again = parse(JSON.parse(JSON.stringify(encoded)))
    if (again._tag === "Failure") return `the encoded event was rejected: ${again.failure}`
    try {
      assert.deepEqual(again.success, first.success)
      assert.deepEqual(encoded, { ...w }) // generated objects have a null prototype
    } catch (e) {
      return `round trip changed the event: ${(e as Error).message}`
    }
    return undefined
  }))

// Messy input: a valid event with up to three fields replaced by edge values,
// wrong types, unknown or internal tags, or removed.
const Junk = Schema.Union([
  Schema.Literals(["", "x", "PaymentTimedOut", "submit", "Refund"]),
  Schema.Literals([0, -1, 1, 3, 4, 1.5, Number.MAX_SAFE_INTEGER + 2]),
  Schema.Boolean,
  Schema.Null,
  Schema.Array(Schema.Number),
  Schema.String,
])
const Edit = Schema.Struct({
  key: Schema.Literals(["_tag", "eventId", "orderId", "amount", "attempt", "reason", "trackingNo", "extra"]),
  value: Schema.Union([Junk, Schema.Literal("<delete>")]),
})
const messy = Arbitrary.all({ event: wire, edits: Arbitrary.array(Arbitrary.schema(Edit), { maxLength: 3 }) }).pipe(
  Arbitrary.map(({ event, edits }) => {
    const m: Record<string, unknown> = { ...event }
    for (const { key, value } of edits) {
      if (value === "<delete>") delete m[key]
      else m[key] = value
    }
    return m
  }),
)

test("accepted ⇒ valid: whatever the parser accepts satisfies validEvent", async () => {
  let accepted = 0
  await check(messy, (raw) => {
    const r = parse(raw)
    if (r._tag === "Failure") return undefined // rejecting is always allowed
    accepted++
    const why = validEvent(r.success)
    if (why) return `accepted an invalid event (${why}): ${JSON.stringify(r.success)}`
    const again = parse(JSON.parse(JSON.stringify(encodeEvent(r.success))))
    if (again._tag === "Failure") return "an accepted event does not round trip"
    return undefined
  }, 3000)
  // A generator that never produces an accepted event tests nothing.
  assert.ok(accepted > 30, `only ${accepted} messy inputs were accepted; the generator is too noisy`)
})

test("rejects each broken rule", async () => {
  type Rule = readonly [name: string, tags: readonly string[] | "all", edit: (m: Record<string, unknown>) => void]
  const withOrder = ["Submit", "PaymentSucceeded", "PaymentFailed", "ShipmentCreated", "Retry"]
  const withAttempt = ["PaymentSucceeded", "PaymentFailed"]
  const rules: readonly Rule[] = [
    ["missing eventId", "all", (m) => { delete m.eventId }],
    ["empty eventId", "all", (m) => { m.eventId = "" }],
    ["unknown tag", "all", (m) => { m._tag = "Refund" }],
    ["internal tag", "all", (m) => { m._tag = "PaymentTimedOut"; m.attempt = 1 }],
    ["empty orderId", withOrder, (m) => { m.orderId = "" }],
    ["zero amount", ["Submit"], (m) => { m.amount = 0 }],
    ["negative amount", ["Submit"], (m) => { m.amount = -5 }],
    ["fractional amount", ["Submit"], (m) => { m.amount = 1.5 }],
    ["attempt 0", withAttempt, (m) => { m.attempt = 0 }],
    ["attempt above max", withAttempt, (m) => { m.attempt = MAX_PAYMENT_ATTEMPTS + 1 }],
    ["fractional attempt", withAttempt, (m) => { m.attempt = 1.5 }],
    ["empty trackingNo", ["ShipmentCreated"], (m) => { m.trackingNo = "" }],
  ]
  const samples = await Effect.runPromise(Arbitrary.sampleEffect(wire, { count: 300 }))
  for (const w of samples) {
    for (const [name, tags, edit] of rules) {
      if (tags !== "all" && !tags.includes(w._tag)) continue
      const m: Record<string, unknown> = { ...w }
      edit(m)
      const r = parse(m)
      assert.equal(r._tag, "Failure", `rule "${name}" not enforced: accepted ${JSON.stringify(m)}`)
    }
  }
})
