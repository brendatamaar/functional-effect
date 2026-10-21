---
type: regex
pattern: "from ['\"]effect|Effect\\.(gen|runPromise|retry)|Context\\.Service|Schema\\.decodeUnknown"
match: not_contains
target: last_message
---
The project does not depend on Effect; the answer must not use it.
