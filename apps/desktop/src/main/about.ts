// What About shows about this build, and the text "Copy build info" puts on the clipboard. The
// renderer never sends text to the clipboard: the main process composes it from its own facts.
import { displayPath, readPidFile } from "@tokama/core";
import type { AboutInfo } from "../shared/bridge.js";

export interface BuildStamp {
  readonly built: string;
  readonly commit: string;
}

export interface AboutDeps {
  readonly version: string;
  readonly build: BuildStamp;
  readonly apiVersion: number;
  readonly tokamaHome: string;
  readonly userHome?: string;
  /** The engine's lock file: the pid is its first word. */
  readonly lockPath: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly versions: { readonly electron?: string; readonly node?: string };
}

const SYSTEMS: Partial<Record<NodeJS.Platform, string>> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

/** The pid in the lock file; undefined when the file is missing, is not a plain file or does not start with a pid. */
export function readEnginePid(lockPath: string): number | undefined {
  return readPidFile(lockPath)?.pid;
}

export function aboutInfo(deps: AboutDeps): AboutInfo {
  const pid = readEnginePid(deps.lockPath);
  return {
    app: { version: deps.version, built: deps.build.built, commit: deps.build.commit },
    // The engine ships in the same build as the app.
    engine: { version: deps.version, apiVersion: deps.apiVersion, ...(pid === undefined ? {} : { pid }) },
    dataFolder: displayPath(deps.tokamaHome, deps.userHome === undefined ? {} : { home: deps.userHome }),
    runtime: { electron: deps.versions.electron ?? "unknown", node: deps.versions.node ?? "unknown" },
    platform: `${SYSTEMS[deps.platform] ?? deps.platform} · ${deps.arch}`,
  };
}
