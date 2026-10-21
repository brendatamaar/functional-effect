// Fakes for the demo and tests. Each behaves like a well-behaved real service
// (idempotent per key) and can be scripted to misbehave.

import { Effect } from "effect"
import type { Amount, IdempotencyKey, OrderId } from "../core/order.js"
import {
  type PaymentStatus,
  NotifyFailed,
  Notifier,
  PaymentDeclined,
  PaymentGateway,
  Shipping,
  Transient,
} from "./capabilities.js"

/** How one call to a fake behaves. */
export type Behavior = "Normal" | "Decline" | "Transient" | "LostResponse"

export class FakeGateway {
  private readonly results = new Map<IdempotencyKey, PaymentStatus>()
  private readonly charged = new Map<OrderId, number>()
  readonly calls = new Map<string, number>()
  /** Always declined, like the magic amounts of a provider's sandbox. */
  declineAmount: Amount | undefined

  /** Decides how call number n (1-based) for an op and key behaves. */
  constructor(private readonly script: (op: "charge" | "resolve", key: IdempotencyKey, n: number) => Behavior = () => "Normal") {}

  private behavior(op: "charge" | "resolve", key: IdempotencyKey): Behavior {
    const k = `${op}|${key}`
    const n = (this.calls.get(k) ?? 0) + 1
    this.calls.set(k, n)
    return this.script(op, key, n)
  }

  readonly service: PaymentGateway["Service"] = {
    charge: (key, orderId, amount) =>
      Effect.suspend((): Effect.Effect<void, PaymentDeclined | Transient> => {
        let b = this.behavior("charge", key)
        if (b === "Transient") return Effect.fail(new Transient({ reason: "gateway timeout" }))
        const prev = this.results.get(key)
        if (prev !== undefined) // idempotent replay of the first result
          return prev === "Charged" ? Effect.void : Effect.fail(new PaymentDeclined({ reason: `key ${key} ${prev.toLowerCase()}` }))
        if (amount === this.declineAmount) b = "Decline"
        if (b === "Decline") {
          this.results.set(key, "Declined")
          return Effect.fail(new PaymentDeclined({ reason: "insufficient funds" }))
        }
        this.results.set(key, "Charged")
        this.charged.set(orderId, (this.charged.get(orderId) ?? 0) + 1)
        return b === "LostResponse" ? Effect.fail(new Transient({ reason: "response lost" })) : Effect.void
      }),
    resolve: (key) =>
      Effect.suspend((): Effect.Effect<PaymentStatus, Transient> => {
        if (this.behavior("resolve", key) === "Transient") return Effect.fail(new Transient({ reason: "gateway timeout" }))
        const prev = this.results.get(key)
        if (prev !== undefined) return Effect.succeed(prev)
        this.results.set(key, "Declined") // fence: a late charge with this key is declined
        return Effect.succeed("NotFound")
      }),
  }

  /** How many times money actually moved for an order. */
  chargedFor(orderId: OrderId): number {
    return this.charged.get(orderId) ?? 0
  }
}

export class FakeShipping {
  private readonly shipments = new Map<IdempotencyKey, string>()
  private readonly created = new Map<OrderId, number>()
  private calls = 0

  constructor(private readonly script: (n: number) => Behavior = () => "Normal") {}

  readonly service: Shipping["Service"] = {
    create: (key, orderId) =>
      Effect.suspend((): Effect.Effect<string, Transient> => {
        if (this.script(++this.calls) === "Transient") return Effect.fail(new Transient({ reason: "shipping API 503" }))
        const existing = this.shipments.get(key)
        if (existing) return Effect.succeed(existing)
        const trackingNo = `TRK-${orderId}`
        this.shipments.set(key, trackingNo)
        this.created.set(orderId, (this.created.get(orderId) ?? 0) + 1)
        return Effect.succeed(trackingNo)
      }),
  }

  createdFor(orderId: OrderId): number {
    return this.created.get(orderId) ?? 0
  }
}

export class FakeNotifier {
  readonly sent: string[] = []
  fail = false

  readonly service: Notifier["Service"] = {
    send: (orderId, message) =>
      Effect.suspend((): Effect.Effect<void, NotifyFailed> => {
        if (this.fail) return Effect.fail(new NotifyFailed({ reason: "sms provider down" }))
        this.sent.push(`${orderId}: ${message}`)
        return Effect.void
      }),
  }
}
