# Model Functional Effect in Go

Complete, runnable version: `examples/go` in this plugin (`go test -race ./...`, `go run ./cmd/demo`). Standard library only.

## Layout

```
internal/core/    pure: types, Step, Run, smart constructors, property tests
internal/shell/   boundary, capabilities, interpreter, store (version/inbox/event log/outbox), app, worker, fakes
cmd/<app>/        main: wire real capabilities, run the worker
```

## Sum types: sealed interfaces

```go
//sumtype:decl
type State interface{ isState() }   // unexported method: no other package can add a variant

type (
    Draft           struct{}
    AwaitingPayment struct{ OrderID OrderID; Amount Amount; Attempt int }
    Reconciling     struct{ OrderID OrderID; Amount Amount; Attempt int }
    Paid            struct{ OrderID OrderID }
)

func (Draft) isState()           {}
func (AwaitingPayment) isState() {}
// ...
```

`//sumtype:decl` lets golangci-lint's `gochecksumtype` fail a type switch that misses a variant. Avoid `bool` flag combinations (`isLoading`, `isError`).

A plain status with no data per value is fine as a named enum:

```go
type BuildStatus string

const (
    BuildQueued  BuildStatus = "queued"
    BuildRunning BuildStatus = "running"
    BuildDone    BuildStatus = "done"
)

func (s BuildStatus) Validate() error { /* reject anything not listed */ }
```

Switch to a sealed interface when one value needs its own data (`Failed{Step, ExitCode}`, `Running{StartedAt}`): an optional field that is only meaningful in some states is a sum type in disguise.

## Values parsed at the boundary

```go
type Amount struct{ v int64 }       // unexported field: only NewAmount can build a valid one

func NewAmount(n int64) (Amount, error) {
    if n <= 0 {
        return Amount{}, errors.New("amount must be positive")
    }
    return Amount{v: n}, nil
}
```

`type Amount int64` is not enough: untyped constants convert implicitly (`var a Amount = -1` compiles).

## Step: guards on state, order and attempt

```go
case PaymentSucceeded:
    id, _, attempt, ok := pending(s)               // AwaitingPayment or Reconciling
    if !ok || id != in.OrderID || attempt != in.Attempt {
        return s, nil                              // stale, duplicated or for another order
    }
    return Paid{OrderID: id}, []Command{CreateShipment{OrderID: id, Key: ShipmentKey(id)}}

case PaymentTimedOut:                              // a timer the core scheduled earlier
    id, amount, attempt, ok := pending(s)
    if !ok || id != in.OrderID || attempt != in.Attempt {
        return s, nil
    }
    return Reconciling{OrderID: id, Amount: amount, Attempt: attempt}, reconcile(id, attempt)
```

Time is a command: `ScheduleInput{After: PaymentTimeout, Input: PaymentTimedOut{...}}`. `time.Duration` as a type is fine in the core; `time.Now()` is not. Idempotency keys come from state: `ChargeKey(id, attempt)`.

## Property tests with shrinking (no dependencies)

```go
func check(t *testing.T, prop func([]Input) error) {
    for seed := int64(1); seed <= runs; seed++ {
        inputs := genInputs(seed)                  // seeded math/rand, small domain
        if err := prop(inputs); err != nil {
            minimal := shrink(inputs, prop)        // drop inputs while it still fails
            t.Fatalf("seed %d: %v\nminimal failing inputs:\n  %s", seed, err, describeInputs(minimal))
        }
    }
}
```

A failure reports the shortest path, e.g. `Submit`, `PaymentSucceeded{Attempt:3}` for a missing attempt guard. `pgregory.net/rapid` is a drop-in alternative with richer shrinking.

## Interpreter: one strategy per command

```go
case core.ChargeCard:
    err := retryTransient(d, 3, 100*time.Millisecond, func() error {
        return d.Payments.Charge(ctx, c.Key, c.OrderID, c.Amount)   // same key every retry
    })
    switch {
    case err == nil:
        return core.PaymentSucceeded{OrderID: c.OrderID, Attempt: c.Attempt}, nil
    case errors.Is(err, ErrDeclined):          // domain outcome
        return core.PaymentFailed{OrderID: c.OrderID, Attempt: c.Attempt, Reason: err.Error()}, nil
    case errors.Is(err, ErrTransient):         // unknown outcome: wait for the timer
        return nil, nil
    default:                                   // defect
        return nil, fmt.Errorf("charge %s: %w", c.Key, err)
    }
```

`ResolvePayment` calls a **fenced** `Resolve(key)`: the final outcome, or "not found" after voiding the key so a late redelivered charge is declined.

## Store, app and worker

```go
type Store interface {
    Load(ctx, id) (core.State, Version, error)
    Commit(ctx, Commit) error            // version check + inbox + event log + state + outbox, atomically
    ClaimDue(ctx, now, limit) ([]OutboxItem, error)
    Complete(ctx, itemID) error
    Release(ctx, itemID, retryAt) error
    Events(ctx, id) ([]core.Input, error)
}
```

`App.Handle(ctx, eventID, input)` loads, runs `core.Step`, commits; `ErrConflict` → reload and retry; `ErrDuplicate` → no-op. `Worker.RunOnce(ctx, now)` claims due items, interprets, feeds results back with event ID `<item>:result`, completes. SQL in [outbox.md](outbox.md).

## Shell tests

Fakes behave like real services (idempotent per key) and are scripted per call: `Normal`, `Decline`, `Transient`, `LostResponse`. The worker has crash points (`AfterEffect`, `AfterResult`). The concurrency test wraps the store in a barrier so every handler loads before any commits; without that, a missing version check goes unnoticed. The chaos test asserts that money moves at most once per order, and only for orders that ship.

## Enforcing it with golangci-lint

The plugin's hook checks edits made by Claude. For CI and human edits, use `templates/golangci.depguard.yml` (depguard, forbidigo, gochecksumtype).
