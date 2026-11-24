# api

The versioned engine API: commands, queries and events. Fully serializable; no Electron, Node or OS types cross it.
Clients (desktop, CLI, later mobile) use it through `@tokama/client`, never the slices.
See `docs/spec/architecture.md`, section 3.
