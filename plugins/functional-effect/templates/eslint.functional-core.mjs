// Model Functional Effect: enforce a pure functional core in CI (ESLint flat config).
// Spread `functionalCore` into your eslint.config.mjs and adjust `files`.
// Uses typescript-eslint for `allowTypeImports` (type-only imports are erased at compile time).
// Note: check typescript-eslint's TypeScript peer range; as of Oct 2026 it does not yet accept
// TypeScript 7, so lint with a TypeScript 5.x/6.0 install if your build uses tsc 7.

import tseslint from "typescript-eslint"

const nodeIO = ["fs", "fs/promises", "child_process", "net", "http", "https", "http2", "dgram", "dns", "tls", "os", "process", "worker_threads", "cluster", "readline", "timers", "perf_hooks"]

export const functionalCore = [
  {
    files: ["src/core/**/*.{ts,tsx,mts,cts}"],
    ignores: ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      // switch-exhaustiveness-check needs type information.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Every variant of State/Input/Command is handled; a `default:` does not count,
      // so a new variant is never swallowed by a catch-all.
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        { considerDefaultExhaustiveForUnions: false, requireDefaultForNonUnion: false },
      ],
      "no-console": "error",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [...nodeIO, ...nodeIO.map((m) => `node:${m}`)].map((name) => ({
            name,
            allowTypeImports: true,
            message: "functional core: no IO. Return a Command and interpret it in the shell.",
          })),
          patterns: [
            {
              group: ["axios", "node-fetch", "undici", "got", "ky", "pg", "mysql2", "mongodb", "mongoose", "redis", "ioredis", "@prisma/client", "knex", "sequelize", "typeorm", "@aws-sdk/*", "express", "fastify", "koa", "@effect/platform-*"],
              allowTypeImports: true,
              message: "functional core: infrastructure belongs in the shell.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "functional core: return a Command instead of fetching." },
        { name: "setTimeout", message: "functional core: scheduling belongs in the shell." },
        { name: "setInterval", message: "functional core: scheduling belongs in the shell." },
        { name: "localStorage", message: "functional core: storage belongs in the shell." },
        { name: "sessionStorage", message: "functional core: storage belongs in the shell." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "functional core: the clock arrives as an Input field." },
        { object: "Math", property: "random", message: "functional core: randomness arrives as an Input field." },
        { object: "process", message: "functional core: no process access." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "functional core: the clock arrives as an Input field." },
        { selector: "CallExpression[callee.object.name='Effect'][callee.property.name=/^run/]", message: "functional core: Effect.run* belongs at the edge." },
      ],
    },
  },
]
