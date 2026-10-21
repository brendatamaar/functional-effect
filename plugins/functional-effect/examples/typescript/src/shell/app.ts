// App: load → step → commit, with optimistic concurrency. It performs no
// effects itself; commands go to the outbox and the worker interprets them.

import { Effect } from "effect"
import { type Input, type OrderId, initial, orderOf, run, step } from "../core/order.js"
import { type OutboxItem, Store } from "./store.js"

/**
 * Apply one input, identified by eventId for de-duplication. A duplicate
 * delivery is a no-op that returns the current state. `now` comes from the
 * caller: the shell owns the clock.
 */
export const handle = (eventId: string, input: Input, now: number) =>
  Effect.gen(function* () {
    const store = yield* Store
    const orderId = orderOf(input)
    const once = Effect.gen(function* () {
      const { state, version } = yield* store.load(orderId)
      const [next, commands] = step(state, input)
      // Deterministic IDs: re-processing the same event yields the same items.
      const outbox = commands.map(
        (command, k): OutboxItem => ({
          id: `${eventId}#${k}`,
          orderId,
          command,
          dueAt: command.tag === "ScheduleInput" ? now + command.afterMs : now,
        }),
      )
      yield* store.commit({ orderId, expected: version, eventId, input, state: next, outbox })
      return next
    })
    return yield* once.pipe(
      // Someone else committed first: reload and re-run step.
      Effect.retry({ times: 10, while: (e) => e._tag === "Conflict" }),
      Effect.catchTag("Duplicate", () => store.load(orderId).pipe(Effect.map((r) => r.state))),
    )
  })

/** Rebuild an order's state from its event log with the pure core. */
export const replay = (orderId: OrderId) =>
  Effect.gen(function* () {
    const store = yield* Store
    return run(initial, yield* store.events(orderId))[0]
  })
