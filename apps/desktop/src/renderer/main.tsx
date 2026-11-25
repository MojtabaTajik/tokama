import { createRoot } from "react-dom/client";
import { DEFAULT_DESKTOP_STATE } from "../shared/desktop-state.js";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
// The remembered layout comes first, so the window opens at its saved widths and not at the defaults.
const initial = await window.tokama.getDesktopState().catch(() => DEFAULT_DESKTOP_STATE);
createRoot(root).render(<App bridge={window.tokama} initial={initial} />);
