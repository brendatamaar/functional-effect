---
description: Extract the decisions from an existing function, handler or module that mixes logic with IO into a pure Model Functional Effect core (State, Input, Command, step) with a thin shell, one flow at a time, behind characterization tests so behavior stays the same. Use when asked to refactor, migrate or adopt the model in existing code, or to pull business logic out of a handler.
argument-hint: "<file | file:function | package>"
arguments: [target]
---

# Extract: $target

Move the decisions out of code that already works, without changing what it does. One flow per run: a handler, a job, a reducer, a command. If the target is a whole package, list its flows, recommend one, and start there.

Behavior stays identical. Bugs you notice are reported at the end, not fixed on the way; fixing them is a separate change the user asks for.

## 1. Read

Read the target in full, its callers, and its tests. Read `.functional-effect.json` for `core`, `shell`, `profile` and `designDir`; if there is none, propose paths that fit the layout and offer `/functional-effect:setup` first. Find the design document for the feature in `designDir` if one exists.

## 2. Map what is there

Write this table and show it to the user. Stop for approval when the extraction moves more than one function or adds a new package:

| Where in the code | Kind | In the model |
|---|---|---|
| each branch or `switch` on data | decision | a row of the transition table in `step` |
| each value loaded before deciding (DB row, cache, config) | state | a field of `State`, loaded by the shell |
| each value read from the clock, random source or generator | input | a field on an `Input`, filled by the shell |
| each call that changes the world (write, send, charge, publish, log that matters) | effect | a `Command` |
| each result of an effect that changes the next decision | result | an `Input` (success and each domain outcome) |
| each error path | failure | one of the four classes (see the `functional-effect:model` skill) |
| each outside value (request, message, row, env) | boundary | a parser into core types |

Name the states the flow can be in, including the ones the code only has implicitly (a nullable column, a boolean pair, a status string). The state map is the extraction's real design; if it is large, run `/functional-effect:design` first and extract against that document.

Profile limits scope: `core` extracts decisions only; `service` also the boundary and the interpreter; `distributed` flows are extracted the same way, but introducing an outbox, inbox or fencing is a separate design, not part of an extraction. Name it as follow-up.

## 3. Pin the behavior first

Before touching anything, make sure the flow has tests that call it at its current boundary (the handler, the exported function) with fakes for what it calls, and that cover each branch in the map. Write characterization tests for the branches that have none, based on what the code does now, not what it should do. Run them against the unchanged code; they must pass. Do not continue without them: this is what proves the extraction is a refactor.

## 4. Extract in small steps

Run the characterization tests after every step; a red test means undo the last step.

1. **Types.** Add `State`, `Input` and `Command` in a core path: closed sum types when variants carry different data (see the model skill for the rule and for Go and TypeScript patterns). Nothing uses them yet.
2. **`step`.** Move each decision into `step(state, input) → (state, commands)`, one transition at a time, calling the new function from the old code in place of the inline branch. Unhandled pairs return the state unchanged with no commands. The purity checker will deny effects in core files; restructure, never add `fe:allow`.
3. **Boundary** (service and up). Replace ad hoc casting and validation of outside values with one parser per source that produces core types (zod or equivalent, a wire struct plus constructors in Go).
4. **Interpreter.** Move each effect into a function from `Command` to the `Input` it produces, with capabilities passed in. Map each failure to its class; domain outcomes become `Input` values.
5. **Thin the original.** The old function becomes: load → parse → `step` → interpret commands → feed results back → return what it returned before. Its signature and observable behavior do not change.
6. **Remove** the logic that is now duplicated, then re-run the whole test suite.

## 5. Add what extraction makes possible

Now that `step` is pure, write the tests that were impractical before, per profile (`/functional-effect:test` does this from a design document, or from the code if there is none): a property test per invariant you can state about the state map, a case per transition row, and for the boundary the round-trip and rejects-each-rule properties. Keep the characterization tests until the property tests cover the same branches.

## 6. Report

Show: the before and after call graph (plain text, indented `→` arrows, core and boundary nodes marked), the state map and transition table that came out, the files added and changed, the tests added and their results, and the **findings noticed on the way**: bugs, unreachable branches, retries on non-idempotent calls, states the old code could reach that should not exist. Ask which to act on; do not fix them in this run.
