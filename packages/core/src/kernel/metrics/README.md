# metrics

Read-only readings of this machine: memory, and the CPU time and memory of every process. The OS-specific part is one interface, `MachineSource`, with one implementation per OS (`macos.ts`, `linux.ts`); `createMachineSource` picks the one for this OS.

- macOS reads `vm_stat` and `ps` through the process runner. Linux reads `/proc` and starts no command.
- Each file has a parser that takes plain text, tested on recorded output (`testing/`).
- A reading that fails comes back as an error value; it never throws.

`readMachineFacts()` gives general facts for diagnostics: OS and version, architecture, CPU family and cores, RAM and GPU memory as ranges, and the GPU model when a file names it. The OS-specific part is `OsFacts` (`macosFacts`, `linuxFacts`, `windowsFacts`); each reads files only (SystemVersion.plist, /etc/os-release, /proc and /sys) and starts no command. Exact amounts, the display and the locale are never read into it.
