# kernel

Security and shared primitives: process, git, command policy, egress, safe file reads, secrets, machine metrics, schemas, ports, and the small helpers every part shares (clock, result, hash, errno, text).
Each primitive exists here once. Slices and adapters use the kernel; the kernel imports neither.

`ports/testing/` holds the port contract suites and in-memory fakes. It is left out of the build; adapter tests import it.
