# kernel

Security and shared primitives: process, git, command policy, egress, safe file reads, secrets, machine metrics, schemas, ports, and the small helpers every part shares (clock, result, hash, errno, JSON lines, text).
Each primitive exists here once. Slices and adapters use the kernel; the kernel imports neither.
The login-shell PATH reader (`process/login-path.ts`) is the one place that starts the user's shell; it reads only the PATH.

`ports/testing/` holds the port contract suites and in-memory fakes. It is left out of the build; adapter tests import it.
