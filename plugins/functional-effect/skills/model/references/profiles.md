# Profiles: how much of the model applies

`profile` in `.functional-effect.json` says how much of the model a project adopts. It decides which sections `design` writes, which tests `test` derives, and which checklist `fe-reviewer` applies. Without it the profile is `service`.

| Profile | For | Adds |
|---|---|---|
| `core` | CLIs, libraries, UI reducers, parsers, anything whose decisions are worth isolating but whose effects are simple | Pure `step`, sum types, property tests per invariant |
| `service` (default) | HTTP services, jobs, tools that call databases and APIs | `core` + boundary parsers, interpreter, failure classes, injected capabilities, contract tests |
| `distributed` | Money, inventory or anything where a crash or redelivery must not duplicate or lose an effect | `service` + outbox, inbox, version check, timers as commands, unknown outcomes with fencing, replay, crash/concurrency/chaos tests |

A higher profile includes everything in the lower ones. Pick the lowest profile that is honest about the failure you cannot afford: a retried payment is `distributed`; a retried read is not.

## What each skill does per profile

| | `core` | `service` | `distributed` |
|---|---|---|---|
| **design** sections | State map, Inputs, Transition table, Invariants, Commands (names only), Files, Open questions | + Commands (cardinality, idempotency), Call graph, Failures, Requirements, Boundary | + Persistence and delivery |
| **test** derives | A property per invariant, a case per transition row | + boundary properties, a contract suite per fake | + store contract, crash, duplicate, concurrency and chaos tests |
| **fe-reviewer** applies | Core checklist, core tests | + shell checklist, boundary and contract tests | + persistence, delivery and time checklist, shell tests |
| **model** sections | Rules for core files, Testing (core) | + Rules for shell files, Failure classes | + Persistence, delivery and time, unknown outcomes |

## Rules

- Never report a gap that belongs to a higher profile than the project's. A `core` project without an outbox is not missing an outbox.
- Say which profile you applied at the top of a design, a test map or a review.
- If the code already does something from a higher profile (an outbox, fencing), review it as written; the profile limits what you ask for, not what you check.
- When a feature crosses a line (a `core` project starts charging cards), say so and suggest raising the profile in `.functional-effect.json`.
