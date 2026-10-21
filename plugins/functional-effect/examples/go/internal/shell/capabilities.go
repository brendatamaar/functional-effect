package shell

import (
	"context"
	"errors"
	"time"

	"example.com/functional-effect/internal/core"
)

// Capabilities the shell needs from the outside world. These interfaces play
// the role of R in Effect<A, E, R>: swap a real client for a fake in tests.

var (
	// ErrDeclined is a domain outcome: it becomes a PaymentFailed Input.
	ErrDeclined = errors.New("payment declined")
	// ErrTransient marks failures worth retrying (timeouts, 429, 503, resets).
	// Retrying is only safe because every command carries an idempotency key.
	ErrTransient = errors.New("transient failure")
)

type PaymentStatus int

const (
	StatusNotFound PaymentStatus = iota // the gateway never saw this key; it is now voided
	StatusPending
	StatusCharged
	StatusDeclined
)

type PaymentGateway interface {
	// Charge must be idempotent per key: a repeated key returns the first result
	// without charging again.
	Charge(ctx context.Context, key core.IdempotencyKey, id core.OrderID, amount core.Amount) error
	// Resolve returns the final outcome for key. If the gateway never saw the key,
	// it voids it: a later Charge with that key is declined. This fencing is what
	// makes "not charged" safe to act on — without it, a ChargeCard redelivered
	// after a crash could charge an order the core already marked Failed.
	Resolve(ctx context.Context, key core.IdempotencyKey) (PaymentStatus, error)
}

type Shipping interface {
	Create(ctx context.Context, key core.IdempotencyKey, id core.OrderID) (trackingNo string, err error)
}

type Notifier interface {
	Send(ctx context.Context, id core.OrderID, message string) error
}

type Deps struct {
	Payments PaymentGateway
	Shipping Shipping
	Notifier Notifier
	// Sleep is injected so retries are instant in tests.
	Sleep func(time.Duration)
	// Log receives escape-hatch and retry notes.
	Log func(format string, args ...any)
}

func (d Deps) logf(format string, args ...any) {
	if d.Log != nil {
		d.Log(format, args...)
	}
}
