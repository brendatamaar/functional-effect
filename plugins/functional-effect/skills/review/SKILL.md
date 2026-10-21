---
description: Review code against Model Functional Effect with the fe-reviewer agent — the current changes by default, given paths, or the whole repository as a baseline whose findings are sorted into fix now, fix when touched, and fine. Read-only. Use when asked to review a change, a package or a whole codebase against the model, or before adopting the model in an existing repository.
argument-hint: "[path ...] [--all] [--write <file>]"
---

# Review: $ARGUMENTS

Review only. Never change code in this skill; the only file you may write is the one named by `--write`. To scan core files for effects and fix them, use `/functional-effect:check` (it edits, after asking); `review` judges design, tests and shell too, and never edits.

## 1. Decide what to review

Read `.functional-effect.json` for the `core`, `shell` and `exclude` globs, the `profile` and `designDir` (without one, infer core and shell from the layout, assume `service`, and say so). Then pick the mode from the arguments:

| Arguments | Mode | Files |
|---|---|---|
| none | **change** | `git diff --name-only HEAD` plus `git ls-files --others --exclude-standard`, limited to source files |
| one or more paths | **baseline** | every source file under those paths |
| `--all` | **baseline** | every source file matching `core` or `shell`, minus `exclude` |

Leave out generated code (files marked `Code generated … DO NOT EDIT`, `gen/` folders, `*.gen.ts`), vendored code, fixtures and build output. Tests are reviewed for strength, not purity.

If the change mode finds no changed files, say so and stop.

## 2. Run the mechanical check

- change mode: `node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs scan --changed`
- baseline mode: `node ${CLAUDE_PLUGIN_ROOT}/scripts/fe-check.mjs scan`

Keep its findings verbatim for the report.

## 3. Run the reviewer

Launch the `functional-effect:fe-reviewer` agent. Its brief names the mode, the exact file list (or the paths, for a baseline), the profile, the design documents in `designDir` that cover them, and, in baseline mode, this instruction:

> This is a baseline of existing code, not a diff. Review whole files. Besides the severity, label every finding **fix now** (it blocks work that is about to build on this code, or breaks purity or a safety rule), **fix when touched** (record it; fix it the next time this code changes), or **fine** (it matches the model, or it is shell code doing shell work; list these only as a one-line summary per package).

For more than about 40 files, split the baseline by top-level package and run one reviewer per group, at most three at a time, so each reviewer reads its files in full. Pass each group the shared context (config, design documents) and merge the reports afterwards.

## 4. Report

Combine the checker output and the reviewer reports into one report:

- **Change mode:** the reviewer's report as is: the call graph of the changed flow, then findings by severity (Must fix, Should fix, Consider) with `file:line`, and the verdict.
- **Baseline mode:**
  1. one line of scope (paths, number of files, design documents found);
  2. a table per package: findings labelled fix now / fix when touched, with severity, `file:line`, the problem in one sentence and the fix in model terms;
  3. the "fine" summary;
  4. the gaps that matter most for what comes next: boundary parsers without round-trip or rejects-each-rule tests, fakes without a contract suite, decisions made inline in effectful code, retries on non-idempotent operations;
  5. a short list of the **fix now** items, in the order to do them.

With `--write <file>`, add the report to that file under a heading `Functional core review (<date>, <mode>)`, keeping everything already in it, and show the user the file path. Without it, show the report in the conversation only.

Do not start fixing anything. Ask the user which findings to act on.
