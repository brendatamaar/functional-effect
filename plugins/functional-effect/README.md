# Model Functional Effect

A Claude Code plugin for one mental model:

```
(state₂, commands) = f(state₁, input)
```

A program is a sequence of typed states. A pure function moves from one state to the next in response to an input and *describes* the effects it wants as data. A thin shell performs those effects and feeds their results back as inputs. The ideas come from type-driven design ("make illegal states unrepresentable", "parse, don't validate"), Pure UI's state map, functional core / imperative shell, and effect systems such as Effect's `Effect<A, E, R>`.

The plugin applies the model at two layers:

| Layer | What it governs | How |
|---|---|---|
| **1. The code** | Code Claude writes in your repo | A purity check on every edit to core files, an approved verify command after every turn that changes them, path-scoped rules, a reviewer agent, Go, TypeScript and Python patterns |
| **2. The agent** | How Claude itself works | Design as a value before code, policy between command and effect (including your approval of every exception), isolated interpreters |

## What's inside

| Component | Name | Purpose |
|---|---|---|
| Skill | `functional-effect:model` | The pattern, rules for core and shell files, references for Go, plain TypeScript, Effect, Python, LLM agent loops and profiles. Claude loads it when relevant. |
| Skill | `/functional-effect:design <feature>` | Writes `docs/design/<feature>.md` — state map, transition table, invariants, commands with cardinality and idempotency, call graph (production and tests), failure classes, requirements, boundary — and stops for approval. |
| Skill | `/functional-effect:setup` | Configures a repo: core/shell paths, profile, design folder, verify command, rules file, baseline scan, optional CI lint rules and permission policy. |
| Skill | `/functional-effect:extract <target>` | Moves the decisions of an existing handler or function that mixes logic with IO into a pure core, one flow at a time, behind characterization tests so behavior stays the same. Reports the bugs it notices instead of fixing them. |
| Skill | `/functional-effect:check [--changed]` | Scans core files for effects and proposes refactors (edits after asking). `review` is the read-only judgment of design, tests and shell. |
| Skill | `/functional-effect:review [path ...] [--all] [--write <file>]` | Runs the reviewer on the current changes, on given paths, or on the whole repository as a baseline sorted into fix now / fix when touched / fine. Read-only; can write the report to a file. |
| Skill | `/functional-effect:test [feature]` | Derives the tests from a design document — a property test per invariant and per boundary parser, a contract suite per capability with a fake — writes them, runs them, and proves each one can fail by mutating a scratch copy, never your working tree. |
| Skill | `/functional-effect:verify [status\|approve\|revoke]` | Review and approve the command that runs after turns that change core files. |
| Agent | `functional-effect:fe-reviewer` | Read-only review of changes against the model, including persistence, delivery, property and contract tests. |
| Hooks | SessionStart, UserPromptSubmit, PreToolUse, Stop | Context and config warnings; a per-turn baseline; deny edits that add effects and ask before new exceptions; re-check and verify at the end of a turn. |
| Schema | `schema/functional-effect.schema.json` | JSON Schema for `.functional-effect.json`. |
| Templates | `templates/` | `.functional-effect.json`, `.claude/rules` file, golangci-lint (depguard, forbidigo, gochecksumtype), ESLint flat config (purity rules, switch exhaustiveness), ruff + pyright config (banned imports, exhaustive `match`), Claude Code permission policy. |
| Evals | `evals/` | Behavior and trigger cases for the skills, run with `claude plugin eval`. |
| Examples | `examples/go`, `examples/typescript`, `examples/python` | The same `distributed`-profile order checkout in both languages: pure core with timers and idempotency keys, shrinking property tests, boundary properties (and a Go fuzz target), an interpreter with a strategy per command, an HTTP payment adapter with a simulator, contract suites for the gateway and the store (TS: also against PostgreSQL), a store with version/inbox/event log/outbox, a worker, replay, and crash/concurrency/chaos tests. `examples/design/order-checkout.md` is the matching design document. `examples/python` is a compact `core`-profile version (frozen-dataclass sum types, `match` with `assert_never`, boundary parser, shrinking property tests). |

## Profiles

Not every project needs an outbox. `profile` in `.functional-effect.json` sets how much of the model `design`, `test` and `fe-reviewer` apply, and nothing above it is reported as a gap:

| Profile | For | Adds |
|---|---|---|
| `core` | CLIs, libraries, parsers, UI reducers | Pure `step`, sum types, property tests |
| `service` (default) | HTTP services, jobs, tools calling databases and APIs | Boundary parsers, interpreter, failure classes, injected capabilities, contract tests |
| `distributed` | Money, inventory, anything where a crash or redelivery must not duplicate or lose an effect | Outbox, inbox, version check, timers, unknown outcomes with fencing, replay, crash/concurrency/chaos tests |

Details: [`references/profiles.md`](skills/model/references/profiles.md). LLM agent loops (tool calls as commands, approval as policy, budgets as invariants): [`references/agent-loop.md`](skills/model/references/agent-loop.md).

## Thinking order

Shapes → states and transitions → happy-path call graph → cardinality (one / stream / cached) → failures → requirements → boundary.

Every failure gets exactly one class:

| Class | Handling |
|---|---|
| Domain outcome | Becomes an `Input` and a state, never an error |
| Retry | Retry with a schedule — only for idempotent commands or with an idempotency key |
| Escape hatch | Fallback value, recorded so the core knows it is degraded |
| Die | A defect: not caught, surfaces loudly |

Call graphs are shown as plain text with indented `→` arrows, with a separate Tests graph when tests swap the implementations behind the capabilities. The code should have the same shape as the graph.

## How the purity check works

The hooks do nothing until a repository opts in with a `.functional-effect.json`.

1. **Policy before effect (PreToolUse).** Before `Write`/`Edit` touches a core file, the checker computes the file's proposed content and denies the edit if it *adds* an effect: IO/network/database imports (including Go dot-imports), clock reads, randomness, console output, timers, goroutines, process and browser globals, or `Effect.run*`; in Python also `os`/`subprocess`/`socket`/`asyncio`/`threading`/`time`/`random`/`logging` imports, `print`/`open`/`input`, `datetime.now()` and `uuid4()` — as calls or as function values (`const now = Date.now`). Claude sees the line, the reason and how to restructure.
2. **Ratchet.** Only newly added violations block, keyed by rule and matched token, so renaming a variable on a legacy line does not count as new. Legacy code never blocks unrelated edits.
3. **Exceptions are yours.** `fe:allow <reason>` on a line (or `fe:allow-file <reason>` in the first five lines) marks a reviewed exception. Every new one triggers an approval prompt; one without a reason suppresses nothing.
4. **Per-turn baseline (UserPromptSubmit + Stop).** When you send a prompt, core files you have already changed are snapshotted. At the end of the turn, only what changed *during the turn* (edits, shell commands, even commits) is re-checked, so your own uncommitted work is never blamed on Claude. New violations send Claude back to fix them, at most three times per turn; new exceptions added outside the edit tools are reported to you.
5. **Verify.** If the config sets `verify` and you approved it (`/functional-effect:verify approve`), the Stop hook runs it after every turn that changed core files; a failure sends Claude back with the output. The approval is stored outside the repository and bound to the exact command, so a repository cannot make your machine run something new.

Unknown keys and invalid values in the config are reported at session start (with "did you mean" suggestions) instead of being ignored silently. If `.claude/rules/functional-effect.md` has different `paths:` than `core`, session start warns about that too.

The checker is a static, heuristic analysis (zero-dependency Node script). It catches the common cases, not every indirect effect; the `fe-reviewer` agent and the CI templates cover more.

### `.functional-effect.json`

```json
{
  "core": ["internal/core/**", "src/core/**"],
  "shell": ["internal/shell/**", "cmd/**", "src/shell/**", "src/main.ts"],
  "exclude": [],
  "mode": "deny",
  "stopCheck": "changed",
  "profile": "service",
  "designDir": "docs/design",
  "verify": { "command": "go test ./internal/core/...", "timeout": 120 },
  "rules": {
    "go": { "forbidImports": [], "allowImports": [], "forbidCalls": [] },
    "ts": { "forbidImports": [], "allowImports": [], "forbidCalls": [] },
    "py": { "forbidImports": [], "allowImports": [], "forbidCalls": [] }
  }
}
```

| Field | Default | Meaning |
|---|---|---|
| `core` | common core paths (`internal/core`, `src/core`, `src/*/core`, `core`) | Globs for pure files |
| `shell` | common shell paths | Globs for shell files (shown to Claude as context) |
| `exclude` | tests (`*_test.go`, `*.test.*`, `test_*.py`, `conftest.py`), `testdata`, `.d.ts` | Extra globs to skip |
| `mode` | `deny` | `deny` blocks the edit; `warn` allows it and adds the report as context |
| `stopCheck` | `changed` | `changed` re-checks core files changed during the turn (needs git); `off` disables it |
| `profile` | `service` | `core`, `service` or `distributed`: how much of the model applies (see Profiles) |
| `designDir` | `docs/design` | Folder for design documents |
| `verify` | — | Command (or `{ command, timeout }`) run after turns that change core files, once you approve it |
| `rules.<lang>.forbidImports` | — | Extra import prefixes to forbid |
| `rules.<lang>.allowImports` | — | Import prefixes to always allow |
| `rules.<lang>.forbidCalls` | — | Extra regular expressions to forbid |

## Layer 2: Claude Code as a functional effect

| Model | Claude Code |
|---|---|
| Program as a value | Plan mode, `/functional-effect:design` — reviewed before anything runs |
| Policy check | Permission rules, the PreToolUse hook |
| Interpreter | Tools running in a sandbox, a worktree, or your checkout |
| Event log, replay | Session transcript; resume and fork |
| Revertible state | Checkpoints, git worktrees |

`/functional-effect:setup` can merge a small permission policy (`templates/settings.layer2.json`) into `.claude/settings.json`.

## Persistence, delivery and time

The examples go past the pure core into what makes it survive production:

- **Time is a command**: `ScheduleInput{after, input}` becomes a delayed outbox row; when it is due, its input goes back to the core.
- **Idempotency keys are derived from state** (`charge:<order>:<attempt>`), and results and timers carry their attempt, so stale ones are ignored.
- **One transaction per input**: version check, inbox, event log, state and outbox together. A worker drains the outbox with leases (at-least-once), made safe by keys and the inbox.
- **Unknown outcome ≠ failure**: a charge that timed out after being sent moves to `Reconciling`, which asks the gateway through a *fenced* call that voids unseen keys, so a late redelivery cannot charge an order already marked failed.
- **Replay**: the stored state always equals `run(initial, events)`.

`skills/model/references/outbox.md` has the PostgreSQL schema, transaction and claim query; `test/outbox-sql.test.mjs` runs those exact statements against PostgreSQL (PGlite).

## Testing

Each layer of the model gets the test that fits it ([`references/testing.md`](skills/model/references/testing.md)):

| Layer | Test |
|---|---|
| Core `step` | property tests over input sequences, one per invariant, shrinking to the shortest failing sequence |
| Boundary parser | round trip, accepted ⇒ valid, rejects each broken rule; a fuzz target in Go |
| Capabilities | a contract suite per capability, run against the fake **and** the live adapter, so the fake cannot drift from the real thing |
| Shell | fakes that pass their contract, with crash points, duplicates, worst-case interleaving and a seeded chaos run |

The contract suites in the examples run in three places:

```
PaymentGateway   FakeGateway               every run
                 HTTP adapter + simulator  every run
                 HTTP adapter + sandbox    PAYMENTS_SANDBOX_URL, _KEY, _DECLINE_AMOUNT
Store            in-memory store           every run
                 PgStore on PostgreSQL     every run (PGlite, TypeScript)
```

Every property and clause in the examples was checked by breaking the code it guards and watching it fail.

## Install

Requires Node.js 18+ on `PATH` (used by the hooks). The Python example needs Python 3.11+. The hooks run with `node` directly, so they work on Windows, macOS and Linux.

```bash
# from GitHub
claude plugin marketplace add brendatamaar/functional-effect
claude plugin install functional-effect@functional-effect-marketplace

# or from a local clone
claude plugin marketplace add ./functional-effect
claude plugin install functional-effect@functional-effect-marketplace
```

To try it without installing: `claude --plugin-dir ./functional-effect/plugins/functional-effect`.

Then, in a repository: `/functional-effect:setup`. Adopting the model in existing code? Start with `/functional-effect:review --all` for a baseline.

## Develop

```bash
node --test test/fe-check.test.mjs                                   # checker and hook tests
(cd test && npm install) && node --test test/outbox-sql.test.mjs     # optional: SQL reference against PGlite
(cd examples/go && go test -race ./... && go run ./cmd/demo)
(cd examples/go && go test ./internal/shell -run XXX -fuzz=FuzzParseEvent -fuzztime=30s)
(cd examples/typescript && npm install && npm test && npm start)
(cd examples/python && python -m unittest discover -s tests -t .)
claude plugin validate . --strict
claude plugin eval . --runs 1                                        # skill behavior and trigger evals (calls the API)
```

## License

MIT
