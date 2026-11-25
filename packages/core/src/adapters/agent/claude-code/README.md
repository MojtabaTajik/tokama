# claude-code

AgentRuntime adapter: runs one headless `claude -p` call per launch through the kernel process runner, stream-json in and out.
Maps the step's tool limits onto Claude Code's own permission flags (never a skip-permissions flag), parses the stream into typed events, and classifies failures (quota, rate limit, auth, crash, timeout).
Also reads the plan windows: Claude Code's own `get_usage` answer from an idle restricted session (version-checked), else the `cachedUsageUtilization` key of `~/.claude.json`, read-only.
Must not read Claude Code's credentials or any other of its files, and must not send anything itself: the CLI does the network calls.
Tests run against `testing/fake-claude.ts`, which replays recorded stream-json samples; `TOKAMA_REAL_CLAUDE=1` adds one call to the real CLI.
