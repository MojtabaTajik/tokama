# Security policy

## Reporting a vulnerability

Please report a vulnerability privately, not in a public issue or pull request.

Use GitHub's private vulnerability reporting: on the repository page, open the Security tab and choose **Report a vulnerability**. It is turned on for this repository. If you cannot use it, write to hello@tokama.dev.

Say which version you tested (About shows it), your operating system, and what you did, so that I can repeat it. A short proof of concept helps. Please do not test against other people's machines or accounts.

## What is in scope

Anything in this repository and in the apps built from it, for example:

- a way for an agent, a template or a repo's content to run commands outside the rules and the sandbox described in the README
- a way to read or write files, or reach hosts, that Tokama says it blocks
- leaks of secrets, such as tokens or the contents of well-known secret files
- a flaw in how Tokama installs, signs or verifies updates and release files
- a flaw in the local engine and its API, such as access by another user or by a web page

Out of scope:

- the limits the README already lists, such as check commands that run unsandboxed as your user, or a registry that can carry data out
- a template or check command you chose to run that does harm
- problems in Claude Code, git, Electron or another dependency with no way to trigger them through Tokama (report those to their own projects)
- reports from automated scanners with no demonstrated effect

## What to expect

One person maintains Tokama, so there is no fixed response time. I read every report, usually reply within a few days, and tell you whether I can reproduce the problem. I fix confirmed problems as soon as I can and keep you updated. Please give me time to ship a fix before you publish details. I name reporters in the release notes unless you ask me not to.

There is no bounty program.
