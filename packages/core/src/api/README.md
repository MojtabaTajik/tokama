# api

The versioned engine API: commands, queries and events. Fully serializable; no Electron, Node or OS types cross it.
Clients (desktop, CLI, later mobile) use it through `@tokama/client`, never the slices.
The message schemas live in `kernel/schemas`; this folder holds the local transport both sides share: line framing with a size cap, and the endpoint (socket, token and lock paths).
