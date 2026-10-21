---
type: regex
pattern: "time\\.Now\\(|time\\.Since\\(|time\\.Sleep\\(|time\\.After\\("
match: not_contains
target: last_message
---
The core must not read the clock or sleep.
