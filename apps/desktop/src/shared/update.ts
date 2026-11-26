// What the app shows and says about updates. Types and pure functions only: the main process
// owns the state, the window builds the chip from it and from the engine's running count.

/** An update the release marks as important: the reason is one plain line of text, cleaned in the main process. */
export interface Critical {
  readonly reason: string;
}

export type UpdateState =
  /** `platform`: Updates are manual on this system. The other two show nothing. */
  | { readonly status: "unavailable"; readonly reason: "development" | "platform" | "not_in_applications" }
  /** Up to date, or not checked yet. */
  | { readonly status: "idle"; readonly checkedAt?: number }
  | { readonly status: "checking"; readonly checkedAt?: number }
  | { readonly status: "downloading"; readonly version: string; readonly percent: number; readonly transferred: number; readonly total: number; readonly critical?: Critical }
  | { readonly status: "ready"; readonly version: string; readonly critical?: Critical }
  | { readonly status: "installing"; readonly version: string; readonly critical?: Critical }
  /**
   * The installer has not answered after Restart now: the engine is stopped and nothing was put
   * back, because the installer may still swap the app. Restart Tokama asks it again; a quit lets
   * it finish.
   */
  | { readonly status: "stalled"; readonly version: string }
  /** `at` is when it failed (ms since the epoch). `version` and `critical` are set once an update was found. */
  | { readonly status: "error"; readonly stage: "check" | "download" | "install"; readonly at: number; readonly version?: string; readonly critical?: Critical };

/** `busy`: something runs, or it could not be told; nothing was changed. */
export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly reason: "not_ready" | "busy" | "failed"; readonly running?: number };

/** The chip (and the collapsed rail icon) for an update. Undefined when no chip shows. */
export interface UpdateChipView {
  /** `installing` is the status line "Restarting to update…"; `stalled` the notice that the installer did not answer. */
  readonly kind: "ready" | "installing" | "stalled";
  readonly version: string;
  readonly critical: boolean;
  /** The one short visible word: "Update", "Important update", or the status line. */
  readonly label: string;
  /** The tooltip's first line. */
  readonly title: string;
  /** The release's reason line, for an important update. */
  readonly reason?: string;
  /** The tooltip's action line. */
  readonly action: string;
  /** The accessible name of the chip and of the rail icon. */
  readonly accessibleName: string;
  /** Items running now. They block the install. */
  readonly running: number;
}

const items = (count: number) => (count === 1 ? "1 item is" : `${count} items are`);

const when = (count: number) => (count === 1 ? "it finishes" : "they finish");

/** The action line of the tooltip: what a click does. A click only opens the panel; restarting is a second, clear button. */
export function updateAction(running: number): string {
  return running > 0 ? `${items(running)} running. You can restart when ${when(running)}` : "Click to update, then confirm the restart";
}

/** The line of the panel that opens with items running. */
export function updatePanelText(running: number): string {
  return `${items(running)} still running. You can restart when ${when(running)}.`;
}

/** The line of the panel when nothing runs. */
export const NOTHING_RUNNING = "Nothing is running. Restarting takes a few seconds.";
/** The panel's last line, always there: why Restart now may be off, and that it is never done by itself. */
export const RESTART_NOW_BLOCKED = "Tokama never stops running work to update, and it never restarts by itself.";
/** What the update says when the engine would not say how many items run: nothing is installed then. */
export const CANT_TELL = "Tokama can't tell what's running right now";
export const RESTARTING = "Restarting to update…";
export const STALLED = "Update didn't install";
export const STALLED_ACTION = "Tokama will try again when you quit.";
export const RESTART_TOKAMA = "Restart Tokama";

const withoutEnd = (text: string) => text.replace(/[.!\s]+$/, "");

/** The chip for `state` with `running` items running. A chip shows only for a ready update, and as a status line while it installs. */
export function updateChip(state: UpdateState, running: number): UpdateChipView | undefined {
  if (state.status === "stalled") {
    return { kind: "stalled", version: state.version, critical: false, label: STALLED, title: STALLED, action: STALLED_ACTION, accessibleName: `${STALLED}. ${STALLED_ACTION}`, running };
  }
  if (state.status === "installing") {
    return { kind: "installing", version: state.version, critical: false, label: RESTARTING, title: RESTARTING, action: "", accessibleName: RESTARTING, running };
  }
  if (state.status !== "ready") return undefined;
  const action = updateAction(running);
  const { version } = state;
  if (state.critical === undefined) {
    return { kind: "ready", version, critical: false, label: "Update", title: `Tokama ${version} is ready`, action, accessibleName: `Update: Tokama ${version} is ready. ${action}.`, running };
  }
  const reason = state.critical.reason;
  return {
    kind: "ready",
    version,
    critical: true,
    label: "Important update",
    title: `Important update · ${version}`,
    reason,
    action,
    accessibleName: `Important update: Tokama ${version}. ${reason === "" ? "" : `${withoutEnd(reason)}. `}${action}.`,
    running,
  };
}
