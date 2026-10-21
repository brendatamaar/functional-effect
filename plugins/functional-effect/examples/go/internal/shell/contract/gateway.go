// Package contract holds contract suites: the behavior every implementation
// of a capability must have, written once and run against each implementation.
//
// A fake is only worth testing against if it behaves like the real thing. Run
// each suite against the fake (in every test run) and against the live adapter
// (against a simulator in every run, and against the provider's sandbox or a
// real database when configured). If both pass the same suite, a shell test
// that passes with the fake says something about production.
//
// Clauses use only the capability's interface plus the optional hooks in the
// subject, never an implementation's internals, so they can run against a
// service we do not control.
package contract

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"testing"

	"example.com/functional-effect/internal/core"
	"example.com/functional-effect/internal/shell"
)

// Fault is a failure a test can inject into the next call.
type Fault int

const (
	// Unreachable: the request never reaches the service. Nothing happens.
	Unreachable Fault = iota + 1
	// LostResponse: the service does the work, the caller never hears back.
	LostResponse
)

// GatewayUnderTest is one implementation of shell.PaymentGateway.
type GatewayUnderTest struct {
	Gateway shell.PaymentGateway
	// DeclineAmount is an amount the implementation always declines
	// (sandboxes document magic amounts or cards for this).
	DeclineAmount core.Amount
	// Inject makes the next call to op ("charge" or "resolve") fail with f.
	// Nil when faults cannot be injected (a real sandbox): those clauses skip.
	Inject func(op string, f Fault)
	// Charged reports how many times money moved for an order.
	// Nil when it cannot be observed: those checks are skipped.
	Charged func(id core.OrderID) int
}

// PaymentGateway runs the PaymentGateway contract. newGateway is called once
// per clause; each clause uses order IDs unique to this run, so the suite can
// run repeatedly against a shared sandbox.
func PaymentGateway(t *testing.T, newGateway func(t *testing.T) GatewayUnderTest) {
	run := runID()
	ctx := context.Background()
	amount, _ := core.NewAmount(4200)

	type env struct {
		GatewayUnderTest
		t     *testing.T
		order core.OrderID
	}
	clause := func(name string, needsFaults bool, f func(e env)) {
		t.Run(name, func(t *testing.T) {
			g := newGateway(t)
			if needsFaults && g.Inject == nil {
				t.Skip("implementation cannot inject faults")
			}
			id, _ := core.NewOrderID(run + "-" + strings.ReplaceAll(t.Name(), "/", "-"))
			f(env{GatewayUnderTest: g, t: t, order: id})
		})
	}
	// classified fails the test on any error that is not one of the capability's
	// two error classes: an unclassified error would surface as a defect.
	classified := func(t *testing.T, op string, err error) error {
		t.Helper()
		if err != nil && !errors.Is(err, shell.ErrDeclined) && !errors.Is(err, shell.ErrTransient) {
			t.Fatalf("%s: unclassified error (must wrap ErrDeclined or ErrTransient): %v", op, err)
		}
		return err
	}
	charge := func(e env, key core.IdempotencyKey, amt core.Amount) error {
		e.t.Helper()
		return classified(e.t, "charge", e.Gateway.Charge(ctx, key, e.order, amt))
	}
	resolve := func(e env, key core.IdempotencyKey) shell.PaymentStatus {
		e.t.Helper()
		st, err := e.Gateway.Resolve(ctx, key)
		if classified(e.t, "resolve", err) != nil {
			e.t.Fatalf("resolve %s: %v", key, err)
		}
		return st
	}
	wantCharged := func(e env, n int) {
		e.t.Helper()
		if e.Charged != nil {
			if got := e.Charged(e.order); got != n {
				e.t.Fatalf("money moved %d times for %s, want %d", got, e.order, n)
			}
		}
	}
	wantStatus := func(e env, got shell.PaymentStatus, want ...shell.PaymentStatus) {
		e.t.Helper()
		for _, w := range want {
			if got == w {
				return
			}
		}
		e.t.Fatalf("status %d, want one of %v", got, want)
	}

	clause("a charge is reported by resolve", false, func(e env) {
		key := core.ChargeKey(e.order, 1)
		if err := charge(e, key, amount); err != nil {
			e.t.Fatalf("charge: %v", err)
		}
		wantStatus(e, resolve(e, key), shell.StatusCharged)
		wantCharged(e, 1)
	})

	clause("charge is idempotent per key", false, func(e env) {
		key := core.ChargeKey(e.order, 1)
		for i := 0; i < 3; i++ {
			if err := charge(e, key, amount); err != nil {
				e.t.Fatalf("charge #%d: %v", i+1, err)
			}
		}
		wantCharged(e, 1)
	})

	clause("a decline is a domain outcome and is stable", false, func(e env) {
		key := core.ChargeKey(e.order, 1)
		for i := 0; i < 2; i++ {
			if err := charge(e, key, e.DeclineAmount); !errors.Is(err, shell.ErrDeclined) {
				e.t.Fatalf("charge #%d: want ErrDeclined, got %v", i+1, err)
			}
		}
		wantStatus(e, resolve(e, key), shell.StatusDeclined)
		wantCharged(e, 0)
	})

	clause("resolve fences a key it has never seen", false, func(e env) {
		key := core.ChargeKey(e.order, 1)
		wantStatus(e, resolve(e, key), shell.StatusNotFound)
		if err := charge(e, key, amount); !errors.Is(err, shell.ErrDeclined) {
			e.t.Fatalf("a charge after the fence must be declined, got %v", err)
		}
		wantStatus(e, resolve(e, key), shell.StatusNotFound, shell.StatusDeclined)
		wantCharged(e, 0)
	})

	clause("keys are independent", false, func(e env) {
		k1, k2 := core.ChargeKey(e.order, 1), core.ChargeKey(e.order, 2)
		if err := charge(e, k1, amount); err != nil {
			e.t.Fatalf("charge k1: %v", err)
		}
		wantStatus(e, resolve(e, k2), shell.StatusNotFound)
		wantStatus(e, resolve(e, k1), shell.StatusCharged)
		wantCharged(e, 1)
	})

	clause("an unreachable charge has no effect and can be retried", true, func(e env) {
		key := core.ChargeKey(e.order, 1)
		e.Inject("charge", Unreachable)
		if err := charge(e, key, amount); !errors.Is(err, shell.ErrTransient) {
			e.t.Fatalf("want ErrTransient, got %v", err)
		}
		wantCharged(e, 0)
		if err := charge(e, key, amount); err != nil {
			e.t.Fatalf("retry: %v", err)
		}
		wantCharged(e, 1)
	})

	clause("a lost response is not a failure: the retry does not charge twice", true, func(e env) {
		key := core.ChargeKey(e.order, 1)
		e.Inject("charge", LostResponse)
		// A client may retry an idempotent request on its own (Go's http.Transport
		// does for requests with an Idempotency-Key), so success is also correct.
		if err := charge(e, key, amount); err != nil && !errors.Is(err, shell.ErrTransient) {
			e.t.Fatalf("want nil or ErrTransient, got %v", err)
		}
		if err := charge(e, key, amount); err != nil {
			e.t.Fatalf("retry: %v", err)
		}
		wantCharged(e, 1)
	})

	clause("resolve after a lost response finds the charge", true, func(e env) {
		key := core.ChargeKey(e.order, 1)
		e.Inject("charge", LostResponse)
		_ = charge(e, key, amount)
		wantStatus(e, resolve(e, key), shell.StatusCharged)
		wantCharged(e, 1)
	})

	clause("an unreachable resolve does not fence the key", true, func(e env) {
		key := core.ChargeKey(e.order, 1)
		e.Inject("resolve", Unreachable)
		if _, err := e.Gateway.Resolve(ctx, key); !errors.Is(classified(e.t, "resolve", err), shell.ErrTransient) {
			e.t.Fatalf("want ErrTransient, got %v", err)
		}
		if err := charge(e, key, amount); err != nil {
			e.t.Fatalf("the key must still be usable: %v", err)
		}
		wantCharged(e, 1)
	})
}

func runID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "ct-" + hex.EncodeToString(b)
}
