# machine

CPU and memory of this computer and of Tokama's own processes, sampled only while a client asks.
- CPU is the change in CPU time between two readings, so the first answer after a pause waits one short warm-up. Memory is what the OS cannot give back at once, not the cache.
- A process group counts everything started below its root as well as its members, because agents start shell commands in groups of their own. A process is counted once.
- The engine's own share is its process alone; the agent and check processes it started are counted under their items.
- The OS-specific readings are `kernel/metrics`. This slice only does the sums, the history and the on-demand loop.
