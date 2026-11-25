# diagnostics

What Tokama records about its own errors and use, kept in `<home>/diagnostics/` so a user can choose to send it. Nothing here sends anything.

- `redact.ts` cleans text before it is written: Tokama's own code paths become `<app>/...`, other paths `<path>`, URLs `<url>`, emails `<email>`, token shapes and long hex or base64 runs `<token>`, repo names `<repo>` and the login name `<user>`. `cleanStack` also cuts a stack to its line and character caps; `fingerprint` gives the same id for the same failure across line numbers and messages.
- `DiagnosticsStore` writes `entries.jsonl` (append-only, one entry per line, 0600) and `settings.json` (the off switch, the resettable install id, the time the last crash was seen). It builds every entry from typed parts and cleans the stack itself, so no caller can write an uncleaned one. Old entries go first: after 30 days, or when the file passes 2 MB (`MAX_DIAGNOSTICS_BYTES`, what one upload may hold).
- `engine.running` is set when the store opens and removed by `close()`. Found at open, it means the last engine did not stop cleanly: a `crash` entry is recorded and `settings().crashWaiting` is true until the crash is marked seen or deleted.
- Usage is counted in memory per UTC day and written by `flushUsage()` (on a timer, on a new day and on close). Each flush writes one entry per day with a count per action since the last flush, so a day's total is the sum of its entries.
- With collecting off, nothing new is written, pending counts included. A settings file that exists but does not load turns collecting off and is left as it is. After `close()` nothing is written.
