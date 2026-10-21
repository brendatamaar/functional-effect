package shell

import (
	"context"
	"errors"
	"fmt"
	"time"

	"example.com/functional-effect/internal/core"
)

// App applies inputs to orders: load → core.Step → commit, with optimistic
// concurrency. It performs no effects itself; commands go to the outbox and the
// Worker interprets them.
type App struct {
	Store Store
	Now   func() time.Time
}

const maxConflictRetries = 10

// Handle applies one input, identified by eventID for de-duplication. A
// duplicate delivery is a no-op that returns the current state.
func (a *App) Handle(ctx context.Context, eventID string, in core.Input) (core.State, error) {
	id, ok := orderOf(in)
	if !ok {
		return nil, fmt.Errorf("input %T has no order id", in)
	}
	return a.HandleFor(ctx, id, eventID, in)
}

// HandleFor is Handle for inputs that do not name their order (such as Retry).
func (a *App) HandleFor(ctx context.Context, id core.OrderID, eventID string, in core.Input) (core.State, error) {
	for i := 0; i < maxConflictRetries; i++ {
		state, version, err := a.Store.Load(ctx, id)
		if err != nil {
			return nil, err
		}
		next, cmds := core.Step(state, in)
		now := a.Now()
		outbox := make([]OutboxItem, len(cmds))
		for k, c := range cmds {
			due := now
			if s, ok := c.(core.ScheduleInput); ok {
				due = now.Add(s.After)
			}
			// Deterministic IDs: re-processing the same event yields the same items.
			outbox[k] = OutboxItem{ID: fmt.Sprintf("%s#%d", eventID, k), OrderID: id, Command: c, DueAt: due}
		}
		err = a.Store.Commit(ctx, Commit{OrderID: id, Expected: version, EventID: eventID, Input: in, State: next, Outbox: outbox})
		switch {
		case err == nil:
			return next, nil
		case errors.Is(err, ErrDuplicate):
			s, _, err := a.Store.Load(ctx, id)
			return s, err
		case errors.Is(err, ErrConflict):
			continue // someone else committed first: reload and re-run Step
		default:
			return nil, err
		}
	}
	return nil, fmt.Errorf("order %s: too many concurrent updates", id)
}

// Replay rebuilds an order's state from its event log with the pure core.
func (a *App) Replay(ctx context.Context, id core.OrderID) (core.State, error) {
	events, err := a.Store.Events(ctx, id)
	if err != nil {
		return nil, err
	}
	s, _ := core.Run(core.Initial, events)
	return s, nil
}

func orderOf(in core.Input) (core.OrderID, bool) {
	switch e := in.(type) {
	case core.Submit:
		return e.OrderID, true
	case core.PaymentSucceeded:
		return e.OrderID, true
	case core.PaymentFailed:
		return e.OrderID, true
	case core.PaymentTimedOut:
		return e.OrderID, true
	case core.ShipmentCreated:
		return e.OrderID, true
	case core.Retry:
		return core.OrderID{}, false
	}
	return core.OrderID{}, false
}
