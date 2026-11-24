# execution

One agent call: launch through an agent runtime, loop guards, usage capture.
Loop guards stop a call that loops: a turn cap, a same-call repeat limit, an idle stop (only after file changes and passing checks) and a timeout. Each stop is recorded with the time wasted.
Guard settings are internal settings with defaults, not template fields.
Must not run checks or read the working tree itself: the caller passes those in.
