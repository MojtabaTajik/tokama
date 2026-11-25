# claude-code

AgentRuntime adapter: runs one headless `claude -p` call per launch through the kernel process runner, stream-json in and out.
Maps the step's tool limits onto Claude Code's own permission flags (never a skip-permissions flag), parses the stream into typed events, and classifies failures (quota, rate limit, auth, crash, timeout).
Also reads the plan windows (the `limits` list, with weekly limits scoped to one model and their share, or else the older fixed windows): Claude Code's own `get_usage` answer from an idle restricted session (version-checked), else the `cachedUsageUtilization` key of `~/.claude.json`, read-only.
Also reads Claude Code's session logs (`~/.claude/projects/**/*.jsonl`) for the usage of every Claude Code call on this machine: only the model, the four token counts, the time and the message id of assistant messages, through fs-safe (real folders only, no links, size caps), from where the last read of each log ended. Message text, tool inputs and tool outputs are dropped as each line is parsed; project folder names leave the reader only as hashes, and repos are matched by encoding their paths the way Claude Code names its folders.
Must not read Claude Code's credentials or any other of its files, and must not send anything itself: the CLI does the network calls.
Tests run against `testing/fake-claude.ts`, which replays recorded stream-json samples; `TOKAMA_REAL_CLAUDE=1` adds one call to the real CLI.
