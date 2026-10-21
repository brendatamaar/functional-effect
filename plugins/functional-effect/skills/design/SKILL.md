---
description: Design a feature with Model Functional Effect before writing code — state map, transition table, call graph, cardinality, failure classes, requirements and boundary — then stop for approval. Use when asked to design, plan or spec a feature that has states, workflows, async flows, retries, external calls or an agent loop.
argument-hint: "[feature]"
arguments: [feature]
---

# Design: $feature

Produce the design as a value first; implement only after the user approves it. A plan the user can review is cheaper to change than code.

## 1. Gather

Read the code the feature touches (or will touch). Check `.functional-effect.json` for the project's core and shell paths, `profile` and `designDir`; if there is none, propose paths that fit the existing layout, `designDir` `docs/design`, and a profile (see [profiles](${CLAUDE_PLUGIN_ROOT}/skills/model/references/profiles.md): `core` for pure logic with simple effects, `service` by default, `distributed` when a crash or redelivery must not duplicate or lose an effect). Identify every source of outside data and every side effect involved. If the feature needs a higher profile than the project's, say so and propose raising it.

## 2. Think in this order

Each step narrows the next one. Do not jump ahead. Steps 3 to 7 are for `service` and up; a `core` design stops after step 2 and lists the commands by name.

1. **Shapes.** Name the domain nouns: records, branded IDs/values, the state variants, and the inputs.
2. **States and transitions (the decisions).** Draw the state map and the transition table: what the pure `step` decides.
3. **Happy path (A).** Draw the call graph of the shell from the entry point to the outside world: what runs, in which order, for the success case.
4. **Cardinality.** For every node and command: one value, a stream of values over time, or a time-bounded value that is cached and deduplicated.
5. **Failures (E).** Classify every way each node can fail (see the table below).
6. **Requirements (R).** List the capabilities each node needs. The program can run when all of them are provided.
7. **Boundary.** Every outside source and its parser.

## 3. Write the design document

Save it to `<designDir>/$feature.md` (default `docs/design/`; create the folder if needed; use a kebab-case file name). Put the profile on the line under the title. Use these sections, leaving out those that start at a higher profile than the project's (marked below):

````markdown
# <Feature> — Model Functional Effect design
Profile: core | service | distributed

## State map
Every state the feature can be in, one line each, with the data it carries.
Include the ones that are easy to forget: empty, loading, partial, retrying,
timed out, cancelled, rejected, already-done.

## Inputs
Everything that can happen: user actions, external events, and the results of
commands (success and each domain outcome). Clock/random values arrive here.

## Transition table
| From state | Input | Guard | To state | Commands |
Every legal hallway. State explicitly: "any other (state, input) pair: no change, no commands."

## Invariants
Properties that must hold after every step, phrased so a property test can
check them (e.g. "at most N charges", "Shipped only after Paid", "no command
after Cancelled"). Name the property test for each one.

## Commands
(core: a name and one line each. service and up:)
| Command | Cardinality | Idempotent | Produces |
Cardinality: one / stream / cached (with TTL and dedup key). Idempotent: yes,
no, or "yes with key <idempotency key>". Produces: the Input(s) fed back.

## Call graph  (service and up)
Plain text, indented `→` arrows, in a `ts` (or `go`) code block. Show
Production, and Tests when the layers behind R differ:

```ts
// Production
HTTP POST /orders
  → parseInput (boundary)
  → step (core)
  → interpret ChargeCard
      → PaymentGateway.live → payments API
```

```ts
// Tests
run(initial, inputs) (core, no shell)
interpret ChargeCard
  → PaymentGateway.memory
```

## Failures  (service and up)
| Node | Failure | Class | Handling |
Class is exactly one of: domain outcome, retry, escape hatch, die (definitions
and the retry-only-if-idempotent rule: "Failure classes" in the
functional-effect:model skill). Note how errors are translated at each layer so
callers never see lower-layer error types.

## Requirements  (service and up)
| Capability | Live | Test | Contract |
Capabilities (Go interfaces / Effect services) per node, the live and test
implementation of each, and the contract suite both must pass: its clauses
(success, each domain outcome, idempotency, each fault) and where it runs
(fake, simulator, sandbox or real database and the environment variables that
enable it). If a node needs many fakes to test, it does too much: split it.

## Persistence and delivery  (distributed)
- Where state, event log, inbox and outbox live, and the expected-version check
  on commit. Effects never run inside the request handler or the transaction.
- Event ID of every producer (user, webhook, worker result) and how long the
  inbox keeps them.
- Timers: each ScheduleInput, its delay, and what happens when it fires late or
  for an attempt that already resolved.
- Commands whose outcome can be unknown (timeout after the request was sent),
  and the fenced call that reconciles them.
- Shell invariants, phrased for a chaos test (e.g. "money moves at most once
  per order, and only for orders that ship").

## Boundary  (service and up)
| Source | Parser | Produces | Rejects |
Each outside source → its parser → the core type it produces. Note what is
rejected and how the rejection is reported. Each row gets the boundary
properties: round trip, accepted ⇒ valid, rejects each rule (and a fuzz
target in Go).

## Files
Planned files under core and shell, the property tests to write first, and
the contract suites.

## Open questions
Decisions the user must make.
````

Keep it concrete: real type and field names in the project's language. Prefer a smaller state space; merge states that never behave differently and split ones that do. A stateless request/response feature may have a single trivial state; then the call graph, failures and requirements carry the design.

## 4. Show and stop

Give the user a short summary (number of states, inputs and commands; non-idempotent commands; notable invariants and open questions) and the file path. Ask for approval or changes. Do not write implementation code in this turn.

## 5. After approval

Implement in this order (skipping what the profile leaves out): core types → `step`/`run` → property tests, one per invariant (run them) → boundary and its properties → capabilities with their contract suites (fake first, then the live adapter) → interpreter → store and worker, against the store contract (distributed) → shell tests (crash points, duplicates, concurrency, chaos; distributed) → wiring. `/functional-effect:test` builds the test map from this document. Follow the `functional-effect:model` skill. Update the design document if the implementation forces a change to the transition table, call graph or failure classes.
