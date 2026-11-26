import type { SandboxSupport } from "./support.js";

/** Tool caches a build may write on macOS, `~/`-relative. Never a folder with programs on the PATH. */
export const MACOS_CACHE_DIRS: readonly string[] = [
  "~/.npm",
  "~/Library/pnpm/store",
  "~/Library/Caches/pnpm",
  "~/Library/Caches/Yarn",
  "~/.nuget/packages",
  "~/.local/share/NuGet",
  "~/Library/Caches/pip",
  "~/go/pkg/mod",
  "~/Library/Caches/go-build",
  "~/.cargo/registry",
  "~/.cargo/git",
  "~/.m2/repository",
  "~/.gradle/caches",
  "~/.gradle/wrapper",
];

/** The sandbox is part of macOS (Seatbelt): nothing to install, nothing to probe. */
export function createMacosSupport(): SandboxSupport {
  return { check: async () => ({ ok: true }) };
}
