# sandbox

What an agent's commands may touch, written once for every AI CLI adapter, and whether this machine can run the CLI's sandbox.

- `SandboxSpec`: the one writable folder (the call's working directory), folders that are read-only, and a `network` policy: the hosts commands may reach and what happens to every other host (`unlisted: "deny"`; a way to ask a person can become another case, and every adapter then has to handle it). It covers commands only: a CLI's file and web tools are outside it. `checkSandboxSpec` refuses a spec that cannot be enforced as written: relative paths, a writable folder that is not the working directory, overlapping roots, Tokama's own folder, and anything that is not a plain host name (no bare `*`, no IP address).
- `PACKAGE_REGISTRY_HOSTS`: the package registries a build needs. Every host is also a way for data to leave, so the list is short and has no code host.
- `toolCacheDirs(platform)`: the tool caches a build may write. `usableCacheDirs` drops one that is on the call's PATH or holds a PATH folder, so a command cannot plant a program that later runs outside the sandbox.
- `CREDENTIAL_PATHS`: well-known login and key files, closed to reads.
- `createSandboxSupport`: one implementation per OS. macOS has the sandbox built in. Linux needs `bwrap` and `socat`, started through the same runner and environment as the call, and two no-ops that run inside `bwrap` with the options Claude Code uses: one plain, one that makes a nested user namespace as Claude Code's `apply-seccomp` helper does (so an AppArmor rule that blocks either shows up as "installed but blocked", not as a failed step later; when the nested one fails, `/proc/self/attr/current` inside the sandbox is read to name Ubuntu's `unpriv_bwrap` profile). `BWRAP_BLOCKED_HINT` and `NESTED_BLOCKED_HINT` are the fix texts the check and the adapter's failed-step messages use. Other systems have no sandbox. A failure is never cached.

Each adapter maps the spec onto its CLI's own flags; nothing here knows a CLI.
