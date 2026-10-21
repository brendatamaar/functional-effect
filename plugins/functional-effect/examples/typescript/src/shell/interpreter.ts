// Interpreter: one Command → its effect → the Input it produces for the core
// (or undefined). Each command has an explicit failure strategy:
//
//   ChargeCard      domain outcome (declined → PaymentFailed); transient → retry with the
//                   same key, then escape hatch: rely on the PaymentTimedOut timer
//   ResolvePayment  fenced status check; transient → retry, then escape hatch: the next
//                   timer resolves again
//   CreateShipment  transient → retry, then RetryLater (idempotent: safe to redo)
//   NotifyCustomer  escape hatch: best effort, log and drop
//   ScheduleInput   the timer fired: its Input goes to the core

import { Effect } from "effect"
import type { Command, Input } from "../core/order.js"
import { Notifier, PaymentGateway, Retries, RetryLater, Shipping } from "./capabilities.js"

const some = (i: Input): Input | undefined => i

export const interpret = (cmd: Command) =>
  Effect.gen(function* () {
    const retries = yield* Retries
    switch (cmd.tag) {
      case "ChargeCard": {
        const gateway = yield* PaymentGateway
        return yield* retries.transient(gateway.charge(cmd.key, cmd.orderId, cmd.amount)).pipe(
          Effect.as(some({ tag: "PaymentSucceeded", orderId: cmd.orderId, attempt: cmd.attempt })),
          Effect.catchTag("PaymentDeclined", (e) =>
            Effect.succeed(some({ tag: "PaymentFailed", orderId: cmd.orderId, attempt: cmd.attempt, reason: e.reason })),
          ),
          // Outcome unknown: the charge may have gone through. Never guess; the
          // PaymentTimedOut timer moves the order to Reconciling.
          Effect.catchTag("Transient", () =>
            Effect.logWarning(`charge ${cmd.key}: outcome unknown after retries, waiting for reconciliation`).pipe(Effect.as(undefined)),
          ),
        )
      }
      case "ResolvePayment": {
        const gateway = yield* PaymentGateway
        return yield* retries.transient(gateway.resolve(cmd.key)).pipe(
          Effect.map((status): Input | undefined => {
            switch (status) {
              case "Charged": return { tag: "PaymentSucceeded", orderId: cmd.orderId, attempt: cmd.attempt }
              case "Declined": return { tag: "PaymentFailed", orderId: cmd.orderId, attempt: cmd.attempt, reason: "declined" }
              case "NotFound": return { tag: "PaymentFailed", orderId: cmd.orderId, attempt: cmd.attempt, reason: "not charged (voided)" }
              case "Pending": return undefined // the next timer resolves again
            }
          }),
          Effect.catchTag("Transient", () =>
            Effect.logWarning(`resolve ${cmd.key}: gateway unavailable, next timer resolves again`).pipe(Effect.as(undefined)),
          ),
        )
      }
      case "CreateShipment": {
        const shipping = yield* Shipping
        return yield* retries.transient(shipping.create(cmd.key, cmd.orderId)).pipe(
          Effect.map((trackingNo) => some({ tag: "ShipmentCreated", orderId: cmd.orderId, trackingNo })),
          Effect.catchTag("Transient", (e) => Effect.fail(new RetryLater({ reason: e.reason }))),
        )
      }
      case "NotifyCustomer": {
        const notifier = yield* Notifier
        return yield* notifier.send(cmd.orderId, cmd.message).pipe(
          Effect.as(undefined),
          Effect.catchTag("NotifyFailed", (e) => Effect.logWarning(`notify ${cmd.orderId}: dropped (${e.reason})`).pipe(Effect.as(undefined))),
        )
      }
      case "ScheduleInput":
        return some(cmd.input)
    }
  })
