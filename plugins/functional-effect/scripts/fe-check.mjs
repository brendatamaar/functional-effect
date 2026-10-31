#!/usr/bin/env node
// Model Functional Effect: purity checker for functional-core code.
//
// Zero dependencies, Node 18+, works on Windows, macOS and Linux.
//
// Hook modes (read hook JSON on stdin):
//   pre        PreToolUse   deny edits that add effects to core files; ask before new fe:allow exceptions
//   turn       UserPromptSubmit  snapshot core files that are dirty at the start of the turn
//   stop       Stop         re-check core files changed during the turn, then run the approved verify command
//   session    SessionStart context for Claude, config warnings for the user
//
// CLI modes:
//   scan [--changed] [--json] [--root <dir>] [files...]
//   approve [--root <dir>] [--data <dir>] [--revoke] [--status]
//
// Languages: Go, TypeScript/JavaScript and Python.
//
// Opt-in per project: nothing happens unless a `.functional-effect.json`
// exists in the project (or a parent directory of the edited file).
//
// Ratchet: hooks only report violations an edit or turn *adds*, keyed by rule
// and matched token. Existing ones in legacy code never block unrelated work.

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, realpathSync, unlinkSync } from "node:fs"
import { execFileSync, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

const CONFIG_NAME = ".functional-effect.json"
const MAX_BLOCKS_PER_TURN = 3
const MAX_SNAPSHOT_BYTES = 1_000_000
const MAX_SNAPSHOT_TOTAL = 20_000_000
const DEFAULT_VERIFY_TIMEOUT = 300
const MAX_VERIFY_TIMEOUT = 540

// ---------------------------------------------------------------------------
// Default rules
// ---------------------------------------------------------------------------

const DEFAULTS = {
  core: ["internal/core/**", "pkg/core/**", "src/core/**", "src/*/core/**", "core/**"],
  shell: ["internal/shell/**", "src/shell/**", "src/*/shell/**", "cmd/**"],
  exclude: [
    "**/*_test.go", "**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/testdata/**", "**/*.d.ts",
    "**/test_*.py", "**/*_test.py", "**/conftest.py",
  ],
}

const GO_IMPORTS = [
  // exact package or any sub-package ("os" also matches "os/exec")
  ["os", "filesystem, env and process access"],
  ["net", "network access"],
  ["database/sql", "database access"],
  ["io/ioutil", "filesystem access"],
  ["math/rand", "randomness"],
  ["crypto/rand", "randomness"],
  ["log", "logging is output"],
  ["syscall", "system calls"],
  ["plugin", "dynamic loading"],
  ["github.com/jackc/pgx", "database access"],
  ["github.com/lib/pq", "database access"],
  ["github.com/go-sql-driver/mysql", "database access"],
  ["gorm.io", "database access"],
  ["go.mongodb.org/mongo-driver", "database access"],
  ["github.com/redis/go-redis", "cache/network access"],
  ["github.com/aws/aws-sdk-go", "cloud API access"],
  ["github.com/aws/aws-sdk-go-v2", "cloud API access"],
  ["cloud.google.com/go", "cloud API access"],
  ["github.com/gin-gonic/gin", "HTTP framework"],
  ["github.com/labstack/echo", "HTTP framework"],
  ["github.com/gofiber/fiber", "HTTP framework"],
]

// Packages whose dot-import would hide effectful calls behind bare names.
const GO_DOT_IMPORT_HIDES = { time: "hides clock calls", fmt: "hides console output" }

const TS_IMPORTS = [
  ["fs", "filesystem access"],
  ["child_process", "process spawning"],
  ["net", "network access"],
  ["http", "network access"],
  ["https", "network access"],
  ["http2", "network access"],
  ["dgram", "network access"],
  ["dns", "network access"],
  ["tls", "network access"],
  ["os", "host access"],
  ["process", "process access"],
  ["worker_threads", "concurrency"],
  ["cluster", "concurrency"],
  ["readline", "terminal IO"],
  ["timers", "scheduling"],
  ["perf_hooks", "clock"],
  ["axios", "network access"],
  ["node-fetch", "network access"],
  ["undici", "network access"],
  ["got", "network access"],
  ["ky", "network access"],
  ["pg", "database access"],
  ["mysql2", "database access"],
  ["mongodb", "database access"],
  ["mongoose", "database access"],
  ["redis", "cache/network access"],
  ["ioredis", "cache/network access"],
  ["@prisma/client", "database access"],
  ["knex", "database access"],
  ["sequelize", "database access"],
  ["typeorm", "database access"],
  ["@aws-sdk", "cloud API access"],
  ["@supabase/supabase-js", "network access"],
  ["firebase", "network access"],
  ["express", "HTTP framework"],
  ["fastify", "HTTP framework"],
  ["koa", "HTTP framework"],
  ["@effect/platform-node", "live platform layer (wire it at the edge)"],
  ["@effect/platform-bun", "live platform layer (wire it at the edge)"],
  ["@effect/platform-browser", "live platform layer (wire it at the edge)"],
  ["@effect/platform-deno", "live platform layer (wire it at the edge)"],
]

// Python modules (exact module or any submodule: "os" also matches "os.path").
// Allow a pure one with rules.py.allowImports, e.g. "os.path" or "pathlib".
const PY_IMPORTS = [
  ["os", "filesystem, env and process access"],
  ["sys", "process and stdio access"],
  ["subprocess", "process spawning"],
  ["shutil", "filesystem access"],
  ["pathlib", "filesystem access (allow it if you only use PurePath)"],
  ["tempfile", "filesystem access"],
  ["glob", "filesystem access"],
  ["fileinput", "filesystem access"],
  ["socket", "network access"],
  ["ssl", "network access"],
  ["select", "IO multiplexing"],
  ["selectors", "IO multiplexing"],
  ["http", "network access"],
  ["urllib", "network access"],
  ["ftplib", "network access"],
  ["smtplib", "network access"],
  ["imaplib", "network access"],
  ["poplib", "network access"],
  ["xmlrpc", "network access"],
  ["socketserver", "network access"],
  ["asyncio", "event loop and scheduling"],
  ["threading", "concurrency"],
  ["multiprocessing", "concurrency"],
  ["concurrent", "concurrency"],
  ["queue", "concurrency"],
  ["sched", "scheduling"],
  ["signal", "process signals"],
  ["time", "clock"],
  ["random", "randomness"],
  ["secrets", "randomness"],
  ["logging", "logging is output"],
  ["sqlite3", "database access"],
  ["dbm", "database access"],
  ["shelve", "filesystem access"],
  ["requests", "network access"],
  ["httpx", "network access"],
  ["aiohttp", "network access"],
  ["urllib3", "network access"],
  ["websockets", "network access"],
  ["grpc", "network access"],
  ["psycopg", "database access"],
  ["psycopg2", "database access"],
  ["asyncpg", "database access"],
  ["pymysql", "database access"],
  ["mysql", "database access"],
  ["sqlalchemy", "database access"],
  ["pymongo", "database access"],
  ["motor", "database access"],
  ["redis", "cache/network access"],
  ["boto3", "cloud API access"],
  ["botocore", "cloud API access"],
  ["aiofiles", "filesystem access"],
  ["django", "HTTP framework"],
  ["flask", "HTTP framework"],
  ["fastapi", "HTTP framework"],
  ["starlette", "HTTP framework"],
  ["tornado", "HTTP framework"],
]

// [regex source, rule, message]. A leading `(^|[^\w.$])` group is a delimiter
// guard and is not part of the reported token. `{fmt}` / `{time}` are replaced
// by the package names (or aliases) imported in the Go file. Patterns that do
// not end in `(` also catch function values (`f := time.Now`, `const now = Date.now`).
const GO_CALLS = [
  ["(^|[^\\w.])({time})\\.(Now|Since|Until|Sleep|After|AfterFunc|Tick|NewTimer|NewTicker)\\b", "clock", "reads or waits on the clock"],
  ["(^|[^\\w.])({fmt})\\.(Print|Println|Printf|Fprint|Fprintln|Fprintf|Scan|Scanln|Scanf|Fscan|Fscanln|Fscanf)\\b", "io", "performs console/stream IO"],
  ["(^|[^\\w.])go\\s+(func\\b|[A-Za-z_][\\w.]*\\s*\\()", "concurrency", "starts a goroutine"],
]

const TS_CALLS = [
  ["(^|[^\\w.$])fetch\\s*\\(", "network", "performs a network request"],
  ["\\bglobalThis\\.(fetch|XMLHttpRequest|WebSocket)\\b", "network", "performs a network request"],
  ["\\bnew\\s+(XMLHttpRequest|WebSocket|EventSource|Worker)\\s*\\(", "network", "opens a connection or worker"],
  ["\\bDate\\.now\\b", "clock", "reads the clock"],
  ["\\bnew\\s+Date\\s*\\(\\s*\\)", "clock", "reads the clock"],
  ["\\bperformance\\.now\\b", "clock", "reads the clock"],
  ["\\bMath\\.random\\b", "randomness", "uses randomness"],
  ["\\bcrypto\\.(randomUUID|getRandomValues|randomBytes)\\b", "randomness", "uses randomness"],
  ["\\bconsole\\.\\w+", "io", "writes to the console"],
  ["(^|[^\\w.$])(setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame)\\s*\\(", "scheduling", "schedules work"],
  ["\\bglobalThis\\.(setTimeout|setInterval|setImmediate|queueMicrotask)\\b", "scheduling", "schedules work"],
  ["\\b(globalThis\\.)?process\\.(env|argv|exit|stdout|stderr|stdin|cwd|hrtime|nextTick)\\b", "process", "touches the process"],
  ["\\b(globalThis\\.)?(localStorage|sessionStorage|indexedDB|window|navigator)\\s*[.\\[]", "browser", "touches browser globals"],
  ["\\bEffect\\.run(Promise|Sync|Fork|Callback)\\w*\\b", "execution", "executes an Effect (execution belongs at the edge)"],
  ["\\bManagedRuntime\\.make\\b", "execution", "builds a runtime (execution belongs at the edge)"],
]

const PY_CALLS = [
  ["(^|[^\\w.])(print|input|open|breakpoint)\\s*\\(", "io", "performs console/file IO"],
  ["\\b(datetime|date)\\.(now|utcnow|today)\\b", "clock", "reads the clock"],
  ["(^|[^\\w.])uuid(1|4)\\s*\\(", "randomness", "uses randomness"],
  ["\\buuid\\.uuid(1|4)\\b", "randomness", "uses randomness"],
  ["\\bos\\.(environ|getenv|system|urandom)\\b", "process", "touches the process or host"],
  ["\\bsys\\.(argv|exit|stdout|stderr|stdin)\\b", "process", "touches the process"],
]

const HINT =
  "Keep this file pure: return a Command describing the effect and let the shell interpret it, " +
  "or move the code to a shell path. Inputs from the clock, randomness or IO arrive as Input data. " +
  "A deliberate exception needs `fe:allow <reason>` on the line, and the user approves every new one."

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const toPosix = (p) => p.replace(/\\/g, "/")
const sha = (s, n = 64) => createHash("sha256").update(s).digest("hex").slice(0, n)

const readStdin = () => {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

const parseJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

const readText = (abs) => {
  try {
    return readFileSync(abs, "utf8")
  } catch {
    return null
  }
}

const argValue = (args, flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}

// Minimal glob: `**` any depth, `*` within a segment, `?` one char.
const globToRegex = (glob) => {
  let re = ""
  const g = toPosix(glob).replace(/^\.\//, "")
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === "*") {
      if (g[i + 1] === "*") {
        const slashAfter = g[i + 2] === "/"
        re += slashAfter ? "(?:.*/)?" : ".*"
        i += slashAfter ? 2 : 1
      } else re += "[^/]*"
    } else if (c === "?") re += "[^/]"
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${re}$`)
}

const matchesAny = (rel, globs) => globs.some((g) => globToRegex(g).test(rel))

const languageOf = (file) => {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".go") return "go"
  if (ext === ".py") return "py"
  if ([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "ts"
  return null
}

const levenshtein = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

const suggest = (key, known) => {
  const best = known.map((k) => [k, levenshtein(key, k)]).sort((x, y) => x[1] - y[1])[0]
  return best && best[1] <= 2 ? ` (did you mean "${best[0]}"?)` : ""
}

// ---------------------------------------------------------------------------
// Data directory (approvals, per-turn baselines). Never inside the repository.
// ---------------------------------------------------------------------------

const dataDir = (args = []) => {
  const dir = argValue(args, "--data") || process.env.CLAUDE_PLUGIN_DATA || path.join(homedir(), ".claude", "functional-effect")
  mkdirSync(dir, { recursive: true })
  return dir
}

const realRoot = (root) => {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

// ---------------------------------------------------------------------------
// Config (validated; every problem becomes a warning, never a silent no-op)
// ---------------------------------------------------------------------------

const KNOWN_KEYS = ["$schema", "core", "shell", "exclude", "mode", "stopCheck", "profile", "designDir", "verify", "rules"]
const PROFILES = ["service", "core", "distributed"]
const PROFILE_NOTES = {
  core: "pure step function, sum types and property tests; no boundary, interpreter or persistence review.",
  service: "core plus the boundary, interpreter, failure classes, capabilities and contract tests; no outbox, inbox or chaos review.",
  distributed: "service plus outbox, inbox, timers, unknown outcomes with fencing, replay and chaos tests.",
}
const RULE_FILE = ".claude/rules/functional-effect.md"
const RULE_LANGS = ["go", "ts", "py"]
const RULE_KEYS = ["forbidImports", "allowImports", "forbidCalls"]

const findConfigFrom = (startDir) => {
  let dir = path.resolve(startDir)
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function loadConfig(configPath) {
  const raw = parseJson(readFileSync(configPath, "utf8"))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${CONFIG_NAME} is not a valid JSON object`)
  const warnings = []

  for (const k of Object.keys(raw)) if (!KNOWN_KEYS.includes(k)) warnings.push(`unknown key "${k}"${suggest(k, KNOWN_KEYS)} is ignored`)

  const strings = (v, name, fallback) => {
    if (v === undefined) return fallback
    if (Array.isArray(v) && v.every((s) => typeof s === "string")) return v
    warnings.push(`"${name}" must be an array of strings; using the default`)
    return fallback
  }
  const oneOf = (v, name, options) => {
    if (v === undefined) return options[0]
    if (options.includes(v)) return v
    warnings.push(`"${name}" must be one of ${options.map((o) => `"${o}"`).join(", ")}; using "${options[0]}"`)
    return options[0]
  }

  let designDir = "docs/design"
  if (raw.designDir !== undefined) {
    const d = typeof raw.designDir === "string" ? toPosix(raw.designDir.trim()).replace(/\/+$/, "") : ""
    if (d && !path.isAbsolute(d) && !d.split("/").includes("..")) designDir = d
    else warnings.push(`"designDir" must be a relative folder inside the repository; using "${designDir}"`)
  }

  const core = strings(raw.core, "core", DEFAULTS.core)
  if (core.length === 0) warnings.push(`"core" is empty: no file will be checked`)

  let verify = null
  if (raw.verify !== undefined) {
    const v = typeof raw.verify === "string" ? { command: raw.verify } : raw.verify
    if (v && typeof v === "object" && typeof v.command === "string" && v.command.trim()) {
      const t = v.timeout === undefined ? DEFAULT_VERIFY_TIMEOUT : Number(v.timeout)
      if (!Number.isFinite(t) || t <= 0) warnings.push(`"verify.timeout" must be a positive number of seconds`)
      for (const k of Object.keys(v)) if (!["command", "timeout"].includes(k)) warnings.push(`unknown key "verify.${k}" is ignored`)
      verify = { command: v.command.trim(), timeout: Math.min(Number.isFinite(t) && t > 0 ? t : DEFAULT_VERIFY_TIMEOUT, MAX_VERIFY_TIMEOUT) }
    } else warnings.push(`"verify" must be a command string or { "command": string, "timeout"?: seconds }`)
  }

  const rules = raw.rules && typeof raw.rules === "object" ? raw.rules : {}
  if (raw.rules !== undefined && (typeof raw.rules !== "object" || Array.isArray(raw.rules))) warnings.push(`"rules" must be an object`)
  for (const lang of Object.keys(rules)) {
    if (!RULE_LANGS.includes(lang)) warnings.push(`unknown key "rules.${lang}"${suggest(lang, RULE_LANGS)} is ignored`)
    else for (const k of Object.keys(rules[lang] ?? {})) if (!RULE_KEYS.includes(k)) warnings.push(`unknown key "rules.${lang}.${k}"${suggest(k, RULE_KEYS)} is ignored`)
  }
  const ruleList = (lang, key) => strings(rules[lang]?.[key], `rules.${lang}.${key}`, [])
  const customCalls = (lang) =>
    ruleList(lang, "forbidCalls").filter((src) => {
      try {
        new RegExp(src)
        return true
      } catch {
        warnings.push(`"rules.${lang}.forbidCalls" has an invalid regular expression: ${src}`)
        return false
      }
    })

  return {
    path: configPath,
    root: path.dirname(configPath),
    warnings,
    core,
    shell: strings(raw.shell, "shell", DEFAULTS.shell),
    exclude: [...DEFAULTS.exclude, ...strings(raw.exclude, "exclude", [])],
    mode: oneOf(raw.mode, "mode", ["deny", "warn"]),
    stopCheck: oneOf(raw.stopCheck, "stopCheck", ["changed", "off"]),
    profile: oneOf(raw.profile, "profile", PROFILES),
    designDir,
    verify,
    go: {
      forbidImports: [...GO_IMPORTS, ...ruleList("go", "forbidImports").map((p) => [p, "forbidden by project config"])],
      allowImports: ruleList("go", "allowImports"),
      forbidCalls: [...GO_CALLS, ...customCalls("go").map((r) => [r, "custom", "forbidden by project config"])],
    },
    ts: {
      forbidImports: [...TS_IMPORTS, ...ruleList("ts", "forbidImports").map((p) => [p, "forbidden by project config"])],
      allowImports: ruleList("ts", "allowImports"),
      forbidCalls: [...TS_CALLS, ...customCalls("ts").map((r) => [r, "custom", "forbidden by project config"])],
    },
    py: {
      forbidImports: [...PY_IMPORTS, ...ruleList("py", "forbidImports").map((p) => [p, "forbidden by project config"])],
      allowImports: ruleList("py", "allowImports"),
      forbidCalls: [...PY_CALLS, ...customCalls("py").map((r) => [r, "custom", "forbidden by project config"])],
    },
  }
}

const isCoreFile = (cfg, absFile) => {
  const rel = toPosix(path.relative(cfg.root, absFile))
  if (rel.startsWith("../") || path.isAbsolute(rel)) return null
  if (!languageOf(rel)) return null
  if (!matchesAny(rel, cfg.core) || matchesAny(rel, cfg.exclude)) return null
  return rel
}

// ---------------------------------------------------------------------------
// Lexing: blank out comments and/or string contents, keeping offsets and
// newlines so line numbers still line up with the original text.
// ---------------------------------------------------------------------------

const blank = (s) => s.replace(/[^\n]/g, " ")

/**
 * Python: blank out `#` comments and string contents (single, triple-quoted,
 * prefixed). The expressions inside f-strings are code and stay visible.
 */
function stripPy(src, keepStrings) {
  let out = ""
  let i = 0
  const n = src.length

  const fExpressions = (inner) => {
    let r = ""
    let depth = 0
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k]
      if (depth === 0 && (ch === "{" || ch === "}") && inner[k + 1] === ch) {
        r += "  "
        k++
      } else if (ch === "{") {
        depth++
        r += " "
      } else if (ch === "}" && depth > 0) {
        depth--
        r += " "
      } else r += depth > 0 || ch === "\n" ? ch : " "
    }
    return r
  }

  while (i < n) {
    const c = src[i]
    if (c === "#") {
      const end = src.indexOf("\n", i)
      const stop = end === -1 ? n : end
      out += blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i)
      const q = triple ? c.repeat(3) : c
      const prefix = /(?:^|[^\w])([A-Za-z]{1,2})$/.exec(src.slice(Math.max(0, i - 3), i))?.[1] ?? ""
      const isF = /f/i.test(prefix)
      let j = i + q.length
      let closed = false
      while (j < n) {
        if (src[j] === "\\") {
          j += 2
          continue
        }
        if (src.startsWith(q, j)) {
          closed = true
          break
        }
        if (!triple && src[j] === "\n") break
        j++
      }
      j = Math.min(j, n)
      const inner = src.slice(i + q.length, j)
      const end = closed ? j + q.length : j
      if (keepStrings) out += src.slice(i, end)
      else out += q + (isF ? fExpressions(inner) : blank(inner)) + (closed ? q : "")
      i = end
      continue
    }
    out += c
    i++
  }
  return out
}

function strip(src, lang, { keepStrings }) {
  if (lang === "py") return stripPy(src, keepStrings)
  let out = ""
  let i = 0
  const n = src.length
  const templateDepth = [] // TS: brace depth at which each `${` opened
  let braceDepth = 0

  const readQuoted = (q) => {
    let j = i + 1
    while (j < n) {
      const c = src[j]
      if (c === "\\" && q !== "`") {
        j += 2
        continue
      }
      if (c === q) return j + 1
      if (c === "\n" && q !== "`") return j
      j++
    }
    return n
  }

  // Inside a TS template literal: copy until the closing backtick or a `${`.
  const templateBody = () => {
    for (;;) {
      if (i >= n) return
      const d = src[i]
      if (d === "\\") {
        out += keepStrings ? src.slice(i, i + 2) : "  "
        i += 2
        continue
      }
      if (d === "`") {
        out += "`"
        i++
        return
      }
      if (d === "$" && src[i + 1] === "{") {
        out += "${"
        i += 2
        templateDepth.push(braceDepth)
        braceDepth++
        return
      }
      out += keepStrings || d === "\n" ? d : " "
      i++
    }
  }

  while (i < n) {
    const c = src[i]
    const next = src[i + 1]

    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i)
      const stop = end === -1 ? n : end
      out += blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? n : end + 2
      out += blank(src.slice(i, stop))
      i = stop
      continue
    }
    if (lang === "ts" && c === "`") {
      out += "`"
      i++
      templateBody()
      continue
    }
    if (lang === "ts" && c === "}" && templateDepth.length && templateDepth[templateDepth.length - 1] === braceDepth - 1) {
      templateDepth.pop()
      braceDepth--
      out += "}"
      i++
      templateBody()
      continue
    }
    if (c === "{") braceDepth++
    if (c === "}") braceDepth = Math.max(0, braceDepth - 1)

    if (c === '"' || c === "'" || (lang === "go" && c === "`")) {
      const end = readQuoted(c)
      const body = src.slice(i, end)
      out += keepStrings
        ? body
        : c + blank(body.slice(1, Math.max(1, body.length - 1))) + (body.length > 1 ? body[body.length - 1] : "")
      i = end
      continue
    }

    out += c
    i++
  }
  return out
}

const lineAt = (text, index) => {
  let line = 1
  for (let k = 0; k < index && k < text.length; k++) if (text.charCodeAt(k) === 10) line++
  return line
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const importMatches = (spec, entry, sep = "/") => spec === entry || spec.startsWith(entry + sep)

function goImports(noComments) {
  const imports = [] // { path, alias, index }
  const single = /\bimport\s+(?:([A-Za-z_.][\w]*)\s+)?"([^"]+)"/g
  const block = /\bimport\s*\(([\s\S]*?)\)/g
  let m
  while ((m = single.exec(noComments))) imports.push({ path: m[2], alias: m[1] ?? null, index: m.index })
  while ((m = block.exec(noComments))) {
    const inner = m[1]
    const base = m.index + m[0].indexOf("(") + 1
    const line = /(?:([A-Za-z_.][\w]*)\s+)?"([^"]+)"/g
    let k
    while ((k = line.exec(inner))) imports.push({ path: k[2], alias: k[1] ?? null, index: base + k.index })
  }
  return imports
}

function tsImports(noComments) {
  const imports = [] // { path, index, typeOnly }
  const patterns = [
    /\bimport\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(type\s+)?(?:[\w*{}\s,$]+?\s+)?from\s+["']([^"']+)["']/g,
    /\b(?:require|import)\s*\(\s*()["']([^"']+)["']\s*\)/g,
  ]
  for (const re of patterns) {
    let m
    while ((m = re.exec(noComments))) imports.push({ path: m[2], index: m.index, typeOnly: Boolean(m[1]) })
  }
  return imports
}

/** Python: is the line at `index` inside an `if TYPE_CHECKING:` block (erased at runtime)? */
function inTypeChecking(code, index) {
  const lines = code.slice(0, index).split("\n")
  const indentOf = (l) => l.length - l.trimStart().length
  let indent = indentOf(code.slice(code.lastIndexOf("\n", index - 1) + 1).split("\n")[0])
  for (let k = lines.length - 2; k >= 0 && indent > 0; k--) {
    if (lines[k].trim() === "") continue
    const here = indentOf(lines[k])
    if (here >= indent) continue
    if (/^\s*if\s+(?:typing\.)?TYPE_CHECKING\s*:/.test(lines[k])) return true
    indent = here
  }
  return false
}

function pyImports(code) {
  const imports = [] // { path, index, typeOnly }
  const add = (spec, index) => {
    if (spec && !spec.startsWith(".")) imports.push({ path: spec, index, typeOnly: inTypeChecking(code, index) })
  }
  let m
  const plain = /^[ \t]*import[ \t]+([^\n;]+)/gm
  while ((m = plain.exec(code))) for (const part of m[1].replace(/[()\\]/g, " ").split(",")) add(part.trim().split(/\s+/)[0], m.index)
  const from = /^[ \t]*from[ \t]+([\w.]+)[ \t]+import\b/gm
  while ((m = from.exec(code))) add(m[1], m.index)
  return imports
}

/** Python: is the match at `index` the name in a `def` or `class` statement? */
const isPyDeclaration = (code, index) => /\b(def|class)[ \t]+$/.test(code.slice(Math.max(0, index - 20), index))

/**
 * TS: is the `(` at `open` the parameter list of a declaration rather than a call?
 * True for `function f(` and when the matching `)` is followed by `{` or `:`.
 */
function isDeclaration(code, open) {
  const before = code.slice(Math.max(0, open - 40), open)
  if (/\bfunction\s*\*?\s*[\w$]*\s*$/.test(before)) return true
  let depth = 0
  let k = open
  for (; k < code.length; k++) {
    if (code[k] === "(") depth++
    else if (code[k] === ")" && --depth === 0) break
  }
  if (k >= code.length) return false
  const after = code.slice(k + 1).match(/^\s*(\S)/)
  return after !== null && (after[1] === "{" || after[1] === ":")
}

/**
 * Reason given by an allow marker on `line`: undefined when there is no marker,
 * null when the marker has no reason (it then does not suppress anything).
 */
const allowReason = (line, marker) => {
  const re = marker === "file" ? /fe:allow-file\b(.*)$/ : /fe:allow(?!-file)\b(.*)$/
  const m = line.match(re)
  if (!m) return undefined
  const reason = m[1].replace(/\*\/.*$/, "").replace(/-->.*$/, "").trim()
  return reason.length >= 3 ? reason : null
}

const normalizeToken = (s) => s.replace(/\s+/g, " ").trim()

/**
 * Returns { findings, suppressed }. Each item: { line, rule, message, token, snippet }.
 * `suppressed` items carry the `reason` of the fe:allow marker that hid them.
 */
function analyze(source, lang, cfg) {
  const rules = cfg[lang]
  const findings = []
  const suppressed = []
  const lines = source.split("\n")
  const fileMarker = lines.slice(0, 5).map((l) => allowReason(l, "file")).find((r) => r !== undefined)

  const noComments = strip(source, lang, { keepStrings: true })
  const codeOnly = strip(source, lang, { keepStrings: false })

  const push = (index, rule, message, token) => {
    const line = lineAt(source, index)
    const item = { line, rule, message, token: normalizeToken(token), snippet: (lines[line - 1] ?? "").trim().slice(0, 160) }
    const lineMarker = allowReason(lines[line - 1] ?? "", "line")
    const reason = typeof fileMarker === "string" ? fileMarker : lineMarker
    if (typeof reason === "string") return void suppressed.push({ ...item, reason })
    if (lineMarker === null) item.message += " (fe:allow needs a reason)"
    else if (fileMarker === null) item.message += " (fe:allow-file needs a reason)"
    findings.push(item)
  }

  const aliases = { fmt: ["fmt"], time: ["time"] }
  if (lang === "go") {
    for (const imp of goImports(noComments)) {
      if (imp.alias === ".") {
        const hides = GO_DOT_IMPORT_HIDES[imp.path]
        if (hides) push(imp.index, "import", `dot-imports "${imp.path}" (${hides})`, `. ${imp.path}`)
      } else {
        if (imp.path === "fmt" && imp.alias && imp.alias !== "_") aliases.fmt = [imp.alias]
        if (imp.path === "time" && imp.alias && imp.alias !== "_") aliases.time = [imp.alias]
      }
      if (rules.allowImports.some((a) => importMatches(imp.path, a))) continue
      const hit = rules.forbidImports.find(([p]) => importMatches(imp.path, p))
      if (hit) push(imp.index, "import", `imports "${imp.path}" (${hit[1]})`, imp.path)
    }
  } else if (lang === "py") {
    for (const imp of pyImports(codeOnly)) {
      if (imp.typeOnly) continue // erased at runtime
      if (rules.allowImports.some((a) => importMatches(imp.path, a, "."))) continue
      const hit = rules.forbidImports.find(([p]) => importMatches(imp.path, p, "."))
      if (hit) push(imp.index, "import", `imports "${imp.path}" (${hit[1]})`, imp.path)
    }
  } else {
    for (const imp of tsImports(noComments)) {
      if (imp.typeOnly) continue // erased at compile time
      const spec = imp.path.replace(/^node:/, "")
      if (rules.allowImports.some((a) => importMatches(spec, a))) continue
      const hit = rules.forbidImports.find(([p]) => importMatches(spec, p))
      if (hit) push(imp.index, "import", `imports "${imp.path}" (${hit[1]})`, spec)
    }
  }

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  for (const [src, rule, message] of rules.forbidCalls) {
    let pattern = src
    if (lang === "go") {
      pattern = pattern
        .replace("{fmt}", aliases.fmt.map(esc).join("|"))
        .replace("{time}", aliases.time.map(esc).join("|"))
    }
    let re
    try {
      re = new RegExp(pattern, "gm")
    } catch {
      continue
    }
    const guarded = src.startsWith("(^|[^")
    let m
    while ((m = re.exec(codeOnly))) {
      if (m[0].length === 0) re.lastIndex++
      if (lang === "ts" && m[0].endsWith("(") && isDeclaration(codeOnly, m.index + m[0].length - 1)) continue
      const lead = guarded ? (m[1] ?? "").length : 0
      if (lang === "py" && isPyDeclaration(codeOnly, m.index + lead)) continue
      push(m.index + lead, rule, message, m[0].slice(lead))
    }
  }
  const byLine = (a, b) => a.line - b.line
  return { findings: findings.sort(byLine), suppressed: suppressed.sort(byLine) }
}

/** Items in `after` that are not in `before`, as a multiset keyed by rule and token. */
function added(before, after) {
  const key = (f) => `${f.rule}\u0000${f.token}`
  const counts = new Map()
  for (const f of before) counts.set(key(f), (counts.get(key(f)) ?? 0) + 1)
  return after.filter((f) => {
    const k = key(f)
    const c = counts.get(k) ?? 0
    if (c > 0) {
      counts.set(k, c - 1)
      return false
    }
    return true
  })
}

/** Compare two versions of one file: new violations and new exceptions. */
function diffFile(beforeText, afterText, lang, cfg) {
  const before = beforeText === null ? { findings: [], suppressed: [] } : analyze(beforeText, lang, cfg)
  const after = analyze(afterText, lang, cfg)
  return { violations: added(before.findings, after.findings), exceptions: added(before.suppressed, after.suppressed) }
}

const formatFindings = (byFile) => {
  const lines = []
  for (const [file, items] of byFile)
    for (const f of items)
      lines.push(`  ${file}:${f.line}  [${f.rule}] ${f.message}${f.reason ? ` — fe:allow: ${f.reason}` : ""}\n      ${f.snippet}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Proposed content for Write / Edit / MultiEdit
// ---------------------------------------------------------------------------

const replaceOnce = (text, oldStr, newStr, all) => {
  if (!oldStr) return null
  if (all) return text.split(oldStr).join(newStr)
  const at = text.indexOf(oldStr)
  return at === -1 ? null : text.slice(0, at) + newStr + text.slice(at + oldStr.length)
}

function proposedContent(toolName, input, current) {
  if (toolName === "Write") return typeof input.content === "string" ? input.content : null
  if (toolName === "Edit") {
    if (typeof input.new_string !== "string") return null
    const applied = current === null ? null : replaceOnce(current, input.old_string, input.new_string, input.replace_all === true)
    return applied ?? input.new_string // fall back to checking the fragment alone
  }
  if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    let text = current ?? ""
    for (const e of input.edits) {
      const applied = replaceOnce(text, e.old_string, e.new_string ?? "", e.replace_all === true)
      text = applied ?? text + "\n" + (e.new_string ?? "")
    }
    return text
  }
  return null
}

// ---------------------------------------------------------------------------
// git helpers (paths are repo-relative, POSIX)
// ---------------------------------------------------------------------------

const git = (root, args) =>
  execFileSync("git", ["-C", root, "-c", "core.quotepath=off", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
  })

const gitTry = (root, args) => {
  try {
    return git(root, args)
  } catch {
    return null
  }
}

const gitRoot = (dir) => gitTry(dir, ["rev-parse", "--show-toplevel"])?.trim() ?? null
const gitHead = (root) => gitTry(root, ["rev-parse", "--verify", "-q", "HEAD"])?.trim() || null
const splitZ = (s) => (s ?? "").split("\0").filter(Boolean)

/** Paths that differ between `rev` and the working tree, plus untracked files. */
function changedSince(root, rev) {
  const tracked = rev ? splitZ(gitTry(root, ["diff", "--name-only", "-z", "--no-renames", rev, "--"])) : splitZ(gitTry(root, ["ls-files", "-z"]))
  const untracked = splitZ(gitTry(root, ["ls-files", "-z", "--others", "--exclude-standard"]))
  return [...new Set([...tracked, ...untracked])]
}

const gitShow = (root, rev, rel) => (rev ? gitTry(root, ["show", `${rev}:${rel}`]) : null)

// ---------------------------------------------------------------------------
// Per-turn state: baseline snapshot, block counter
// ---------------------------------------------------------------------------

const turnFile = (dir, sessionId) => path.join(dir, "turns", `${sha(String(sessionId ?? "default"), 24)}.json`)

const loadTurn = (dir, sessionId) => parseJson(readText(turnFile(dir, sessionId)) ?? "")

const saveTurn = (dir, sessionId, state) => {
  mkdirSync(path.join(dir, "turns"), { recursive: true })
  writeFileSync(turnFile(dir, sessionId), JSON.stringify(state))
}

const pruneTurns = (dir) => {
  const d = path.join(dir, "turns")
  if (!existsSync(d)) return
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000
  for (const name of readdirSync(d)) {
    try {
      const p = path.join(d, name)
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p)
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Verify command approval: bound to the exact command and the repository path.
// ---------------------------------------------------------------------------

const approvalsFile = (dir) => path.join(dir, "approvals.json")
const approvalKey = (root) => sha(realRoot(root), 32)
const commandHash = (root, command) => sha(`${realRoot(root)}\u0000${command}`)

const loadApprovals = (dir) => parseJson(readText(approvalsFile(dir)) ?? "") ?? { entries: {} }

const isApproved = (dir, cfg) => {
  if (!cfg.verify) return false
  const entry = loadApprovals(dir).entries?.[approvalKey(cfg.root)]
  return entry?.hash === commandHash(cfg.root, cfg.verify.command)
}

function runVerify(cfg) {
  const r = spawnSync(cfg.verify.command, {
    cwd: cfg.root,
    shell: true,
    encoding: "utf8",
    timeout: cfg.verify.timeout * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  })
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd()
  const tail = output.split("\n").slice(-80).join("\n").slice(-6000)
  if (r.error?.code === "ETIMEDOUT") return { ok: false, summary: `timed out after ${cfg.verify.timeout}s`, tail }
  if (r.error) return { ok: false, summary: `could not start: ${r.error.message}`, tail }
  return { ok: r.status === 0, summary: `exit code ${r.status}`, tail }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

function modePre() {
  const hook = parseJson(readStdin())
  if (!hook) return 0
  const input = hook.tool_input ?? {}
  const filePath = input.file_path
  if (typeof filePath !== "string" || !languageOf(filePath)) return 0

  const abs = path.resolve(hook.cwd ?? process.cwd(), filePath)
  const configPath = findConfigFrom(path.dirname(abs))
  if (!configPath) return 0
  const cfg = loadConfig(configPath)
  const rel = isCoreFile(cfg, abs)
  if (!rel) return 0

  const current = readText(abs)
  const next = proposedContent(hook.tool_name, input, current)
  if (next === null) return 0

  const { violations, exceptions } = diffFile(current, next, languageOf(rel), cfg)
  if (violations.length === 0 && exceptions.length === 0) return 0

  if (violations.length > 0) {
    const report = [
      `Model Functional Effect: this edit would add effects to functional-core file ${rel}:`,
      formatFindings([[rel, violations]]),
      "",
      HINT,
    ].join("\n")
    const out =
      cfg.mode === "deny"
        ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: report } }
        : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: report } }
    process.stdout.write(JSON.stringify(out))
    return 0
  }

  // Only new exceptions: the user decides.
  const report = [
    `Model Functional Effect: this edit adds ${exceptions.length} fe:allow exception(s) to functional-core file ${rel}:`,
    formatFindings([[rel, exceptions]]),
    "",
    "Approve only if the effect is deliberate and reviewed; otherwise deny and ask Claude to restructure.",
  ].join("\n")
  const out =
    cfg.mode === "deny"
      ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: report } }
      : { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: report } }
  process.stdout.write(JSON.stringify(out))
  return 0
}

function modeTurn() {
  // UserPromptSubmit: plain stdout would be added to Claude's context, so print nothing.
  const hook = parseJson(readStdin()) ?? {}
  const configPath = findConfigFrom(process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd())
  if (!configPath) return 0
  const cfg = loadConfig(configPath)
  if (cfg.stopCheck === "off" && !cfg.verify) return 0
  const root = gitRoot(cfg.root)
  if (!root) return 0

  const dir = dataDir()
  pruneTurns(dir)
  const head = gitHead(root)
  const snapshots = {}
  let total = 0
  for (const rel of changedSince(root, head)) {
    const abs = path.join(root, rel)
    if (!isCoreFile(cfg, abs)) continue
    const text = readText(abs)
    if (text !== null && (text.length > MAX_SNAPSHOT_BYTES || total + text.length > MAX_SNAPSHOT_TOTAL)) continue
    snapshots[rel] = text // null: deleted at turn start
    total += text?.length ?? 0
  }
  saveTurn(dir, hook.session_id, { root, head, snapshots, blocks: 0, startedAt: new Date().toISOString() })
  return 0
}

function modeStop() {
  const hook = parseJson(readStdin()) ?? {}
  const start = process.env.CLAUDE_PROJECT_DIR || hook.cwd || process.cwd()
  const configPath = findConfigFrom(start)
  if (!configPath) return 0
  const cfg = loadConfig(configPath)
  if (cfg.stopCheck === "off" && !cfg.verify) return 0
  const root = gitRoot(cfg.root)
  if (!root) return 0 // not a git repository: the PreToolUse check still applies

  const dir = dataDir()
  const stored = loadTurn(dir, hook.session_id)
  const turn = stored && stored.root === root ? stored : null
  // Without a baseline (plugin enabled mid-session) fall back to HEAD, and never block twice in a row.
  if (!turn && hook.stop_hook_active === true) return 0
  const baseRev = turn ? turn.head : gitHead(root)
  const snapshots = turn?.snapshots ?? {}

  const violationsByFile = []
  const exceptionsByFile = []
  let coreChanged = false
  for (const rel of new Set([...changedSince(root, baseRev), ...Object.keys(snapshots)])) {
    const abs = path.join(root, rel)
    const relToCfg = isCoreFile(cfg, abs)
    if (!relToCfg) continue
    const before = Object.prototype.hasOwnProperty.call(snapshots, rel) ? snapshots[rel] : gitShow(root, baseRev, rel)
    const after = readText(abs)
    if (before === after) continue
    coreChanged = true
    if (after === null || cfg.stopCheck === "off") continue
    const { violations, exceptions } = diffFile(before, after, languageOf(relToCfg), cfg)
    if (violations.length) violationsByFile.push([relToCfg, violations])
    if (exceptions.length) exceptionsByFile.push([relToCfg, exceptions])
  }

  const notes = []
  if (exceptionsByFile.length)
    notes.push(`Model Functional Effect: this turn added fe:allow exceptions in functional-core files. Review them:\n${formatFindings(exceptionsByFile)}`)

  let blockReason = null
  if (violationsByFile.length) {
    blockReason = [
      "Model Functional Effect: changes in this turn added effects to functional-core files (likely via a shell command):",
      formatFindings(violationsByFile),
      "",
      HINT,
    ].join("\n")
  } else if (coreChanged && cfg.verify) {
    if (isApproved(dir, cfg)) {
      const r = runVerify(cfg)
      if (!r.ok)
        blockReason = [
          `Model Functional Effect: functional-core files changed and the verify command failed (${r.summary}):`,
          `  $ ${cfg.verify.command}`,
          "",
          r.tail,
          "",
          "Fix the failures (or the invariant the change broke) before finishing.",
        ].join("\n")
    } else {
      notes.push(`Model Functional Effect: verify command not run because it is not approved for this repository: ${cfg.verify.command}. Run /functional-effect:verify to review and approve it.`)
    }
  }

  const out = {}
  if (blockReason) {
    const blocks = (turn?.blocks ?? 0) + 1
    if (turn) saveTurn(dir, hook.session_id, { ...turn, blocks })
    if (blocks <= MAX_BLOCKS_PER_TURN) {
      out.decision = "block"
      out.reason = blockReason
    } else {
      notes.push(`Model Functional Effect: still failing after ${MAX_BLOCKS_PER_TURN} attempts this turn; stopping without blocking.\n${blockReason}`)
    }
  }
  if (notes.length) out.systemMessage = notes.join("\n\n")
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out))
  return 0
}

// `paths:` of the path-scoped rule file, from its frontmatter (inline array or YAML list); null if there is none
function ruleFilePaths(root) {
  const text = readText(path.join(root, RULE_FILE))
  if (text === null) return null
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!fm) return null
  const lines = fm[1].split(/\r?\n/)
  const at = lines.findIndex((l) => /^paths\s*:/.test(l))
  if (at < 0) return null
  const inline = lines[at].replace(/^paths\s*:/, "").trim()
  if (inline.startsWith("[")) {
    const v = parseJson(inline)
    return Array.isArray(v) ? v.map(String) : null
  }
  if (inline) return [inline.replace(/^["']|["']$/g, "")]
  const out = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\s*-\s*(.+?)\s*$/.exec(l)
    if (!m) break
    out.push(m[1].replace(/^["']|["']$/g, ""))
  }
  return out
}

function modeSession() {
  readStdin()
  const configPath = findConfigFrom(process.env.CLAUDE_PROJECT_DIR || process.cwd())
  if (!configPath) return 0
  let cfg
  try {
    cfg = loadConfig(configPath)
  } catch (err) {
    process.stdout.write(JSON.stringify({ systemMessage: `Model Functional Effect: ${err.message}. The purity check is not active.` }))
    return 0
  }
  const context = [
    "Model Functional Effect is active in this project (config: .functional-effect.json).",
    `Functional core paths: ${cfg.core.join(", ")}. Code there follows (state₂, commands) = step(state₁, input): no IO, network, filesystem, clock, randomness, console, timers, goroutines, threads, or Effect.run*.`,
    `Imperative shell paths: ${cfg.shell.join(", ")}. The shell parses outside data into core types at the boundary and interprets core commands into effects.`,
    `A PreToolUse check ${cfg.mode === "deny" ? "denies" : "flags"} edits that add effects to core files; new fe:allow exceptions need the user's approval. The functional-effect:model skill describes the pattern.`,
  ]
  context.push(`Profile "${cfg.profile}": ${PROFILE_NOTES[cfg.profile]} Design documents live in ${cfg.designDir}/.`)
  if (cfg.verify) context.push(`When core files change, the verify command \`${cfg.verify.command}\` runs at the end of the turn and failures must be fixed.`)

  const messages = cfg.warnings.map((w) => `Model Functional Effect: ${CONFIG_NAME}: ${w}`)
  const scoped = ruleFilePaths(cfg.root)
  if (scoped && [...scoped].sort().join("\n") !== [...cfg.core].sort().join("\n"))
    messages.push(`Model Functional Effect: ${RULE_FILE} has paths [${scoped.join(", ")}] but "core" is [${cfg.core.join(", ")}]. Update the rule file so it loads on the core files.`)
  if (cfg.verify && !isApproved(dataDir(), cfg))
    messages.push(`Model Functional Effect: the verify command is not approved for this repository and will not run: ${cfg.verify.command}. Run /functional-effect:verify to review it.`)

  const out = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context.join("\n") } }
  if (messages.length) out.systemMessage = messages.join("\n")
  process.stdout.write(JSON.stringify(out))
  return 0
}

function modeApprove(args) {
  const start = argValue(args, "--root") ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const configPath = findConfigFrom(start)
  if (!configPath) {
    process.stdout.write(`No ${CONFIG_NAME} found from ${path.resolve(start)}.\n`)
    return 2
  }
  const cfg = loadConfig(configPath)
  const dir = dataDir(args)
  const approvals = loadApprovals(dir)
  approvals.entries ??= {}
  const key = approvalKey(cfg.root)

  if (args.includes("--revoke")) {
    delete approvals.entries[key]
    writeFileSync(approvalsFile(dir), JSON.stringify(approvals, null, 2))
    process.stdout.write(`Revoked verify approval for ${realRoot(cfg.root)}.\n`)
    return 0
  }
  if (!cfg.verify) {
    process.stdout.write(`${CONFIG_NAME} has no "verify" command.\n`)
    return 2
  }
  const approved = isApproved(dir, cfg)
  if (args.includes("--status")) {
    const prev = approvals.entries[key]
    process.stdout.write(
      [
        `Repository: ${realRoot(cfg.root)}`,
        `Verify command: ${cfg.verify.command} (timeout ${cfg.verify.timeout}s)`,
        `Status: ${approved ? "approved" : prev ? `NOT approved (an earlier, different command was approved: ${prev.command})` : "NOT approved"}`,
      ].join("\n") + "\n",
    )
    return approved ? 0 : 1
  }
  approvals.entries[key] = {
    root: realRoot(cfg.root),
    command: cfg.verify.command,
    hash: commandHash(cfg.root, cfg.verify.command),
    approvedAt: new Date().toISOString(),
  }
  writeFileSync(approvalsFile(dir), JSON.stringify(approvals, null, 2))
  process.stdout.write(`Approved verify command for ${realRoot(cfg.root)}:\n  ${cfg.verify.command}\nIt runs at the end of turns that change functional-core files. Changing the command requires approving it again.\n`)
  return 0
}

const SKIP_DIRS = new Set(["node_modules", ".git", "vendor", "dist", "build", "out", ".next", "coverage", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages"])

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = path.join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) walk(abs, acc)
    else acc.push(abs)
    if (acc.length > 20000) return acc
  }
  return acc
}

function modeScan(args) {
  const json = args.includes("--json")
  const changedOnly = args.includes("--changed")
  const start = argValue(args, "--root") ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  const explicit = args.filter((a, i) => !a.startsWith("--") && !["--root", "--data"].includes(args[i - 1]))

  const configPath = findConfigFrom(start)
  if (!configPath) {
    const msg = `No ${CONFIG_NAME} found from ${path.resolve(start)}. Run /functional-effect:setup first.`
    process.stdout.write(json ? JSON.stringify({ error: msg }) : msg + "\n")
    return 2
  }
  const cfg = loadConfig(configPath)
  for (const w of cfg.warnings) process.stderr.write(`warning: ${CONFIG_NAME}: ${w}\n`)

  let candidates
  if (explicit.length) candidates = explicit.map((f) => path.resolve(start, f))
  else if (changedOnly) {
    const root = gitRoot(cfg.root)
    candidates = root ? changedSince(root, gitHead(root)).map((f) => path.join(root, f)) : walk(cfg.root, [])
  } else candidates = walk(cfg.root, [])

  const violationsByFile = []
  const exceptionsByFile = []
  let scanned = 0
  for (const abs of candidates) {
    const rel = isCoreFile(cfg, abs)
    if (!rel) continue
    const text = readText(abs)
    if (text === null) continue
    scanned++
    const { findings, suppressed } = analyze(text, languageOf(rel), cfg)
    if (findings.length) violationsByFile.push([rel, findings])
    if (suppressed.length) exceptionsByFile.push([rel, suppressed])
  }

  const total = violationsByFile.reduce((n, [, f]) => n + f.length, 0)
  const allowed = exceptionsByFile.reduce((n, [, f]) => n + f.length, 0)
  if (json) {
    const files = (list) => list.map(([file, findings]) => ({ file, findings }))
    process.stdout.write(
      JSON.stringify({ root: cfg.root, scanned, violations: total, exceptions: allowed, warnings: cfg.warnings, files: files(violationsByFile), allowed: files(exceptionsByFile) }, null, 2) + "\n",
    )
  } else {
    const out = []
    if (total === 0) out.push(`Model Functional Effect: ${scanned} core file(s) checked, no effects found.`)
    else out.push(`Model Functional Effect: ${total} violation(s) in ${violationsByFile.length} of ${scanned} core file(s):`, formatFindings(violationsByFile), "", HINT)
    if (allowed) out.push("", `${allowed} reviewed exception(s) (fe:allow):`, formatFindings(exceptionsByFile))
    process.stdout.write(out.join("\n") + "\n")
  }
  return total === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------

const [mode, ...rest] = process.argv.slice(2)
let code = 0
try {
  if (mode === "pre") code = modePre()
  else if (mode === "turn") code = modeTurn()
  else if (mode === "stop") code = modeStop()
  else if (mode === "session") code = modeSession()
  else if (mode === "scan") code = modeScan(rest)
  else if (mode === "approve") code = modeApprove(rest)
  else {
    process.stderr.write("usage: fe-check.mjs <pre|turn|stop|session|scan|approve> [options]\n")
    code = 64
  }
} catch (err) {
  // A broken config or checker bug must never block the user's work silently:
  // report it, exit non-blocking (1).
  process.stderr.write(`functional-effect: ${err?.message ?? err}\n`)
  code = 1
}
process.exitCode = code
