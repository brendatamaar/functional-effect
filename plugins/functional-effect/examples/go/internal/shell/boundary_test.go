package shell

// Property tests for the boundary. ParseEvent is the only door from the
// outside world into the core, so it gets four properties:
//
//	round trip      ParseEvent(EncodeEvent(e)) == e for every valid event
//	accepted⇒valid  whatever ParseEvent accepts satisfies validEvent, a predicate
//	                written independently of the parser (never by calling it)
//	rejects rules   breaking any one rule of a valid event gets it rejected
//	never panics    FuzzParseEvent, on arbitrary bytes (go test -fuzz=FuzzParseEvent)

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"reflect"
	"strings"
	"testing"

	"example.com/functional-effect/internal/core"
)

const boundaryRuns = 3000

// validEvent states what "valid" means, independently of ParseEvent.
func validEvent(e Event) error {
	if e.ID == "" {
		return errors.New("empty event ID")
	}
	order := func(id core.OrderID) error {
		if id.String() == "" {
			return errors.New("empty order ID")
		}
		return nil
	}
	attempt := func(a int) error {
		if a < 1 || a > core.MaxPaymentAttempts {
			return fmt.Errorf("attempt %d out of range", a)
		}
		return nil
	}
	switch in := e.Input.(type) {
	case core.Submit:
		if in.Amount.Int64() <= 0 {
			return fmt.Errorf("amount %d", in.Amount.Int64())
		}
		return order(in.OrderID)
	case core.PaymentSucceeded:
		return errors.Join(order(in.OrderID), attempt(in.Attempt))
	case core.PaymentFailed:
		return errors.Join(order(in.OrderID), attempt(in.Attempt))
	case core.ShipmentCreated:
		if in.TrackingNo == "" {
			return errors.New("empty tracking number")
		}
		return order(in.OrderID)
	case core.Retry:
		return nil
	case core.PaymentTimedOut:
		return errors.New("internal input accepted from outside")
	}
	return fmt.Errorf("unknown input %T", e.Input)
}

// Generators. Strings come from a pool that includes the characters JSON
// encoders get wrong: quotes, backslashes, control characters, line separators
// and non-ASCII text.
var runePool = []rune("aZ09-_:#/ \"\\\x00\x1f é中\U0001F600")

func genString(r *rand.Rand, min int) string {
	n := min + r.Intn(8)
	var b strings.Builder
	for i := 0; i < n; i++ {
		b.WriteRune(runePool[r.Intn(len(runePool))])
	}
	return b.String()
}

func genAmount(r *rand.Rand) int64 {
	switch r.Intn(4) {
	case 0:
		return 1
	case 1:
		return math.MaxInt64
	default:
		return 1 + r.Int63n(1_000_000)
	}
}

// genEvent returns a random valid event, as ParseEvent could produce it.
func genEvent(r *rand.Rand) Event {
	id := mustOrder(genString(r, 1))
	attempt := 1 + r.Intn(core.MaxPaymentAttempts)
	var in core.Input
	switch r.Intn(5) {
	case 0:
		in = core.Submit{OrderID: id, Amount: mustAmount(genAmount(r))}
	case 1:
		in = core.PaymentSucceeded{OrderID: id, Attempt: attempt}
	case 2:
		in = core.PaymentFailed{OrderID: id, Attempt: attempt, Reason: genString(r, 0)}
	case 3:
		in = core.ShipmentCreated{OrderID: id, TrackingNo: genString(r, 1)}
	default:
		in = core.Retry{}
	}
	return Event{ID: genString(r, 1), Input: in}
}

func TestBoundaryRoundTrip(t *testing.T) {
	for seed := int64(1); seed <= boundaryRuns; seed++ {
		e := genEvent(rand.New(rand.NewSource(seed)))
		raw, err := EncodeEvent(e)
		if err != nil {
			t.Fatalf("seed %d: encode %#v: %v", seed, e, err)
		}
		got, err := ParseEvent(raw)
		if err != nil {
			t.Fatalf("seed %d: valid event rejected: %v\n  %s", seed, err, raw)
		}
		if !reflect.DeepEqual(got, e) {
			t.Fatalf("seed %d: round trip changed the event\n  want %#v\n  got  %#v\n  wire %s", seed, e, got, raw)
		}
	}
}

// genWire returns messy JSON: a valid event with zero to three fields replaced
// by edge values, wrong types, unknown or internal tags, odd-cased or extra
// keys, and sometimes broken bytes. Starting from a valid event keeps a useful
// share of inputs accepted (the test below checks that share).
func genWire(r *rand.Rand) []byte {
	pick := func(xs ...any) any { return xs[r.Intn(len(xs))] }
	value := func() any {
		return pick("", "x", genString(r, 0), 0, -1, 1, 3, 4, 1.5, math.MaxInt64, true, nil, []any{1}, map[string]any{"a": 1})
	}
	raw, _ := EncodeEvent(genEvent(r))
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	for n := r.Intn(4); n > 0; n-- {
		switch k := pick("_tag", "eventId", "orderId", "amount", "attempt", "reason", "trackingNo", "EVENTID", "extra").(string); k {
		case "_tag":
			m[k] = pick("Submit", "PaymentSucceeded", "PaymentFailed", "ShipmentCreated", "Retry", "PaymentTimedOut", "submit", "", 7)
		default:
			if r.Intn(4) == 0 {
				delete(m, k)
			} else {
				m[k] = value()
			}
		}
	}
	raw, _ = json.Marshal(m)
	if r.Intn(8) == 0 && len(raw) > 2 { // corrupt a byte or truncate
		if r.Intn(2) == 0 {
			raw[r.Intn(len(raw))] = byte(r.Intn(256))
		} else {
			raw = raw[:r.Intn(len(raw))]
		}
	}
	return raw
}

// checkAccepted is the property shared by the messy-input test and the fuzz target.
func checkAccepted(raw []byte) error {
	e, err := ParseEvent(raw)
	if err != nil {
		return nil // rejecting is always allowed
	}
	if err := validEvent(e); err != nil {
		return fmt.Errorf("accepted an invalid event (%v): %#v", err, e)
	}
	again, err := EncodeEvent(e)
	if err != nil {
		return fmt.Errorf("accepted event cannot be encoded: %v", err)
	}
	if e2, err := ParseEvent(again); err != nil || !reflect.DeepEqual(e, e2) {
		return fmt.Errorf("accepted event does not round trip: %#v → %s → %#v (%v)", e, again, e2, err)
	}
	return nil
}

func TestBoundaryAcceptsOnlyValidEvents(t *testing.T) {
	accepted := 0
	for seed := int64(1); seed <= boundaryRuns; seed++ {
		raw := genWire(rand.New(rand.NewSource(seed)))
		if err := checkAccepted(raw); err != nil {
			t.Fatalf("seed %d: %v\n  input %q", seed, err, raw)
		}
		if _, err := ParseEvent(raw); err == nil {
			accepted++
		}
	}
	// A generator that never produces an accepted event tests nothing.
	if accepted < boundaryRuns/100 {
		t.Fatalf("only %d of %d messy inputs were accepted; the generator is too noisy", accepted, boundaryRuns)
	}
}

// Each rule, broken on its own, must get an otherwise valid event rejected.
// This is the test that fails when someone deletes a check from the parser.
func TestBoundaryRejectsEachBrokenRule(t *testing.T) {
	type rule struct {
		name    string
		applies func(tag string) bool
		break_  func(m map[string]any)
	}
	any_ := func(string) bool { return true }
	has := func(tags ...string) func(string) bool {
		return func(tag string) bool {
			for _, x := range tags {
				if x == tag {
					return true
				}
			}
			return false
		}
	}
	withOrder := has("Submit", "PaymentSucceeded", "PaymentFailed", "ShipmentCreated")
	withAttempt := has("PaymentSucceeded", "PaymentFailed")
	rules := []rule{
		{"missing eventId", any_, func(m map[string]any) { delete(m, "eventId") }},
		{"empty eventId", any_, func(m map[string]any) { m["eventId"] = "" }},
		{"unknown tag", any_, func(m map[string]any) { m["_tag"] = "Refund" }},
		{"internal tag", any_, func(m map[string]any) { m["_tag"] = "PaymentTimedOut"; m["attempt"] = 1 }},
		{"empty orderId", withOrder, func(m map[string]any) { m["orderId"] = "" }},
		{"zero amount", has("Submit"), func(m map[string]any) { m["amount"] = 0 }},
		{"negative amount", has("Submit"), func(m map[string]any) { m["amount"] = -5 }},
		{"fractional amount", has("Submit"), func(m map[string]any) { m["amount"] = 1.5 }},
		{"attempt 0", withAttempt, func(m map[string]any) { m["attempt"] = 0 }},
		{"attempt above max", withAttempt, func(m map[string]any) { m["attempt"] = core.MaxPaymentAttempts + 1 }},
		{"empty trackingNo", has("ShipmentCreated"), func(m map[string]any) { m["trackingNo"] = "" }},
	}
	for seed := int64(1); seed <= 300; seed++ {
		e := genEvent(rand.New(rand.NewSource(seed)))
		raw, _ := EncodeEvent(e)
		for _, rl := range rules {
			var m map[string]any
			_ = json.Unmarshal(raw, &m)
			tag, _ := m["_tag"].(string)
			if !rl.applies(tag) {
				continue
			}
			rl.break_(m)
			broken, _ := json.Marshal(m)
			if got, err := ParseEvent(broken); err == nil {
				t.Fatalf("rule %q not enforced: accepted %s as %#v", rl.name, broken, got)
			}
		}
	}
}

// FuzzParseEvent runs as a normal test over its seed corpus; with
// `go test -fuzz=FuzzParseEvent ./internal/shell` it explores new inputs.
func FuzzParseEvent(f *testing.F) {
	for seed := int64(1); seed <= 20; seed++ {
		raw, _ := EncodeEvent(genEvent(rand.New(rand.NewSource(seed))))
		f.Add(raw)
	}
	f.Add([]byte(`{}`))
	f.Add([]byte(`{"_tag":"PaymentTimedOut","eventId":"e","orderId":"o","attempt":1}`))
	f.Add([]byte(`{"_tag":"Submit","eventId":"e","orderId":"o","amount":1e400}`))
	f.Fuzz(func(t *testing.T, raw []byte) {
		if err := checkAccepted(raw); err != nil {
			t.Fatal(err)
		}
	})
}
