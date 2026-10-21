---
type: llm
criteria: "The boundary parser uses zod and returns a value for rejected input (not an exception into the core); capabilities are passed in (a deps object or parameters, not imported globals); a decline becomes an input/result value, not a thrown error; an unavailable gateway is retried or left as an unknown outcome, and any retry is safe because of an idempotency key on the charge."
focus: last_message
---
