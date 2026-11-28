// Claude Code's own sandbox for the Bash tool, switched on through the per-call settings file.
// It wraps the commands the agent runs and their children. The file tools and the web tools
// (WebFetch, WebSearch) are not in it: files stay limited by `--restricted` and the permission
// rules (args.ts), and a step with `web` on can open any website, whatever the host list says.
import { BWRAP_BLOCKED_HINT, CREDENTIAL_PATHS, type NetworkPolicy, type SandboxSpec } from "../../../kernel/sandbox/index.js";
import { permissionPath } from "./args.js";

export interface SandboxSettingsOptions {
  /** The folders holding this call's `rules.json` and `settings.json`: closed to writes, so commands add and change nothing there. */
  readonly callDirs: readonly string[];
  /** The files in those folders: closed to reads. Listed one by one, never as a folder (see `sandboxSettings`). */
  readonly callFiles: readonly string[];
  /** Tokama's folder, `~/.tokama` or absolute: closed to commands. */
  readonly tokamaHome: string;
  /** More folders closed to commands: the engine's socket and token folder. */
  readonly closedDirs?: readonly string[];
  /** Tool caches commands may write (`~/`-relative), already without any that is on the PATH. */
  readonly cacheDirs: readonly string[];
}

/**
 * The `permissions` and `sandbox` parts of the call's settings, for a checked spec. The working
 * directory is writable by default, so `writableRoot` is not listed. Everything that would loosen
 * the sandbox is set false in words, so a user or repo default cannot change it. Nothing here is
 * ever written to the user's own settings.
 *
 * - The call's folder is closed to writes as a folder and to reads file by file. On Linux a folder in
 *   `denyRead` is replaced by an empty, writable scratch folder: a write into it seems to work (and
 *   is lost when the command ends) and a read finds nothing. A denied file is refused for real on
 *   both systems. The folder stays unwritable because Linux mounts everything outside the working
 *   directory and the temp folder read-only, and `denyWrite` keeps this one so.
 * - `failIfUnavailable`: a sandbox that cannot start ends the call; it never runs unsandboxed.
 * - `allowUnsandboxedCommands: false` and the deny rule: the agent cannot retry outside it.
 * - `strictAllowlist`: a host outside `network.allow` is refused in every permission mode.
 * - `autoAllowBashIfSandboxed: false`: Tokama's rules and hook still decide each command.
 */
export function sandboxSettings(spec: SandboxSpec, options: SandboxSettingsOptions): { permissions: unknown; sandbox: unknown } {
  const closed = [...new Set([options.tokamaHome, ...(options.closedDirs ?? [])])];
  return {
    permissions: {
      deny: ["Bash(dangerouslyDisableSandbox:true)", ...spec.readOnlyRoots.map((root) => `Edit(${permissionPath(root)}/**)`)],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: [],
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowNestedUserNamespaces: false,
      allowAppleEvents: false,
      filesystem: {
        allowWrite: [...options.cacheDirs],
        denyWrite: [...closed, ...options.callDirs, ...spec.readOnlyRoots],
        denyRead: [...closed, ...options.callFiles, ...CREDENTIAL_PATHS],
      },
      network: {
        allowedDomains: [...spec.network.allow],
        strictAllowlist: unlistedHosts(spec.network.unlisted),
        allowLocalBinding: false,
        allowAllUnixSockets: false,
      },
    },
  };
}

/** `strictAllowlist`: whether a host outside the list is refused in every permission mode. */
function unlistedHosts(unlisted: NetworkPolicy["unlisted"]): boolean {
  switch (unlisted) {
    case "deny":
      return true;
  }
}

const START_CHARS = 300;

/** The failed-step text for a Claude Code that exited at startup because its sandbox could not start. */
export function sandboxStartProblem(stderr: string, platform: NodeJS.Platform): string {
  const said = stderr.trim().slice(0, START_CHARS);
  return `Claude Code could not start its sandbox: ${said}.${platform === "linux" ? ` ${BWRAP_BLOCKED_HINT}` : ""}`;
}

/** True when the CLI's stderr says the sandbox is why it stopped. */
export const mentionsSandbox = (stderr: string): boolean => /sandbox/i.test(stderr);

/**
 * The start of a tool result that says the sandbox is not working: it stopped in the middle of
 * the session, or its `apply-seccomp` helper failed (Ubuntu's AppArmor stops it from making a user
 * namespace). Its `could not set` line is a warning: the command still ran.
 */
export const SANDBOX_REQUIRED = /^(?:Sandbox is required|apply-seccomp: (?!could not set ))/;
