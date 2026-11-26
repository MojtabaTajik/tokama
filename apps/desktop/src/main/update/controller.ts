// Holds the update state and drives it from what the updater reports. No Electron here.
// The install is in install.ts; the controller only tells it when the updater's installer fails.
import type { UpdateState } from "../../shared/update.js";
import { criticalOf } from "./critical.js";
import type { UpdateEngine } from "./port.js";
import { next, type UpdateEvent } from "./state.js";

/** The diagnostics warnings an update can raise. They carry no text: no URL, no path, no message. */
export type UpdateWarning = "update_check_failed" | "update_download_failed" | "update_install_failed";

export interface ControllerDeps {
  readonly engine: UpdateEngine;
  /** `unavailable` when this run never checks, otherwise `idle`. */
  readonly initial: UpdateState;
  readonly now: () => number;
  /** This app's version, to tell whether the feed marks the update as important for it. */
  readonly appVersion: string;
  /** Told of every change. */
  readonly onChange: (state: UpdateState) => void;
  /** Raises a warning for diagnostics. At most one per code per app run: an unreachable feed would otherwise fill them. */
  readonly report: (warning: UpdateWarning) => void;
}

export interface UpdateController {
  state(): UpdateState;
  dispatch(event: UpdateEvent): void;
  /** Asks the feed now. Does nothing while a check or a download runs or an update is ready. */
  check(): Promise<void>;
  /** Raises an update warning, once per code per run. */
  warn(warning: UpdateWarning): void;
  /** While an install runs, the installer's failures go to `listener` and nowhere else. Returns a function that stops it. */
  watchInstallError(listener: () => void): () => void;
}

export function createUpdateController(deps: ControllerDeps): UpdateController {
  let state = deps.initial;
  let checking: Promise<void> | undefined;
  let installError: (() => void) | undefined;
  const warned = new Set<UpdateWarning>();

  const dispatch = (event: UpdateEvent) => {
    const after = next(state, event);
    if (after === state) return;
    state = after;
    deps.onChange(state);
  };
  const warn = (warning: UpdateWarning) => {
    if (warned.has(warning)) return;
    warned.add(warning);
    deps.report(warning);
  };
  /** A failure of the feed or of the download; an install has its own path. */
  const failed = () => {
    if (state.status !== "checking" && state.status !== "downloading") return;
    const warning = state.status === "downloading" ? "update_download_failed" : "update_check_failed";
    dispatch({ type: "error", at: deps.now() });
    warn(warning);
  };

  const optionalCritical = (minSafeVersion: unknown) => {
    const critical = criticalOf(minSafeVersion, deps.appVersion);
    return critical === undefined ? {} : { critical };
  };
  deps.engine.onAvailable((info) => dispatch({ type: "available", version: info.version, ...optionalCritical(info.minSafeVersion) }));
  deps.engine.onProgress((progress) => dispatch({ type: "progress", ...progress }));
  deps.engine.onDownloaded((info) => dispatch({ type: "downloaded", version: info.version, ...optionalCritical(info.minSafeVersion) }));
  deps.engine.onError(() => {
    if (state.status === "installing") installError?.();
    else failed();
  });

  return {
    state: () => state,
    dispatch,
    warn,
    watchInstallError: (listener) => {
      installError = listener;
      return () => {
        if (installError === listener) installError = undefined;
      };
    },
    check: () => {
      if (checking !== undefined) return checking;
      if (state.status !== "idle" && state.status !== "error") return Promise.resolve();
      dispatch({ type: "check_started" });
      checking = (async () => {
        try {
          const { available } = await deps.engine.check();
          if (!available) dispatch({ type: "up_to_date", at: deps.now() });
        } catch {
          failed();
        } finally {
          checking = undefined;
        }
      })();
      return checking;
    },
  };
}
