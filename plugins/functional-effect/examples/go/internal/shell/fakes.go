package shell

import (
	"context"
	"fmt"
	"sync"

	"example.com/functional-effect/internal/core"
)

// Fakes for the demo and tests. Each one behaves like a well-behaved real
// service (idempotent per key) and can be scripted to misbehave.

// Behavior scripts one call to a fake.
type Behavior int

const (
	Normal       Behavior = iota
	Decline               // the gateway declines the charge (domain outcome)
	Transient             // the call fails before reaching the service
	LostResponse          // the service did the work, but the response was lost
)

// FakeGateway is an idempotent payment gateway with Resolve fencing.
type FakeGateway struct {
	mu      sync.Mutex
	results map[core.IdempotencyKey]PaymentStatus
	charged map[core.OrderID]int
	calls   map[string]int
	// Script decides how call number n (1-based) for op ("charge"/"resolve") and key behaves.
	Script func(op string, key core.IdempotencyKey, n int) Behavior
	// DeclineAmount is always declined, like the magic amounts of a provider's sandbox.
	DeclineAmount core.Amount
}

func NewFakeGateway(script func(op string, key core.IdempotencyKey, n int) Behavior) *FakeGateway {
	return &FakeGateway{
		results: map[core.IdempotencyKey]PaymentStatus{},
		charged: map[core.OrderID]int{},
		calls:   map[string]int{},
		Script:  script,
	}
}

func (g *FakeGateway) behavior(op string, key core.IdempotencyKey) Behavior {
	g.calls[op+"|"+string(key)]++
	if g.Script == nil {
		return Normal
	}
	return g.Script(op, key, g.calls[op+"|"+string(key)])
}

func (g *FakeGateway) Charge(_ context.Context, key core.IdempotencyKey, id core.OrderID, amount core.Amount) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	b := g.behavior("charge", key)
	if b == Transient {
		return fmt.Errorf("gateway timeout: %w", ErrTransient)
	}
	if prev, seen := g.results[key]; seen { // idempotent replay of the first result
		if prev == StatusCharged {
			return nil
		}
		return fmt.Errorf("key %s: %w", key, ErrDeclined)
	}
	if amount == g.DeclineAmount {
		b = Decline
	}
	switch b {
	case Decline:
		g.results[key] = StatusDeclined
		return fmt.Errorf("insufficient funds: %w", ErrDeclined)
	case LostResponse:
		g.results[key] = StatusCharged
		g.charged[id]++
		return fmt.Errorf("response lost: %w", ErrTransient)
	case Normal, Transient:
	}
	g.results[key] = StatusCharged
	g.charged[id]++
	return nil
}

func (g *FakeGateway) Resolve(_ context.Context, key core.IdempotencyKey) (PaymentStatus, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.behavior("resolve", key) == Transient {
		return 0, fmt.Errorf("gateway timeout: %w", ErrTransient)
	}
	if prev, seen := g.results[key]; seen {
		return prev, nil
	}
	g.results[key] = StatusDeclined // fence: a late charge with this key is declined
	return StatusNotFound, nil
}

// Charged reports how many times money actually moved for an order.
func (g *FakeGateway) Charged(id core.OrderID) int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.charged[id]
}

// FakeShipping creates one shipment per key.
type FakeShipping struct {
	mu        sync.Mutex
	shipments map[core.IdempotencyKey]string
	created   map[core.OrderID]int
	calls     int
	Script    func(n int) Behavior
}

func NewFakeShipping(script func(n int) Behavior) *FakeShipping {
	return &FakeShipping{shipments: map[core.IdempotencyKey]string{}, created: map[core.OrderID]int{}, Script: script}
}

func (s *FakeShipping) Create(_ context.Context, key core.IdempotencyKey, id core.OrderID) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls++
	if s.Script != nil && s.Script(s.calls) == Transient {
		return "", fmt.Errorf("shipping API 503: %w", ErrTransient)
	}
	if tn, ok := s.shipments[key]; ok {
		return tn, nil
	}
	tn := "TRK-" + id.String()
	s.shipments[key] = tn
	s.created[id]++
	return tn, nil
}

func (s *FakeShipping) Created(id core.OrderID) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.created[id]
}

// FakeNotifier records messages and can be told to fail.
type FakeNotifier struct {
	mu   sync.Mutex
	Sent []string
	Fail bool
}

func (n *FakeNotifier) Send(_ context.Context, id core.OrderID, msg string) error {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.Fail {
		return fmt.Errorf("sms provider down")
	}
	n.Sent = append(n.Sent, id.String()+": "+msg)
	return nil
}
