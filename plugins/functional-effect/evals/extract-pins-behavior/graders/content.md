---
type: llm
criteria: "The response maps the handler (decisions, state loaded, effects, results) and proposes pinning current behavior with characterization tests before changing anything; it identifies Date.now() as an input field and the charge, update and mail as commands; it keeps the handler's observable behavior the same; it reports the suspicious double coupon discount as a finding to ask about and does NOT silently change the arithmetic in its refactored version."
focus: last_message
---
Fail if the extracted code changes the total computation, or if no behavior-pinning step comes before the extraction.
