// Functional core for an order checkout.
//
// Model Functional Effect:  (state₂, commands) = step(state₁, input)
//
// Rules this file follows (and the plugin's checker enforces):
//   - No IO, no clock reads, no randomness, no console, no Effect.run* here.
//   - Every state, input and command is a closed sum type.
//   - step() returns new data; it never performs the commands it emits.
//   - Time enters as data: timers are ScheduleInput commands, and the shell
//     feeds the scheduled Input back when it is due.

// A type-only import: erased at compile time, so the core stays free of runtime dependencies.
import type { Brand } from "effect"

// ---------------------------------------------------------------------------
// Boundary-verified values (produced only by parsers in the shell)
// ---------------------------------------------------------------------------

/** Positive integer amount in the smallest currency unit. */
export type Amount = number & Brand.Brand<"Amount">

export type OrderId = string & Brand.Brand<"OrderId">

/** Identifies one logical operation: the same key always means the same operation. */
export type IdempotencyKey = string & Brand.Brand<"IdempotencyKey">

/** Deterministic: replaying the same inputs yields the same keys. */
export const chargeKey = (id: OrderId, attempt: number) => `charge:${id}:${attempt}` as IdempotencyKey
export const shipmentKey = (id: OrderId) => `ship:${id}` as IdempotencyKey

// ---------------------------------------------------------------------------
// State: the rooms
// ---------------------------------------------------------------------------

export type State =
  | { readonly tag: "Draft" }
  | { readonly tag: "AwaitingPayment"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number }
  /** The charge outcome is unknown: a timeout does not mean the charge failed, so we ask. */
  | { readonly tag: "Reconciling"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number }
  | { readonly tag: "Paid"; readonly orderId: OrderId }
  | { readonly tag: "Shipped"; readonly orderId: OrderId; readonly trackingNo: string }
  | { readonly tag: "Failed"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number; readonly reason: string }

// ---------------------------------------------------------------------------
// Input: user actions, command results and timers. Payment results and timers
// carry their attempt, so a stale one can never move the current attempt.
// ---------------------------------------------------------------------------

export type Input =
  | { readonly tag: "Submit"; readonly orderId: OrderId; readonly amount: Amount }
  | { readonly tag: "PaymentSucceeded"; readonly orderId: OrderId; readonly attempt: number }
  | { readonly tag: "PaymentFailed"; readonly orderId: OrderId; readonly attempt: number; readonly reason: string }
  | { readonly tag: "PaymentTimedOut"; readonly orderId: OrderId; readonly attempt: number }
  | { readonly tag: "ShipmentCreated"; readonly orderId: OrderId; readonly trackingNo: string }
  | { readonly tag: "Retry"; readonly orderId: OrderId }

// ---------------------------------------------------------------------------
// Command: effects described as data. The shell interprets them.
// ---------------------------------------------------------------------------

export type Command =
  | { readonly tag: "ChargeCard"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number; readonly key: IdempotencyKey }
  | { readonly tag: "ResolvePayment"; readonly orderId: OrderId; readonly attempt: number; readonly key: IdempotencyKey }
  | { readonly tag: "CreateShipment"; readonly orderId: OrderId; readonly key: IdempotencyKey }
  | { readonly tag: "NotifyCustomer"; readonly orderId: OrderId; readonly message: string }
  /** Ask the shell to feed `input` back after a delay: time without reading the clock. */
  | { readonly tag: "ScheduleInput"; readonly afterMs: number; readonly input: Input }

export const MAX_PAYMENT_ATTEMPTS = 3
export const PAYMENT_TIMEOUT_MS = 10 * 60 * 1000

export const initial: State = { tag: "Draft" }

const charge = (orderId: OrderId, amount: Amount, attempt: number): readonly Command[] => [
  { tag: "ChargeCard", orderId, amount, attempt, key: chargeKey(orderId, attempt) },
  { tag: "ScheduleInput", afterMs: PAYMENT_TIMEOUT_MS, input: { tag: "PaymentTimedOut", orderId, attempt } },
]

const reconcile = (orderId: OrderId, attempt: number): readonly Command[] => [
  { tag: "ResolvePayment", orderId, attempt, key: chargeKey(orderId, attempt) },
  { tag: "ScheduleInput", afterMs: PAYMENT_TIMEOUT_MS, input: { tag: "PaymentTimedOut", orderId, attempt } },
]

type InFlight = { readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number }

/** The in-flight payment attempt, if the state has one. */
export const pending = (s: State): InFlight | undefined => {
  switch (s.tag) {
    case "AwaitingPayment":
    case "Reconciling":
      return { orderId: s.orderId, amount: s.amount, attempt: s.attempt }
    case "Draft":
    case "Paid":
    case "Shipped":
    case "Failed":
      return undefined
  }
}

const matches = (p: InFlight | undefined, orderId: OrderId, attempt: number): p is InFlight =>
  p !== undefined && p.orderId === orderId && p.attempt === attempt

// ---------------------------------------------------------------------------
// step: the transition table. Each case is one legal hallway.
// Anything not listed leaves the state unchanged and emits nothing.
// ---------------------------------------------------------------------------

export const step = (s: State, i: Input): readonly [State, readonly Command[]] => {
  switch (i.tag) {
    case "Submit":
      if (s.tag !== "Draft") return [s, []]
      return [{ tag: "AwaitingPayment", orderId: i.orderId, amount: i.amount, attempt: 1 }, charge(i.orderId, i.amount, 1)]

    case "PaymentSucceeded": {
      const p = pending(s)
      if (!matches(p, i.orderId, i.attempt)) return [s, []] // stale, duplicated or for another order
      return [{ tag: "Paid", orderId: p.orderId }, [{ tag: "CreateShipment", orderId: p.orderId, key: shipmentKey(p.orderId) }]]
    }

    case "PaymentFailed": {
      const p = pending(s)
      if (!matches(p, i.orderId, i.attempt)) return [s, []]
      return [
        { tag: "Failed", orderId: p.orderId, amount: p.amount, attempt: p.attempt, reason: i.reason },
        [{ tag: "NotifyCustomer", orderId: p.orderId, message: `Payment failed: ${i.reason}` }],
      ]
    }

    case "PaymentTimedOut": {
      const p = pending(s)
      if (!matches(p, i.orderId, i.attempt)) return [s, []] // a timer for an attempt that already resolved
      return [{ tag: "Reconciling", orderId: p.orderId, amount: p.amount, attempt: p.attempt }, reconcile(p.orderId, p.attempt)]
    }

    case "Retry": {
      if (s.tag !== "Failed" || s.orderId !== i.orderId || s.attempt >= MAX_PAYMENT_ATTEMPTS) return [s, []]
      const next = s.attempt + 1
      return [{ tag: "AwaitingPayment", orderId: s.orderId, amount: s.amount, attempt: next }, charge(s.orderId, s.amount, next)]
    }

    case "ShipmentCreated":
      if (s.tag !== "Paid" || s.orderId !== i.orderId) return [s, []]
      return [
        { tag: "Shipped", orderId: s.orderId, trackingNo: i.trackingNo },
        [{ tag: "NotifyCustomer", orderId: s.orderId, message: `Shipped: ${i.trackingNo}` }],
      ]
  }
}

// ---------------------------------------------------------------------------
// run: a whole history is a fold over inputs. Replay, deterministic tests and
// property-based tests are all just calls to run.
// ---------------------------------------------------------------------------

export const run = (s0: State, inputs: readonly Input[]): readonly [State, readonly Command[]] =>
  inputs.reduce<readonly [State, readonly Command[]]>(
    ([s, cmds], i) => {
      const [next, emitted] = step(s, i)
      return [next, [...cmds, ...emitted]]
    },
    [s0, []],
  )

/** Every input names its order, so the shell can route it to the right history. */
export const orderOf = (i: Input): OrderId => i.orderId

export const describe = (s: State): string => {
  switch (s.tag) {
    case "Draft": return "Draft"
    case "AwaitingPayment": return `AwaitingPayment(${s.orderId}, attempt ${s.attempt})`
    case "Reconciling": return `Reconciling(${s.orderId}, attempt ${s.attempt})`
    case "Paid": return `Paid(${s.orderId})`
    case "Shipped": return `Shipped(${s.orderId}, ${s.trackingNo})`
    case "Failed": return `Failed(${s.orderId}, attempt ${s.attempt}, ${s.reason})`
  }
}
