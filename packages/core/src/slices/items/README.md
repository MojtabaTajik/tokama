# items

Item storage: each item's append-only event log (`<home>/items/<id>/events.jsonl`) with its other files beside it, the item record folded from the log, and restart recovery.

- The record is a pure fold over the events. The store folds every new event before it appends it, so a log never holds an event that does not fit the item's history.
- Appends are one write plus fsync. A new item's folder is fsynced too. Listeners hear about a change only after it is on disk.
- A last line cut short by a crash is ignored on read and cut off before the next append.
- Deletes are tombstones. Nothing may follow one.
- Events carry the host id and the UTC time. Records hold no absolute paths or user names.
- On start, a step that was running becomes a run failure (not counted) with a Retry step / Stop decision. Its leftover processes are killed through the kernel's `killLeftoverTree`, which checks the boot time and the start time first.

Usage per call is read from these logs. The engine app's SQLite database holds only what is not in them: plan samples and Claude Code's own usage.
