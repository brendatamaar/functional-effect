// Package shell is the imperative shell: it parses the outside world into core
// types, persists state with its commands atomically, and interprets commands
// into real effects.
package shell

import (
	"encoding/json"
	"fmt"

	"example.com/functional-effect/internal/core"
)

// wireEvent is the untrusted wire format. It never crosses into the core.
type wireEvent struct {
	EventID    string `json:"eventId"`
	Tag        string `json:"_tag"`
	OrderID    string `json:"orderId,omitempty"`
	Amount     int64  `json:"amount,omitempty"`
	Attempt    int    `json:"attempt,omitempty"`
	Reason     string `json:"reason,omitempty"`
	TrackingNo string `json:"trackingNo,omitempty"`
}

// Event is a parsed external event: a delivery ID for de-duplication plus the core Input.
type Event struct {
	ID    string
	Input core.Input
}

// ParseEvent turns untrusted bytes into an Event, or an error.
// Parse, don't validate: the result carries the guarantee in its type.
func ParseEvent(raw []byte) (Event, error) {
	var w wireEvent
	if err := json.Unmarshal(raw, &w); err != nil {
		return Event{}, fmt.Errorf("invalid json: %w", err)
	}
	if w.EventID == "" {
		return Event{}, fmt.Errorf("eventId must not be empty")
	}
	in, err := parseInput(w)
	if err != nil {
		return Event{}, err
	}
	return Event{ID: w.EventID, Input: in}, nil
}

func parseInput(w wireEvent) (core.Input, error) {
	attempt := func() (int, error) {
		if w.Attempt < 1 || w.Attempt > core.MaxPaymentAttempts {
			return 0, fmt.Errorf("attempt must be between 1 and %d", core.MaxPaymentAttempts)
		}
		return w.Attempt, nil
	}
	if w.Tag == "Retry" {
		return core.Retry{}, nil
	}
	id, err := core.NewOrderID(w.OrderID)
	if err != nil {
		return nil, err
	}
	switch w.Tag {
	case "Submit":
		amt, err := core.NewAmount(w.Amount)
		if err != nil {
			return nil, err
		}
		return core.Submit{OrderID: id, Amount: amt}, nil
	case "PaymentSucceeded":
		a, err := attempt()
		if err != nil {
			return nil, err
		}
		return core.PaymentSucceeded{OrderID: id, Attempt: a}, nil
	case "PaymentFailed":
		a, err := attempt()
		if err != nil {
			return nil, err
		}
		return core.PaymentFailed{OrderID: id, Attempt: a, Reason: w.Reason}, nil
	case "ShipmentCreated":
		if w.TrackingNo == "" {
			return nil, fmt.Errorf("trackingNo must not be empty")
		}
		return core.ShipmentCreated{OrderID: id, TrackingNo: w.TrackingNo}, nil
	}
	// PaymentTimedOut is internal: only the scheduler produces it, never the outside world.
	return nil, fmt.Errorf("unknown event %q", w.Tag)
}

// EncodeEvent is the inverse of ParseEvent: the wire format producers send.
// ParseEvent(EncodeEvent(e)) == e for every event ParseEvent can return; the
// property tests in boundary_test.go and FuzzParseEvent check it.
func EncodeEvent(e Event) ([]byte, error) {
	w := wireEvent{EventID: e.ID}
	switch in := e.Input.(type) {
	case core.Submit:
		w.Tag, w.OrderID, w.Amount = "Submit", in.OrderID.String(), in.Amount.Int64()
	case core.PaymentSucceeded:
		w.Tag, w.OrderID, w.Attempt = "PaymentSucceeded", in.OrderID.String(), in.Attempt
	case core.PaymentFailed:
		w.Tag, w.OrderID, w.Attempt, w.Reason = "PaymentFailed", in.OrderID.String(), in.Attempt, in.Reason
	case core.ShipmentCreated:
		w.Tag, w.OrderID, w.TrackingNo = "ShipmentCreated", in.OrderID.String(), in.TrackingNo
	case core.Retry:
		w.Tag = "Retry"
	case core.PaymentTimedOut:
		return nil, fmt.Errorf("PaymentTimedOut is internal and has no wire format")
	default:
		return nil, fmt.Errorf("unknown input %T", e.Input)
	}
	return json.Marshal(w)
}
