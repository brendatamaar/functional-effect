"""Order checkout: the functional core.

(state2, commands) = step(state1, input). No IO, clock, randomness or logging
in this package; scripts/fe-check.mjs enforces that on every edit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import NewType, NoReturn

MAX_ATTEMPTS = 3
PAYMENT_TIMEOUT_MS = 30_000

OrderId = NewType("OrderId", str)
Amount = NewType("Amount", int)


def order_id(raw: str) -> OrderId:
    """Smart constructor: the only way to make an OrderId."""
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"invalid order id: {raw!r}")
    return OrderId(raw)


def amount(raw: int) -> Amount:
    """Smart constructor: a positive whole number of minor units."""
    if isinstance(raw, bool) or not isinstance(raw, int) or raw <= 0:
        raise ValueError(f"invalid amount: {raw!r}")
    return Amount(raw)


def charge_key(order: OrderId, attempt: int) -> str:
    """Idempotency key, derived from state so replays produce the same key."""
    return f"charge:{order}:{attempt}"


# --- State: closed sum type (a union of frozen dataclasses) -----------------


@dataclass(frozen=True, slots=True)
class Draft:
    pass


@dataclass(frozen=True, slots=True)
class AwaitingPayment:
    order_id: OrderId
    amount: Amount
    attempt: int


@dataclass(frozen=True, slots=True)
class Paid:
    order_id: OrderId


@dataclass(frozen=True, slots=True)
class Failed:
    order_id: OrderId
    reason: str


State = Draft | AwaitingPayment | Paid | Failed


# --- Input -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Submit:
    order_id: OrderId
    amount: Amount


@dataclass(frozen=True, slots=True)
class PaymentSucceeded:
    order_id: OrderId
    attempt: int


@dataclass(frozen=True, slots=True)
class PaymentFailed:
    order_id: OrderId
    attempt: int
    reason: str


@dataclass(frozen=True, slots=True)
class PaymentTimedOut:
    order_id: OrderId
    attempt: int


Input = Submit | PaymentSucceeded | PaymentFailed | PaymentTimedOut


# --- Command: effects as data ------------------------------------------------


@dataclass(frozen=True, slots=True)
class ChargeCard:
    order_id: OrderId
    amount: Amount
    attempt: int
    key: str


@dataclass(frozen=True, slots=True)
class ScheduleInput:
    """Time is a command: the shell feeds `input` back when `after_ms` has passed."""

    after_ms: int
    input: Input


Command = ChargeCard | ScheduleInput


def assert_never(value: NoReturn) -> NoReturn:
    raise AssertionError(f"unhandled variant: {value!r}")


def _charge(order: OrderId, amt: Amount, attempt: int) -> tuple[Command, ...]:
    return (
        ChargeCard(order, amt, attempt, charge_key(order, attempt)),
        ScheduleInput(PAYMENT_TIMEOUT_MS, PaymentTimedOut(order, attempt)),
    )


def step(state: State, event: Input) -> tuple[State, tuple[Command, ...]]:
    """Every return is one row of the transition table in the design.

    Results and timers carry the attempt they belong to; a late one from an
    earlier attempt is ignored (state unchanged, no commands).
    """
    match event:
        case Submit(order_id=order, amount=amt):
            if not isinstance(state, Draft):
                return state, ()
            return AwaitingPayment(order, amt, 1), _charge(order, amt, 1)

        case PaymentSucceeded(order_id=order, attempt=attempt):
            if not (isinstance(state, AwaitingPayment) and state.order_id == order and state.attempt == attempt):
                return state, ()
            return Paid(order), ()

        case PaymentFailed(order_id=order, attempt=attempt, reason=reason):
            if not (isinstance(state, AwaitingPayment) and state.order_id == order and state.attempt == attempt):
                return state, ()
            return Failed(order, reason), ()

        case PaymentTimedOut(order_id=order, attempt=attempt):
            if not (isinstance(state, AwaitingPayment) and state.order_id == order and state.attempt == attempt):
                return state, ()
            if attempt >= MAX_ATTEMPTS:
                return Failed(order, "payment timed out"), ()
            return AwaitingPayment(order, state.amount, attempt + 1), _charge(order, state.amount, attempt + 1)

        case _:
            assert_never(event)


def run(initial: State, inputs: list[Input] | tuple[Input, ...]) -> tuple[State, tuple[Command, ...]]:
    state = initial
    commands: tuple[Command, ...] = ()
    for event in inputs:
        state, more = step(state, event)
        commands += more
    return state, commands
