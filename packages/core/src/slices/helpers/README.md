# helpers

The small AI tasks Tokama runs for itself (suggest the checks of a repo, ...), each started by a click. A helper is a definition: its id and version, the inputs Tokama collects for it (a closed list, each with a label and a size cap), its instructions and how long a call may take. The shape of its answer is part of the engine API, so a definition cannot change it.
`readAnswer` finds the one JSON object in the agent's reply and checks it against that shape and the helper's own rule; `retryNote` says what was wrong without repeating what the agent wrote.
The built-in list is empty until the first helper is written.
Must not call an agent, read the repo or build prompts: `workflow-engine` composes the helper with its agent and its inputs.
