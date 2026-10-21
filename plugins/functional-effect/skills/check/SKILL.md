---
description: Scan this project's functional-core files for effects (IO, clock, randomness, network, console, goroutines/timers, Effect.run*) and report or fix them.
argument-hint: "[--changed] [files...]"
disable-model-invocation: true
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs *)
---

# Check the functional core

Mechanical purity scan of core files, with refactors for what it finds (this skill edits, after asking). For a judgment of design, tests and shell code, use `/functional-effect:review`, which never edits.

Run the checker from the project root:

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs scan $ARGUMENTS
```

- Exit 0: report the number of core files checked and that they are pure.
- Exit 2: there is no `.functional-effect.json`; suggest `/functional-effect:setup` and stop.
- Exit 1: summarize the violations grouped by file and by rule (import, clock, io, network, randomness, concurrency, scheduling, process, browser, execution).

For violations, propose the smallest refactor for each, following the `functional-effect:model` skill:

- Effect performed in the core → return a `Command` and interpret it in the shell.
- Clock or random value read in the core → add a field to the `Input`; the shell fills it.
- Effectful import used for a type only → TS: `import type`; Go: move the dependency behind an interface defined in the core and implemented in the shell.
- Code that is shell code by nature → move the file to a shell path.

Ask before editing. After edits, re-run the scan and the project's tests.
