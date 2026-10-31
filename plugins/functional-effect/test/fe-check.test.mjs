// Tests for scripts/fe-check.mjs. Run: node --test test/
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const CHECK = path.join(here, "..", "scripts", "fe-check.mjs")

const project = (files, config = { core: ["core/**"], shell: ["shell/**"] }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "fe-check-"))
  if (config) writeFileSync(path.join(dir, ".functional-effect.json"), JSON.stringify(config))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), content)
  }
  return dir
}

const run = (args, { stdin = "", cwd, env = {} } = {}) => {
  const r = spawnSync(process.execPath, [CHECK, ...args], {
    input: stdin,
    cwd,
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", ...env },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const scanJson = (dir) => JSON.parse(run(["scan", "--json", "--root", dir]).out)
const rulesOf = (report) => report.files.flatMap((f) => f.findings.map((x) => `${x.line}:${x.rule}`))

test("go: flags effectful imports and calls, ignores strings, comments and fe:allow", () => {
  const dir = project({
    "core/a.go": [
      "package core", // 1
      "import (", // 2
      '  "fmt"', // 3
      '  t "time"', // 4
      '  "os"', // 5
      '  "net/http"', // 6
      ")", // 7
      "func F() {", // 8
      "  _ = t.Now()", // 9
      '  fmt.Println("x")', // 10
      "  go work()", // 11
      '  s := "time.Now() fmt.Println( go f()"', // 12
      "  // fmt.Println(s) go f()", // 13
      '  _ = fmt.Sprintf("%s", s)', // 14
      "  _ = t.Now() // fe:allow audit timestamp is injected in tests", // 15
      "  _ = http.StatusOK; _ = os.Args", // 16
      "}",
    ].join("\n"),
  })
  const report = scanJson(dir)
  assert.deepEqual(rulesOf(report).sort(), ["10:io", "11:concurrency", "5:import", "6:import", "9:clock"].sort())
  rmSync(dir, { recursive: true, force: true })
})

test("ts: flags effects, allows type-only imports, member calls and strings", () => {
  const dir = project({
    "core/a.ts": [
      'import type { Stats } from "node:fs"', // 1 type-only: fine
      'import { readFileSync } from "node:fs"', // 2
      'import { Effect } from "effect"', // 3 fine
      "export const f = async (api: { fetch(u: string): void }) => {", // 4
      '  await fetch("/x")', // 5
      '  api.fetch("/y")', // 6 member: fine
      "  const now = Date.now()", // 7
      "  const d = new Date()", // 8
      "  const e = new Date(0)", // 9 fine
      "  const r = Math.random()", // 10
      '  console.log("hi")', // 11
      '  const s = "fetch( Date.now() console.log("', // 12 fine
      "  // fetch(x) Date.now()", // 13 fine
      "  const t = `at ${Date.now()} fetch(`", // 14 clock inside ${}
      "  Effect.runPromise(Effect.void)", // 15
      '  const c = require("child_process")', // 16
      "}",
    ].join("\n"),
  })
  const report = scanJson(dir)
  assert.deepEqual(
    rulesOf(report).sort(),
    ["2:import", "5:network", "7:clock", "8:clock", "10:randomness", "11:io", "14:clock", "15:execution", "16:import"].sort(),
  )
  rmSync(dir, { recursive: true, force: true })
})

test("ts: method and function declarations named like effects are not calls", () => {
  const dir = project({
    "core/a.ts": [
      "export class Repo {",
      "  async fetch(id: string): Promise<string> { return id }",
      "  fetch2(id: string) { return id }",
      "}",
      "function fetch(u: string) { return u }",
      "export const o = { fetch(u: string) { return u } }",
    ].join("\n"),
  })
  assert.equal(scanJson(dir).violations, 0)
  rmSync(dir, { recursive: true, force: true })
})

test("scan ignores shell files, tests and excluded paths", () => {
  const dir = project({
    "core/a_test.go": 'package core\nimport "os"\n',
    "core/b.test.ts": "fetch('/x')\n",
    "shell/c.ts": "fetch('/x')\n",
  })
  const report = scanJson(dir)
  assert.equal(report.violations, 0)
  assert.equal(report.scanned, 0)
  rmSync(dir, { recursive: true, force: true })
})

const preInput = (dir, rel, tool, toolInput) =>
  JSON.stringify({ hook_event_name: "PreToolUse", cwd: dir, tool_name: tool, tool_input: { file_path: path.join(dir, rel), ...toolInput } })

test("pre: denies an Edit that adds an effect to a core file", () => {
  const dir = project({ "core/a.ts": "export const f = (x: number) => x + 1\n" })
  const r = run(["pre"], {
    stdin: preInput(dir, "core/a.ts", "Edit", { old_string: "x + 1", new_string: "x + Date.now()" }),
  })
  assert.equal(r.code, 0)
  const out = JSON.parse(r.out)
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny")
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /core\/a\.ts:1 +\[clock\]/)
  rmSync(dir, { recursive: true, force: true })
})

test("pre: denies a Write of a new core file with effects", () => {
  const dir = project({})
  const r = run(["pre"], { stdin: preInput(dir, "core/new.go", "Write", { content: 'package core\nimport "os"\n' }) })
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, "deny")
  rmSync(dir, { recursive: true, force: true })
})

test("pre: ratchet — existing violations never block an unrelated edit", () => {
  const dir = project({ "core/a.ts": "export const f = () => Date.now()\nexport const g = 1\n" })
  const r = run(["pre"], { stdin: preInput(dir, "core/a.ts", "Edit", { old_string: "g = 1", new_string: "g = 2" }) })
  assert.equal(r.out, "")
  rmSync(dir, { recursive: true, force: true })
})

test("pre: silent for shell files and for projects without a config", () => {
  const dir = project({ "shell/a.ts": "export const x = 1\n" })
  const r1 = run(["pre"], { stdin: preInput(dir, "shell/a.ts", "Edit", { old_string: "1", new_string: "Date.now()" }) })
  assert.equal(r1.out, "")
  const bare = project({ "core/a.ts": "export const x = 1\n" }, null)
  const r2 = run(["pre"], { stdin: preInput(bare, "core/a.ts", "Edit", { old_string: "1", new_string: "Date.now()" }) })
  assert.equal(r2.out, "")
  rmSync(dir, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
})

test("pre: warn mode adds context instead of denying", () => {
  const dir = project({ "core/a.ts": "export const x = 1\n" }, { core: ["core/**"], mode: "warn" })
  const r = run(["pre"], { stdin: preInput(dir, "core/a.ts", "Edit", { old_string: "1", new_string: "Math.random()" }) })
  const out = JSON.parse(r.out)
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined)
  assert.match(out.hookSpecificOutput.additionalContext, /randomness/)
  rmSync(dir, { recursive: true, force: true })
})

test("pre: a broken config reports a non-blocking error instead of blocking", () => {
  const dir = project({ "core/a.ts": "x\n" }, null)
  writeFileSync(path.join(dir, ".functional-effect.json"), "{ not json")
  const r = run(["pre"], { stdin: preInput(dir, "core/a.ts", "Edit", { old_string: "x", new_string: "y" }) })
  assert.equal(r.code, 1)
  assert.equal(r.out, "")
  rmSync(dir, { recursive: true, force: true })
})

const gitInit = (dir) => {
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" })
  g("init", "-q")
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
}

test("stop: blocks when a session added effects outside the edit tools", () => {
  const dir = project({ "core/a.go": "package core\nfunc F() int { return 1 }\n" })
  gitInit(dir)
  writeFileSync(path.join(dir, "core/a.go"), 'package core\nimport "os"\nfunc F() int { return len(os.Args) }\n')
  const r = run(["stop"], { stdin: JSON.stringify({ cwd: dir, stop_hook_active: false }) })
  const out = JSON.parse(r.out)
  assert.equal(out.decision, "block")
  assert.match(out.reason, /core\/a\.go:2 +\[import\]/)

  const again = run(["stop"], { stdin: JSON.stringify({ cwd: dir, stop_hook_active: true }) })
  assert.equal(again.out, "", "never blocks twice in a row")
  rmSync(dir, { recursive: true, force: true })
})

test("session: prints context only when the project opts in", () => {
  const dir = project({})
  assert.match(run(["session"], { cwd: dir }).out, /Model Functional Effect is active/)
  const bare = project({}, null)
  assert.equal(run(["session"], { cwd: bare }).out, "")
  rmSync(dir, { recursive: true, force: true })
  rmSync(bare, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// v0.3
// ---------------------------------------------------------------------------

test("fe:allow without a reason does not suppress", () => {
  const dir = project({ "core/a.ts": "export const t = () => Date.now() // fe:allow\n" })
  const report = scanJson(dir)
  assert.equal(report.violations, 1)
  assert.match(report.files[0].findings[0].message, /needs a reason/)
  rmSync(dir, { recursive: true, force: true })
})

test("pre: a new fe:allow exception asks the user instead of passing silently", () => {
  const dir = project({ "core/a.ts": "export const t = () => Date.now()\n" })
  const r = run(["pre"], {
    stdin: preInput(dir, "core/a.ts", "Edit", { old_string: "Date.now()", new_string: "Date.now() // fe:allow audit clock is injected later" }),
  })
  const out = JSON.parse(r.out).hookSpecificOutput
  assert.equal(out.permissionDecision, "ask")
  assert.match(out.permissionDecisionReason, /fe:allow: audit clock is injected later/)
  rmSync(dir, { recursive: true, force: true })
})

test("pre: ratchet is keyed by token, so editing a legacy line elsewhere passes", () => {
  const dir = project({ "core/a.ts": "export const started = Date.now()\n" })
  const r = run(["pre"], { stdin: preInput(dir, "core/a.ts", "Edit", { old_string: "started", new_string: "startedAt" }) })
  assert.equal(r.out, "")
  rmSync(dir, { recursive: true, force: true })
})

test("go: dot-imports and function values are flagged, field access is not", () => {
  const dir = project({
    "core/a.go": [
      "package core", // 1
      'import . "time"', // 2
      'import t "time"', // 3
      "var clock = t.Now", // 4
      "type S struct{ time struct{ Now int } }", // 5
      "func F(in S) int { return in.time.Now }", // 6
    ].join("\n"),
  })
  assert.deepEqual(rulesOf(scanJson(dir)).sort(), ["2:import", "4:clock"].sort())
  rmSync(dir, { recursive: true, force: true })
})

test("ts: function values and globalThis access are flagged", () => {
  const dir = project({
    "core/a.ts": [
      "export const now = Date.now", // 1
      'export const get = () => globalThis.fetch("/x")', // 2
      "export const later = globalThis.setTimeout", // 3
      "export const rnd = Math.random", // 4
    ].join("\n"),
  })
  assert.deepEqual(rulesOf(scanJson(dir)).sort(), ["1:clock", "2:network", "3:scheduling", "4:randomness"].sort())
  rmSync(dir, { recursive: true, force: true })
})

test("config: typos and bad values become warnings", () => {
  const dir = project({}, { cores: ["x/**"], mode: "block", rules: { go: { forbidImport: ["x"] } } })
  const s = JSON.parse(run(["session"], { cwd: dir }).out)
  assert.match(s.systemMessage, /unknown key "cores" \(did you mean "core"\?\)/)
  assert.match(s.systemMessage, /"mode" must be one of "deny", "warn"/)
  assert.match(s.systemMessage, /rules\.go\.forbidImport.*did you mean "forbidImports"/)
  rmSync(dir, { recursive: true, force: true })
})

test("config: profile and designDir reach the session context; bad values warn", () => {
  const ok = project({}, { core: ["core/**"], profile: "distributed", designDir: "specs/" })
  const ctx = JSON.parse(run(["session"], { cwd: ok }).out).hookSpecificOutput.additionalContext
  assert.match(ctx, /Profile "distributed"/)
  assert.match(ctx, /live in specs\//)
  const dflt = project({}, { core: ["core/**"] })
  assert.match(JSON.parse(run(["session"], { cwd: dflt }).out).hookSpecificOutput.additionalContext, /Profile "service".*live in docs\/design\//)
  const bad = project({}, { core: ["core/**"], profile: "huge", designDir: "../outside" })
  const msg = JSON.parse(run(["session"], { cwd: bad }).out).systemMessage
  assert.match(msg, /"profile" must be one of "service", "core", "distributed"/)
  assert.match(msg, /"designDir" must be a relative folder/)
  for (const d of [ok, dflt, bad]) rmSync(d, { recursive: true, force: true })
})

test("session: warns when the rule file's paths differ from core, in either list style", () => {
  const rule = (paths) => ({ ".claude/rules/functional-effect.md": `---\n${paths}\n---\n\n# rule\n` })
  const same = project(rule('paths: ["core/**"]'))
  assert.doesNotMatch(run(["session"], { cwd: same }).out, /rule file|functional-effect\.md/)
  const yamlSame = project(rule("paths:\n  - core/**"))
  assert.doesNotMatch(run(["session"], { cwd: yamlSame }).out, /functional-effect\.md/)
  const drift = project(rule('paths: ["internal/core/**"]'))
  assert.match(JSON.parse(run(["session"], { cwd: drift }).out).systemMessage, /functional-effect\.md has paths \[internal\/core\/\*\*\] but "core" is \[core\/\*\*\]/)
  const yamlDrift = project(rule("paths:\n  - core/**\n  - extra/**"))
  assert.match(JSON.parse(run(["session"], { cwd: yamlDrift }).out).systemMessage, /Update the rule file/)
  const none = project({})
  assert.doesNotMatch(run(["session"], { cwd: none }).out, /functional-effect\.md/)
  for (const d of [same, yamlSame, drift, yamlDrift, none]) rmSync(d, { recursive: true, force: true })
})

// --- per-turn baseline, verify, block cap -----------------------------------

const commitAll = (dir) => {
  const g = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" })
  g("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A")
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c", "--allow-empty")
}

const hookRun = (mode, dir, data, extra = {}) =>
  run([mode], {
    stdin: JSON.stringify({ session_id: "s1", cwd: dir, stop_hook_active: false, ...extra }),
    env: { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: data },
  })

const tmpData = () => mkdtempSync(path.join(tmpdir(), "fe-data-"))

test("stop: the user's uncommitted edits made before the turn are not blamed on Claude", () => {
  const dir = project({ "core/a.go": "package core\n" })
  gitInit(dir)
  const data = tmpData()
  // the user edits a core file before prompting
  writeFileSync(path.join(dir, "core/a.go"), 'package core\nimport "os"\nvar _ = os.Args\n')
  hookRun("turn", dir, data)
  assert.equal(hookRun("stop", dir, data).out, "", "pre-existing dirty edit is the baseline")

  // during the turn, a new effect is added to another core file via a shell command
  writeFileSync(path.join(dir, "core/b.go"), 'package core\nimport "net/http"\nvar _ = http.Get\n')
  const out = JSON.parse(hookRun("stop", dir, data).out)
  assert.equal(out.decision, "block")
  assert.match(out.reason, /core\/b\.go:2/)
  assert.doesNotMatch(out.reason, /core\/a\.go/)
  rmSync(dir, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test("stop: block cap — at most three blocks per turn, then a message for the user", () => {
  const dir = project({ "core/a.go": "package core\n" })
  gitInit(dir)
  const data = tmpData()
  hookRun("turn", dir, data)
  writeFileSync(path.join(dir, "core/a.go"), 'package core\nimport "os"\nvar _ = os.Args\n')
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse(hookRun("stop", dir, data, { stop_hook_active: i > 0 }).out).decision, "block")
  const last = JSON.parse(hookRun("stop", dir, data, { stop_hook_active: true }).out)
  assert.equal(last.decision, undefined)
  assert.match(last.systemMessage, /still failing after 3 attempts/)
  rmSync(dir, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test("stop: a new fe:allow added outside the edit tools is reported to the user, not blocked", () => {
  const dir = project({ "core/a.ts": "export const x = 1\n" })
  gitInit(dir)
  const data = tmpData()
  hookRun("turn", dir, data)
  writeFileSync(path.join(dir, "core/a.ts"), "export const x = Date.now() // fe:allow legacy clock, tracked in #12\n")
  const out = JSON.parse(hookRun("stop", dir, data).out)
  assert.equal(out.decision, undefined)
  assert.match(out.systemMessage, /added fe:allow exceptions/)
  rmSync(dir, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test("verify: runs only when approved, blocks on failure, and approval is bound to the command", () => {
  const failing = `node -e "console.log('invariant broken'); process.exit(3)"`
  const dir = project({ "core/a.ts": "export const x = 1\n" }, { core: ["core/**"], verify: failing })
  gitInit(dir)
  const data = tmpData()
  const change = (v) => writeFileSync(path.join(dir, "core/a.ts"), `export const x = ${v}\n`)

  // not approved: skipped with a note
  hookRun("turn", dir, data)
  change(2)
  let out = JSON.parse(hookRun("stop", dir, data).out)
  assert.equal(out.decision, undefined)
  assert.match(out.systemMessage, /not approved/)

  // approved: runs, fails, blocks with the output
  assert.equal(run(["approve", "--root", dir, "--data", data]).code, 0)
  hookRun("turn", dir, data)
  change(3)
  out = JSON.parse(hookRun("stop", dir, data).out)
  assert.equal(out.decision, "block")
  assert.match(out.reason, /exit code 3/)
  assert.match(out.reason, /invariant broken/)

  // no core change in the turn: verify does not run
  commitAll(dir)
  hookRun("turn", dir, data)
  assert.equal(hookRun("stop", dir, data).out, "")

  // changing the command revokes the approval
  writeFileSync(path.join(dir, ".functional-effect.json"), JSON.stringify({ core: ["core/**"], verify: "node -e 0" }))
  assert.equal(run(["approve", "--status", "--root", dir, "--data", data]).code, 1)
  hookRun("turn", dir, data)
  change(4)
  assert.match(JSON.parse(hookRun("stop", dir, data).out).systemMessage, /not approved/)

  // approved and passing: silent
  run(["approve", "--root", dir, "--data", data])
  hookRun("turn", dir, data)
  change(5)
  assert.equal(hookRun("stop", dir, data).out, "")
  rmSync(dir, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test("turn: prints nothing (its stdout would become Claude's context)", () => {
  const dir = project({ "core/a.go": "package core\n" })
  gitInit(dir)
  const data = tmpData()
  const r = hookRun("turn", dir, data)
  assert.equal(r.out, "")
  assert.equal(r.code, 0)
  rmSync(dir, { recursive: true, force: true })
  rmSync(data, { recursive: true, force: true })
})

test("py: flags effectful imports and calls, ignores strings, docstrings, comments, TYPE_CHECKING and fe:allow", () => {
  const dir = project({
    "core/a.py": [
      '"""Docstring.', // 1
      "import os", // 2 inside a docstring: fine
      "time.sleep(1)", // 3 fine
      '"""', // 4
      "from __future__ import annotations", // 5
      "import os.path as osp", // 6 import
      "import json, subprocess", // 7 import
      "from datetime import datetime", // 8 fine
      "from typing import TYPE_CHECKING", // 9
      "from . import sibling", // 10 relative: fine
      "if TYPE_CHECKING:", // 11
      "    import requests", // 12 type-only: fine
      "def f(x):", // 13
      "    now = datetime.now()", // 14 clock
      '    s = "datetime.now() print( open("', // 15 fine
      "    # print(x) open(y)", // 16 fine
      "    print(x)", // 17 io
      "    t = f'{datetime.utcnow()} done'", // 18 clock inside f-string
      "    u = f'{{datetime.now()}}'", // 19 escaped braces: fine
      "    d = {'a': 1}.items()", // 20 fine
      "    return open(x)  # fe:allow reviewed: path is injected in tests", // 21 allowed
      "class Repo:", // 22
      "    def open(self, p):", // 23 declaration: fine
      "        return self.open(p)", // 24 member call: fine
      "    def print(self): ...", // 25 declaration: fine
    ].join("\n"),
  })
  const report = scanJson(dir)
  assert.deepEqual(rulesOf(report).sort(), ["14:clock", "17:io", "18:clock", "6:import", "7:import"].sort())
  assert.equal(report.exceptions, 1)
  rmSync(dir, { recursive: true, force: true })
})

test("py: allowImports, forbidImports and forbidCalls come from rules.py", () => {
  const dir = project(
    {
      "core/a.py": ["import os.path", "import numpy", "import time", "def f():", "    return dangerous(1)"].join("\n"),
    },
    {
      core: ["core/**"],
      rules: { py: { allowImports: ["os.path"], forbidImports: ["numpy"], forbidCalls: ["\\bdangerous\\s*\\("] } },
    },
  )
  const report = scanJson(dir)
  assert.deepEqual(rulesOf(report).sort(), ["2:import", "3:import", "5:custom"].sort())
  rmSync(dir, { recursive: true, force: true })
})

test("py: tests, conftest and non-core files are skipped; default src/<pkg>/core path is core", () => {
  const dir = project(
    {
      "src/app/core/order.py": "import os\n",
      "src/app/core/test_order.py": "import os\n",
      "src/app/core/order_test.py": "import os\n",
      "src/app/core/conftest.py": "import os\n",
      "src/app/shell/io.py": "import os\n",
    },
    {},
  )
  const report = scanJson(dir)
  assert.equal(report.scanned, 1)
  assert.deepEqual(rulesOf(report), ["1:import"])
  rmSync(dir, { recursive: true, force: true })
})

test("py: pre denies an edit that adds an effect, and allows a pure one", () => {
  const dir = project({ "core/a.py": "def f(x):\n    return x + 1\n" })
  const denied = run(["pre"], { stdin: preInput(dir, "core/a.py", "Edit", { old_string: "x + 1", new_string: "print(x)" }) })
  assert.equal(JSON.parse(denied.out).hookSpecificOutput.permissionDecision, "deny")
  const dated = run(["pre"], { stdin: preInput(dir, "core/a.py", "Edit", { old_string: "x + 1", new_string: "datetime.now()" }) })
  assert.match(JSON.parse(dated.out).hookSpecificOutput.permissionDecisionReason, /core\/a\.py:2 +\[clock\]/)
  const ok = run(["pre"], { stdin: preInput(dir, "core/a.py", "Edit", { old_string: "x + 1", new_string: "x + 2" }) })
  assert.equal(ok.out, "")
  rmSync(dir, { recursive: true, force: true })
})
