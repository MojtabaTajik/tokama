// How wide the sidebar and the drawer are right now. The widths the user chose are kept as they
// are; what is shown follows from the window: the main area never gets narrower than
// MAIN_MIN_WIDTH, so when the window shrinks the drawer gives way first (down to its minimum), then
// the sidebar (down to its minimum), and if the main area would still be too narrow the drawer
// floats over it instead of pushing it. The chosen widths come back when there is room again.
import { DRAWER_WIDTH, MAIN_MIN_WIDTH, RAIL_WIDTH, SIDEBAR_WIDTH } from "../../shared/desktop-state.js";

export interface PanelChoice {
  readonly sidebarOpen: boolean;
  readonly drawerOpen: boolean;
  /** The widths the user chose, each within its limits. */
  readonly sidebar: number;
  readonly drawer: number;
}

export interface PanelFit {
  /** 0 when the sidebar is closed. */
  readonly sidebar: number;
  /** 0 when the drawer is closed. */
  readonly drawer: number;
  /** The drawer lies over the main area instead of beside it. */
  readonly floating: boolean;
}

export function fitPanels(windowWidth: number, choice: PanelChoice): PanelFit {
  const room = windowWidth - RAIL_WIDTH - MAIN_MIN_WIDTH;
  let sidebar = choice.sidebarOpen ? choice.sidebar : 0;
  let drawer = choice.drawerOpen ? choice.drawer : 0;
  let over = sidebar + drawer - room;
  if (over > 0 && drawer > 0) {
    const cut = Math.min(over, drawer - DRAWER_WIDTH.min);
    drawer -= cut;
    over -= cut;
  }
  if (over > 0 && sidebar > 0) {
    const cut = Math.min(over, sidebar - SIDEBAR_WIDTH.min);
    sidebar -= cut;
    over -= cut;
  }
  if (over > 0 && drawer > 0) {
    // The drawer leaves the flow, so the sidebar may be as wide as it chose, as far as the main area allows.
    const available = windowWidth - RAIL_WIDTH;
    return { sidebar: sidebar > 0 ? Math.max(SIDEBAR_WIDTH.min, Math.min(choice.sidebar, room)) : 0, drawer: Math.min(choice.drawer, available - sidebar), floating: true };
  }
  return { sidebar, drawer, floating: false };
}

/** The widest the sidebar may be dragged or moved by key: its own limit, and a main area that keeps its minimum. */
export const sidebarMax = (windowWidth: number): number => Math.max(SIDEBAR_WIDTH.min, Math.min(SIDEBAR_WIDTH.max, windowWidth - RAIL_WIDTH - MAIN_MIN_WIDTH));
