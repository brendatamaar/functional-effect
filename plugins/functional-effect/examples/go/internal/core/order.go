// Package core is the functional core of an order checkout.
//
// Model Functional Effect:  (state₂, commands) = Step(state₁, input)
//
// Rules this package follows (and the plugin's checker enforces):
//   - No IO, no clock reads, no randomness, no goroutines, no printing.
//   - State, Input and Command are closed sum types (sealed interfaces).
//   - Step returns new values; it never performs the commands it emits.
//   - Time enters as data: timers are ScheduleInput commands, and the shell
//     feeds the scheduled Input back when it is due.
package core

import (
	"errors"
	"strconv"
	"time"
)

// ---------------------------------------------------------------------------
// Boundary-verified values. Unexported fields mean the only way to get one
// from outside this package is through the smart constructor, so an invalid
// Amount or OrderID cannot exist past the boundary.
// ---------------------------------------------------------------------------

// Amount is a positive amount in the smallest currency unit.
type Amount struct{ v int64 }

// NewAmount parses n into an Amount. It is pure: it decides, it does not do.
func NewAmount(n int64) (Amount, error) {
	if n <= 0 {
		return Amount{}, errors.New("amount must be positive")
	}
	return Amount{v: n}, nil
}

func (a Amount) Int64() int64 { return a.v }

// OrderID is a non-empty order identifier.
type OrderID struct{ v string }

func NewOrderID(s string) (OrderID, error) {
	if s == "" {
		return OrderID{}, errors.New("order id must not be empty")
	}
	return OrderID{v: s}, nil
}

func (o OrderID) String() string { return o.v }

// IdempotencyKey identifies one logical operation. The same key always means
// the same operation, so a retried or re-delivered command cannot charge twice.
type IdempotencyKey string

// ChargeKey is deterministic: replaying the same inputs yields the same keys.
func ChargeKey(id OrderID, attempt int) IdempotencyKey {
	return IdempotencyKey("charge:" + id.v + ":" + strconv.Itoa(attempt))
}

func ShipmentKey(id OrderID) IdempotencyKey { return IdempotencyKey("ship:" + id.v) }

// ---------------------------------------------------------------------------
// State: the rooms. isState is unexported, so no other package can add a variant.
// ---------------------------------------------------------------------------

//sumtype:decl
type State interface{ isState() }

type (
	Draft           struct{}
	AwaitingPayment struct {
		OrderID OrderID
		Amount  Amount
		Attempt int
	}
	// Reconciling: the charge outcome is unknown (the gateway did not answer in
	// time). A timeout does not mean the charge failed, so we ask instead of retrying.
	Reconciling struct {
		OrderID OrderID
		Amount  Amount
		Attempt int
	}
	Paid    struct{ OrderID OrderID }
	Shipped struct {
		OrderID    OrderID
		TrackingNo string
	}
	Failed struct {
		OrderID OrderID
		Amount  Amount
		Attempt int
		Reason  string
	}
)

func (Draft) isState()           {}
func (AwaitingPayment) isState() {}
func (Reconciling) isState()     {}
func (Paid) isState()            {}
func (Shipped) isState()         {}
func (Failed) isState()          {}

// ---------------------------------------------------------------------------
// Input: everything that can happen (user actions, command results, timers).
// Payment results and timers carry the attempt they belong to, so a stale one
// can never move the current attempt.
// ---------------------------------------------------------------------------

//sumtype:decl
type Input interface{ isInput() }

type (
	Submit struct {
		OrderID OrderID
		Amount  Amount
	}
	PaymentSucceeded struct {
		OrderID OrderID
		Attempt int
	}
	PaymentFailed struct {
		OrderID OrderID
		Attempt int
		Reason  string
	}
	PaymentTimedOut struct {
		OrderID OrderID
		Attempt int
	}
	ShipmentCreated struct {
		OrderID    OrderID
		TrackingNo string
	}
	Retry struct{}
)

func (Submit) isInput()           {}
func (PaymentSucceeded) isInput() {}
func (PaymentFailed) isInput()    {}
func (PaymentTimedOut) isInput()  {}
func (ShipmentCreated) isInput()  {}
func (Retry) isInput()            {}

// ---------------------------------------------------------------------------
// Command: effects described as data. The shell interprets them.
// ---------------------------------------------------------------------------

//sumtype:decl
type Command interface{ isCommand() }

type (
	ChargeCard struct {
		OrderID OrderID
		Amount  Amount
		Attempt int
		Key     IdempotencyKey
	}
	ResolvePayment struct {
		OrderID OrderID
		Attempt int
		Key     IdempotencyKey
	}
	CreateShipment struct {
		OrderID OrderID
		Key     IdempotencyKey
	}
	NotifyCustomer struct {
		OrderID OrderID
		Message string
	}
	// ScheduleInput asks the shell to feed Input back after a delay. It is how
	// the core expresses time without reading the clock.
	ScheduleInput struct {
		After time.Duration
		Input Input
	}
)

func (ChargeCard) isCommand()     {}
func (ResolvePayment) isCommand() {}
func (CreateShipment) isCommand() {}
func (NotifyCustomer) isCommand() {}
func (ScheduleInput) isCommand()  {}

const (
	MaxPaymentAttempts = 3
	PaymentTimeout     = 10 * time.Minute
)

// Initial is the starting state.
var Initial State = Draft{}

func charge(id OrderID, amount Amount, attempt int) []Command {
	return []Command{
		ChargeCard{OrderID: id, Amount: amount, Attempt: attempt, Key: ChargeKey(id, attempt)},
		ScheduleInput{After: PaymentTimeout, Input: PaymentTimedOut{OrderID: id, Attempt: attempt}},
	}
}

func reconcile(id OrderID, attempt int) []Command {
	return []Command{
		ResolvePayment{OrderID: id, Attempt: attempt, Key: ChargeKey(id, attempt)},
		ScheduleInput{After: PaymentTimeout, Input: PaymentTimedOut{OrderID: id, Attempt: attempt}},
	}
}

// pending returns the in-flight payment attempt, if the state has one.
func pending(s State) (id OrderID, amount Amount, attempt int, ok bool) {
	switch s := s.(type) {
	case AwaitingPayment:
		return s.OrderID, s.Amount, s.Attempt, true
	case Reconciling:
		return s.OrderID, s.Amount, s.Attempt, true
	case Draft, Paid, Shipped, Failed:
		return OrderID{}, Amount{}, 0, false
	}
	return OrderID{}, Amount{}, 0, false
}

// Step is the transition table. Each case is one legal hallway; anything not
// listed leaves the state unchanged and emits nothing.
func Step(s State, in Input) (State, []Command) {
	switch in := in.(type) {
	case Submit:
		if _, ok := s.(Draft); !ok {
			return s, nil
		}
		return AwaitingPayment{OrderID: in.OrderID, Amount: in.Amount, Attempt: 1}, charge(in.OrderID, in.Amount, 1)

	case PaymentSucceeded:
		id, _, attempt, ok := pending(s)
		if !ok || id != in.OrderID || attempt != in.Attempt {
			return s, nil // stale, duplicated or for another order
		}
		return Paid{OrderID: id}, []Command{CreateShipment{OrderID: id, Key: ShipmentKey(id)}}

	case PaymentFailed:
		id, amount, attempt, ok := pending(s)
		if !ok || id != in.OrderID || attempt != in.Attempt {
			return s, nil
		}
		return Failed{OrderID: id, Amount: amount, Attempt: attempt, Reason: in.Reason},
			[]Command{NotifyCustomer{OrderID: id, Message: "Payment failed: " + in.Reason}}

	case PaymentTimedOut:
		id, amount, attempt, ok := pending(s)
		if !ok || id != in.OrderID || attempt != in.Attempt {
			return s, nil // a timer for an attempt that already resolved
		}
		return Reconciling{OrderID: id, Amount: amount, Attempt: attempt}, reconcile(id, attempt)

	case Retry:
		f, ok := s.(Failed)
		if !ok || f.Attempt >= MaxPaymentAttempts {
			return s, nil
		}
		next := f.Attempt + 1
		return AwaitingPayment{OrderID: f.OrderID, Amount: f.Amount, Attempt: next}, charge(f.OrderID, f.Amount, next)

	case ShipmentCreated:
		p, ok := s.(Paid)
		if !ok || p.OrderID != in.OrderID {
			return s, nil
		}
		return Shipped{OrderID: p.OrderID, TrackingNo: in.TrackingNo},
			[]Command{NotifyCustomer{OrderID: p.OrderID, Message: "Shipped: " + in.TrackingNo}}
	}
	return s, nil
}

// Run folds a sequence of inputs through Step. Replay, deterministic tests and
// property-based tests are all just calls to Run.
func Run(s State, inputs []Input) (State, []Command) {
	var all []Command
	for _, in := range inputs {
		var cmds []Command
		s, cmds = Step(s, in)
		all = append(all, cmds...)
	}
	return s, all
}

// Describe renders a state for logs; formatting is pure, printing is not.
func Describe(s State) string {
	switch s := s.(type) {
	case Draft:
		return "Draft"
	case AwaitingPayment:
		return "AwaitingPayment(" + s.OrderID.v + ", attempt " + strconv.Itoa(s.Attempt) + ")"
	case Reconciling:
		return "Reconciling(" + s.OrderID.v + ", attempt " + strconv.Itoa(s.Attempt) + ")"
	case Paid:
		return "Paid(" + s.OrderID.v + ")"
	case Shipped:
		return "Shipped(" + s.OrderID.v + ", " + s.TrackingNo + ")"
	case Failed:
		return "Failed(" + s.OrderID.v + ", attempt " + strconv.Itoa(s.Attempt) + ", " + s.Reason + ")"
	}
	return "unknown"
}
