# Model Functional Effect in TypeScript (with Effect v4)

Complete, runnable version: `examples/typescript` in this plugin (`npm install && npm test && npm start`). This is the Effect flavor; for plain TypeScript (zod, a `Deps` object, fast-check) see [typescript.md](typescript.md).

## Layout

```
src/core/     pure: types, step, run, property tests (type-only imports at most)
src/shell/    boundary (Schema), capabilities (services), interpreter, store, app, worker, fakes
src/main.ts   the edge: provide services, read the clock, Effect.runPromise
```

## Sum types and branded values

```ts
import type { Brand } from "effect"                 // type-only: erased, the core stays dependency-free
export type Amount = number & Brand.Brand<"Amount">

export type State =
  | { readonly tag: "Draft" }
  | { readonly tag: "AwaitingPayment"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number }
  | { readonly tag: "Reconciling"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number }
  // ...
```

A plain status with no data per value can be a string-literal union (`type BuildStatus = "queued" | "running" | "done"`); use a tagged union once a variant carries its own data. Switches list every variant; the ESLint template's `switch-exhaustiveness-check` (with `considerDefaultExhaustiveForUnions: false`) fails a switch that misses one or hides it behind `default`.

## step: guards on state, order and attempt

```ts
case "PaymentSucceeded": {
  const p = pending(s)                               // AwaitingPayment or Reconciling
  if (!matches(p, i.orderId, i.attempt)) return [s, []]
  return [{ tag: "Paid", orderId: p.orderId }, [{ tag: "CreateShipment", orderId: p.orderId, key: shipmentKey(p.orderId) }]]
}
```

Time is a command: `{ tag: "ScheduleInput", afterMs: PAYMENT_TIMEOUT_MS, input: { tag: "PaymentTimedOut", orderId, attempt } }`. Keys come from state: `chargeKey(orderId, attempt)`.

For UI state the same `step` is a reducer: `useReducer` in React, or a Pinia/Vue store whose only mutation is `state = step(state, input)[0]`, with commands dispatched by a composable.

## Property tests from a Schema, with shrinking

```ts
import * as Arbitrary from "effect/Arbitrary"         // unstable in Effect 4.0; fast-check is the stable alternative

const InputSchema = Schema.Union([
  Schema.Struct({ tag: Schema.Literal("Submit"), orderId: OrderId, amount: Amount }),
  Schema.Struct({ tag: Schema.Literal("PaymentSucceeded"), orderId: OrderId, attempt: Attempt }),
  // ... OrderId = Schema.Literals(["ord-1", "ord-2"]) so sequences collide
])
const inputs = Arbitrary.array(Arbitrary.schema(InputSchema), { maxLength: 40 })

const result = await Effect.runPromise(Arbitrary.checkEffect(inputs, (xs) => property(xs) === undefined, { runs: 2000 }))
if (result._tag === "Falsified") assert.fail(JSON.stringify(result.shrunkInput))   // the minimal sequence
```

## Boundary (Effect Schema v4)

```ts
export const EventSchema = Schema.Union([
  Schema.TaggedStruct("Submit", { eventId: EventId, orderId: OrderId, amount: Amount }),
  Schema.TaggedStruct("PaymentSucceeded", { eventId: EventId, orderId: OrderId, attempt: Attempt }),
  // PaymentTimedOut is not here: only the scheduler produces it
])
export const parseEvent = (raw: unknown) =>
  Schema.decodeUnknownEffect(EventSchema)(raw).pipe(Effect.map((w) => ({ id: w.eventId, input: toCore(w) })))
```

## Interpreter: one strategy per command

```ts
case "ChargeCard": {
  const gateway = yield* PaymentGateway                         // R += PaymentGateway
  return yield* retries.transient(gateway.charge(cmd.key, cmd.orderId, cmd.amount)).pipe(
    Effect.as(some({ tag: "PaymentSucceeded", orderId: cmd.orderId, attempt: cmd.attempt })),
    Effect.catchTag("PaymentDeclined", (e) => Effect.succeed(some({ tag: "PaymentFailed", /* ... */ reason: e.reason }))),
    Effect.catchTag("Transient", () => Effect.logWarning("outcome unknown").pipe(Effect.as(undefined))),   // wait for the timer
  )
}
```

`Retries` is a service: production uses `Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 2, while: isTransient })`, tests retry instantly. `ResolvePayment` calls a fenced `resolve(key)`.

## Store, app, worker

`Store` is a `Context.Service` with `load`, `commit` (version + inbox + event log + state + outbox; fails with `Conflict` or `Duplicate`), `claimDue`, `complete`, `release`, `events`. `handle(eventId, input, now)` retries `Conflict` and turns `Duplicate` into a no-op; `runOnce(now)` drains the outbox. The shell owns the clock: only `main.ts` reads `Clock.currentTimeMillis`. SQL in [outbox.md](outbox.md).

The in-memory store's `load` reads and then yields before returning, like a real round trip, so concurrent handlers see stale reads and the concurrency test exercises the version check.

## Effect v4 names

`Context.Service` (not `Context.Tag`/`Effect.Service`), `Data.TaggedError` or `Schema.TaggedError`, `Result` (not `Either`), `Effect.result`, `Effect.catch` (not `catchAll`), `Effect.forkChild` (not `fork`), `References.MinimumLogLevel`. Modules under `effect/unstable/*` may change in minor releases.

## Enforcing it with ESLint

For CI and human edits, add `templates/eslint.functional-core.mjs` (purity rules and `switch-exhaustiveness-check`).
