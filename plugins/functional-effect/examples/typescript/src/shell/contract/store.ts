// The Store contract: the transactional semantics the app and the worker rely
// on (see skills/model/references/outbox.md). Run against MemoryStore and
// against PgStore on a real PostgreSQL (PGlite in tests).

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { Effect } from "effect"
import {
  type Amount,
  type Command,
  type Input,
  type OrderId,
  type State,
  PAYMENT_TIMEOUT_MS,
  chargeKey,
  initial,
  shipmentKey,
} from "../../core/order.js"
import type { Commit, Conflict, Duplicate, OutboxItem, Store } from "../store.js"

export interface StoreUnderTest {
  /** An empty store. */
  readonly store: Store["Service"]
  /** How long claimDue leases an item. */
  readonly leaseMs: number
  readonly close?: () => Promise<void>
}

const T0 = Date.UTC(2026, 0, 1, 9)
const MIN = 60_000
const o1 = "ord-1" as OrderId
const o2 = "ord-2" as OrderId
const amount = 4200 as Amount
const submit: Input = { tag: "Submit", orderId: o1, amount }
const awaiting: State = { tag: "AwaitingPayment", orderId: o1, amount, attempt: 1 }
const paid: State = { tag: "Paid", orderId: o1 }
const notify: Command = { tag: "NotifyCustomer", orderId: o1, message: "hi" }
const item = (id: string, command: Command, dueAt: number): OutboxItem => ({ id, orderId: o1, command, dueAt })
const first: Commit = { orderId: o1, expected: 0, eventId: "evt-1", input: submit, state: awaiting, outbox: [] }

export const storeContract = (suite: string, make: () => StoreUnderTest | Promise<StoreUnderTest>) =>
  describe(suite, () => {
    interface Env {
      readonly leaseMs: number
      readonly commit: (c: Commit) => Promise<"ok" | "Conflict" | "Duplicate">
      readonly mustCommit: (c: Commit) => Promise<void>
      readonly load: (id: OrderId) => Promise<{ readonly state: State; readonly version: number }>
      readonly claim: (now: number, limit?: number) => Promise<readonly string[]>
      readonly s: Store["Service"]
      readonly run: <A>(eff: Effect.Effect<A>) => Promise<A>
    }

    const clause = (name: string, body: (e: Env) => Promise<void>) =>
      it(name, async () => {
        const subject = await make()
        const s = subject.store
        const run = <A>(eff: Effect.Effect<A>) => Effect.runPromise(eff)
        const commit = async (c: Commit) => {
          const r = await Effect.runPromise(Effect.result(s.commit(c) as Effect.Effect<void, Conflict | Duplicate>))
          return r._tag === "Success" ? "ok" : r.failure._tag
        }
        try {
          await body({
            leaseMs: subject.leaseMs,
            s,
            run,
            commit,
            mustCommit: async (c) => assert.equal(await commit(c), "ok", `commit ${c.eventId}`),
            load: (id) => run(s.load(id)),
            claim: async (now, limit = 10) => (await run(s.claimDue(now, limit))).map((i) => i.id),
          })
        } finally {
          await subject.close?.()
        }
      })

    clause("an unknown order loads as the initial state at version 0", async (e) => {
      assert.deepEqual(await e.load(o1), { state: initial, version: 0 })
    })

    clause("a commit saves the state, bumps the version and appends the event", async (e) => {
      const succeeded: Input = { tag: "PaymentSucceeded", orderId: o1, attempt: 1 }
      await e.mustCommit(first)
      await e.mustCommit({ orderId: o1, expected: 1, eventId: "evt-2", input: succeeded, state: paid, outbox: [] })
      assert.deepEqual(await e.load(o1), { state: paid, version: 2 })
      assert.deepEqual(await e.run(e.s.events(o1)), [submit, succeeded])
    })

    clause("a stale version conflicts and leaves nothing behind", async (e) => {
      await e.mustCommit(first)
      const stale: Commit = { orderId: o1, expected: 0, eventId: "evt-2", input: submit, state: paid, outbox: [item("evt-2#0", notify, T0)] }
      assert.equal(await e.commit(stale), "Conflict")
      assert.deepEqual(await e.load(o1), { state: awaiting, version: 1 })
      assert.deepEqual(await e.claim(T0), [])
      // The conflicting commit must not have recorded its event ID either.
      await e.mustCommit({ ...stale, expected: 1 })
    })

    clause("a version ahead of the stored one conflicts", async (e) => {
      assert.equal(await e.commit({ ...first, expected: 1 }), "Conflict", "new order with expected version 1")
      assert.equal((await e.load(o1)).version, 0)
    })

    clause("a duplicate event ID is rejected and leaves nothing behind", async (e) => {
      await e.mustCommit(first)
      assert.equal(await e.commit({ ...first, expected: 1, state: paid, outbox: [item("dup#0", notify, T0)] }), "Duplicate")
      assert.deepEqual(await e.load(o1), { state: awaiting, version: 1 })
      assert.deepEqual(await e.claim(T0), [])
    })

    clause("orders are independent", async (e) => {
      await e.mustCommit(first)
      await e.mustCommit({ orderId: o2, expected: 0, eventId: "evt-2", input: { tag: "Submit", orderId: o2, amount }, state: initial, outbox: [] })
      assert.equal((await e.load(o1)).version, 1)
    })

    clause("concurrent commits at the same version: exactly one wins", async (e) => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => e.commit({ ...first, eventId: `evt-${i}` })))
      assert.deepEqual(results.filter((r) => r === "ok").length, 1, `results: ${results.join(", ")}`)
      assert.ok(results.every((r) => r === "ok" || r === "Conflict"), `results: ${results.join(", ")}`)
      assert.equal((await e.load(o1)).version, 1)
    })

    clause("outbox items are claimed when due, earliest first, up to the limit", async (e) => {
      await e.mustCommit({
        ...first,
        outbox: [item("evt-1#0", notify, T0 + MIN), item("evt-1#1", notify, T0), item("evt-1#2", notify, T0), item("evt-1#3", notify, T0 + 10 * MIN)],
      })
      assert.deepEqual(await e.claim(T0 - 1000), [])
      assert.deepEqual(await e.claim(T0 + MIN, 2), ["evt-1#1", "evt-1#2"])
      assert.deepEqual(await e.claim(T0 + MIN), ["evt-1#0"])
    })

    clause("a claimed item is leased, and due again when the lease expires", async (e) => {
      await e.mustCommit({ ...first, outbox: [item("evt-1#0", notify, T0)] })
      assert.deepEqual(await e.claim(T0), ["evt-1#0"])
      assert.deepEqual(await e.claim(T0 + e.leaseMs - 1), [])
      assert.deepEqual(await e.claim(T0 + e.leaseMs), ["evt-1#0"])
    })

    clause("a completed item is never claimed again", async (e) => {
      await e.mustCommit({ ...first, outbox: [item("evt-1#0", notify, T0)] })
      await e.claim(T0)
      await e.run(e.s.complete("evt-1#0"))
      assert.deepEqual(await e.claim(T0 + 60 * MIN), [])
    })

    clause("a released item is due again at its retry time", async (e) => {
      await e.mustCommit({ ...first, outbox: [item("evt-1#0", notify, T0)] })
      await e.claim(T0)
      await e.run(e.s.release("evt-1#0", T0 + MIN))
      assert.deepEqual(await e.claim(T0 + MIN - 1), [])
      assert.deepEqual(await e.claim(T0 + MIN), ["evt-1#0"])
    })

    clause("states, inputs and commands come back exactly as committed", async (e) => {
      // A real store serializes these values; every variant must survive.
      const key = chargeKey(o1, 2)
      const commands: Command[] = [
        { tag: "ChargeCard", orderId: o1, amount, attempt: 2, key },
        { tag: "ResolvePayment", orderId: o1, attempt: 2, key },
        { tag: "CreateShipment", orderId: o1, key: shipmentKey(o1) },
        { tag: "NotifyCustomer", orderId: o1, message: 'Shipped: "TRK" ✓' },
        { tag: "ScheduleInput", afterMs: PAYMENT_TIMEOUT_MS, input: { tag: "PaymentTimedOut", orderId: o1, attempt: 2 } },
      ]
      const states: State[] = [
        initial, awaiting, { tag: "Reconciling", orderId: o1, amount, attempt: 2 }, paid,
        { tag: "Shipped", orderId: o1, trackingNo: "TRK-1" }, { tag: "Failed", orderId: o1, amount, attempt: 3, reason: "declined" },
      ]
      const inputs: Input[] = [
        submit, { tag: "PaymentSucceeded", orderId: o1, attempt: 2 }, { tag: "PaymentFailed", orderId: o1, attempt: 1, reason: "no" },
        { tag: "PaymentTimedOut", orderId: o1, attempt: 3 }, { tag: "ShipmentCreated", orderId: o1, trackingNo: "TRK-1" }, { tag: "Retry", orderId: o1 },
      ]
      const outbox = commands.map((c, i) => item(`evt-0#${i}`, c, T0))
      for (const [i, state] of states.entries()) {
        await e.mustCommit({ orderId: o1, expected: i, eventId: `evt-${i}`, input: inputs[i]!, state, outbox: i === 0 ? outbox : [] })
        assert.deepEqual((await e.load(o1)).state, state)
      }
      assert.deepEqual(await e.run(e.s.events(o1)), inputs)
      assert.deepEqual(await e.run(e.s.claimDue(T0, 10)), outbox)
    })
  })
