package shell

import (
	"context"
	"errors"
	"fmt"
	"time"

	"example.com/functional-effect/internal/core"
)

// ErrRetryLater asks the worker to put the command back in the outbox and try
// again later. Only returned for idempotent commands.
var ErrRetryLater = errors.New("retry later")

// retryTransient retries f while it fails with ErrTransient, with exponential
// backoff. Callers use it only for commands that carry an idempotency key.
func retryTransient(d Deps, attempts int, base time.Duration, f func() error) error {
	var err error
	for i := 0; i < attempts; i++ {
		if err = f(); err == nil || !errors.Is(err, ErrTransient) {
			return err
		}
		if i < attempts-1 && d.Sleep != nil {
			d.Sleep(base << i)
		}
	}
	return err
}

// Interpret performs one command and returns the Input it produces for the
// core (nil if none). Each command has an explicit failure strategy:
//
//	ChargeCard      domain outcome (declined → PaymentFailed); transient → retry with
//	                the same key, then escape hatch: rely on the PaymentTimedOut timer
//	ResolvePayment  fenced status check (voids unseen keys); transient → retry, then
//	                escape hatch: the next timer resolves again
//	CreateShipment  transient → retry, then ErrRetryLater (idempotent: safe to redo)
//	NotifyCustomer  escape hatch: best effort, log and drop
//	ScheduleInput   the timer fired: its Input goes to the core
//
// Any other error is a defect and is returned as is.
func Interpret(ctx context.Context, d Deps, cmd core.Command) (core.Input, error) {
	switch c := cmd.(type) {
	case core.ChargeCard:
		err := retryTransient(d, 3, 100*time.Millisecond, func() error {
			return d.Payments.Charge(ctx, c.Key, c.OrderID, c.Amount)
		})
		switch {
		case err == nil:
			return core.PaymentSucceeded{OrderID: c.OrderID, Attempt: c.Attempt}, nil
		case errors.Is(err, ErrDeclined):
			return core.PaymentFailed{OrderID: c.OrderID, Attempt: c.Attempt, Reason: err.Error()}, nil
		case errors.Is(err, ErrTransient):
			// Outcome unknown: the charge may have gone through. Never guess; the
			// PaymentTimedOut timer moves the order to Reconciling.
			d.logf("charge %s: outcome unknown after retries, waiting for reconciliation", c.Key)
			return nil, nil
		default:
			return nil, fmt.Errorf("charge %s: %w", c.Key, err)
		}

	case core.ResolvePayment:
		var status PaymentStatus
		err := retryTransient(d, 3, 100*time.Millisecond, func() error {
			var e error
			status, e = d.Payments.Resolve(ctx, c.Key)
			return e
		})
		if errors.Is(err, ErrTransient) {
			d.logf("query %s: gateway unavailable, next timer re-queries", c.Key)
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("query %s: %w", c.Key, err)
		}
		switch status {
		case StatusCharged:
			return core.PaymentSucceeded{OrderID: c.OrderID, Attempt: c.Attempt}, nil
		case StatusDeclined:
			return core.PaymentFailed{OrderID: c.OrderID, Attempt: c.Attempt, Reason: "declined"}, nil
		case StatusNotFound:
			return core.PaymentFailed{OrderID: c.OrderID, Attempt: c.Attempt, Reason: "not charged (voided)"}, nil
		case StatusPending:
			return nil, nil // the next timer re-queries
		}
		return nil, fmt.Errorf("query %s: unknown status %d", c.Key, status)

	case core.CreateShipment:
		var tn string
		err := retryTransient(d, 3, 100*time.Millisecond, func() error {
			var e error
			tn, e = d.Shipping.Create(ctx, c.Key, c.OrderID)
			return e
		})
		if errors.Is(err, ErrTransient) {
			return nil, ErrRetryLater
		}
		if err != nil {
			return nil, fmt.Errorf("shipment %s: %w", c.Key, err)
		}
		return core.ShipmentCreated{OrderID: c.OrderID, TrackingNo: tn}, nil

	case core.NotifyCustomer:
		if err := d.Notifier.Send(ctx, c.OrderID, c.Message); err != nil {
			d.logf("notify %s: dropped (%v)", c.OrderID, err)
		}
		return nil, nil

	case core.ScheduleInput:
		return c.Input, nil
	}
	return nil, fmt.Errorf("unknown command %T", cmd)
}
