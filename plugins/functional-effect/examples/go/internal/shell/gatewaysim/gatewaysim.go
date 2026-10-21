// Package gatewaysim simulates the payment provider's HTTP API (the one
// shell.HTTPGateway speaks) so the live adapter can run the PaymentGateway
// contract suite in every test run, without network access.
//
// A simulator encodes our reading of the provider's documentation, so it can
// be wrong in the same way the fake is. The sandbox run of the contract suite
// (PAYMENTS_SANDBOX_URL) is what checks that reading against the real provider.
package gatewaysim

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync"
)

type status string

const (
	charged  status = "charged"
	declined status = "declined"
)

// Sim is an http.Handler. Charges are idempotent per Idempotency-Key, resolve
// voids keys it has never seen, and DeclineAmount is always declined.
type Sim struct {
	DeclineAmount int64

	mu      sync.Mutex
	results map[string]status
	charged map[string]int
	fail    map[string]int // op → pending 503s
	lose    map[string]int // op → pending lost responses
}

func New(declineAmount int64) *Sim {
	return &Sim{
		DeclineAmount: declineAmount,
		results:       map[string]status{},
		charged:       map[string]int{},
		fail:          map[string]int{},
		lose:          map[string]int{},
	}
}

// FailNext makes the next request for op ("charge" or "resolve") answer 503
// without doing anything.
func (s *Sim) FailNext(op string) { s.mu.Lock(); s.fail[op]++; s.mu.Unlock() }

// LoseNext makes the next request for op do its work and then drop the
// connection before answering.
func (s *Sim) LoseNext(op string) { s.mu.Lock(); s.lose[op]++; s.mu.Unlock() }

// Charged reports how many times money moved for an order.
func (s *Sim) Charged(orderID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.charged[orderID]
}

func (s *Sim) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	switch {
	case r.URL.Path == "/v1/charges":
		s.charge(w, r)
	case strings.HasPrefix(r.URL.Path, "/v1/charges/") && strings.HasSuffix(r.URL.Path, "/resolve"):
		key := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/charges/"), "/resolve")
		s.resolve(w, key)
	default:
		http.NotFound(w, r)
	}
}

// fault consumes a scripted fault for op: stop means answer 503 before doing
// anything, lose means do the work and then drop the connection.
func (s *Sim) fault(op string) (stop bool, lose bool) {
	if s.fail[op] > 0 {
		s.fail[op]--
		return true, false
	}
	if s.lose[op] > 0 {
		s.lose[op]--
		return false, true
	}
	return false, false
}

func (s *Sim) charge(w http.ResponseWriter, r *http.Request) {
	key := r.Header.Get("Idempotency-Key")
	var body struct {
		OrderID string `json:"orderId"`
		Amount  int64  `json:"amount"`
	}
	if key == "" || json.NewDecoder(r.Body).Decode(&body) != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	s.mu.Lock()
	stop, lose := s.fault("charge")
	if stop {
		s.mu.Unlock()
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	res, seen := s.results[key]
	if !seen {
		res = charged
		if body.Amount == s.DeclineAmount {
			res = declined
		} else {
			s.charged[body.OrderID]++
		}
		s.results[key] = res
	}
	s.mu.Unlock()
	if lose {
		drop(w)
		return
	}
	code := http.StatusOK
	if res == declined {
		code = http.StatusPaymentRequired
	}
	reply(w, code, map[string]string{"status": string(res), "reason": "card declined"})
}

func (s *Sim) resolve(w http.ResponseWriter, key string) {
	s.mu.Lock()
	stop, lose := s.fault("resolve")
	if stop {
		s.mu.Unlock()
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	res, seen := s.results[key]
	answer := string(res)
	if !seen {
		s.results[key] = declined // void: a later charge with this key is declined
		answer = "not_found"
	}
	s.mu.Unlock()
	if lose {
		drop(w)
		return
	}
	reply(w, http.StatusOK, map[string]string{"status": answer})
}

func reply(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// drop closes the connection without a response: the work happened, the
// client never hears about it.
func drop(w http.ResponseWriter) {
	if hj, ok := w.(http.Hijacker); ok {
		if conn, _, err := hj.Hijack(); err == nil {
			_ = conn.Close()
			return
		}
	}
	panic(http.ErrAbortHandler)
}
