// Capabilities the shell needs from the outside world. As Effect services they
// appear in the R of Effect<A, E, R>, and tests swap them for fakes.

import { Context, Data, Effect, Schedule } from "effect"
import type { Amount, IdempotencyKey, OrderId } from "../core/order.js"

/** A domain outcome: becomes a PaymentFailed Input, never an error the caller sees. */
export class PaymentDeclined extends Data.TaggedError("PaymentDeclined")<{ readonly reason: string }> {}

/**
 * Worth retrying (timeout, 429, 503, reset). Retrying is only safe because
 * every command carries an idempotency key.
 */
export class Transient extends Data.TaggedError("Transient")<{ readonly reason: string }> {}

export class NotifyFailed extends Data.TaggedError("NotifyFailed")<{ readonly reason: string }> {}

/** Put the command back in the outbox and try later. Only for idempotent commands. */
export class RetryLater extends Data.TaggedError("RetryLater")<{ readonly reason: string }> {}

export type PaymentStatus = "NotFound" | "Pending" | "Charged" | "Declined"

export class PaymentGateway extends Context.Service<
  PaymentGateway,
  {
    /** Idempotent per key: a repeated key returns the first result without charging again. */
    readonly charge: (key: IdempotencyKey, orderId: OrderId, amount: Amount) => Effect.Effect<void, PaymentDeclined | Transient>
    /**
     * The final outcome for key. If the gateway never saw the key it voids it, so a
     * later charge with that key is declined. This fencing makes "not charged" safe
     * to act on: otherwise a ChargeCard redelivered after a crash could charge an
     * order the core already marked Failed.
     */
    readonly resolve: (key: IdempotencyKey) => Effect.Effect<PaymentStatus, Transient>
  }
>()("PaymentGateway") {}

export class Shipping extends Context.Service<
  Shipping,
  { readonly create: (key: IdempotencyKey, orderId: OrderId) => Effect.Effect<string, Transient> }
>()("Shipping") {}

export class Notifier extends Context.Service<
  Notifier,
  { readonly send: (orderId: OrderId, message: string) => Effect.Effect<void, NotifyFailed> }
>()("Notifier") {}

/** How transient failures are retried. Production backs off; tests retry instantly. */
export class Retries extends Context.Service<
  Retries,
  { readonly transient: <A, E extends { readonly _tag: string }, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R> }
>()("Retries") {}

const isTransient = (e: { readonly _tag: string }) => e._tag === "Transient"

export const productionRetries: Retries["Service"] = {
  transient: (self) => self.pipe(Effect.retry({ schedule: Schedule.exponential("100 millis"), times: 2, while: isTransient })),
}

export const instantRetries: Retries["Service"] = {
  transient: (self) => self.pipe(Effect.retry({ times: 2, while: isTransient })),
}
