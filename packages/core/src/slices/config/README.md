# config

Loads the engineer's config files: agents (`<id>.md`, YAML front matter plus role text) and `repos.yaml`.
Agents resolve for one repo: personal (`~/.tokama/agents/`) over the repo's shared (`.tokama/agents/`) over the built-in Builder.
Every file carries `format: 1`. Problems are plain words with the file and line; a bad agent file is skipped and reported, and still claims its id.
Reads only through fs-safe and never writes. Links in `~/.tokama` (`repos.yaml`, `agents/` and the agent files) are resolved first, so dotfile managers work; a link that leads nowhere is reported. Linked files and folders in a repo's `.tokama` are never followed, because repo content can come from anyone. Records hold no paths except a repo's host-local `path`.
Must not launch agents or check that a CLI or model exists: callers do that.
