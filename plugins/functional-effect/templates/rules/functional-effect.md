---
paths: ["internal/core/**", "src/core/**"]
---

# Functional core (Model Functional Effect)

- Files under these paths are the functional core: `(state₂, commands) = step(state₁, input)`.
- The core has no IO, network, filesystem, database, console or logging, clock reads, randomness, timers, goroutines, threads, environment access, or `Effect.run*`.
- `State`, `Input` and `Command` are closed sum types (Go: sealed interfaces; TS: discriminated unions with `tag`; Python: unions of frozen dataclasses matched with `match` and `assert_never`) when their variants carry different data. A plain status with no data per value can be a named enum (Go: `type X string` + constants + validation; TS: a string-literal union; Python: an `Enum` or `Literal`). State combinations are not modeled with boolean flags or raw strings.
- Unhandled `(state, input)` pairs return the state unchanged with no commands.
- Values that need validation are branded/value types created only by smart constructors; wire formats stay in the shell.
- The clock, random values and generated IDs arrive as fields on an `Input`.
- Every change to `step` comes with property tests that run random input sequences and check invariants.
- The shell (boundary parsers, interpreter, wiring) lives outside these paths.
