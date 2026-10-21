package core

// Property-based tests for the functional core. Because Step is pure, a test is
// just: generate inputs → Run → check invariants. No mocks, no network, no clock.
//
// check() generates random input sequences from a seed and, on failure, shrinks
// the sequence to the shortest one that still fails, so the report shows the
// minimal path to the bug. pgregory.net/rapid or testing/quick are drop-in
// alternatives; this helper keeps the example dependency-free.

import (
	"fmt"
	"math/rand"
	"reflect"
	"strings"
	"testing"
)

const runs = 3000

func mustAmount(n int64) Amount  { a, _ := NewAmount(n); return a }
func mustOrder(s string) OrderID { o, _ := NewOrderID(s); return o }

var ids = []OrderID{mustOrder("ord-1"), mustOrder("ord-2")}

func genInput(r *rand.Rand) Input {
	id := ids[r.Intn(len(ids))]
	attempt := 1 + r.Intn(MaxPaymentAttempts)
	switch r.Intn(7) {
	case 0:
		return Submit{OrderID: id, Amount: mustAmount(4200)}
	case 1:
		return PaymentSucceeded{OrderID: id, Attempt: attempt}
	case 2:
		return PaymentFailed{OrderID: id, Attempt: attempt, Reason: "declined"}
	case 3:
		return PaymentTimedOut{OrderID: id, Attempt: attempt}
	case 4:
		return ShipmentCreated{OrderID: id, TrackingNo: "TRK-1"}
	default:
		return Retry{}
	}
}

func genInputs(seed int64) []Input {
	r := rand.New(rand.NewSource(seed))
	n := 1 + r.Intn(40)
	out := make([]Input, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, genInput(r))
	}
	return out
}

// shrink removes inputs one at a time while the property still fails.
func shrink(inputs []Input, prop func([]Input) error) []Input {
	for changed := true; changed; {
		changed = false
		for i := len(inputs) - 1; i >= 0; i-- {
			candidate := append(append([]Input{}, inputs[:i]...), inputs[i+1:]...)
			if prop(candidate) != nil {
				inputs, changed = candidate, true
			}
		}
	}
	return inputs
}

func describeInputs(inputs []Input) string {
	parts := make([]string, len(inputs))
	for i, in := range inputs {
		parts[i] = strings.ReplaceAll(fmt.Sprintf("%T%+v", in, in), "core.", "")
	}
	return strings.Join(parts, "\n  ")
}

func check(t *testing.T, prop func([]Input) error) {
	t.Helper()
	for seed := int64(1); seed <= runs; seed++ {
		inputs := genInputs(seed)
		if err := prop(inputs); err != nil {
			minimal := shrink(inputs, prop)
			t.Fatalf("seed %d: %v\nminimal failing inputs (%d of %d):\n  %s\nfails with: %v",
				seed, err, len(minimal), len(inputs), describeInputs(minimal), prop(minimal))
		}
	}
}

// eachStep runs inputs through Step and calls f with (before, input, after, commands).
func eachStep(inputs []Input, f func(State, Input, State, []Command) error) error {
	s := Initial
	for _, in := range inputs {
		next, cmds := Step(s, in)
		if err := f(s, in, next, cmds); err != nil {
			return err
		}
		s = next
	}
	return nil
}

func TestStepIsDeterministic(t *testing.T) {
	check(t, func(in []Input) error {
		s1, c1 := Run(Initial, in)
		s2, c2 := Run(Initial, in)
		if !reflect.DeepEqual(s1, s2) || !reflect.DeepEqual(c1, c2) {
			return fmt.Errorf("non-deterministic result")
		}
		return nil
	})
}

func TestAtMostMaxChargesWithUniqueKeys(t *testing.T) {
	check(t, func(in []Input) error {
		_, cmds := Run(Initial, in)
		keys := map[IdempotencyKey]bool{}
		for _, c := range cmds {
			if cc, ok := c.(ChargeCard); ok {
				if keys[cc.Key] {
					return fmt.Errorf("charge key %s reused", cc.Key)
				}
				keys[cc.Key] = true
			}
		}
		if len(keys) > MaxPaymentAttempts {
			return fmt.Errorf("%d charges", len(keys))
		}
		return nil
	})
}

func TestEveryChargeHasATimeout(t *testing.T) {
	check(t, func(in []Input) error {
		return eachStep(in, func(_ State, _ Input, _ State, cmds []Command) error {
			for _, c := range cmds {
				cc, ok := c.(ChargeCard)
				if !ok {
					continue
				}
				found := false
				for _, d := range cmds {
					if si, ok := d.(ScheduleInput); ok && si.Input == (PaymentTimedOut{OrderID: cc.OrderID, Attempt: cc.Attempt}) {
						found = true
					}
				}
				if !found {
					return fmt.Errorf("ChargeCard attempt %d without a timeout", cc.Attempt)
				}
			}
			return nil
		})
	})
}

func TestShipmentOnlyAfterPaid(t *testing.T) {
	check(t, func(in []Input) error {
		paid := map[OrderID]bool{}
		return eachStep(in, func(_ State, _ Input, next State, cmds []Command) error {
			if p, ok := next.(Paid); ok {
				paid[p.OrderID] = true
			}
			for _, c := range cmds {
				if cs, ok := c.(CreateShipment); ok && !paid[cs.OrderID] {
					return fmt.Errorf("shipment for unpaid order %s", cs.OrderID)
				}
			}
			return nil
		})
	})
}

func TestShippedOnlyFromPaidAndTerminal(t *testing.T) {
	check(t, func(in []Input) error {
		return eachStep(in, func(before State, _ Input, next State, cmds []Command) error {
			_, wasShipped := before.(Shipped)
			_, nowShipped := next.(Shipped)
			_, wasPaid := before.(Paid)
			if nowShipped && !wasShipped && !wasPaid {
				return fmt.Errorf("reached Shipped from %s", Describe(before))
			}
			if wasShipped && (!reflect.DeepEqual(before, next) || len(cmds) > 0) {
				return fmt.Errorf("Shipped is terminal, but moved to %s", Describe(next))
			}
			return nil
		})
	})
}

func TestStaleAttemptsNeverChangeState(t *testing.T) {
	check(t, func(in []Input) error {
		return eachStep(in, func(before State, input Input, next State, cmds []Command) error {
			_, _, current, inFlight := pending(before)
			var attempt int
			switch e := input.(type) {
			case PaymentSucceeded:
				attempt = e.Attempt
			case PaymentFailed:
				attempt = e.Attempt
			case PaymentTimedOut:
				attempt = e.Attempt
			case Submit, ShipmentCreated, Retry:
				return nil
			}
			if (!inFlight || attempt != current) && (!reflect.DeepEqual(before, next) || len(cmds) > 0) {
				return fmt.Errorf("stale attempt %d moved %s to %s", attempt, Describe(before), Describe(next))
			}
			return nil
		})
	})
}

// The shrinker itself: a deliberately broken property must shrink to its essence.
func TestShrinkFindsMinimalSequence(t *testing.T) {
	broken := func(in []Input) error { // "never reaches Reconciling" is false
		s, _ := Run(Initial, in)
		if _, ok := s.(Reconciling); ok {
			return fmt.Errorf("reached Reconciling")
		}
		return nil
	}
	in := []Input{
		Retry{},
		Submit{OrderID: ids[0], Amount: mustAmount(1)},
		PaymentSucceeded{OrderID: ids[1], Attempt: 1},
		PaymentTimedOut{OrderID: ids[0], Attempt: 2},
		PaymentTimedOut{OrderID: ids[0], Attempt: 1},
	}
	got := shrink(in, broken)
	want := []Input{Submit{OrderID: ids[0], Amount: mustAmount(1)}, PaymentTimedOut{OrderID: ids[0], Attempt: 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("shrunk to\n  %s", describeInputs(got))
	}
}
