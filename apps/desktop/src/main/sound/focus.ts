// Whether the user can be disturbed by a sound. macOS offers this app no readable Focus (Do Not
// Disturb) state, so the probe reports "unknown" there, and only a locked screen counts. The same
// lock rule serves Linux and Windows. Electron comes in through `deps`, so this is tested with fakes.

export type FocusState = "on" | "off" | "locked" | "unknown";

export interface FocusProbe {
  state(): Promise<FocusState>;
}

export interface FocusDeps {
  /** Electron's `powerMonitor.getSystemIdleState(1)`. */
  readonly idleState: () => "active" | "idle" | "locked" | "unknown";
}

/** The probe. Every platform has the lock rule and none has a readable Focus state, so one implementation serves all. */
export function createFocusProbe(deps: FocusDeps): FocusProbe {
  return { state: async () => (deps.idleState() === "locked" ? "locked" : "unknown") };
}
