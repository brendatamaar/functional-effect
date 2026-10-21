package shell

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"example.com/functional-effect/internal/core"
)

// HTTPGateway is the live PaymentGateway: a client for a payment provider's
// HTTP API. Its job is translation, in both directions:
//
//	POST /v1/charges              Idempotency-Key: <key>   {"orderId","amount"}
//	  200 {"status":"charged"}                   → nil
//	  402 {"status":"declined","reason":"…"}     → ErrDeclined (domain outcome)
//	POST /v1/charges/<key>/resolve
//	  200 {"status":"charged"|"declined"|"pending"|"not_found"}
//
//	408, 429, 5xx, network errors, lost responses → ErrTransient (retry)
//	any other status or an unreadable 200          → a defect, returned as is
//
// The contract suite in contract/ checks this mapping: against a simulator of
// the provider in every test run, and against the provider's sandbox when
// PAYMENTS_SANDBOX_URL is set.
type HTTPGateway struct {
	BaseURL string
	APIKey  string
	Client  *http.Client
}

type httpResult struct {
	Status string `json:"status"`
	Reason string `json:"reason"`
}

func (g *HTTPGateway) Charge(ctx context.Context, key core.IdempotencyKey, id core.OrderID, amount core.Amount) error {
	body, _ := json.Marshal(map[string]any{"orderId": id.String(), "amount": amount.Int64()})
	res, err := g.post(ctx, "/v1/charges", key, body)
	if err != nil {
		return err
	}
	switch res.Status {
	case "charged":
		return nil
	case "declined":
		reason := res.Reason
		if reason == "" {
			reason = "declined"
		}
		return fmt.Errorf("%s: %w", reason, ErrDeclined)
	}
	return fmt.Errorf("charge %s: unexpected status %q", key, res.Status)
}

func (g *HTTPGateway) Resolve(ctx context.Context, key core.IdempotencyKey) (PaymentStatus, error) {
	res, err := g.post(ctx, "/v1/charges/"+url.PathEscape(string(key))+"/resolve", key, nil)
	if err != nil {
		return 0, err
	}
	switch res.Status {
	case "charged":
		return StatusCharged, nil
	case "declined":
		return StatusDeclined, nil
	case "pending":
		return StatusPending, nil
	case "not_found":
		return StatusNotFound, nil
	}
	return 0, fmt.Errorf("resolve %s: unexpected status %q", key, res.Status)
}

func (g *HTTPGateway) post(ctx context.Context, path string, key core.IdempotencyKey, body []byte) (httpResult, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(g.BaseURL, "/")+path, bytes.NewReader(body))
	if err != nil {
		return httpResult{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", string(key))
	if g.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+g.APIKey)
	}
	client := g.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return httpResult{}, ctx.Err() // the caller gave up: not ours to classify
		}
		// Connection refused, reset, timeout, or the response was lost on the way
		// back. The request may or may not have been processed: transient, and
		// safe to retry only because of the idempotency key.
		return httpResult{}, fmt.Errorf("%s: %v: %w", path, err, ErrTransient)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return httpResult{}, fmt.Errorf("%s: reading response: %v: %w", path, err, ErrTransient)
	}
	switch {
	case resp.StatusCode == http.StatusOK, resp.StatusCode == http.StatusPaymentRequired:
		var res httpResult
		if err := json.Unmarshal(raw, &res); err != nil {
			return httpResult{}, fmt.Errorf("%s: malformed response %q: %w", path, raw, err)
		}
		return res, nil
	case resp.StatusCode == http.StatusRequestTimeout, resp.StatusCode == http.StatusTooManyRequests, resp.StatusCode >= 500:
		return httpResult{}, fmt.Errorf("%s: HTTP %d: %w", path, resp.StatusCode, ErrTransient)
	}
	return httpResult{}, errors.New(path + ": HTTP " + resp.Status + ": " + string(raw))
}
