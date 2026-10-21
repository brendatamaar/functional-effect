---
type: llm
criteria: "The code is a pure step function (state and input in, new state and commands out) with state and input as closed sum types; the current time arrives as a field on an input (or expiry is a scheduled input emitted as a command); trial status variants that carry different data (e.g. an expiry, an extension) are separate variants, not booleans; unhandled state/input pairs return the state unchanged with no commands; it suggests or includes property tests over input sequences."
focus: last_message
---
