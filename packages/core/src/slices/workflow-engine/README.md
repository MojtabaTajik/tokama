# workflow-engine

Runs an item through its template: Start (worktree, setup), each step's attempts under the loop guards, done_when, if_failed, decisions, and Finish (the commit). The only slice that composes others.
The log is the state: every change is an event before the loop acts on it, and the loop resumes from the log after a decision or a restart. Commands (`startItem`, `resolveDecision`, `stopItem`) wait for restart recovery first.
Run failures (crash, quota, auth, timeout) ask and never count as attempts; work failures (checks, reviewer changes) count. A step entered again after a back starts a new round: `max_attempts` counts each round, and each step may send the work back 3 times before the item asks. Counters, grants, rounds and the budget come from the log (`counters.ts`).
Protection (`protect.ts`): files that steer Tokama (git config entries except the remote and tracking keys a push writes, with network URLs only, included config files, hooks, attributes, HEAD, `.tokama/`) are hashed once after setup passed at Start; any later change stops the item. Each staged tree is judged against the base commit; protected changes ask, and an approval covers that exact content. The checked, reviewed and committed tree is one tree.
Results: a step that sees an earlier step gets `{{ <step>.summary }}`, that step's final reply. A reviewer's reply must end with `VERDICT: approve` or `VERDICT: changes`; changes go back as a feedback block.
Must not spawn processes, run git or read config itself: the kernel and the other slices do, through the ports it is given.
