---
type: regex
pattern: "outbox|inbox|fenc(ed|ing)|reconcil|idempotency key|chaos"
flags: i
match: not_contains
target: last_message
---
A core-profile design must not ask for persistence, delivery or fencing machinery.
