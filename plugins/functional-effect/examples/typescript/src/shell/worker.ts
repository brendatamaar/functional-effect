// Worker: drain the outbox. Claim due items, interpret each command, feed the
// resulting Input back through handle, then mark the item complete.
//
// Delivery is at-least-once: if the worker dies between interpreting and
// completing, the lease expires and the item runs again. That is safe because
// commands carry idempotency keys and the result's event ID is derived from the
// item ID, so the inbox drops the duplicate result.

import { Effect } from "effect"
import { handle } from "./app.js"
import { interpret } from "./interpreter.js"
import { type OutboxItem, Store } from "./store.js"

export type CrashPoint = "AfterEffect" | "AfterResult"

export interface WorkerOptions {
  readonly batch?: number
  readonly backoffMs?: number
  /** Simulate the process dying at a point (tests only). */
  readonly crash?: (item: OutboxItem, at: CrashPoint) => boolean
}

export const runOnce = (now: number, options: WorkerOptions = {}) =>
  Effect.gen(function* () {
    const store = yield* Store
    const items = yield* store.claimDue(now, options.batch ?? 100)
    for (const item of items) {
      const result = yield* interpret(item.command).pipe(Effect.result)
      if (result._tag === "Failure") {
        yield* store.release(item.id, now + (options.backoffMs ?? 30_000)) // RetryLater
        continue
      }
      if (options.crash?.(item, "AfterEffect")) continue
      if (result.success !== undefined) yield* handle(`${item.id}:result`, result.success, now)
      if (options.crash?.(item, "AfterResult")) continue
      yield* store.complete(item.id)
    }
    return items.length
  })
