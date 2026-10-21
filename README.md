# functional-effect

A Claude Code plugin marketplace for **Model Functional Effect**:

```
(state₂, commands) = f(state₁, input)
```

A program is a sequence of typed states. A pure function moves from one state to the next in response to an input and *describes* the effects it wants as data. A thin shell performs those effects and feeds their results back as inputs. The ideas come from type-driven design ("make illegal states unrepresentable", "parse, don't validate"), Pure UI's state map, functional core / imperative shell, and effect systems such as Effect's `Effect<A, E, R>`.

## Plugins

| Plugin | Version | Description |
|---|---|---|
| [`functional-effect`](plugins/functional-effect) | 0.7.0 | Keep functional-core code pure in Go and TypeScript, design features as state maps and transition tables, and run agent work as plan → policy → interpret. |

The plugin applies the model at two layers:

| Layer | What it governs | How |
|---|---|---|
| **1. The code** | Code Claude writes in your repo | A purity check on every edit to core files, an approved verify command after turns that change them, path-scoped rules, a reviewer agent, Go and TypeScript patterns |
| **2. The agent** | How Claude itself works | Design as a value before code, policy between command and effect (including your approval of every exception), isolated interpreters |

## Install

Requires Node.js 18+ on `PATH`. The hooks run with `node` directly, so they work on Windows, macOS and Linux.

```bash
claude plugin marketplace add brendatamaar/functional-effect
claude plugin install functional-effect@functional-effect-marketplace
```

From a local clone: `claude plugin marketplace add ./functional-effect`. To try it without installing: `claude --plugin-dir ./functional-effect/plugins/functional-effect`.

## Usage

| Command | What it does |
|---|---|
| `/functional-effect:setup` | Configures a repo: core/shell paths, verify command, rules file, baseline scan, optional CI lint rules and permission policy |
| `/functional-effect:design <feature>` | Writes `docs/design/<feature>.md` — state map, transition table, invariants, commands, call graph, failure classes, requirements, boundary — and stops for approval |
| `/functional-effect:extract <target>` | Moves the decisions of existing code that mixes logic with IO into a pure core, behind characterization tests |
| `/functional-effect:test [feature]` | Derives property and contract tests from the design document, runs them, and proves each one can fail |
| `/functional-effect:review [path ...] [--all] [--write <file>]` | Reviews current changes, given paths, or the whole repo as a baseline (fix now / fix when touched / fine) |
| `/functional-effect:check [--changed]` | Scans core files and proposes refactors |
| `/functional-effect:verify [status\|approve\|revoke]` | Approves the command that runs after turns that change core files |

The `functional-effect:model` skill (the pattern plus Go, plain TypeScript, Effect and agent-loop references) and the read-only `fe-reviewer` agent load when relevant.

Adopting the model in existing code? Start with `/functional-effect:review --all` for a baseline, then `/functional-effect:extract` one flow at a time.

Not every project needs an outbox: set `profile` in `.functional-effect.json` to `core`, `service` (default) or `distributed` to scale what design, test and review ask for.

## How it works

**Thinking order.** Shapes → states and transitions → happy-path call graph → cardinality (one / stream / cached) → failures → requirements → boundary. Every failure gets exactly one class: domain outcome (becomes an input and a state), retry (only if idempotent or keyed), escape hatch (recorded fallback), or die (a defect).

**Purity check.** The hooks stay inactive until a repo opts in with a `.functional-effect.json`. Then:

- **PreToolUse** denies edits to core files that *add* an effect — IO/network/database imports, clock, randomness, console, timers, goroutines, process/browser globals, `Effect.run*`.
- **Ratchet**: only new violations block; legacy code never blocks unrelated edits.
- **Exceptions** (`fe:allow <reason>`) need a reason and your approval.
- **Per-turn baseline**: only what changed during Claude's turn is re-checked at Stop, so your uncommitted work is never blamed on Claude.
- **Verify**: an approved command runs after turns that change core files; the approval is bound to the exact command and stored outside the repo.

**Layer 2.** Plan mode and `/functional-effect:design` are the program as a value; permission rules and the PreToolUse hook are the policy; sandboxes and worktrees are the interpreter; the session transcript is the event log; checkpoints are revertible state.

## Examples

[`examples/go`](plugins/functional-effect/examples/go) and [`examples/typescript`](plugins/functional-effect/examples/typescript) implement the same order checkout, with [`examples/design/order-checkout.md`](plugins/functional-effect/examples/design/order-checkout.md) as its design document:

- Pure core with timers as commands, idempotency keys derived from state, and a fenced `Reconciling` state for unknown payment outcomes.
- Shell with an interpreter (one failure strategy per command), a store with version check, inbox, event log and outbox, a leased outbox worker, and replay.
- Shrinking property tests per invariant, boundary properties (and a Go fuzz target), contract suites run against both fakes and real adapters (TypeScript also on PostgreSQL via PGlite), and crash/concurrency/chaos tests — each mutation-checked.

## Repository layout

```
.claude-plugin/marketplace.json      marketplace manifest
plugins/functional-effect/
  .claude-plugin/plugin.json         plugin manifest
  skills/                            model, design, setup, extract, check, review, test, verify
  agents/fe-reviewer.md              read-only reviewer
  hooks/hooks.json                   SessionStart, UserPromptSubmit, PreToolUse, Stop
  scripts/fe-check.mjs               zero-dependency purity checker
  schema/                            JSON Schema for .functional-effect.json
  templates/                         config, rules, golangci-lint, ESLint, permission policy
  examples/                          go/, typescript/, design/
  test/                              checker, hook and outbox SQL tests
  evals/                             skill behavior and trigger evals
```

## Develop

From `plugins/functional-effect`:

```bash
node --test test/fe-check.test.mjs                                   # checker and hook tests
(cd test && npm install) && node --test test/outbox-sql.test.mjs     # SQL reference against PGlite
(cd examples/go && go test -race ./... && go run ./cmd/demo)
(cd examples/go && go test ./internal/shell -run XXX -fuzz=FuzzParseEvent -fuzztime=30s)
(cd examples/typescript && npm install && npm test && npm start)
claude plugin validate . --strict
```

## Documentation

The [plugin README](plugins/functional-effect/README.md) has the full details: the purity check, the `.functional-effect.json` reference, persistence and delivery, the testing approach, credits and the changelog.

## License

MIT
