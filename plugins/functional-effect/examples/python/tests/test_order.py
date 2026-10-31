"""Core tests: a transition table test per row, a property per invariant."""

import random
import unittest

from orders.core.order import (
    MAX_ATTEMPTS,
    PAYMENT_TIMEOUT_MS,
    Amount,
    AwaitingPayment,
    ChargeCard,
    Draft,
    Failed,
    Input,
    OrderId,
    Paid,
    PaymentFailed,
    PaymentSucceeded,
    PaymentTimedOut,
    ScheduleInput,
    Submit,
    amount,
    charge_key,
    order_id,
    run,
    step,
)
from tests.prop import check_sequences

# A small domain, so generated sequences collide on the same order and attempt.
ORDERS = [order_id("ord-1"), order_id("ord-2")]
AMOUNTS = [amount(100), amount(500)]


def gen_input(rng: random.Random) -> Input:
    order = rng.choice(ORDERS)
    attempt = rng.randint(1, MAX_ATTEMPTS)
    kind = rng.randrange(4)
    if kind == 0:
        return Submit(order, rng.choice(AMOUNTS))
    if kind == 1:
        return PaymentSucceeded(order, attempt)
    if kind == 2:
        return PaymentFailed(order, attempt, "declined")
    return PaymentTimedOut(order, attempt)


def states_of(inputs):
    state = Draft()
    yield state
    for event in inputs:
        state, _ = step(state, event)
        yield state


class TransitionTable(unittest.TestCase):
    O = ORDERS[0]
    A = AMOUNTS[0]

    def test_submit_from_draft_charges_and_schedules_a_timeout(self):
        state, commands = step(Draft(), Submit(self.O, self.A))
        self.assertEqual(state, AwaitingPayment(self.O, self.A, 1))
        self.assertEqual(
            commands,
            (
                ChargeCard(self.O, self.A, 1, charge_key(self.O, 1)),
                ScheduleInput(PAYMENT_TIMEOUT_MS, PaymentTimedOut(self.O, 1)),
            ),
        )

    def test_payment_succeeded_pays(self):
        awaiting = AwaitingPayment(self.O, self.A, 2)
        self.assertEqual(step(awaiting, PaymentSucceeded(self.O, 2)), (Paid(self.O), ()))

    def test_timeout_retries_with_a_new_attempt_then_fails(self):
        state, commands = step(AwaitingPayment(self.O, self.A, 1), PaymentTimedOut(self.O, 1))
        self.assertEqual(state, AwaitingPayment(self.O, self.A, 2))
        self.assertEqual(commands[0], ChargeCard(self.O, self.A, 2, charge_key(self.O, 2)))
        self.assertEqual(
            step(AwaitingPayment(self.O, self.A, MAX_ATTEMPTS), PaymentTimedOut(self.O, MAX_ATTEMPTS)),
            (Failed(self.O, "payment timed out"), ()),
        )

    def test_stale_and_unexpected_inputs_change_nothing(self):
        awaiting = AwaitingPayment(self.O, self.A, 2)
        self.assertEqual(step(awaiting, PaymentSucceeded(self.O, 1)), (awaiting, ()))
        self.assertEqual(step(awaiting, PaymentTimedOut(self.O, 1)), (awaiting, ()))
        self.assertEqual(step(Draft(), PaymentSucceeded(self.O, 1)), (Draft(), ()))
        self.assertEqual(step(Paid(self.O), Submit(self.O, self.A)), (Paid(self.O), ()))


class Properties(unittest.TestCase):
    def test_every_charge_key_is_issued_at_most_once(self):
        def prop(inputs):
            _, commands = run(Draft(), inputs)
            keys = [c.key for c in commands if isinstance(c, ChargeCard)]
            return len(keys) == len(set(keys))

        check_sequences(gen_input, prop)

    def test_attempt_never_exceeds_the_maximum(self):
        def prop(inputs):
            return all(s.attempt <= MAX_ATTEMPTS for s in states_of(inputs) if isinstance(s, AwaitingPayment))

        check_sequences(gen_input, prop)

    def test_paid_and_failed_are_terminal(self):
        def prop(inputs):
            seen = list(states_of(inputs))
            return all(b == a for a, b in zip(seen, seen[1:]) if isinstance(a, (Paid, Failed)))

        check_sequences(gen_input, prop)

    def test_only_the_submitted_order_ever_moves(self):
        def prop(inputs):
            ids = {s.order_id for s in states_of(inputs) if not isinstance(s, Draft)}
            return len(ids) <= 1

        check_sequences(gen_input, prop)


class Constructors(unittest.TestCase):
    def test_invalid_values_cannot_be_built(self):
        for bad in (0, -5, 1.5, True, "10"):
            with self.assertRaises(ValueError):
                amount(bad)  # type: ignore[arg-type]
        for bad in ("", "  "):
            with self.assertRaises(ValueError):
                order_id(bad)


if __name__ == "__main__":
    unittest.main()
