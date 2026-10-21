// The edge of the program: the only place an Effect is executed and the clock is read.
//
// Scenario: the first charge goes through but its response is lost, and the
// retries never reach the gateway. The shell does not guess. Ten minutes later
// the timer fires, the order is reconciled with a fenced resolve, and it ships.
// The same webhook is then delivered twice, and the state is replayed from the
// event log to prove the stored state is just run(events).

import { Clock, Effect } from "effect"
import { type OrderId, PAYMENT_TIMEOUT_MS, describe } from "./core/order.js"
import { handle, replay } from "./shell/app.js"
import { parseEvent } from "./shell/boundary.js"
import { Notifier, PaymentGateway, Retries, Shipping, productionRetries } from "./shell/capabilities.js"
import { type Behavior, FakeGateway, FakeNotifier, FakeShipping } from "./shell/fakes.js"
import { MemoryStore, Store } from "./shell/store.js"
import { runOnce } from "./shell/worker.js"

const gateway = new FakeGateway((op, _key, n): Behavior => (op === "charge" ? (n === 1 ? "LostResponse" : "Transient") : "Normal"))
const notifier = new FakeNotifier()
const store = new MemoryStore()

const program = Effect.gen(function* () {
  // Real time at the edge; simulated time from here on so the demo is instant.
  let now = yield* Clock.currentTimeMillis
  const clock = () => new Date(now).toISOString().slice(11, 16)
  const show = (label: string, id: OrderId) =>
    Effect.gen(function* () {
      const { state, version } = yield* store.service.load(id)
      yield* Effect.log(`${clock()}  ${label.padEnd(28)} v${version}  ${describe(state)}`)
    })
  const drain = Effect.gen(function* () {
    while ((yield* runOnce(now)) > 0) {}
  })

  const event = yield* parseEvent({ eventId: "evt-1", _tag: "Submit", orderId: "ord-1", amount: 4200 })
  const id = event.input.orderId
  yield* handle(event.id, event.input, now)
  yield* show("submitted", id)

  yield* drain
  yield* show("charge outcome unknown", id)

  now += PAYMENT_TIMEOUT_MS
  yield* drain
  yield* show("timer fired, reconciled", id)

  for (let i = 0; i < 2; i++) {
    const dup = yield* parseEvent({ eventId: "wh-77", _tag: "PaymentSucceeded", orderId: "ord-1", attempt: 1 })
    yield* handle(dup.id, dup.input, now)
  }
  yield* show("late webhook ×2 (ignored)", id)

  const rejected = yield* parseEvent({ eventId: "evt-x", _tag: "Submit", orderId: "", amount: -5 }).pipe(Effect.flip)
  yield* Effect.log(`       rejected at boundary: ${rejected.message.split("\n")[0]}`)

  const { state } = yield* store.service.load(id)
  const replayed = yield* replay(id)
  const events = yield* store.service.events(id)
  yield* Effect.log(`event log (${events.length} inputs):\n${events.map((e, i) => `  ${i + 1}. ${JSON.stringify(e)}`).join("\n")}`)
  const same = JSON.stringify(replayed) === JSON.stringify(state)
  yield* Effect.log(`replayed state equals stored state: ${same}`)
  yield* Effect.log(`money moved: ${gateway.chargedFor(id)} time(s); customer notified: ${JSON.stringify(notifier.sent)}`)
  return state.tag === "Shipped" && gateway.chargedFor(id) === 1 && same
}).pipe(
  Effect.provideService(Store, store.service),
  Effect.provideService(PaymentGateway, gateway.service),
  Effect.provideService(Shipping, new FakeShipping().service),
  Effect.provideService(Notifier, notifier.service),
  Effect.provideService(Retries, productionRetries),
)

Effect.runPromise(program).then((ok) => {
  if (!ok) process.exitCode = 1
})
