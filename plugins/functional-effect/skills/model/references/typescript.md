# Model Functional Effect in plain TypeScript

No framework required: discriminated unions, a schema library at the boundary (zod shown), plain objects for capabilities, and `fast-check` for properties. Using Effect v4? See [typescript-effect.md](typescript-effect.md); the model is the same.

## Layout

```
src/core/     pure: types, step, run (type-only imports at most)
src/shell/    boundary (zod), capabilities, interpreter, app, fakes
src/main.ts   the edge: build the capabilities, read the clock, start the app
```

## Sum types and branded values

```ts
export type Amount = number & { readonly __brand: "Amount" }
export const Amount = (n: number): Amount => {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`invalid amount: ${n}`) // caught at the boundary only
  return n as Amount
}

export type State =
  | { readonly tag: "Draft" }
  | { readonly tag: "AwaitingPayment"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number }
  | { readonly tag: "Paid"; readonly orderId: OrderId }
  | { readonly tag: "Failed"; readonly orderId: OrderId; readonly reason: string }

export type Input =
  | { readonly tag: "Submit"; readonly orderId: OrderId; readonly amount: Amount }
  | { readonly tag: "PaymentSucceeded"; readonly orderId: OrderId; readonly attempt: number }
  | { readonly tag: "PaymentFailed"; readonly orderId: OrderId; readonly attempt: number; readonly reason: string }

export type Command =
  | { readonly tag: "ChargeCard"; readonly orderId: OrderId; readonly amount: Amount; readonly attempt: number; readonly key: string }
  | { readonly tag: "ScheduleInput"; readonly afterMs: number; readonly input: Input }
```

A plain status with no data per value can be a string-literal union (`"queued" | "running" | "done"`); use a tagged union once a variant carries its own data. Exhaustiveness: end every switch with `const _: never = x` (or the ESLint template's `switch-exhaustiveness-check`), never a `default` that returns the state.

```ts
const assertNever = (x: never): never => { throw new Error(`unhandled: ${JSON.stringify(x)}`) }
```

## step: guards on state and attempt

```ts
export const step = (s: State, i: Input): readonly [State, readonly Command[]] => {
  switch (i.tag) {
    case "Submit":
      if (s.tag !== "Draft") return [s, []]
      return [
        { tag: "AwaitingPayment", orderId: i.orderId, amount: i.amount, attempt: 1 },
        [{ tag: "ChargeCard", orderId: i.orderId, amount: i.amount, attempt: 1, key: chargeKey(i.orderId, 1) }],
      ]
    case "PaymentSucceeded":
      if (s.tag !== "AwaitingPayment" || s.orderId !== i.orderId || s.attempt !== i.attempt) return [s, []]
      return [{ tag: "Paid", orderId: s.orderId }, []]
    case "PaymentFailed":
      if (s.tag !== "AwaitingPayment" || s.orderId !== i.orderId || s.attempt !== i.attempt) return [s, []]
      return [{ tag: "Failed", orderId: s.orderId, reason: i.reason }, []]
    default:
      return assertNever(i)
  }
}

export const run = (initial: State, inputs: readonly Input[]) =>
  inputs.reduce<readonly [State, readonly Command[]]>(([s, cs], i) => {
    const [next, more] = step(s, i)
    return [next, [...cs, ...more]]
  }, [initial, []])
```

Time and keys are data: `{ tag: "ScheduleInput", afterMs, input: { tag: "PaymentTimedOut", orderId, attempt } }`; `chargeKey(orderId, attempt)` is a pure function of state.

UI state: the same `step` is a reducer (`useReducer` in React, or a Pinia/Vue store whose only mutation is `state = step(state, input)[0]`), with commands dispatched by an effect hook or composable.

## Boundary (zod)

```ts
const EventSchema = z.discriminatedUnion("tag", [
  z.object({ tag: z.literal("Submit"), eventId: z.string().min(1), orderId: z.string().min(1), amount: z.number().int().positive() }),
  z.object({ tag: z.literal("PaymentSucceeded"), eventId: z.string().min(1), orderId: z.string().min(1), attempt: z.number().int().positive() }),
])

export type Parsed = { ok: true; id: string; input: Input } | { ok: false; reason: string }

export const parseEvent = (raw: unknown): Parsed => {
  const r = EventSchema.safeParse(raw)
  if (!r.success) return { ok: false, reason: r.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") }
  const e = r.data
  return e.tag === "Submit"
    ? { ok: true, id: e.eventId, input: { tag: "Submit", orderId: OrderId(e.orderId), amount: Amount(e.amount) } }
    : { ok: true, id: e.eventId, input: { tag: "PaymentSucceeded", orderId: OrderId(e.orderId), attempt: e.attempt } }
}
```

The parser returns a value, not an exception: rejection is a domain outcome the HTTP layer maps to a 400.

## Capabilities and the interpreter

```ts
export interface PaymentGateway {
  charge(key: string, orderId: OrderId, amount: Amount, signal: AbortSignal): Promise<ChargeResult>
}
export type ChargeResult =
  | { tag: "Charged" }
  | { tag: "Declined"; reason: string }       // domain outcome: a value, not a throw
  | { tag: "Unavailable" }                    // transient: the interpreter decides on retry
export interface Deps { gateway: PaymentGateway; clock: () => number }

export const interpret = async (cmd: Command, deps: Deps): Promise<Input | undefined> => {
  switch (cmd.tag) {
    case "ChargeCard": {
      const r = await withRetry(() => deps.gateway.charge(cmd.key, cmd.orderId, cmd.amount, AbortSignal.timeout(5_000)), isUnavailable)
      if (r.tag === "Charged") return { tag: "PaymentSucceeded", orderId: cmd.orderId, attempt: cmd.attempt }
      if (r.tag === "Declined") return { tag: "PaymentFailed", orderId: cmd.orderId, attempt: cmd.attempt, reason: r.reason }
      return undefined                         // unknown outcome: wait for the timer
    }
    case "ScheduleInput":
      return undefined                         // handled by the scheduler, not here
    default:
      return assertNever(cmd)
  }
}
```

`Deps` is passed in, never imported as a global; `main.ts` builds the real ones and tests build fakes. Retry only commands that are idempotent or carry a key; wrap `withRetry`, timeouts and tracing around the capability or the interpreter so the flow stays readable.

## Property tests with fast-check

```ts
import fc from "fast-check"

const orderId = fc.constantFrom("ord-1", "ord-2").map(OrderId)           // small domain, so sequences collide
const input: fc.Arbitrary<Input> = fc.oneof(
  fc.record({ tag: fc.constant("Submit" as const), orderId, amount: fc.constantFrom(100, 500).map(Amount) }),
  fc.record({ tag: fc.constant("PaymentSucceeded" as const), orderId, attempt: fc.integer({ min: 1, max: 3 }) }),
)

test("at most one ChargeCard per attempt", () => {
  fc.assert(
    fc.property(fc.array(input, { maxLength: 40 }), (inputs) => {
      const [, commands] = run({ tag: "Draft" }, inputs)
      const keys = commands.flatMap((c) => (c.tag === "ChargeCard" ? [c.key] : []))
      return new Set(keys).size === keys.length
    }),
    { numRuns: 2000 },        // shrinks to the shortest failing sequence; add { seed } to reproduce
  )
})
```

One property per invariant, named after it. Boundary: round trip, accepted ⇒ valid (against a predicate written independently of the parser), rejects each broken rule; messy input is valid events perturbed with `fc.anything()`. Contract suites are functions taking a factory (`(make: () => PaymentGateway) => void`) and run for the fake and the live adapter.

## Persistence

For the `distributed` profile: load → `step` → commit in one transaction (version, inbox, event log, state, outbox), a worker draining the outbox. The SQL is in [outbox.md](outbox.md); the complete shell is in `examples/typescript` (written with Effect; the structure carries over).

## Enforcing it with ESLint

For CI and human edits, add `templates/eslint.functional-core.mjs` (purity rules and `switch-exhaustiveness-check`).
