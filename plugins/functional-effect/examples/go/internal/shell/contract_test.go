package shell_test

// Contract runs: each capability's contract suite against every implementation.
// The fakes used by shell_test.go are only trustworthy because they pass here.

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"testing"
	"time"

	"example.com/functional-effect/internal/core"
	"example.com/functional-effect/internal/shell"
	"example.com/functional-effect/internal/shell/contract"
	"example.com/functional-effect/internal/shell/gatewaysim"
)

const declineAmount = 402

func mustAmount(n int64) core.Amount { a, _ := core.NewAmount(n); return a }

func TestFakeGatewayContract(t *testing.T) {
	contract.PaymentGateway(t, func(t *testing.T) contract.GatewayUnderTest {
		next := map[string]shell.Behavior{}
		g := shell.NewFakeGateway(func(op string, _ core.IdempotencyKey, _ int) shell.Behavior {
			b := next[op]
			delete(next, op)
			return b
		})
		g.DeclineAmount = mustAmount(declineAmount)
		return contract.GatewayUnderTest{
			Gateway:       g,
			DeclineAmount: g.DeclineAmount,
			Inject: func(op string, f contract.Fault) {
				next[op] = map[contract.Fault]shell.Behavior{contract.Unreachable: shell.Transient, contract.LostResponse: shell.LostResponse}[f]
			},
			Charged: g.Charged,
		}
	})
}

func TestHTTPGatewayContract(t *testing.T) {
	contract.PaymentGateway(t, func(t *testing.T) contract.GatewayUnderTest {
		sim := gatewaysim.New(declineAmount)
		srv := httptest.NewServer(sim)
		t.Cleanup(srv.Close)
		return contract.GatewayUnderTest{
			Gateway:       &shell.HTTPGateway{BaseURL: srv.URL, Client: &http.Client{Timeout: 5 * time.Second}},
			DeclineAmount: mustAmount(declineAmount),
			Inject: func(op string, f contract.Fault) {
				if f == contract.Unreachable {
					sim.FailNext(op)
				} else {
					sim.LoseNext(op)
				}
			},
			Charged: func(id core.OrderID) int { return sim.Charged(id.String()) },
		}
	})
}

// TestHTTPGatewaySandboxContract runs the same suite against the provider's
// sandbox. It is the only run that checks our reading of the provider:
//
//	PAYMENTS_SANDBOX_URL=https://sandbox.example-pay.test PAYMENTS_SANDBOX_KEY=… \
//	PAYMENTS_SANDBOX_DECLINE_AMOUNT=402 go test ./internal/shell -run Sandbox
func TestHTTPGatewaySandboxContract(t *testing.T) {
	url := os.Getenv("PAYMENTS_SANDBOX_URL")
	if url == "" {
		t.Skip("PAYMENTS_SANDBOX_URL not set")
	}
	n, err := strconv.ParseInt(os.Getenv("PAYMENTS_SANDBOX_DECLINE_AMOUNT"), 10, 64)
	if err != nil {
		t.Fatal("PAYMENTS_SANDBOX_DECLINE_AMOUNT must be the sandbox's always-declined amount")
	}
	contract.PaymentGateway(t, func(t *testing.T) contract.GatewayUnderTest {
		return contract.GatewayUnderTest{
			Gateway:       &shell.HTTPGateway{BaseURL: url, APIKey: os.Getenv("PAYMENTS_SANDBOX_KEY"), Client: &http.Client{Timeout: 15 * time.Second}},
			DeclineAmount: mustAmount(n),
			// No Inject, no Charged: a sandbox cannot be told to fail, and money
			// movements are observed through Resolve only.
		}
	})
}

func TestMemStoreContract(t *testing.T) {
	contract.Store(t, func(t *testing.T) contract.StoreUnderTest {
		return contract.StoreUnderTest{Store: shell.NewMemStore(30 * time.Second), Lease: 30 * time.Second}
	})
}
