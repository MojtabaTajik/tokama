# config

Loads the engineer's config files: agents (`<id>.md`, YAML front matter plus role text) and `repos.yaml`.
Agents resolve for one repo: personal (`~/.tokama/agents/`) over the repo's shared (`.tokama/agents/`) over the built-in Builder.
Every file carries `format: 1`; problems are plain words with the file and line, and any invalid file fails the load.
Reads only through fs-safe and never writes. Records hold no paths except a repo's host-local `path`.
Must not launch agents or check that a CLI or model exists: callers do that.
