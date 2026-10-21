---
type: llm
criteria: "The answer structures the loop as a pure step function over state and inputs; model replies and tool results are inputs; calling the model and running a tool are commands interpreted in a shell; the model's output is parsed and validated at a boundary before it reaches the core (a malformed tool call is a handled input, not executed); approval gates execution of risky tools; budget and turn limit are invariants checked in the core with a terminal aborted state; it recommends property tests over generated input sequences and replaying recorded sessions, with a fake model."
focus: last_message
---
