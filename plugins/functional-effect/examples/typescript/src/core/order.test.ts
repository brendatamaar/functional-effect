// Property-based tests for the functional core, with generators derived from a
// Schema and shrinking: a failure reports the shortest input sequence that
// still breaks the invariant.
//
// Effect v4's `effect/Arbitrary` derives generators from a Schema and shrinks
// failures (marked unstable in v4.0; fast-check is the stable alternative).
// The schema here deliberately uses a tiny domain (two order IDs, attempts
// 1–3) so random sequences keep hitting the same order and the same attempts.

import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, Schema } from "effect"
import * as Arbitrary from "effect/Arbitrary"
import {
  type Command,
  type Input,
  type State,
  MAX_PAYMENT_ATTEMPTS,
  describe,
  initial,
  pending,
  run,
  step,
} from "./order.js"

const OrderId = Schema.Literals(["ord-1", "ord-2"]).pipe(Schema.brand("OrderId"))
const Amount = Schema.Literals([4200]).pipe(Schema.brand("Amount"))
const Attempt = Schema.Literals([1, 2, 3])

const InputSchema = Schema.Union([
  Schema.Struct({ tag: Schema.Literal("Submit"), orderId: OrderId, amount: Amount }),
  Schema.Struct({ tag: Schema.Literal("PaymentSucceeded"), orderId: OrderId, attempt: Attempt }),
  Schema.Struct({ tag: Schema.Literal("PaymentFailed"), orderId: OrderId, attempt: Attempt, reason: Schema.Literal("declined") }),
  Schema.Struct({ tag: Schema.Literal("PaymentTimedOut"), orderId: OrderId, attempt: Attempt }),
  Schema.Struct({ tag: Schema.Literal("ShipmentCreated"), orderId: OrderId, trackingNo: Schema.Literal("TRK-1") }),
  Schema.Struct({ tag: Schema.Literal("Retry"), orderId: OrderId }),
])

// Compile-time proof that the generated values are core Inputs.
const _inputsAreCoreInputs = (x: typeof InputSchema.Type): Input => x

const inputs = Arbitrary.array(Arbitrary.schema(InputSchema), { maxLength: 40 })

/** A property returns undefined when it holds, or a description of the violation. */
const check = async (property: (xs: readonly Input[]) => string | undefined) => {
  const result = await Effect.runPromise(Arbitrary.checkEffect(inputs, (xs) => property(xs) === undefined, { runs: 2000 }))
  if (result._tag === "Falsified") {
    assert.fail(`${property(result.shrunkInput)}\nminimal failing inputs (${result.shrunkInput.length}):\n  ${result.shrunkInput.map((x) => JSON.stringify(x)).join("\n  ")}\n${Arbitrary.formatCheckFailure(result)}`)
  }
  assert.equal(result._tag, "Passed", Arbitrary.formatCheckFailure(result) ?? "")
}

/** Run inputs through step, calling f with (before, input, after, commands). */
const eachStep = (xs: readonly Input[], f: (b: State, i: Input, a: State, c: readonly Command[]) => string | undefined) => {
  let s = initial
  for (const i of xs) {
    const [next, cmds] = step(s, i)
    const v = f(s, i, next, cmds)
    if (v) return v
    s = next
  }
  return undefined
}

test("step is deterministic", () =>
  check((xs) => (JSON.stringify(run(initial, xs)) === JSON.stringify(run(initial, xs)) ? undefined : "non-deterministic")))

test("at most MAX_PAYMENT_ATTEMPTS charges per order, each with a unique key", () =>
  check((xs) => {
    const keys = new Map<string, number>()
    const perOrder = new Map<string, number>()
    for (const c of run(initial, xs)[1]) {
      if (c.tag !== "ChargeCard") continue
      if (keys.has(c.key)) return `charge key ${c.key} reused`
      keys.set(c.key, 1)
      perOrder.set(c.orderId, (perOrder.get(c.orderId) ?? 0) + 1)
    }
    for (const [id, n] of perOrder) if (n > MAX_PAYMENT_ATTEMPTS) return `${n} charges for ${id}`
    return undefined
  }))

test("every charge comes with a timeout for the same attempt", () =>
  check((xs) =>
    eachStep(xs, (_b, _i, _a, cmds) => {
      for (const c of cmds) {
        if (c.tag !== "ChargeCard") continue
        const timer = cmds.some(
          (d) => d.tag === "ScheduleInput" && d.input.tag === "PaymentTimedOut" && d.input.orderId === c.orderId && d.input.attempt === c.attempt,
        )
        if (!timer) return `ChargeCard attempt ${c.attempt} without a timeout`
      }
      return undefined
    }),
  ))

test("a shipment is only created after Paid", () =>
  check((xs) => {
    const paid = new Set<string>()
    return eachStep(xs, (_b, _i, after, cmds) => {
      if (after.tag === "Paid") paid.add(after.orderId)
      for (const c of cmds) if (c.tag === "CreateShipment" && !paid.has(c.orderId)) return `shipment before payment for ${c.orderId}`
      return undefined
    })
  }))

test("Shipped is reached only from Paid, and is terminal", () =>
  check((xs) =>
    eachStep(xs, (before, _i, after, cmds) => {
      if (after.tag === "Shipped" && before.tag !== "Shipped" && before.tag !== "Paid") return `reached Shipped from ${describe(before)}`
      if (before.tag === "Shipped" && (after !== before || cmds.length > 0)) return `Shipped moved to ${describe(after)}`
      return undefined
    }),
  ))

test("stale attempts never change the state", () =>
  check((xs) =>
    eachStep(xs, (before, input, after, cmds) => {
      if (input.tag !== "PaymentSucceeded" && input.tag !== "PaymentFailed" && input.tag !== "PaymentTimedOut") return undefined
      const p = pending(before)
      const stale = p === undefined || p.attempt !== input.attempt || p.orderId !== input.orderId
      return stale && (after !== before || cmds.length > 0) ? `stale ${input.tag} moved ${describe(before)} to ${describe(after)}` : undefined
    }),
  ))
