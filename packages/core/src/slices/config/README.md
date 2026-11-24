# config

Loads the engineer's config files: agents (`<id>.md`, YAML front matter plus role text) and `repos.yaml`.
Agents resolve for one repo: personal (`~/.tokama/agents/`) over the repo's shared (`.tokama/agents/`) over the built-in Builder.
Every file carries `format: 1`. Problems are plain words with the file and line; a bad agent file is skipped and reported, and still claims its id.
Reads only through fs-safe and never writes; symlinks are followed in `~/.tokama`, refused in a repo. Records hold no paths except a repo's host-local `path`.
Must not launch agents or check that a CLI or model exists: callers do that.
