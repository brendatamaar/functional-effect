package shell

import (
	"context"
	"errors"
	"time"
)

// Worker drains the outbox: claim due items, interpret each command, feed the
// resulting Input back through App.Handle, then mark the item complete.
//
// Delivery is at-least-once: if the worker crashes between interpreting and
// completing, the lease expires and the item runs again. That is safe because
// commands carry idempotency keys and the result's event ID is derived from the
// item ID, so the inbox drops the duplicate result.
type Worker struct {
	App     *App
	Deps    Deps
	Batch   int
	Backoff time.Duration
	// Crash simulates the process dying at a point (tests only).
	Crash func(OutboxItem, CrashPoint) bool
}

// CrashPoint is where a simulated crash happens.
type CrashPoint int

const (
	// AfterEffect: the effect happened, its result was not recorded yet.
	AfterEffect CrashPoint = iota
	// AfterResult: the result was recorded, the item was not completed yet.
	AfterResult
)

func (w *Worker) crash(it OutboxItem, at CrashPoint) bool {
	return w.Crash != nil && w.Crash(it, at)
}

// RunOnce processes the items due at now and reports how many it handled.
func (w *Worker) RunOnce(ctx context.Context, now time.Time) (int, error) {
	batch := w.Batch
	if batch == 0 {
		batch = 100
	}
	items, err := w.App.Store.ClaimDue(ctx, now, batch)
	if err != nil {
		return 0, err
	}
	for _, it := range items {
		in, err := Interpret(ctx, w.Deps, it.Command)
		if errors.Is(err, ErrRetryLater) {
			if err := w.App.Store.Release(ctx, it.ID, now.Add(w.backoff())); err != nil {
				return 0, err
			}
			continue
		}
		if err != nil {
			return 0, err // a defect: leave the item leased, surface it loudly
		}
		if w.crash(it, AfterEffect) {
			continue
		}
		if in != nil {
			if _, err := w.App.HandleFor(ctx, it.OrderID, it.ID+":result", in); err != nil {
				return 0, err
			}
		}
		if w.crash(it, AfterResult) {
			continue
		}
		if err := w.App.Store.Complete(ctx, it.ID); err != nil {
			return 0, err
		}
	}
	return len(items), nil
}

func (w *Worker) backoff() time.Duration {
	if w.Backoff == 0 {
		return 30 * time.Second
	}
	return w.Backoff
}
