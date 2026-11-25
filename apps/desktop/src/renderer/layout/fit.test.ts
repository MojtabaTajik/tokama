import { describe, expect, it } from "vitest";
import { DRAWER_WIDTH, MAIN_MIN_WIDTH, RAIL_WIDTH, SIDEBAR_WIDTH } from "../../shared/desktop-state.js";
import { fitPanels, type PanelChoice, sidebarMax } from "./fit.js";

const defaults: PanelChoice = { sidebarOpen: true, drawerOpen: true, sidebar: SIDEBAR_WIDTH.default, drawer: DRAWER_WIDTH.default };
const main = (width: number, fit: ReturnType<typeof fitPanels>) => width - RAIL_WIDTH - fit.sidebar - (fit.floating ? 0 : fit.drawer);

describe("fitPanels", () => {
  it("shows the chosen widths when there is room: the defaults need 1,164 px", () => {
    expect(fitPanels(1164, defaults)).toEqual({ sidebar: 264, drawer: 420, floating: false });
    expect(fitPanels(1440, defaults)).toEqual({ sidebar: 264, drawer: 420, floating: false });
  });

  it("gives way with the drawer first, down to 340", () => {
    expect(fitPanels(1100, defaults)).toEqual({ sidebar: 264, drawer: 356, floating: false });
    expect(fitPanels(1084, defaults)).toEqual({ sidebar: 264, drawer: 340, floating: false });
  });

  it("then with the sidebar, down to 200", () => {
    expect(fitPanels(1040, defaults)).toEqual({ sidebar: 220, drawer: 340, floating: false });
    expect(fitPanels(1024, defaults)).toEqual({ sidebar: 204, drawer: 340, floating: false });
    expect(fitPanels(1020, { ...defaults, sidebar: 200 })).toEqual({ sidebar: 200, drawer: 340, floating: false });
  });

  it("floats the drawer when the main area would still be under 420 px", () => {
    const fit = fitPanels(980, { ...defaults, sidebar: 200 });
    expect(fit.floating).toBe(true);
    expect(main(980, fit)).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
    expect(fit.drawer).toBeLessThanOrEqual(420);
  });

  it("gives the sidebar back its chosen width when the drawer floats, as far as the main area allows", () => {
    const fit = fitPanels(760, { ...defaults, sidebar: 300 });
    expect(fit).toEqual({ sidebar: 280, drawer: 420, floating: true });
    expect(main(760, fit)).toBe(420);
    expect(fitPanels(720, defaults).sidebar).toBe(240);
  });

  it("keeps the main area at 420 px or more from 720 px up, for every chosen width", () => {
    for (let width = 720; width <= 1600; width += 7) {
      for (const sidebar of [200, 264, 360]) {
        for (const drawer of [340, 420, 640]) {
          const fit = fitPanels(width, { sidebarOpen: true, drawerOpen: true, sidebar, drawer });
          expect(main(width, fit), `${width} ${sidebar} ${drawer}`).toBeGreaterThanOrEqual(MAIN_MIN_WIDTH);
          expect(fit.sidebar).toBeGreaterThanOrEqual(SIDEBAR_WIDTH.min);
          expect(fit.sidebar).toBeLessThanOrEqual(sidebar);
          if (!fit.floating) expect(fit.drawer).toBeGreaterThanOrEqual(DRAWER_WIDTH.min);
        }
      }
    }
  });

  it("gives no width to a closed panel", () => {
    expect(fitPanels(1440, { ...defaults, drawerOpen: false })).toEqual({ sidebar: 264, drawer: 0, floating: false });
    expect(fitPanels(1440, { ...defaults, sidebarOpen: false })).toEqual({ sidebar: 0, drawer: 420, floating: false });
    expect(fitPanels(720, { ...defaults, drawerOpen: false })).toEqual({ sidebar: 240, drawer: 0, floating: false });
  });

  it("lets a wide choice stand when the window is wide", () => {
    expect(fitPanels(1600, { ...defaults, sidebar: 360, drawer: 640 })).toEqual({ sidebar: 360, drawer: 640, floating: false });
  });
});

describe("sidebarMax", () => {
  it("is 360, or less where the main area needs the room, and never under 200", () => {
    expect(sidebarMax(1440)).toBe(360);
    expect(sidebarMax(800)).toBe(320);
    expect(sidebarMax(720)).toBe(240);
    expect(sidebarMax(600)).toBe(200);
  });
});
