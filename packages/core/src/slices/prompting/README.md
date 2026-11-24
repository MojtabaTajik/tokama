# prompting

What one agent call receives: the system text (Tokama rules, then the agent's role) and the user text (step instructions with `{{ step.field }}` references expanded once, then the inputs).
Untrusted content (item text, earlier results, diff, repo files, check output) goes inside data blocks fenced with a random mark that does not occur in the content.
Enforces the data rules at runtime, behind template validation: a cloud step gets only what its `data` rule and `sees` allow, never connection results, and is refused otherwise.
Returns a record of what was included, and the exact text for a cloud agent, for the item store.
Must not read files, run checks or start agents: the caller passes every input in.
