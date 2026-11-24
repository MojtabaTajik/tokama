# verification

Runs the check and setup commands Tokama runs itself in an item's worktree: `runCommand`, `runChecks`, and `checksPass` in the shape the loop guards take.
Every command passes the command policy (rules from the caller), then runs through the process runner with a timeout and the allowlisted environment.
Results are plain JSON: outcome, exit status, duration and a capped output tail; a refused command is a result, not a throw.
Must not decide which rules apply or store results: callers do that. A full-output file goes outside the worktree.
