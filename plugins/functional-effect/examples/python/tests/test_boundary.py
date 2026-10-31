"""Boundary properties: round trip, accepted => valid, rejects each broken rule."""

import random
import unittest

from orders.core.order import PaymentFailed, PaymentSucceeded, Submit, amount, order_id
from orders.shell.boundary import Accepted, Rejected, encode_event, parse_event
from tests.prop import check_sequences


def gen_valid(rng: random.Random):
    oid = order_id(rng.choice(["ord-1", "ord-2", "x"]))
    kind = rng.randrange(3)
    if kind == 0:
        return Submit(oid, amount(rng.randint(1, 10_000)))
    if kind == 1:
        return PaymentSucceeded(oid, rng.randint(1, 5))
    return PaymentFailed(oid, rng.randint(1, 5), rng.choice(["declined", "expired"]))


def valid(event) -> bool:
    """The rules, written again and independently of the parser."""
    if not event.order_id.strip():
        return False
    if isinstance(event, Submit):
        return event.amount > 0
    if isinstance(event, PaymentSucceeded):
        return event.attempt > 0
    return event.attempt > 0 and bool(event.reason.strip())


def perturb(rng: random.Random, wire: dict) -> dict:
    """Break, delete or mistype one field of a valid event."""
    broken = dict(wire)
    key = rng.choice(sorted(broken))
    how = rng.randrange(3)
    if how == 0:
        del broken[key]
    elif how == 1:
        broken[key] = rng.choice([None, "", -1, 0, 1.5, True, [], {}])
    else:
        broken[key] = "garbage"
    return broken


class BoundaryProperties(unittest.TestCase):
    def test_round_trip(self):
        def prop(events):
            return all(parse_event(encode_event("e1", e)) == Accepted("e1", e) for e in events)

        check_sequences(gen_valid, prop, runs=500)

    def test_whatever_is_accepted_is_valid(self):
        accepted = 0

        def prop(events):
            nonlocal accepted
            rng = random.Random(len(events))
            for e in events:
                parsed = parse_event(perturb(rng, encode_event("e1", e)))
                if isinstance(parsed, Accepted):
                    accepted += 1
                    if not valid(parsed.input):
                        return False
            return True

        check_sequences(gen_valid, prop, runs=500)
        self.assertGreater(accepted, 0, "messy input should sometimes still be valid, or the property tests nothing")

    def test_each_broken_rule_is_rejected(self):
        base = {"tag": "Submit", "eventId": "e1", "orderId": "ord-1", "amount": 100}
        for field, bad in [
            ("eventId", ""),
            ("orderId", "  "),
            ("amount", 0),
            ("amount", -3),
            ("amount", 1.5),
            ("amount", True),
            ("tag", "Refund"),
        ]:
            with self.subTest(field=field, bad=bad):
                self.assertIsInstance(parse_event({**base, field: bad}), Rejected)
        self.assertIsInstance(parse_event({"tag": "PaymentFailed", "eventId": "e", "orderId": "o", "attempt": 1}), Rejected)
        self.assertIsInstance(parse_event("not an object"), Rejected)
        self.assertIsInstance(parse_event(None), Rejected)


if __name__ == "__main__":
    unittest.main()
