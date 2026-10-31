# Testing a functional effect

The model decides where each kind of test goes. Runnable versions of everything below are in `examples/go` and `examples/typescript` (and, for the core and boundary layers, `examples/python`).

| Layer | What can go wrong | Test |
|---|---|---|
| Core `step` / `run` | an illegal transition, a broken invariant | property tests over input sequences, with shrinking; one table test per transition-table row |
| Boundary parser | bad data gets in, good data is rejected or changed | property tests: round trip, accepted ⇒ valid, rejects each rule; a fuzz target (Go) |
| Capabilities (gateway, store, …) | the fake behaves differently from the real thing | a **contract suite** run against the fake and against the live adapter |
| Shell (app, interpreter, worker) | lost, duplicated or reordered effects | tests with fakes: crash points, duplicates, worst-case interleaving, a seeded chaos run |
| Whole system | wiring | a few end-to-end paths |

Mocks with call expectations (`expect(gateway.charge).toHaveBeenCalledWith(…)`) have no place here: the core needs no doubles at all, and the shell uses fakes with state, trusted because they pass the contract.

## Property tests

### Core: invariants over input sequences

- Generate **sequences of inputs** from a deliberately small domain (two order IDs, attempts 1–3), so sequences collide on the same order and the same attempt.
- One property per invariant in the design document, named after it. Check the invariant after every step, not only at the end.
- **Shrink** a failure to the shortest sequence that still fails, and make it reproducible (a seed). A failure then reads like a bug report: `Submit, PaymentSucceeded{Attempt:3}`.
- A property must not restate the implementation. "The state after `PaymentSucceeded` is `Paid`" re-implements `step`; "`CreateShipment` is only emitted for an order that reached `Paid`" is an invariant.

Go: a seeded `math/rand` generator and a remove-one-input shrinker (stdlib only), or `pgregory.net/rapid`. TS: `Arbitrary.schema(InputSchema)` from `effect/Arbitrary` (shrinks; unstable in Effect 4.0) or `fast-check`. Python: Hypothesis (`st.lists(inputs)` shrinks and replays), or the stdlib seeded generator with a remove-one-input shrinker in `examples/python/tests/prop.py`.

### Boundary: four properties per parser

| Property | Statement | Catches |
|---|---|---|
| Round trip | `parse(encode(e)) == e` for every valid `e` | an encoder or parser that drops or changes a field |
| Accepted ⇒ valid | whatever `parse` accepts satisfies `valid(e)` | a missing check |
| Rejects each rule | breaking any **one** rule of a valid event gets it rejected | a deleted check (this is the test that fails when someone removes one) |
| Never panics | arbitrary bytes never crash the parser | panics, unbounded allocations |

- Write `valid` **independently** of the parser: a predicate on the parsed type that states the rules again. Calling the parser inside it makes the property circular.
- An encoder (`EncodeEvent` / `encodeEvent`) is worth writing even if only producers and tests use it: it makes round trip testable and documents the wire format.
- Generate messy input by **perturbing valid events** (replace, delete or mistype one to three fields, corrupt a byte), not from scratch: random JSON is almost always rejected and tests nothing. Assert that some share of messy inputs is accepted.
- Generate valid events from the boundary schema itself when you have one (`Arbitrary.schema(EventSchema)`).
- Go: add a native fuzz target over the same property (`func FuzzParseEvent(f *testing.F)`); it runs its seed corpus with `go test` and explores with `go test -fuzz=FuzzParseEvent`.

## Contract tests

A shell test that passes with a fake says something about production only if the fake behaves like the real thing. A contract suite states that behavior once and runs it against every implementation:

```
contract.PaymentGateway(t, …)       FakeGateway                  every run
                                    HTTPGateway + simulator      every run
                                    HTTPGateway + sandbox        when PAYMENTS_SANDBOX_URL is set
contract.Store(t, …)                MemStore / MemoryStore       every run
                                    PgStore + PostgreSQL         every run (PGlite) or against a test database
```

### Writing clauses

- A clause uses **only the capability's interface**, never an implementation's internals, so it can run against a service you do not control. What the interface cannot observe goes into optional hooks on the subject:

  ```go
  type GatewayUnderTest struct {
      Gateway       shell.PaymentGateway
      DeclineAmount core.Amount                 // sandboxes document magic values
      Inject        func(op string, f Fault)    // nil for a sandbox: fault clauses skip
      Charged       func(core.OrderID) int      // nil if unobservable: those checks skip
  }
  ```

- Observation hooks count **effects**, not distinct keys: `Charged` counts every time money moved, a notifier hook counts every delivery. A hook that de-duplicates by key hides the double effect the idempotency clause is looking for.
- Derive clauses from the capability's doc comment and the design's Failures table. For each operation: the success path, each **domain outcome** (and that it is stable on repeat), **idempotency** per key, independence of keys, and each **fault** — unreachable (nothing happened), lost response (it happened, nobody heard), and what the next call must see after each.
- Assert **error classes**, not messages: every error is one of the capability's classes (`ErrDeclined`/`ErrTransient`, `PaymentDeclined`/`Transient`); anything else is a defect and fails the clause.
- Allow what the contract allows. After a lost response, a client that retries an idempotent request on its own may succeed (Go's `http.Transport` does for requests with an `Idempotency-Key` header), so the clause accepts success or `Transient` and then checks money moved once.
- Give every clause fresh IDs unique to the run, so the suite can run repeatedly against a shared sandbox.

### Store clauses

Load of an unknown ID; commit saves state, bumps the version, appends the event; a stale version conflicts **and leaves nothing behind** (state, outbox, and the inbox: the same event can commit later); a version ahead of the stored one conflicts; a duplicate event ID is rejected and leaves nothing behind; concurrent commits at one version: exactly one wins; claim order and limit; lease and redelivery after it expires; complete; release; every State, Input and Command variant comes back exactly as committed (a real store serializes them).

### Simulators and sandboxes

- A **simulator** of the provider's API lets the live adapter (HTTP client, status mapping, timeouts) run the suite in every test run. It encodes your reading of the provider's documentation, so it can be wrong the same way the fake is.
- The **sandbox** run is the only one that checks that reading. Gate it on environment variables and run it in CI on a schedule or before releases.
- For a store, run the suite against the real database engine (PGlite, a container, a test database). Keep the SQL in one place and test that the store runs exactly the documented statements.

### Layout

- Go: the suite is an exported function in a normal package (`internal/shell/contract`), like `testing/fstest.TestFS`; the runs live in an external test package (`package shell_test`) so the suite can import `shell` without a cycle.
- TS: the suite is a function that registers `node:test` `describe`/`it` blocks (`paymentGatewayContract(name, make)`); one test file calls it for each implementation.

## Checking that tests can fail

For each property and each clause, make the smallest change that should break it (remove a guard, flip a comparison, map a status to the wrong class, record the inbox before the version check), run the tests, confirm one goes red, and restore. A test that survives its mutation is testing nothing; strengthen it. Mutation tools (Stryker for TS, `go-mutesting`) automate this; for the guarantees that matter, a targeted manual mutation per invariant is usually enough.
