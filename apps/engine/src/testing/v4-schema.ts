/** The tables of schema version 4, as the engine created them before usage was read from the logs. */
export const V4_SCHEMA = `
  CREATE TABLE usage_calls (
    call_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    template_ref TEXT NOT NULL,
    repo_id TEXT,
    ended_at INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE INDEX usage_calls_ended_at ON usage_calls (ended_at);
  CREATE TABLE plan_samples (
    cli_id TEXT PRIMARY KEY,
    as_of INTEGER NOT NULL,
    record TEXT NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_messages (
    key TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    project TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_write INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX claude_local_messages_at ON claude_local_messages (at);
  CREATE TABLE claude_local_files (
    file_key TEXT PRIMARY KEY,
    ino INTEGER NOT NULL,
    offset INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE claude_local_projects (
    project TEXT PRIMARY KEY,
    repo_id TEXT
  ) STRICT;
`;
