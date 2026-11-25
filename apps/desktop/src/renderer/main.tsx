import { createRoot } from "react-dom/client";
import { DEFAULT_DESKTOP_STATE } from "../shared/desktop-state.js";
import { App } from "./App.js";

// Errors the window does not catch go to the main process for diagnostics: message and stack only.
const reportError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? "") : "";
  void window.tokama.reportError({ message, stack }).catch(() => undefined);
};
window.addEventListener("error", (event) => reportError(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportError(event.reason));

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
// The remembered layout comes first, so the window opens at its saved widths and not at the defaults.
const initial = await window.tokama.getDesktopState().catch(() => DEFAULT_DESKTOP_STATE);
createRoot(root).render(<App bridge={window.tokama} initial={initial} />);
