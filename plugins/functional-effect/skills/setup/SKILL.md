---
description: Set up Model Functional Effect in the current repository — core/shell paths, the purity check, path-scoped rules, optional CI lint rules and Claude Code permission policy.
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs scan *) Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs approve --status *)
---

# Set up Model Functional Effect

Configure this repository so Claude Code (layer 1: the code) and its own workflow (layer 2: plan → policy → interpret) follow the model. Ask before writing each file; never overwrite an existing file without showing the change.

## 1. Inspect

- Languages: `go.mod` → Go; `package.json` / `tsconfig.json` → TypeScript/JavaScript. A repo can have both. For TypeScript, note whether `package.json` depends on `effect` (use `references/typescript-effect.md`) or not (use plain `references/typescript.md`: zod, a `Deps` object, fast-check), and which of zod, fast-check or another schema/property library is already installed; suggest those over adding new ones.
- What the project does, to suggest a profile: money, inventory, queues, retries of non-idempotent calls, workers → `distributed`; HTTP services, jobs, tools calling databases and APIs → `service`; CLIs, libraries, parsers, UI reducers → `core`.
- Existing layout: look for directories that already hold pure domain logic (`internal/core`, `internal/domain`, `pkg/<x>/domain`, `src/core`, `src/domain`, `src/model`) and for shell code (`cmd`, `internal/http`, `internal/handler`, `internal/repository`, `src/api`, `src/server`, `src/shell`, `src/main.ts`).
- Existing `.functional-effect.json`, `.claude/rules/`, `.claude/settings.json`, `.golangci.yml`, `eslint.config.*`.

## 2. Agree on paths

Propose `core` and `shell` globs that match the real layout (prefer existing domain folders over creating new ones). Present them in one question with the recommended option first. Also ask:

- `profile`: `core`, `service` or `distributed` (see `${CLAUDE_PLUGIN_ROOT}/skills/model/references/profiles.md`). Recommend the lowest one that is honest about the failures the project cannot afford, with the reason, and say it can be raised later.
- `designDir`: where design documents live (default `docs/design`; use an existing docs folder if the repo has one).
- `mode`: `deny` (block edits that add effects and ask before new `fe:allow` exceptions; recommended) or `warn` (allow, but tell Claude).
- Whether to enable the end-of-turn re-check of changed core files (`stopCheck`: `changed` or `off`; needs git).
- A `verify` command: the core's tests, run at the end of every turn that changes core files (e.g. `go test ./internal/core/...`). Recommend one; keep it fast.

## 3. Write `.functional-effect.json`

Start from `${CLAUDE_PLUGIN_ROOT}/templates/functional-effect.json`, fill in the agreed values, drop empty `rules` sections. Field reference:

- `core` / `shell`: globs relative to the repo root.
- `profile`: `core` | `service` (default) | `distributed`. `designDir`: relative folder for design documents.
- `exclude`: extra globs to skip (tests, generated code and `.d.ts` are already skipped).
- `verify`: command string, or `{ "command": "...", "timeout": seconds }`.
- `rules.go|ts.forbidImports`: extra import prefixes to forbid in the core; `allowImports`: prefixes to always allow; `forbidCalls`: extra regexes.

The full schema is `${CLAUDE_PLUGIN_ROOT}/schema/functional-effect.schema.json`. Unknown keys and invalid values are reported as warnings at session start.

If a `verify` command was set, tell the user it does not run until they approve it, and offer `/functional-effect:verify approve`. Do not approve it yourself.

## 4. Write the path-scoped rule

Copy `${CLAUDE_PLUGIN_ROOT}/templates/rules/functional-effect.md` to `.claude/rules/functional-effect.md`, replacing the `paths:` list with the agreed `core` globs. It loads only when Claude works on core files. If `core` changes later, update this file too: the session start warns when the two lists differ.

## 5. Baseline scan

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs scan --root .` and report the result, including any reviewed `fe:allow` exceptions. Explain the ratchet: existing violations never block unrelated edits; only edits that add new effects are blocked, and only changes made during a turn are checked at its end (your own uncommitted edits are the baseline). Offer `/functional-effect:check` to work through existing ones later.

## 6. Optional: CI enforcement (for edits made outside Claude Code)

Offer, per language detected, and show the snippet before merging:

Offer the layer for the profile only: `core` projects need the purity rules and exhaustiveness checks; `service` and up add nothing here (the extra rigor is in review and tests).

- Go: merge `${CLAUDE_PLUGIN_ROOT}/templates/golangci.depguard.yml` into `.golangci.yml` with the core path adjusted. It also enables `gochecksumtype`: add `//sumtype:decl` above the `State`, `Input` and `Command` interfaces so a type switch that misses a variant fails CI.
- TypeScript: add `${CLAUDE_PLUGIN_ROOT}/templates/eslint.functional-core.mjs` to the repo and spread `functionalCore` into `eslint.config.*`, with `files` adjusted. It includes `switch-exhaustiveness-check`, which needs type information (`parserOptions.projectService`). Mention its typescript-eslint dependency.

## 7. Optional: layer 2 policy

Offer to merge `${CLAUDE_PLUGIN_ROOT}/templates/settings.layer2.json` into `.claude/settings.json`: append to the existing `permissions.ask` / `permissions.deny` lists without removing anything, and show the resulting diff first. Explain the idea in one line each:

- Plan before multi-file changes (plan mode or `/functional-effect:design`): the program as a value.
- Permission rules and hooks: the policy check between a command and its effect.
- Sandbox, worktrees and checkpoints: isolated, revertible interpreters. Sandboxing is configured separately in Claude Code settings where the platform supports it.

## 8. Finish

List the files written, then suggest committing `.functional-effect.json`, `.claude/rules/functional-effect.md` and any settings so teammates get the same behavior. Mention `/functional-effect:design <feature>` as the way to start the next feature, and `/functional-effect:extract <file or function>` for pulling decisions out of existing code that mixes logic with IO.
