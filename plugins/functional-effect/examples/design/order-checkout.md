# Order checkout — Model Functional Effect design
Profile: distributed

The design behind `examples/go` and `examples/typescript`. It follows the template produced by `/functional-effect:design`.

## State map

- `Draft` — nothing submitted yet.
- `AwaitingPayment { orderId, amount, attempt }` — a charge for `attempt` is in flight.
- `Reconciling { orderId, amount, attempt }` — the charge outcome is unknown (no answer before the timeout); asking the gateway.
- `Paid { orderId }` — payment confirmed, shipment being created.
- `Shipped { orderId, trackingNo }` — done; terminal.
- `Failed { orderId, amount, attempt, reason }` — declined or confirmed not charged; the user may retry.

## Inputs

- `Submit { orderId, amount }` — user.
- `PaymentSucceeded { orderId, attempt }` — result of `ChargeCard` / `ResolvePayment`, or a gateway webhook.
- `PaymentFailed { orderId, attempt, reason }` — same sources (domain outcome: declined / not charged).
- `PaymentTimedOut { orderId, attempt }` — the timer from `ScheduleInput`; internal only, never accepted at the boundary.
- `ShipmentCreated { orderId, trackingNo }` — result of `CreateShipment`.
- `Retry { orderId }` — user.

## Transition table

| From state | Input | Guard | To state | Commands |
|---|---|---|---|---|
| Draft | Submit | — | AwaitingPayment(1) | ChargeCard(key 1), ScheduleInput(10m, PaymentTimedOut 1) |
| AwaitingPayment / Reconciling | PaymentSucceeded | same order and attempt | Paid | CreateShipment(key ship) |
| AwaitingPayment / Reconciling | PaymentFailed | same order and attempt | Failed | NotifyCustomer |
| AwaitingPayment / Reconciling | PaymentTimedOut | same order and attempt | Reconciling | ResolvePayment(key n), ScheduleInput(10m, PaymentTimedOut n) |
| Failed | Retry | same order, attempt < 3 | AwaitingPayment(n+1) | ChargeCard(key n+1), ScheduleInput(10m, PaymentTimedOut n+1) |
| Paid | ShipmentCreated | same order | Shipped | NotifyCustomer |

Any other (state, input) pair: no change, no commands. Results and timers for another order or an earlier attempt are ignored by the guards.

## Invariants

Core (property tests in `order_test.go` / `order.test.ts`, one per line):

| Invariant | Property test |
|---|---|
| `step` is deterministic. | `TestStepIsDeterministic` / "step is deterministic" |
| At most 3 `ChargeCard` per order, each with a unique key. | `TestAtMostMaxChargesWithUniqueKeys` / "at most MAX_PAYMENT_ATTEMPTS charges per order, each with a unique key" |
| Every `ChargeCard` comes with a `ScheduleInput` timeout for the same attempt. | `TestEveryChargeHasATimeout` / "every charge comes with a timeout for the same attempt" |
| `CreateShipment` only for an order that reached `Paid`. | `TestShipmentOnlyAfterPaid` / "a shipment is only created after Paid" |
| `Shipped` is reached only from `Paid`, and is terminal. | `TestShippedOnlyFromPaidAndTerminal` / "Shipped is reached only from Paid, and is terminal" |
| A result or timer for a stale attempt never changes the state. | `TestStaleAttemptsNeverChangeState` / "stale attempts never change the state" |

Shell (chaos and crash tests in `shell_test.go` / `shell.test.ts`):

- Money moves at most once per order, and only for orders that end `Shipped`; a `Failed` order was never charged.
- Each delivery is processed once; concurrent deliveries emit each command once.
- The stored state always equals `run(initial, events)`.

## Commands

| Command | Cardinality | Idempotent | Produces |
|---|---|---|---|
| ChargeCard | one | yes with key `charge:<orderId>:<attempt>` | PaymentSucceeded, PaymentFailed, or nothing (outcome unknown) |
| ResolvePayment | one | yes (fenced: voids an unseen key) | PaymentSucceeded, PaymentFailed, or nothing (retry at the next timer) |
| CreateShipment | one | yes with key `ship:<orderId>` | ShipmentCreated |
| NotifyCustomer | one | no; duplicates tolerable (at-least-once) | — |
| ScheduleInput | one, delayed | yes (deterministic outbox ID) | its Input when due |

## Call graph

```ts
// Production
POST /orders/events (raw JSON)
  → parseEvent (boundary: wire struct + constructors / Effect Schema)
  → handle(eventId, input)
      → load → step (core) → commit state + event + inbox + outbox (one transaction)

worker
  → claimDue(now)
  → interpret ChargeCard     → PaymentGateway.live.charge   (retry 3× backoff, same key; then wait for timer)
  → interpret ResolvePayment → PaymentGateway.live.resolve  (fenced; retry 3×; then next timer)
  → interpret CreateShipment → Shipping.live.create         (retry 3×; then release +30s)
  → interpret NotifyCustomer → Notifier.live.send           (best effort)
  → interpret ScheduleInput  → (its Input)
  → handle(<itemId>:result) → complete
```

```ts
// Tests
run(initial, inputs)                    core only: property tests with shrinking
handle → MemStore / MemoryStore         (barrier store for the worst-case interleaving)
worker → FakeGateway, FakeShipping, FakeNotifier (scripted: Normal, Decline, Transient, LostResponse)
       crash points: AfterEffect, AfterResult
```

## Failures

| Node | Failure | Class | Handling |
|---|---|---|---|
| parseEvent | malformed, invalid or unknown event; missing eventId | domain outcome (at the boundary) | rejected; never reaches the core |
| ChargeCard | card declined | domain outcome | `PaymentFailed` → `Failed` → user may `Retry` |
| ChargeCard | timeout / 503 / lost response | retry, then escape hatch | 3× with the same key; still unknown → wait for `PaymentTimedOut` → `Reconciling` |
| ResolvePayment | gateway unavailable | retry, then escape hatch | 3×; still unavailable → the next timer resolves again |
| CreateShipment | timeout / 503 | retry | 3× with key `ship:<id>`, then release and retry in 30s |
| NotifyCustomer | provider down | escape hatch | logged and dropped |
| commit | version conflict | retry | reload and re-run `step` (up to 10×) |
| commit | duplicate event ID | domain outcome | no-op, return current state |
| worker | crash at any point | retry | lease expires; at-least-once redelivery, made safe by keys and the inbox |
| step | impossible state | die | not caught |

## Requirements

| Capability | Live | Test | Contract |
|---|---|---|---|
| PaymentGateway.charge / resolve | `HTTPGateway` / `httpGateway`: payments API client with idempotency keys and a fenced resolve endpoint | `FakeGateway` (idempotent, fenced, scripted) | `contract.PaymentGateway` / `paymentGatewayContract`: charge reported by resolve; idempotent per key; decline is a stable domain outcome; resolve fences unseen keys; keys independent; unreachable charge has no effect; lost response charges once and resolve finds it; unreachable resolve does not fence. Runs against the fake and the adapter + simulator every run, and the sandbox when `PAYMENTS_SANDBOX_URL` (+ `_KEY`, `_DECLINE_AMOUNT`) is set. |
| Shipping.create | shipping API client with idempotency keys | `FakeShipping` | not yet: no live adapter in the example |
| Notifier.send | email/SMS provider | `FakeNotifier` | not needed: best effort, nothing relies on its behavior |
| Store | `PgStore` (TS) on PostgreSQL ([outbox.md](../../skills/model/references/outbox.md)) | `MemStore` / `MemoryStore` | `contract.Store` / `storeContract`: version, inbox, conflicts leave nothing behind, a version ahead conflicts, concurrent commits, claim order, leases, release, complete, serialization of every variant. Runs against the in-memory stores, and `PgStore` on PGlite (TS). |

## Persistence and delivery

- One `orders` row per order with a version; `inbox`, `order_events` and `outbox` tables; see the SQL reference.
- Event IDs: user and webhook events carry `eventId`; worker results use `<outboxId>:result`; outbox IDs are `<eventId>#<index>`.
- Timers: `PaymentTimedOut` after 10 minutes per attempt; a late timer for a resolved attempt is ignored.
- Unknown outcome: only `ChargeCard`; reconciled by the fenced `resolve`.
- Shell invariant: money moves at most once per order, and only for orders that ship.

## Boundary

| Source | Parser | Produces | Rejects |
|---|---|---|---|
| Event JSON | `ParseEvent` (Go) / `parseEvent` (TS); inverse `EncodeEvent` / `encodeEvent` | `Event { id, input }` | empty eventId, unknown `_tag` (including `PaymentTimedOut`), empty orderId, non-positive or non-integer amount, attempt outside 1–3, empty trackingNo |

Properties (`boundary_test.go` / `boundary.test.ts`): round trip, accepted ⇒ valid, rejects each broken rule; `FuzzParseEvent` in Go.

## Open questions

- The Store service has no error channel for database failures (they are defects in `PgStore`). Should it get a `StoreUnavailable` error, classified as retry?
- Does the real payment gateway offer a fenced status/void call? If not, reconciliation needs a manual review queue for unknown outcomes.
- Should `Failed` after 3 attempts become a terminal `Abandoned` state?
- How long do webhook producers retry? That sets the inbox retention.
