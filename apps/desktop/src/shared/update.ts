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
  /** `at` is when it failed (ms since the epoch). `version` and `critical` are set once an update was found. */
  | { readonly status: "error"; readonly stage: "check" | "download" | "install"; readonly at: number; readonly version?: string; readonly critical?: Critical };

/** `busy`: something runs, or it could not be told; nothing was changed. */
export type InstallResult = { readonly ok: true } | { readonly ok: false; readonly reason: "not_ready" | "busy" | "failed"; readonly running?: number };

/** The chip (and the collapsed rail icon) for an update. Undefined when no chip shows. */
export interface UpdateChipView {
  /** `installing` is the status line "Restarting to update…". */
  readonly kind: "ready" | "installing";
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

/** The action line: what a click does now. */
export function updateAction(running: number): string {
  return running > 0 ? `${items(running)} running. Restart once ${running === 1 ? "it finishes" : "they finish"}` : "Click to restart and update";
}

/** The first line of the panel that opens with items running. */
export function updatePanelText(running: number): string {
  return `${items(running)} running. Tokama updates when ${running === 1 ? "it finishes" : "they finish"} and you restart.`;
}

export const RESTART_NOW_BLOCKED = "Restart now works once nothing runs. Tokama never stops running work to update and never restarts by itself.";
/** What the update says when the engine would not say how many items run: nothing is installed then. */
export const CANT_TELL = "Tokama can't tell what's running right now";
export const RESTARTING ="Restarting to update…";

const withoutEnd = (text: string) => text.replace(/[.!\s]+$/, "");

/** The chip for `state` with `running` items running. A chip shows only for a ready update, and as a status line while it installs. */
export function updateChip(state: UpdateState, running: number): UpdateChipView | undefined {
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
