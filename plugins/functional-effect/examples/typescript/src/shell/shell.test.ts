// Tests for the shell: delivery, crashes, concurrency and time. The core's
// decisions are tested in src/core; here we test that the shell keeps its
// promises (atomic commit, idempotent effects, at-least-once delivery).

import { test } from "node:test"
import assert from "node:assert/strict"
import { Effect, References } from "effect"
import { type Amount, type OrderId, type State, MAX_PAYMENT_ATTEMPTS, PAYMENT_TIMEOUT_MS, chargeKey, describe } from "../core/order.js"
import { handle, replay } from "./app.js"
import { Notifier, PaymentGateway, Retries, Shipping, instantRetries } from "./capabilities.js"
import { type Behavior, FakeGateway, FakeNotifier, FakeShipping } from "./fakes.js"
import { MemoryStore, Store } from "./store.js"
import { type WorkerOptions, runOnce } from "./worker.js"

type R = Store | PaymentGateway | Shipping | Notifier | Retries
const T0 = Date.UTC(2026, 0, 1, 9)
const ord = "ord-1" as OrderId
const amount = 4200 as Amount

const harness = (gateway = new FakeGateway(), shipping = new FakeShipping()) => {
  const store = new MemoryStore(30_000)
  const notifier = new FakeNotifier()
  const h = {
    store,
    gateway,
    shipping,
    notifier,
    now: T0,
    exec: <A, E>(eff: Effect.Effect<A, E, R>) =>
      Effect.runPromise(
        eff.pipe(
          Effect.provideService(Store, store.service),
          Effect.provideService(PaymentGateway, gateway.service),
          Effect.provideService(Shipping, shipping.service),
          Effect.provideService(Notifier, notifier.service),
          Effect.provideService(Retries, instantRetries),
          Effect.provideService(References.MinimumLogLevel, "None"),
        ),
      ),
    /** Run the worker, jumping the clock to the next due item, until the outbox is empty. */
    drain: async (options: WorkerOptions = {}, maxSteps = 100) => {
      for (let i = 0; i < maxSteps; i++) {
        await h.exec(runOnce(h.now, options))
        const next = store.nextDue()
        if (next === undefined) return
        if (next > h.now) h.now = next
      }
    },
    state: async () => h.exec(store.service.load(ord)),
    submit: (eventId: string) => h.exec(handle(eventId, { tag: "Submit", orderId: ord, amount }, h.now)),
    assertReplay: async () => {
      const { state, version } = await h.state()
      assert.deepEqual(await h.exec(replay(ord)), state, "replay equals stored state")
      assert.equal((await h.exec(store.service.events(ord))).length, version, "version equals event count")
    },
  }
  return h
}

const tagOf = (s: State) => s.tag

test("happy path", async () => {
  const h = harness()
  await h.submit("evt-1")
  await h.drain()
  assert.equal(tagOf((await h.state()).state), "Shipped")
  assert.equal(h.gateway.chargedFor(ord), 1)
  assert.equal(h.shipping.createdFor(ord), 1)
  await h.assertReplay()
})

test("a duplicate delivery is processed once", async () => {
  const h = harness()
  await h.submit("evt-1")
  await h.submit("evt-1")
  assert.equal((await h.state()).version, 1)
  await h.drain()
  assert.equal(h.gateway.chargedFor(ord), 1)
})

test("a crash after charging does not charge twice", async () => {
  const h = harness()
  let crashed = false
  await h.submit("evt-1")
  await h.drain({
    crash: (item, at) => {
      if (item.command.tag === "ChargeCard" && at === "AfterEffect" && !crashed) return (crashed = true)
      return false
    },
  })
  assert.ok(crashed)
  assert.equal(tagOf((await h.state()).state), "Shipped")
  assert.equal(h.gateway.chargedFor(ord), 1)
  await h.assertReplay()
})

test("lost responses are reconciled, not retried blindly", async () => {
  // The first call charged but its response was lost; retries never reach the gateway.
  const gateway = new FakeGateway((op, _k, n): Behavior => (op === "charge" ? (n === 1 ? "LostResponse" : "Transient") : "Normal"))
  const h = harness(gateway)
  await h.submit("evt-1")
  await h.exec(runOnce(h.now))
  assert.equal(tagOf((await h.state()).state), "AwaitingPayment", "outcome unknown: keep waiting")
  h.now += PAYMENT_TIMEOUT_MS // the timer fires
  await h.drain()
  assert.equal(tagOf((await h.state()).state), "Shipped")
  assert.equal(gateway.chargedFor(ord), 1)
  const events = await h.exec(h.store.service.events(ord))
  assert.ok(events.some((e) => e.tag === "PaymentTimedOut"))
})

test("resolve fences a late charge", async () => {
  // The charge never reaches the gateway, then the worker stalls past the timeout.
  const gateway = new FakeGateway((op, _k, n): Behavior => (op === "charge" && n <= 3 ? "Transient" : "Normal"))
  const h = harness(gateway)
  h.store.setLease(2 * PAYMENT_TIMEOUT_MS)
  await h.submit("evt-1")
  await h.drain({
    crash: (item, at) => item.command.tag === "ChargeCard" && at === "AfterEffect" && gateway.calls.get(`charge|${chargeKey(ord, 1)}`) === 3,
  })
  const { state } = await h.state()
  assert.equal(describe(state), "Failed(ord-1, attempt 1, not charged (voided))")
  assert.equal(gateway.chargedFor(ord), 0)
})

test("escape hatches: shipping outage retried later, notifications best effort", async () => {
  const shipping = new FakeShipping((n): Behavior => (n <= 4 ? "Transient" : "Normal"))
  const h = harness(new FakeGateway(), shipping)
  h.notifier.fail = true
  await h.submit("evt-1")
  await h.drain()
  assert.equal(tagOf((await h.state()).state), "Shipped")
  assert.equal(shipping.createdFor(ord), 1)
})

test("concurrent deliveries keep one consistent history and emit each command once", async () => {
  const h = harness()
  await h.submit("evt-1")
  const deliveries = Array.from({ length: 20 }, (_, i) =>
    handle(`webhook-${i % 5}`, { tag: "PaymentSucceeded", orderId: ord, attempt: 1 }, h.now),
  )
  await h.exec(Effect.all(deliveries, { concurrency: "unbounded" }))
  const { state, version } = await h.state()
  assert.equal(state.tag, "Paid")
  assert.equal(version, 6, "Submit + 5 distinct delivery IDs; duplicates of an ID are dropped")
  // Without the version check, stale commits would each emit a shipment (lost update).
  assert.equal(h.store.peek().filter((i) => i.command.tag === "CreateShipment").length, 1, "CreateShipment emitted once")
  await h.assertReplay()
  await h.drain()
  assert.equal(h.shipping.createdFor(ord), 1)
})

// Deterministic PRNG so a failing seed is reproducible.
const mulberry32 = (seed: number) => () => {
  let t = (seed += 0x6d2b79f5)
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

test("chaos: money moves at most once, and only for orders that ship", async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = mulberry32(seed)
    const roll = (p: number) => rnd() < p
    const gateway = new FakeGateway((op): Behavior => {
      if (roll(0.3)) return "Transient"
      if (op === "charge" && roll(0.2)) return "LostResponse"
      if (op === "charge" && roll(0.15)) return "Decline"
      return "Normal"
    })
    const shipping = new FakeShipping((): Behavior => (roll(0.3) ? "Transient" : "Normal"))
    const h = harness(gateway, shipping)
    h.notifier.fail = roll(0.5)
    const options: WorkerOptions = { crash: () => roll(0.15) }

    await h.submit("evt-submit")
    if (roll(0.5)) await h.submit("evt-submit")
    let retries = 0
    for (let step = 0; step < 200; step++) {
      await h.drain(options)
      const { state } = await h.state()
      if (state.tag !== "Failed" || state.attempt >= MAX_PAYMENT_ATTEMPTS || retries > 5 || !roll(0.7)) break
      retries++
      await h.exec(handle(`evt-retry-${retries}`, { tag: "Retry", orderId: ord }, h.now))
    }

    const { state } = await h.state()
    const charged = gateway.chargedFor(ord)
    if (state.tag === "Shipped") {
      assert.equal(charged, 1, `seed ${seed}: shipped with ${charged} charges`)
      assert.equal(shipping.createdFor(ord), 1, `seed ${seed}: shipments`)
    } else if (state.tag === "Failed") {
      assert.equal(charged, 0, `seed ${seed}: failed but charged ${charged}`)
    } else {
      assert.fail(`seed ${seed}: unsettled final state ${describe(state)} (pending ${h.store.pending()})`)
    }
    await h.assertReplay()
  }
})
