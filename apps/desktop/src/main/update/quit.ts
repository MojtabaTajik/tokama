// The one `before-quit` handler. It installs a ready update when the user quits and nothing
// runs, and otherwise lets the quit go through as it is. No Electron here.
import type { InstallResult, UpdateState } from "../../shared/update.js";
import type { InstallOptions } from "./install.js";

export interface QuitDeps {
  state(): UpdateState;
  install(options: InstallOptions): Promise<InstallResult>;
  /** Quits the app again. */
  quit(): void;
  /** What the app does on every quit that goes through: save, clear the run marker, let go of the engine. */
  teardown(): void;
}

/**
 * The first quit with a ready update is held back while the install runs, and then the installer
 * quits the app itself. When the install does not start (something runs, the count is unknown,
 * the engine did not stop) or fails, the app quits without installing. When the installer is only
 * slow, the quit goes through after a while: the engine is stopped by then, so nothing runs that a
 * swap could hurt. The teardown runs on the passes that are not held back, never on the held one:
 * it would race the install.
 */
export function createQuitHandler(deps: QuitDeps): (event: { preventDefault(): void }) => void {
  let phase: "none" | "installing" | "done" = "none";
  const quitNow = () => {
    if (phase === "done") return;
    phase = "done";
    deps.quit();
  };
  return (event) => {
    if (phase === "none" && deps.state().status === "ready") {
      event.preventDefault();
      phase = "installing";
      deps.install({ relaunch: false, onFailed: quitNow, onSilent: quitNow }).then((result) => {
        if (!result.ok) quitNow();
      }, quitNow);
      return;
    }
    deps.teardown();
  };
}
