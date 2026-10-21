package contract

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync"
	"testing"
	"time"

	"example.com/functional-effect/internal/core"
	"example.com/functional-effect/internal/shell"
)

// StoreUnderTest is one implementation of shell.Store, empty when created.
type StoreUnderTest struct {
	Store shell.Store
	// Lease is how long ClaimDue leases an item.
	Lease time.Duration
}

var t0 = time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)

// Store runs the Store contract: the transactional semantics the App and the
// Worker rely on (see skills/model/references/outbox.md).
func Store(t *testing.T, newStore func(t *testing.T) StoreUnderTest) {
	ctx := context.Background()
	order := func(s string) core.OrderID { id, _ := core.NewOrderID(s); return id }
	amount, _ := core.NewAmount(4200)
	o1, o2 := order("ord-1"), order("ord-2")
	submit := core.Submit{OrderID: o1, Amount: amount}
	awaiting := core.AwaitingPayment{OrderID: o1, Amount: amount, Attempt: 1}
	paid := core.Paid{OrderID: o1}

	clause := func(name string, f func(t *testing.T, s StoreUnderTest)) {
		t.Run(name, func(t *testing.T) { f(t, newStore(t)) })
	}
	item := func(id string, cmd core.Command, due time.Time) shell.OutboxItem {
		return shell.OutboxItem{ID: id, OrderID: o1, Command: cmd, DueAt: due}
	}
	cmd := core.NotifyCustomer{OrderID: o1, Message: "hi"}
	commit := func(t *testing.T, s StoreUnderTest, c shell.Commit) error {
		t.Helper()
		err := s.Store.Commit(ctx, c)
		if err != nil && !errors.Is(err, shell.ErrConflict) && !errors.Is(err, shell.ErrDuplicate) {
			t.Fatalf("commit %s: unclassified error: %v", c.EventID, err)
		}
		return err
	}
	mustCommit := func(t *testing.T, s StoreUnderTest, c shell.Commit) {
		t.Helper()
		if err := commit(t, s, c); err != nil {
			t.Fatalf("commit %s: %v", c.EventID, err)
		}
	}
	load := func(t *testing.T, s StoreUnderTest, id core.OrderID) (core.State, shell.Version) {
		t.Helper()
		st, v, err := s.Store.Load(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		return st, v
	}
	claim := func(t *testing.T, s StoreUnderTest, now time.Time, limit int) []string {
		t.Helper()
		items, err := s.Store.ClaimDue(ctx, now, limit)
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]string, len(items))
		for i, it := range items {
			ids[i] = it.ID
		}
		return ids
	}
	wantIDs := func(t *testing.T, got []string, want ...string) {
		t.Helper()
		if len(got) == 0 && len(want) == 0 {
			return
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("claimed %v, want %v", got, want)
		}
	}
	first := shell.Commit{OrderID: o1, Expected: 0, EventID: "evt-1", Input: submit, State: awaiting}

	clause("an unknown order loads as the initial state at version 0", func(t *testing.T, s StoreUnderTest) {
		st, v := load(t, s, o1)
		if !reflect.DeepEqual(st, core.Initial) || v != 0 {
			t.Fatalf("got %#v at version %d", st, v)
		}
	})

	clause("a commit saves the state, bumps the version and appends the event", func(t *testing.T, s StoreUnderTest) {
		mustCommit(t, s, first)
		mustCommit(t, s, shell.Commit{OrderID: o1, Expected: 1, EventID: "evt-2", Input: core.PaymentSucceeded{OrderID: o1, Attempt: 1}, State: paid})
		st, v := load(t, s, o1)
		if !reflect.DeepEqual(st, paid) || v != 2 {
			t.Fatalf("got %#v at version %d", st, v)
		}
		events, _ := s.Store.Events(ctx, o1)
		if !reflect.DeepEqual(events, []core.Input{submit, core.PaymentSucceeded{OrderID: o1, Attempt: 1}}) {
			t.Fatalf("events %#v", events)
		}
	})

	clause("a stale version conflicts and leaves nothing behind", func(t *testing.T, s StoreUnderTest) {
		mustCommit(t, s, first)
		stale := shell.Commit{OrderID: o1, Expected: 0, EventID: "evt-2", Input: submit, State: paid, Outbox: []shell.OutboxItem{item("evt-2#0", cmd, t0)}}
		if err := commit(t, s, stale); !errors.Is(err, shell.ErrConflict) {
			t.Fatalf("want ErrConflict, got %v", err)
		}
		if st, v := load(t, s, o1); !reflect.DeepEqual(st, awaiting) || v != 1 {
			t.Fatalf("conflict changed the order: %#v at version %d", st, v)
		}
		wantIDs(t, claim(t, s, t0, 10))
		// The conflicting commit must not have recorded its event ID either.
		stale.Expected = 1
		mustCommit(t, s, stale)
	})

	clause("a version ahead of the stored one conflicts", func(t *testing.T, s StoreUnderTest) {
		ahead := first
		ahead.Expected = 1
		if err := commit(t, s, ahead); !errors.Is(err, shell.ErrConflict) {
			t.Fatalf("new order with expected version 1: want ErrConflict, got %v", err)
		}
		if _, v := load(t, s, o1); v != 0 {
			t.Fatalf("version %d, want 0", v)
		}
	})

	clause("a duplicate event ID is rejected and leaves nothing behind", func(t *testing.T, s StoreUnderTest) {
		mustCommit(t, s, first)
		dup := shell.Commit{OrderID: o1, Expected: 1, EventID: "evt-1", Input: submit, State: paid, Outbox: []shell.OutboxItem{item("dup#0", cmd, t0)}}
		if err := commit(t, s, dup); !errors.Is(err, shell.ErrDuplicate) {
			t.Fatalf("want ErrDuplicate, got %v", err)
		}
		if st, v := load(t, s, o1); !reflect.DeepEqual(st, awaiting) || v != 1 {
			t.Fatalf("duplicate changed the order: %#v at version %d", st, v)
		}
		wantIDs(t, claim(t, s, t0, 10))
	})

	clause("orders are independent", func(t *testing.T, s StoreUnderTest) {
		mustCommit(t, s, first)
		mustCommit(t, s, shell.Commit{OrderID: o2, Expected: 0, EventID: "evt-2", Input: core.Submit{OrderID: o2, Amount: amount}, State: core.Draft{}})
		if _, v := load(t, s, o1); v != 1 {
			t.Fatalf("ord-1 version %d", v)
		}
	})

	clause("concurrent commits at the same version: exactly one wins", func(t *testing.T, s StoreUnderTest) {
		const n = 8
		var wg sync.WaitGroup
		errs := make([]error, n)
		for i := 0; i < n; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				c := first
				c.EventID = fmt.Sprintf("evt-%d", i)
				errs[i] = s.Store.Commit(ctx, c)
			}(i)
		}
		wg.Wait()
		wins := 0
		for _, err := range errs {
			switch {
			case err == nil:
				wins++
			case !errors.Is(err, shell.ErrConflict):
				t.Fatalf("unexpected error: %v", err)
			}
		}
		if _, v := load(t, s, o1); wins != 1 || v != 1 {
			t.Fatalf("%d commits won, version %d", wins, v)
		}
	})

	clause("outbox items are claimed when due, earliest first, up to the limit", func(t *testing.T, s StoreUnderTest) {
		c := first
		c.Outbox = []shell.OutboxItem{
			item("evt-1#0", cmd, t0.Add(time.Minute)),
			item("evt-1#1", cmd, t0),
			item("evt-1#2", cmd, t0),
			item("evt-1#3", cmd, t0.Add(10*time.Minute)),
		}
		mustCommit(t, s, c)
		wantIDs(t, claim(t, s, t0.Add(-time.Second), 10))
		wantIDs(t, claim(t, s, t0.Add(time.Minute), 2), "evt-1#1", "evt-1#2")
		wantIDs(t, claim(t, s, t0.Add(time.Minute), 10), "evt-1#0")
	})

	clause("a claimed item is leased, and due again when the lease expires", func(t *testing.T, s StoreUnderTest) {
		c := first
		c.Outbox = []shell.OutboxItem{item("evt-1#0", cmd, t0)}
		mustCommit(t, s, c)
		wantIDs(t, claim(t, s, t0, 10), "evt-1#0")
		wantIDs(t, claim(t, s, t0.Add(s.Lease-time.Millisecond), 10))
		wantIDs(t, claim(t, s, t0.Add(s.Lease), 10), "evt-1#0")
	})

	clause("a completed item is never claimed again", func(t *testing.T, s StoreUnderTest) {
		c := first
		c.Outbox = []shell.OutboxItem{item("evt-1#0", cmd, t0)}
		mustCommit(t, s, c)
		claim(t, s, t0, 10)
		if err := s.Store.Complete(ctx, "evt-1#0"); err != nil {
			t.Fatal(err)
		}
		wantIDs(t, claim(t, s, t0.Add(time.Hour), 10))
	})

	clause("a released item is due again at its retry time", func(t *testing.T, s StoreUnderTest) {
		c := first
		c.Outbox = []shell.OutboxItem{item("evt-1#0", cmd, t0)}
		mustCommit(t, s, c)
		claim(t, s, t0, 10)
		if err := s.Store.Release(ctx, "evt-1#0", t0.Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		wantIDs(t, claim(t, s, t0.Add(time.Minute-time.Millisecond), 10))
		wantIDs(t, claim(t, s, t0.Add(time.Minute), 10), "evt-1#0")
	})

	clause("states, inputs and commands come back exactly as committed", func(t *testing.T, s StoreUnderTest) {
		// A real store serializes these values; every variant must survive.
		key := core.ChargeKey(o1, 2)
		commands := []core.Command{
			core.ChargeCard{OrderID: o1, Amount: amount, Attempt: 2, Key: key},
			core.ResolvePayment{OrderID: o1, Attempt: 2, Key: key},
			core.CreateShipment{OrderID: o1, Key: core.ShipmentKey(o1)},
			core.NotifyCustomer{OrderID: o1, Message: "Shipped: \"TRK\" ✓"},
			core.ScheduleInput{After: core.PaymentTimeout, Input: core.PaymentTimedOut{OrderID: o1, Attempt: 2}},
		}
		states := []core.State{
			core.Draft{}, awaiting, core.Reconciling{OrderID: o1, Amount: amount, Attempt: 2}, paid,
			core.Shipped{OrderID: o1, TrackingNo: "TRK-1"}, core.Failed{OrderID: o1, Amount: amount, Attempt: 3, Reason: "declined"},
		}
		inputs := []core.Input{
			submit, core.PaymentSucceeded{OrderID: o1, Attempt: 2}, core.PaymentFailed{OrderID: o1, Attempt: 1, Reason: "no"},
			core.PaymentTimedOut{OrderID: o1, Attempt: 3}, core.ShipmentCreated{OrderID: o1, TrackingNo: "TRK-1"}, core.Retry{},
		}
		var outbox []shell.OutboxItem
		for i, c := range commands {
			outbox = append(outbox, item(fmt.Sprintf("evt-0#%d", i), c, t0))
		}
		for i, st := range states {
			c := shell.Commit{OrderID: o1, Expected: shell.Version(i), EventID: fmt.Sprintf("evt-%d", i), Input: inputs[i], State: st}
			if i == 0 {
				c.Outbox = outbox
			}
			mustCommit(t, s, c)
			if got, _ := load(t, s, o1); !reflect.DeepEqual(got, st) {
				t.Fatalf("state %#v came back as %#v", st, got)
			}
		}
		events, _ := s.Store.Events(ctx, o1)
		if !reflect.DeepEqual(events, inputs) {
			t.Fatalf("inputs came back as %#v", events)
		}
		items, _ := s.Store.ClaimDue(ctx, t0, 10)
		if len(items) != len(outbox) {
			t.Fatalf("claimed %d items, want %d", len(items), len(outbox))
		}
		for i, it := range items {
			if !reflect.DeepEqual(it.Command, outbox[i].Command) || it.OrderID != o1 || !it.DueAt.Equal(t0) {
				t.Fatalf("item %s came back as %#v", outbox[i].ID, it)
			}
		}
	})
}
