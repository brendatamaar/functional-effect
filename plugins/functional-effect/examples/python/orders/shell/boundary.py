"""Boundary: untrusted data in, core types out. Parse once, here.

Stdlib only so the example runs anywhere. In a real service use pydantic
(`TypeAdapter(...).validate_python`) or msgspec for the wire model, then call
the same core constructors.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from orders.core.order import (
    Input,
    PaymentFailed,
    PaymentSucceeded,
    Submit,
    amount,
    order_id,
)


@dataclass(frozen=True, slots=True)
class Accepted:
    event_id: str
    input: Input


@dataclass(frozen=True, slots=True)
class Rejected:
    reason: str


Parsed = Accepted | Rejected


def _text(raw: dict[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key}: must be a non-empty string")
    return value


def _whole(raw: dict[str, Any], key: str) -> int:
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise ValueError(f"{key}: must be a positive integer")
    return value


def parse_event(raw: object) -> Parsed:
    """Rejection is a value (the HTTP layer maps it to 400), never an exception."""
    if not isinstance(raw, dict):
        return Rejected("body: must be an object")
    try:
        event_id = _text(raw, "eventId")
        tag = raw.get("tag")
        if tag == "Submit":
            return Accepted(event_id, Submit(order_id(_text(raw, "orderId")), amount(_whole(raw, "amount"))))
        if tag == "PaymentSucceeded":
            return Accepted(event_id, PaymentSucceeded(order_id(_text(raw, "orderId")), _whole(raw, "attempt")))
        if tag == "PaymentFailed":
            return Accepted(
                event_id, PaymentFailed(order_id(_text(raw, "orderId")), _whole(raw, "attempt"), _text(raw, "reason"))
            )
        return Rejected(f"tag: unknown event {tag!r}")
    except ValueError as err:
        return Rejected(str(err))


def encode_event(event_id: str, event: Input) -> dict[str, Any]:
    """Wire format of the events that have one (PaymentTimedOut is internal)."""
    match event:
        case Submit(order_id=oid, amount=amt):
            return {"tag": "Submit", "eventId": event_id, "orderId": oid, "amount": amt}
        case PaymentSucceeded(order_id=oid, attempt=attempt):
            return {"tag": "PaymentSucceeded", "eventId": event_id, "orderId": oid, "attempt": attempt}
        case PaymentFailed(order_id=oid, attempt=attempt, reason=reason):
            return {"tag": "PaymentFailed", "eventId": event_id, "orderId": oid, "attempt": attempt, "reason": reason}
        case _:
            raise ValueError(f"{type(event).__name__} has no wire format")
