# workflow-engine

Runs an item through its template: Start (worktree, setup), each step's attempts under the loop guards, tamper checks, done_when, if_failed, decisions, and Finish (the commit). The only slice that composes others.
The log is the state: every change is an event before the loop acts on it, and the loop resumes from the log after a decision or a restart. Commands (`startItem`, `resolveDecision`, `stopItem`) wait for restart recovery first.
Run failures (crash, quota, auth, timeout) ask and never count as attempts; work failures (checks, reviewer changes) count. A `checks pass` attempt removes ignored files, runs setup, fixes the tree, then runs the checks; Finish commits that tree.
Git and Tokama file changes stop the item; package, test and CI file changes ask. A reviewer's reply must end with `VERDICT: approve` or `VERDICT: changes`.
Must not spawn processes, run git or read config itself: the kernel and the other slices do, through the ports it is given.
