# command-policy

Decides whether a check or step command may run: `checkCommand(command, rules, grammar)`.
One grammar per shell behind `ShellGrammar` (POSIX `sh` now, PowerShell later). A guardrail, not a full shell parser.
Owns the allowlist decision only; it never runs anything. See `docs/spec/architecture.md`, sections 6 and 9.

Notes for the check runner:

- Rules for interpreters or launchers (`node:*`, `python3:*`, `env:*`, `npx:*`) allow any code by design: the policy checks which command starts, not what it does.
- Leading variable assignments (`FOO=1 npm test`) are refused on purpose: they can change how the allowed command behaves (`NODE_OPTIONS`, `PATH`). Pass variables through the process runner's environment instead.
