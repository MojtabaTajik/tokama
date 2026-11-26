// The update state machine: a pure reducer, no timers and no Electron. The main process feeds it
// what the updater reports and shows the result to the window.
import type { Critical, UpdateState } from "../../shared/update.js";

export type UpdateEvent =
  | { readonly type: "check_started" }
  | { readonly type: "up_to_date"; readonly at: number }
  | { readonly type: "available"; readonly version: string; readonly critical?: Critical }
  | { readonly type: "progress"; readonly percent: number; readonly transferred: number; readonly total: number }
  | { readonly type: "downloaded"; readonly version: string; readonly critical?: Critical }
  | { readonly type: "error"; readonly at: number }
  | { readonly type: "install_started" }
  /** The installer has not answered in time; nothing was put back. */
  | { readonly type: "install_stalled" }
  /** The install stopped before it touched anything: the update is ready again. */
  | { readonly type: "install_aborted" }
  | { readonly type: "install_failed"; readonly at: number };

const clampPercent = (percent: number) => (Number.isFinite(percent) ? Math.min(100, Math.max(0, Math.round(percent))) : 0);

/** The state after `event`. A state that cannot take the event stays as it is. */
export function next(state: UpdateState, event: UpdateEvent): UpdateState {
  if (state.status === "unavailable") return state;
  switch (event.type) {
    case "check_started":
      // Check now never throws away a download or a ready update.
      if (state.status === "downloading" || state.status === "ready" || state.status === "installing" || state.status === "stalled") return state;
      return { status: "checking", ...((state.status === "idle" || state.status === "checking") && state.checkedAt !== undefined && { checkedAt: state.checkedAt }) };
    case "up_to_date":
      return state.status === "checking" ? { status: "idle", checkedAt: event.at } : state;
    case "available":
      if (state.status === "ready" || state.status === "installing" || state.status === "stalled") return state;
      return { status: "downloading", version: event.version, percent: 0, transferred: 0, total: 0, ...(event.critical !== undefined && { critical: event.critical }) };
    case "progress":
      if (state.status !== "downloading") return state;
      return { ...state, percent: clampPercent(event.percent), transferred: Math.max(0, event.transferred), total: Math.max(0, event.total) };
    case "downloaded":
      if (state.status === "installing" || state.status === "stalled") return state;
      return { status: "ready", version: event.version, ...(event.critical !== undefined && { critical: event.critical }) };
    case "error":
      // A failed check never takes a ready update away; an install has its own event.
      if (state.status === "ready" || state.status === "installing" || state.status === "stalled") return state;
      if (state.status === "downloading") return { status: "error", stage: "download", at: event.at, version: state.version, ...(state.critical !== undefined && { critical: state.critical }) };
      return { status: "error", stage: "check", at: event.at };
    case "install_started":
      // From stalled it is the retry: the installer is asked again.
      if (state.status === "stalled") return { status: "installing", version: state.version };
      return state.status === "ready" ? { status: "installing", version: state.version, ...(state.critical !== undefined && { critical: state.critical }) } : state;
    case "install_stalled":
      return state.status === "installing" ? { status: "stalled", version: state.version } : state;
    case "install_aborted":
      return state.status === "installing" ? { status: "ready", version: state.version, ...(state.critical !== undefined && { critical: state.critical }) } : state;
    case "install_failed":
      return state.status === "installing" || state.status === "stalled" ? { status: "error", stage: "install", at: event.at, version: state.version } : state;
  }
}
