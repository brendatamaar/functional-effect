---
type: llm
criteria: "The response is a design, not code, and covers: the states (including payment unknown/timed out and cancelled), a transition table or equivalent legal moves, commands described as data, a distinct handling for the timed-out payment that is neither a plain retry nor a plain failure, idempotency, and ends by asking the user to approve or change the design. It contains no implementation code beyond type sketches."
focus: last_message
---
Fail if the response jumps to implementation, treats the payment timeout as a simple failure, or retries a charge without an idempotency key.
