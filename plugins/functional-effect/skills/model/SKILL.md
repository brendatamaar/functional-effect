---
description: The Model Functional Effect pattern — (state₂, commands) = f(state₁, input) — for writing or changing stateful logic in Go or TypeScript (plain or Effect). Use when implementing a feature with states and transitions (orders, workflows, async UI state, LLM agent loops), when code mixes logic with IO, or when a project has a .functional-effect.json. Scales by profile (core, service, distributed).
---

# Model Functional Effect

```
(state₂, commands) = f(state₁, input)      // pure: the functional core
commands → interpreted at the edge → inputs // effectful: the imperative shell
```

A program is a sequence of typed states. A pure function moves from one state to the next in response to an input and *describes* the effects it wants as data (commands). A thin shell performs those commands and feeds their results back as new inputs.

## The four layers

| Layer | Question | Tool |
|---|---|---|
| 1. State map | Which states can exist? | List every state, including loading, error, empty, retrying, cancelled |
| 2. Types | How do we make invalid states unrepresentable? | Sum types for State/Input/Command, branded/value types parsed at the boundary |
| 3. Transitions | Which state → state moves are legal? | One `step` function; its cases are the transition table |
| 4. Exploration | Which sequences did nobody think of? | Property tests: random input sequences, invariants checked after every step |

## Profiles: apply as much as the project needs

`profile` in `.functional-effect.json` (default `service`) sets how much of this skill applies: `core` (pure `step`, sum types, property tests), `service` (+ boundary, interpreter, failure classes, capabilities, contract tests), `distributed` (+ outbox, inbox, timers, unknown outcomes with fencing, replay, chaos tests). Sections below are marked with the profile they start at. Do not add an outbox to a CLI or a fence to a read-only call; see [references/profiles.md](references/profiles.md), and suggest raising the profile when a feature crosses a line (it starts moving money, sending mail, or calling something that cannot be retried).

## Rules for core files (all profiles)

The core is the path set in `.functional-effect.json` (`core`), commonly `internal/core/**` or `src/core/**`.

- Export `step(state, input) → (state, commands)` and a `run` fold over a list of inputs.
- `State`, `Input` and `Command` are closed sum types. Go: interfaces with an unexported marker method and a `//sumtype:decl` comment (checked by `gochecksumtype`). TS: discriminated unions with a `tag` field. Switches over them handle every variant explicitly; no catch-all `default` that would swallow a new variant.
- A plain status whose values carry no data of their own (`queued`, `running`, `done`) can stay a named enum: Go `type TaskStatus string` with constants and a `Validate`/parse function, TS a union of string literals. Use a sum type as soon as one variant carries data the others do not (an attempt, a reason, a tracking number). Never a raw `string` or a set of booleans.
- No IO, network, filesystem, database, console/logging, clock, randomness, timers, goroutines, environment variables, or `Effect.run*`. Randomness and generated IDs enter as fields on an `Input`.
- **Time is a command.** To wait, emit `ScheduleInput{after, input}`; the shell feeds `input` back when it is due (e.g. `PaymentTimedOut`). Never read the clock to decide.
- **Idempotency keys are derived in the core** from state (`charge:<orderId>:<attempt>`), so replays and redeliveries produce the same keys. *(service and up)*
- **Results and timers carry the attempt they belong to.** Guard on it, so a late result or a stale timer from an earlier attempt cannot move the current one. *(service and up)*
- Unhandled `(state, input)` pairs return `(state, no commands)`. Late, duplicated or out-of-order events are ignored this way.
- Values that need validation (amounts, IDs, emails) have smart constructors / branded types so an invalid value cannot exist past the boundary.
- Keep wire formats (JSON field names, `_tag`, nullable columns) out of the core; mapping them is the boundary's job.

## Rules for shell files (service and up)

- **Boundary**: every value from outside (HTTP body, webhook, queue message, DB row, env, file, LLM output) is `unknown` until parsed into a core type. Parse once, at the edge. TS: zod (or `Schema.decodeUnknownEffect` with Effect v4); Go: decode into a wire struct, then call core constructors.
- **Interpreter**: one function maps each `Command` to an effect and returns the `Input` it produces (or none). Domain outcomes become `Input` values (e.g. `PaymentFailed`); failures are handled by their class (below).
- **Capabilities** are injected, never imported globally: Go interfaces in a `Deps` struct with `context.Context`; TS a plain `Deps` object of interfaces (or, with Effect, services in the `R` of `Effect<A, E, R>`). If testing a function needs many fakes, it does too much: split it.
- **Cardinality** is decided per command: one value (Go: a call; TS: `Effect`), a stream of values over time (Go: channel/iterator in the shell; TS: `Stream`), or a time-bounded value that is cached with a TTL and deduplicated for concurrent callers.
- **Cross-cutting behavior** (retry, timeout, tracing, logging, caching) wraps the interpreter or a capability — `.pipe(...)` in Effect, middleware/decorators in Go — so the main flow stays readable.
- **Resources** (connections, files, locks) are acquired and released with their scope (`defer` in Go; `Effect.acquireRelease`/`Scope` in Effect), so release happens on error and interruption too.
- **Execution** happens once, at the entry point (`main`, the HTTP handler, the job runner): `Effect.runPromise`, or the Go/TS `main`.

## Failure classes (service and up)

Classify every way a command can fail into exactly one class:

| Class | Example | Handling |
|---|---|---|
| Domain outcome | declined, not found, out of stock, already exists | An `Input` and a state; never an error. The core decides what happens next. |
| Retry | timeout, rate limit, 503, connection reset | Retry with a schedule (backoff, max attempts) in the shell. **Only if the command is idempotent or carries an idempotency key**: a timeout does not mean the operation failed. |
| Escape hatch | cache miss on an optional enrichment, stale read allowed | Fallback value, recorded in the state or `Input` so the core knows it is degraded. |
| Die | broken invariant, impossible state, programmer error | A defect: not caught, surfaces loudly (Go: `panic` at the shell boundary or a wrapped fatal error; Effect: `Effect.die` / `orDie`). |

Translate errors at every layer so callers never see lower-layer types: e.g. `SqlError → RepositoryError → OrderError → HTTP 409`. In Effect this is `mapError`/`catchTag` per layer; in Go, wrap with a layer-specific sentinel or type and `%w`.

With `Effect.gen`, keep the generator body for the happy path and handle the error channel in the `.pipe(...)` after it. Handle inline only when two steps in the same body need different strategies for the same error type.

**Unknown outcome is its own case** *(distributed)*. When retries of a side effect are exhausted on a timeout, the effect may or may not have happened. Do not retry with a new key and do not record failure. Let the core's timer move to a `Reconciling` state that asks the other system what happened, through a **fenced** call: one that returns the final outcome and, if the operation was never seen, voids its key so a late redelivery of the original command cannot still execute it.

## Persistence, delivery and time (distributed)

Skip this section for `core` and `service` projects unless the code already has a store and a worker. `handle` is load → `step` → commit. The commit is one transaction that:

1. checks the **expected version** (optimistic concurrency: on conflict, reload and re-run `step`);
2. records the **event ID** in an inbox (a redelivered event is a no-op);
3. appends the input to the **event log**;
4. saves the new **state**;
5. inserts the commands into an **outbox** with deterministic IDs (`<eventId>#<index>`); `ScheduleInput` rows get `due_at = now + after`.

A **worker** claims due outbox rows with a lease, interprets each command, feeds the result back through `handle` with event ID `<itemId>:result`, then deletes the row. A crash anywhere leaves the row to be retried after its lease: delivery is at-least-once, and idempotency keys plus the inbox make the effect and its result happen once.

Saving state and performing the effect in the same request handler (without an outbox) loses or duplicates effects on a crash; flag it.

**Replay**: the stored state must always equal `run(initial, events)`. Test it.

The schema, the transaction and the claim query in SQL are in [references/outbox.md](references/outbox.md).

## Testing

Full patterns, both languages: [references/testing.md](references/testing.md). `/functional-effect:test` derives the tests from a design document. Core property tests apply to every profile; boundary and contract tests start at `service`; shell tests with crash points, concurrency and chaos start at `distributed`.

- **Core property tests**: random input sequences from a small domain (two IDs, a few attempts) so they collide, invariants checked after every step, **shrinking** to the shortest failing sequence. One property per invariant in the design document, named after it. Go: a seeded `math/rand` generator plus a remove-one-input shrinker (see the example), or `pgregory.net/rapid`. TS: `effect/Arbitrary` derives generators from a Schema and shrinks (unstable in Effect 4.0), or `fast-check`.
- **Boundary property tests**: round trip (`parse(encode(e)) == e`), accepted ⇒ valid (against a predicate written independently of the parser), rejects each broken rule, and in Go a fuzz target. Messy input perturbs valid events.
- **Contract tests**: every capability with a fake gets a contract suite, run against the fake and the live adapter (a simulator in every run; the sandbox or a real database when configured). Clauses use only the interface plus optional hooks, and assert error classes: success, each domain outcome, idempotency per key, unreachable and lost-response faults. The store contract covers version conflicts, the inbox, leases and serialization of every variant.
- **Shell tests** with fakes that pass their contract: duplicate delivery, a crash after the effect and after recording the result, lost responses, a stall longer than the timeout (fencing), the worst-case concurrent interleaving (every handler loads before any commits), and a seeded chaos run asserting the money/side-effect invariant.
- **Check that tests can fail**: remove a guard (the attempt check, the version check, the inbox, the fence, a parser rule, a status mapping) and make sure some test goes red. A concurrency test that cannot catch a missing version check is not testing concurrency.

## Writing a feature

Think in this order: shapes → states and transitions → happy-path call graph → cardinality → failures → requirements → boundary. `/functional-effect:design` turns that into a document before any code.

1. Write the state map, inputs and commands as types first.
2. Write `step` as a switch over the input, guarding on the current state. Every return is one row of the transition table.
3. Write property tests before the shell (see Testing): random input sequences, invariants after every step, shrinking.
4. Write the boundary parser and the interpreter, with each failure handled by its class.
5. *(distributed)* Persist through a store with version, inbox, event log and outbox; run commands from a worker.
6. Wire capabilities and run at the edge.

Already have a handler that mixes decisions and IO? `/functional-effect:extract` moves it into this shape one function at a time. Building an LLM agent loop? See [references/agent-loop.md](references/agent-loop.md).

## Showing a call graph

When explaining an execution flow, an architecture, or a design (in chat, a design document, or a review), show the call graph as plain text, not a rendered diagram: indented `→` arrows inside a `ts` or `go` code block. Mark the core and boundary nodes. When tests swap the implementations behind R, show a separate Tests graph:

```ts
// Production
HTTP POST /orders/events
  → parseEvent (boundary)
  → handle: load → step (core) → commit state + event + outbox (one transaction)

worker (every second)
  → claimDue
  → interpret ChargeCard
      → PaymentGateway.live.charge (retry: 3× backoff, key charge:<id>:<attempt>; then wait for timer)
  → interpret ResolvePayment
      → PaymentGateway.live.resolve (fenced)
  → interpret CreateShipment
      → Shipping.live.create (retry: 3× backoff, key ship:<id>; then retry later)
  → handle(<item>:result) → complete

// Tests
run(initial, inputs) (core only, property tests)
handle → MemoryStore
worker → PaymentGateway.fake, Shipping.fake (scripted failures, crash points)
```

The code should have the same shape as the graph. If it does not, either the graph or the code is wrong.

For patterns see [references/go.md](references/go.md), [references/typescript.md](references/typescript.md) (plain TypeScript: zod, `Deps`, fast-check) and [references/typescript-effect.md](references/typescript-effect.md) (Effect v4; choose it when `package.json` already depends on `effect`). The plugin's `examples/` folder has a complete `distributed`-profile order-checkout example in both languages: `${CLAUDE_PLUGIN_ROOT}/examples/go` and `${CLAUDE_PLUGIN_ROOT}/examples/typescript` (the latter uses Effect).

## Mapping to Effect<A, E, R> (only for projects that use Effect)

| Model | Effect |
|---|---|
| Command (description of an effect) | An `Effect` value: lazy, immutable, composable |
| Interpreter | Effect runtime / your `interpret` function |
| Domain outcome → Input | Error channel `E`, discharged with `catchTag` into a success value |
| Retry / escape hatch / die | `Effect.retry` + `Schedule`, `catchTag` with a fallback, `Effect.die` / `orDie` |
| One / stream / cached | `Effect` / `Stream` / `Effect.cachedWithTTL` or `Cache` |
| Capabilities the shell needs | Requirements channel `R`, discharged with `provide` |
| Run at the edge | `Effect.runPromise` in `main` only |
| The shell owns the clock | `Clock.currentTimeMillis` at the edge; `now` passed in below it |

## When the checker blocks an edit

A `PreToolUse` hook denies edits that add effects to core files and explains which line and why. Do not work around it (renaming, aliasing, indirection, writing the file through a shell command): the `Stop` hook re-checks every core file changed during the turn. Instead:

- Return a `Command` describing the effect and handle it in the shell, or
- Pass the needed value in through an `Input` field, or
- Move the code to a shell path.

`fe:allow <reason>` on a line marks a deliberate, reviewed exception. It is the user's decision, not yours: every new one triggers an approval prompt, and one without a reason suppresses nothing. Restructure first; propose an exception only when restructuring is clearly worse, and say why.

## When the verify command fails

If the project sets `verify` in `.functional-effect.json` and the user approved it, the `Stop` hook runs it after any turn that changed core files and returns the failing output. Treat it like a failing test: find the broken invariant or transition, fix the code (or the test if the test is wrong, and say so), and do not weaken assertions to make it pass.

## Claude Code itself follows the model

- Plan before editing (plan mode or `/functional-effect:design`): the plan is the program as a value.
- Hooks and permissions are the policy check between "command" and "effect".
- Sandboxes, worktrees and checkpoints are interpreters with isolated, revertible state.
- The session transcript is the event log; resume and fork replay it.
