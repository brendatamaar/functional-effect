---
description: Derive and write the tests a Model Functional Effect feature needs from its design document — property tests for every invariant and every boundary parser, contract suites for every capability with a fake — then prove each test can fail. Use when asked to write, add or review tests for stateful logic, a parser, a fake, an adapter or a store.
argument-hint: "[feature]"
arguments: [feature]
---

# Test: $feature

Tests follow from the design, not from the code: each invariant, each boundary rule and each capability's promises becomes a named test. Read `references/testing.md` in the `functional-effect:model` skill for the patterns and the Go, TypeScript and Python layout before writing anything.

## 1. Find the design

Read `<designDir>/$feature.md` (`designDir` in `.functional-effect.json`, default `docs/design`). If there is none, derive the same information from the code (the State, Input and Command types, `step`, the parsers, the capability interfaces and their doc comments) and tell the user the test map is based on the code because no design document exists. Read `.functional-effect.json` for the core and shell paths and the `profile`, and look at the existing tests so new ones match their style and helpers.

## 2. Build the test map

Write it as a table and show it to the user before writing tests when it adds more than a few tests. State the profile at the top and derive only the rows it includes (`core`: invariants and transition rows; `service`: also boundary and contract rows; `distributed`: also the store contract and shell rows). A missing row for a higher profile is not a gap:

| Source in the design | Test | Kind |
|---|---|---|
| each line under **Invariants** (core) | one property, named after the invariant | property test over input sequences, with shrinking |
| each row of the **Transition table** | one case | table test |
| each row of **Boundary** | round trip, accepted ⇒ valid, rejects each rule; a fuzz target in Go (Hypothesis in Python) | property tests |
| each capability in **Requirements** with a fake | one contract suite, run against the fake and the live adapter (simulator; sandbox or real database gated on environment variables) | contract test |
| the Store in **Persistence and delivery** | the store contract | contract test |
| each shell invariant | crash, duplicate, concurrency or chaos test | shell test |

Contract clauses come from the capability's doc comment and the **Failures** table: the success path, each domain outcome and its stability on repeat, idempotency per key, independence of keys, and each fault (unreachable, lost response) with what the next call must see. Clauses assert error classes, use only the interface plus optional hooks (`Inject`, `Charged`), and use IDs unique to the run.

An invariant, rule or promise you cannot turn into a test is a gap in the design: list it under the design's Open questions instead of writing a weak test.

## 3. Write the tests

- Properties never restate the implementation, and the `valid` predicate for a parser is written independently of the parser.
- Generators use a small domain so inputs collide; messy boundary input perturbs valid events and asserts that some are accepted.
- Every failure message names the invariant, rule or clause and shows the minimal input.
- A capability whose fake has no contract suite gets one before new shell tests rely on that fake.
- Add live adapters' sandbox runs behind environment variables and say which variables they need; never put credentials in the repository.

## 4. Run them

Run the new tests and the existing suite. If a new test fails, decide whether the test or the code is wrong before changing either, and tell the user which: a contract clause that fails only against the real implementation is a finding about the fake or the adapter, not a flaky test.

## 5. Prove each test can fail

Mutate a **scratch copy**, never the working tree, so a half-finished mutation can never mix with the user's uncommitted work:

1. Create the copy: `git worktree add <scratchpad>/mutants HEAD --detach`, then copy the working tree's changed and untracked files into it (or, outside git, copy the source folder). Install dependencies there if the tests need them (symlink `node_modules`, or run the package manager's install).
2. For every new property and clause, make the smallest change in the copy that should break it (remove a guard or a check, flip a comparison, map an error to the wrong class, drop a field in an encoder), run the tests there, confirm a test goes red, and revert that change in the copy before the next one.
3. Budget: one mutation per property or clause, at most about 30 per run; for more, mutate the guards that carry the most risk (attempt check, version check, inbox, fence, each parser rule) and say which ones were left out. Prefer running only the test file that should catch the mutation.
4. Remove the copy when done: `git worktree remove --force <scratchpad>/mutants`. The working tree was never touched, so there is nothing to restore.

A test that survives its mutation is rewritten or reported, never kept as is.

## 6. Report

End with the test map, each row marked passing, skipped (and why, e.g. no sandbox configured) or failing, the mutations that were caught, and any gaps added to the design's Open questions. Update the design document's Invariants, Requirements and Boundary sections with the test and suite names.
