// Claude Code's own sandbox for the Bash tool, switched on through the per-call settings file.
// It wraps the commands the agent runs and their children. The file tools and the web tools
// (WebFetch, WebSearch) are not in it: files stay limited by `--restricted` and the permission
// rules (args.ts), and a step with `web` on can open any website, whatever the host list says.
import { CREDENTIAL_PATHS, type NetworkPolicy, type SandboxSpec } from "../../../kernel/sandbox/index.js";
import { permissionPath } from "./args.js";

export interface SandboxSettingsOptions {
  /** The folders holding this call's `rules.json` and `settings.json`, closed to commands. */
  readonly callDirs: readonly string[];
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
 * - `failIfUnavailable`: a sandbox that cannot start ends the call; it never runs unsandboxed.
 * - `allowUnsandboxedCommands: false` and the deny rule: the agent cannot retry outside it.
 * - `strictAllowlist`: a host outside `network.allow` is refused in every permission mode.
 * - `autoAllowBashIfSandboxed: false`: Tokama's rules and hook still decide each command.
 */
export function sandboxSettings(spec: SandboxSpec, options: SandboxSettingsOptions): { permissions: unknown; sandbox: unknown } {
  const closed = [...new Set([options.tokamaHome, ...(options.closedDirs ?? []), ...options.callDirs])];
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
        denyWrite: [...closed, ...spec.readOnlyRoots],
        denyRead: [...closed, ...CREDENTIAL_PATHS],
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
const APPARMOR_HINT =
  " On Ubuntu, AppArmor may block bubblewrap: add an AppArmor profile for /usr/bin/bwrap (see Claude Code's sandbox docs), or run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` until the next reboot.";

/** The failed-step text for a Claude Code that exited at startup because its sandbox could not start. */
export function sandboxStartProblem(stderr: string, platform: NodeJS.Platform): string {
  const said = stderr.trim().slice(0, START_CHARS);
  return `Claude Code could not start its sandbox: ${said}.${platform === "linux" ? APPARMOR_HINT : ""}`;
}

/** True when the CLI's stderr says the sandbox is why it stopped. */
export const mentionsSandbox = (stderr: string): boolean => /sandbox/i.test(stderr);

/** The text of a tool result that says the sandbox stopped working in the middle of the session. */
export const SANDBOX_REQUIRED = /^Sandbox is required/;
