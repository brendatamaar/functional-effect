// Boundary: the only door from the outside world into the core.
// Untrusted data (HTTP bodies, webhooks, queue messages, LLM output) is `unknown`
// until it has been parsed into a core type here. Parse, don't validate.

import { Effect, Schema } from "effect"
import { type Input, MAX_PAYMENT_ATTEMPTS } from "../core/order.js"

export const Amount = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("Amount"))
export const OrderId = Schema.NonEmptyString.pipe(Schema.brand("OrderId"))
const Attempt = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PAYMENT_ATTEMPTS }))
const EventId = Schema.NonEmptyString

/**
 * Wire format of events arriving from outside. PaymentTimedOut is not here:
 * only the scheduler produces it, never the outside world.
 */
export const EventSchema = Schema.Union([
  Schema.TaggedStruct("Submit", { eventId: EventId, orderId: OrderId, amount: Amount }),
  Schema.TaggedStruct("PaymentSucceeded", { eventId: EventId, orderId: OrderId, attempt: Attempt }),
  Schema.TaggedStruct("PaymentFailed", { eventId: EventId, orderId: OrderId, attempt: Attempt, reason: Schema.String }),
  Schema.TaggedStruct("ShipmentCreated", { eventId: EventId, orderId: OrderId, trackingNo: Schema.NonEmptyString }),
  Schema.TaggedStruct("Retry", { eventId: EventId, orderId: OrderId }),
])

type Wire = typeof EventSchema.Type

/** A parsed event: a delivery ID for de-duplication plus the core Input. */
export interface Event {
  readonly id: string
  readonly input: Input
}

// The decoded type uses `_tag`; the core uses `tag`. The mapping is the
// boundary's job, so the core never sees wire-format concerns.
const toCore = (w: Wire): Input => {
  switch (w._tag) {
    case "Submit": return { tag: "Submit", orderId: w.orderId, amount: w.amount }
    case "PaymentSucceeded": return { tag: "PaymentSucceeded", orderId: w.orderId, attempt: w.attempt }
    case "PaymentFailed": return { tag: "PaymentFailed", orderId: w.orderId, attempt: w.attempt, reason: w.reason }
    case "ShipmentCreated": return { tag: "ShipmentCreated", orderId: w.orderId, trackingNo: w.trackingNo }
    case "Retry": return { tag: "Retry", orderId: w.orderId }
  }
}

/** unknown → Event, with the failure kept in the error channel instead of thrown. */
export const parseEvent = (raw: unknown) =>
  Schema.decodeUnknownEffect(EventSchema)(raw).pipe(Effect.map((w): Event => ({ id: w.eventId, input: toCore(w) })))

/**
 * The inverse of parseEvent: the wire format producers send.
 * parseEvent(encodeEvent(e)) equals e for every event parseEvent can return;
 * boundary.test.ts checks it. PaymentTimedOut has no wire format (only the
 * scheduler produces it), so encoding one is a defect.
 */
export const encodeEvent = (e: Event): Wire => {
  const eventId = e.id
  const i = e.input
  switch (i.tag) {
    case "Submit": return { _tag: "Submit", eventId, orderId: i.orderId, amount: i.amount }
    case "PaymentSucceeded": return { _tag: "PaymentSucceeded", eventId, orderId: i.orderId, attempt: i.attempt }
    case "PaymentFailed": return { _tag: "PaymentFailed", eventId, orderId: i.orderId, attempt: i.attempt, reason: i.reason }
    case "ShipmentCreated": return { _tag: "ShipmentCreated", eventId, orderId: i.orderId, trackingNo: i.trackingNo }
    case "Retry": return { _tag: "Retry", eventId, orderId: i.orderId }
    case "PaymentTimedOut": throw new Error("PaymentTimedOut is internal and has no wire format")
  }
}
