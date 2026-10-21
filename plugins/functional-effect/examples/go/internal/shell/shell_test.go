package shell

// Tests for the shell: delivery, crashes, concurrency and time. The core's
// decisions are tested in internal/core; here we test that the shell keeps its
// promises (atomic commit, idempotent effects, at-least-once delivery).

import (
	"context"
	"fmt"
	"math/rand"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/functional-effect/internal/core"
)

var t0 = time.Date(2026, 1, 1, 9, 0, 0, 0, time.UTC)

type harness struct {
	store    *MemStore
	app      *App
	worker   *Worker
	gateway  *FakeGateway
	shipping *FakeShipping
	notifier *FakeNotifier
	now      time.Time
}

func newHarness(gw *FakeGateway, sh *FakeShipping) *harness {
	h := &harness{store: NewMemStore(30 * time.Second), gateway: gw, shipping: sh, notifier: &FakeNotifier{}, now: t0}
	h.app = &App{Store: h.store, Now: func() time.Time { return h.now }}
	h.worker = &Worker{App: h.app, Deps: Deps{Payments: gw, Shipping: sh, Notifier: h.notifier}}
	return h
}

// drain runs the worker, jumping the clock to the next due item, until the outbox is empty.
func (h *harness) drain(t *testing.T, maxSteps int) {
	t.Helper()
	for i := 0; i < maxSteps; i++ {
		if _, err := h.worker.RunOnce(context.Background(), h.now); err != nil {
			t.Fatal(err)
		}
		next, ok := h.store.NextDue()
		if !ok {
			return
		}
		if next.After(h.now) {
			h.now = next
		}
	}
}

func (h *harness) state(t *testing.T, id core.OrderID) (core.State, Version) {
	t.Helper()
	s, v, err := h.store.Load(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	return s, v
}

func (h *harness) assertReplay(t *testing.T, id core.OrderID) {
	t.Helper()
	stored, version := h.state(t, id)
	replayed, err := h.app.Replay(context.Background(), id)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored, replayed) {
		t.Fatalf("replay mismatch: stored %s, replayed %s", core.Describe(stored), core.Describe(replayed))
	}
	events, _ := h.store.Events(context.Background(), id)
	if int(version) != len(events) {
		t.Fatalf("version %d but %d events", version, len(events))
	}
}

func mustOrder(s string) core.OrderID { o, _ := core.NewOrderID(s); return o }
func mustAmount(n int64) core.Amount  { a, _ := core.NewAmount(n); return a }

var ord = mustOrder("ord-1")

func submit(t *testing.T, h *harness, eventID string) {
	t.Helper()
	if _, err := h.app.Handle(context.Background(), eventID, core.Submit{OrderID: ord, Amount: mustAmount(4200)}); err != nil {
		t.Fatal(err)
	}
}

func TestHappyPath(t *testing.T) {
	h := newHarness(NewFakeGateway(nil), NewFakeShipping(nil))
	submit(t, h, "evt-1")
	h.drain(t, 50)
	s, _ := h.state(t, ord)
	if _, ok := s.(core.Shipped); !ok {
		t.Fatalf("want Shipped, got %s", core.Describe(s))
	}
	if h.gateway.Charged(ord) != 1 || h.shipping.Created(ord) != 1 {
		t.Fatalf("charged %d, shipped %d", h.gateway.Charged(ord), h.shipping.Created(ord))
	}
	h.assertReplay(t, ord)
}

func TestDuplicateDeliveryIsProcessedOnce(t *testing.T) {
	h := newHarness(NewFakeGateway(nil), NewFakeShipping(nil))
	submit(t, h, "evt-1")
	submit(t, h, "evt-1") // the same delivery, twice
	if _, v := h.state(t, ord); v != 1 {
		t.Fatalf("version %d, want 1", v)
	}
	h.drain(t, 50)
	if h.gateway.Charged(ord) != 1 {
		t.Fatalf("charged %d times", h.gateway.Charged(ord))
	}
}

func TestCrashAfterChargeDoesNotChargeTwice(t *testing.T) {
	h := newHarness(NewFakeGateway(nil), NewFakeShipping(nil))
	crashed := false
	h.worker.Crash = func(it OutboxItem, at CrashPoint) bool {
		if _, ok := it.Command.(core.ChargeCard); ok && at == AfterEffect && !crashed {
			crashed = true // the card was charged, the result was never recorded
			return true
		}
		return false
	}
	submit(t, h, "evt-1")
	h.drain(t, 50) // the lease expires, the item is redelivered with the same key
	if !crashed {
		t.Fatal("crash was not simulated")
	}
	s, _ := h.state(t, ord)
	if _, ok := s.(core.Shipped); !ok {
		t.Fatalf("want Shipped, got %s", core.Describe(s))
	}
	if h.gateway.Charged(ord) != 1 {
		t.Fatalf("charged %d times after a crash", h.gateway.Charged(ord))
	}
	h.assertReplay(t, ord)
}

func TestLostResponsesAreReconciledNotRetriedBlindly(t *testing.T) {
	// The first charge call charged but its response was lost; the retries (same
	// key) never reach the gateway. The outcome is unknown, so the shell must not
	// guess: it waits for the timer and resolves.
	gw := NewFakeGateway(func(op string, _ core.IdempotencyKey, n int) Behavior {
		switch {
		case op == "charge" && n == 1:
			return LostResponse
		case op == "charge":
			return Transient
		}
		return Normal
	})
	h := newHarness(gw, NewFakeShipping(nil))
	submit(t, h, "evt-1")
	if _, err := h.worker.RunOnce(context.Background(), h.now); err != nil {
		t.Fatal(err)
	}
	if s, _ := h.state(t, ord); s != (core.AwaitingPayment{OrderID: ord, Amount: mustAmount(4200), Attempt: 1}) {
		t.Fatalf("outcome unknown should keep AwaitingPayment, got %s", core.Describe(s))
	}
	h.now = h.now.Add(core.PaymentTimeout) // the timer fires
	h.drain(t, 50)
	s, _ := h.state(t, ord)
	if _, ok := s.(core.Shipped); !ok {
		t.Fatalf("want Shipped after reconciliation, got %s", core.Describe(s))
	}
	if gw.Charged(ord) != 1 {
		t.Fatalf("charged %d times", gw.Charged(ord))
	}
	events, _ := h.store.Events(context.Background(), ord)
	sawTimeout := false
	for _, e := range events {
		if _, ok := e.(core.PaymentTimedOut); ok {
			sawTimeout = true
		}
	}
	if !sawTimeout {
		t.Fatal("expected the PaymentTimedOut timer in the event log")
	}
}

func TestResolveFencesALateCharge(t *testing.T) {
	// The charge never reaches the gateway (3 transient failures), then the worker
	// crashes. Before the lease expires... the timer is due first in this setup:
	// Resolve voids the key, so the redelivered charge is declined, not executed.
	gw := NewFakeGateway(func(op string, _ core.IdempotencyKey, n int) Behavior {
		if op == "charge" && n <= 3 {
			return Transient
		}
		return Normal
	})
	h := newHarness(gw, NewFakeShipping(nil))
	h.store.lease = 2 * core.PaymentTimeout // a very long stall
	h.worker.Crash = func(it OutboxItem, at CrashPoint) bool {
		_, ok := it.Command.(core.ChargeCard)
		return ok && at == AfterEffect && gw.calls["charge|"+string(core.ChargeKey(ord, 1))] == 3
	}
	submit(t, h, "evt-1")
	h.drain(t, 50)
	s, _ := h.state(t, ord)
	if f, ok := s.(core.Failed); !ok || f.Reason != "not charged (voided)" {
		t.Fatalf("want Failed(not charged), got %s", core.Describe(s))
	}
	if gw.Charged(ord) != 0 {
		t.Fatalf("a fenced key was charged %d times", gw.Charged(ord))
	}
}

func TestEscapeHatchesAndRetryLater(t *testing.T) {
	sh := NewFakeShipping(func(n int) Behavior {
		if n <= 4 { // first worker attempt (3 tries) and one more call fail
			return Transient
		}
		return Normal
	})
	h := newHarness(NewFakeGateway(nil), sh)
	h.notifier.Fail = true // notifications are best effort
	submit(t, h, "evt-1")
	h.drain(t, 50)
	s, _ := h.state(t, ord)
	if _, ok := s.(core.Shipped); !ok {
		t.Fatalf("want Shipped despite shipping outage and notifier down, got %s", core.Describe(s))
	}
	if sh.Created(ord) != 1 {
		t.Fatalf("created %d shipments", sh.Created(ord))
	}
}

func TestConcurrentDeliveriesEmitEachCommandOnce(t *testing.T) {
	h := newHarness(NewFakeGateway(nil), NewFakeShipping(nil))
	submit(t, h, "evt-1")
	// Every delivery loads before any of them commits: the worst-case interleaving.
	const deliveries = 20
	racing := &App{Store: newBarrierStore(h.store, deliveries), Now: h.app.Now}
	var wg sync.WaitGroup
	errs := make(chan error, deliveries)
	for i := 0; i < deliveries; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// The same webhook delivered many times, some with the same delivery ID.
			_, err := racing.Handle(context.Background(), fmt.Sprintf("webhook-%d", i%5), core.PaymentSucceeded{OrderID: ord, Attempt: 1})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	s, v := h.state(t, ord)
	if _, ok := s.(core.Paid); !ok {
		t.Fatalf("want Paid, got %s", core.Describe(s))
	}
	if v != 6 { // Submit + 5 distinct delivery IDs; duplicates of an ID are dropped
		t.Fatalf("version %d, want 6", v)
	}
	// Without the version check, stale commits would each emit a shipment (lost update).
	shipments := 0
	for _, it := range h.store.Peek() {
		if _, ok := it.Command.(core.CreateShipment); ok {
			shipments++
		}
	}
	if shipments != 1 {
		t.Fatalf("CreateShipment emitted %d times, want 1", shipments)
	}
	h.assertReplay(t, ord)
	h.drain(t, 50)
	if h.shipping.Created(ord) != 1 {
		t.Fatalf("created %d shipments", h.shipping.Created(ord))
	}
}

// barrierStore makes the first n Loads wait for each other, so every caller
// holds the same stale version when it commits.
type barrierStore struct {
	Store
	n    int32
	seen atomic.Int32
	wg   sync.WaitGroup
}

func newBarrierStore(s Store, n int) *barrierStore {
	b := &barrierStore{Store: s, n: int32(n)}
	b.wg.Add(n)
	return b
}

func (b *barrierStore) Load(ctx context.Context, id core.OrderID) (core.State, Version, error) {
	s, v, err := b.Store.Load(ctx, id)
	if b.seen.Add(1) <= b.n {
		b.wg.Done()
		b.wg.Wait()
	}
	return s, v, err
}

// TestChaos: random gateway failures, lost responses, declines, crashes at both
// crash points, duplicate deliveries and user retries. Whatever happens, money
// moves at most once, and only for orders that end Shipped.
func TestChaos(t *testing.T) {
	for seed := int64(1); seed <= 400; seed++ {
		r := rand.New(rand.NewSource(seed))
		roll := func(p float64) bool { return r.Float64() < p }
		gw := NewFakeGateway(func(op string, _ core.IdempotencyKey, _ int) Behavior {
			switch {
			case roll(0.3):
				return Transient
			case op == "charge" && roll(0.2):
				return LostResponse
			case op == "charge" && roll(0.15):
				return Decline
			}
			return Normal
		})
		sh := NewFakeShipping(func(int) Behavior {
			if roll(0.3) {
				return Transient
			}
			return Normal
		})
		h := newHarness(gw, sh)
		h.notifier.Fail = roll(0.5)
		h.worker.Crash = func(OutboxItem, CrashPoint) bool { return roll(0.15) }

		submit(t, h, "evt-submit")
		if roll(0.5) {
			submit(t, h, "evt-submit") // duplicate delivery
		}
		retries := 0
		for step := 0; step < 200; step++ {
			h.drain(t, 100)
			s, _ := h.state(t, ord)
			f, failed := s.(core.Failed)
			if !failed || f.Attempt >= core.MaxPaymentAttempts || retries > 5 || !roll(0.7) {
				break
			}
			retries++
			if _, err := h.app.HandleFor(context.Background(), ord, fmt.Sprintf("evt-retry-%d", retries), core.Retry{}); err != nil {
				t.Fatal(err)
			}
		}

		s, _ := h.state(t, ord)
		charged := gw.Charged(ord)
		switch s.(type) {
		case core.Shipped:
			if charged != 1 || sh.Created(ord) != 1 {
				t.Fatalf("seed %d: Shipped with %d charges, %d shipments", seed, charged, sh.Created(ord))
			}
		case core.Failed:
			if charged != 0 {
				t.Fatalf("seed %d: Failed but charged %d times", seed, charged)
			}
		default:
			t.Fatalf("seed %d: unsettled final state %s (pending %d)", seed, core.Describe(s), h.store.Pending())
		}
		h.assertReplay(t, ord)
	}
}
