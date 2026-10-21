# Agent loops as Model Functional Effect

An LLM agent loop is the model with a model in the shell: the core decides what happens next from what has happened; the LLM and the tools are effects.

```
(state₂, commands) = step(state₁, input)

commands:  CallModel{messages} | RunTool{call} | Ask{question} | Stop
inputs:    UserMessage | ModelReplied | ModelFailed | ToolFinished | ToolFailed | Approved | Denied | BudgetTick
```

The loop is `commands → interpret → inputs → step`, exactly as in any other feature. Nothing about the LLM changes the shape; it changes what must be parsed and what must be bounded.

## State

A sum type; the data each variant carries is what keeps illegal states out.

```ts
type State =
  | { tag: "Idle" }
  | { tag: "Thinking"; turn: number; history: Message[]; spent: Budget }
  | { tag: "RunningTools"; turn: number; history: Message[]; pending: ToolCall[]; done: ToolResult[]; spent: Budget }
  | { tag: "AwaitingApproval"; turn: number; history: Message[]; call: ToolCall; spent: Budget }
  | { tag: "Finished"; answer: string }
  | { tag: "Aborted"; reason: "budget" | "turn-limit" | "denied" | "model-failed" }
```

`history` is data in the state, not a mutable list in the shell. `turn` and `spent` are what the invariants talk about.

## Boundary: LLM output is untrusted input

Parse the model's reply into core types before it reaches `step`, once, in the shell:

- Tool calls: tool name must be one the agent has; arguments are decoded against that tool's schema. A call that fails to parse becomes `ModelReplied` with a `malformed` result (or `ToolFailed`), which the core can answer with one repair attempt. It is never an exception and never executed.
- Stop reasons, truncation (`max_tokens`) and refusals are inputs with their own transitions, not strings to compare in the shell.
- Anything the model says about its own limits (budget, permissions) is ignored; the core owns them.

## Commands and policy

- `RunTool` is a command: the core does not call the tool. The interpreter dispatches by tool name to an injected capability.
- **Policy sits between the command and the effect.** The core marks a call as needing approval (state `AwaitingApproval`); the shell asks the human and feeds back `Approved` or `Denied`. Approval for a call is bound to that call's exact arguments.
- Tool idempotency matters for retries: a read can be retried freely; a write, send or deploy needs an idempotency key derived from state (`tool:<turn>:<callId>`) or must not be retried after an unknown outcome.
- Independent tool calls may run as a batch (`RunTools`); their results come back as one `ToolFinished` each, tagged with the `callId` and `turn`, so late results from an abandoned turn are ignored.

## Invariants for property tests

Phrase these so a random input sequence can check them after every step:

- **Bounded**: `spent` never exceeds the budget, and `turn` never exceeds the limit; the step that would exceed either goes to `Aborted`.
- **Terminal states are terminal**: after `Finished` or `Aborted`, no command is emitted.
- **No orphan results**: a `ToolFinished` for a call that is not pending (stale turn, unknown id, duplicate) changes nothing.
- **Approval gates execution**: no `RunTool` for a call that needs approval unless `Approved` for that call came first.
- **Progress**: every non-terminal state emits at least one command or is waiting for a named input.
- **One thing at a time per call**: a `callId` has at most one result recorded.

## Testing without a model

- Test `step` with generated input sequences; a fake model is just another input generator.
- Contract-test the `Model` capability (`reply(messages) → ModelReplied | ModelFailed`) against a scripted fake and, gated on an API key in the environment, the live client: success, tool-call reply, malformed reply, truncation, rate limit, timeout.
- Replay: the final state equals `run(initial, recordedInputs)`. A recorded session is a regression test: re-run `step` over its inputs, no network.
- Shell tests: a tool that hangs (timeout becomes `ToolFailed`), a tool that returns after the turn was abandoned, a crash between the model reply and the tool run.

## Mapping to Claude Code

This is how Claude Code itself behaves: plan mode is a state, permission rules are the policy, tools run in interpreters (sandbox, worktree), the transcript is the event log, and resume replays it.
