// @vitest-environment happy-dom
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import * as icons from "./icons.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: ReactElement): Element {
  const container = document.createElement("div");
  act(() => createRoot(container).render(node));
  return container;
}

/** Each icon component with the size it draws at when a screen gives none. */
const DEFAULT_SIZES: Record<string, number> = {
  PanelIcon: 18,
  BoardIcon: 18,
  InboxIcon: 18,
  InsightsIcon: 18,
  SettingsIcon: 18,
  AttentionIcon: 18,
  UserIcon: 18,
  RepoIcon: 12,
  AllWorkIcon: 12,
  ExpandIcon: 15,
  CollapseIcon: 16,
  BellIcon: 16,
  PulseIcon: 16,
  BookIcon: 16,
  TemplateListIcon: 16,
  AgentIcon: 16,
  TerminalIcon: 16,
  WarningIcon: 18,
  SearchIcon: 13,
  ChevronIcon: 14,
  CheckIcon: 13,
  ShieldIcon: 13,
  CopyIcon: 13,
  ShieldNoteIcon: 15,
  DownloadIcon: 13,
  BuiltinIcon: 12,
  PencilIcon: 12,
  EyeIcon: 12,
  ShellIcon: 12,
  ErrorIcon: 13,
  UsageIcon: 13,
};

describe("ui/icons", () => {
  const components = Object.entries(icons).filter(([name]) => name.endsWith("Icon"));

  it("sizes every icon and lists none that is not sized here", () => {
    expect(components.map(([name]) => name).sort()).toEqual([...Object.keys(DEFAULT_SIZES), "GlobeIcon"].sort());
  });

  it.each(Object.entries(DEFAULT_SIZES))("%s draws one decorative Lucide line icon at %i px", (name, size) => {
    const Icon = icons[name as keyof typeof icons] as (props: icons.IconProps) => ReactElement;
    const svgs = render(<Icon />).querySelectorAll("svg");
    expect(svgs).toHaveLength(1);
    const svg = svgs[0]!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("width")).toBe(String(size));
    expect(svg.getAttribute("height")).toBe(String(size));
    expect(svg.classList.contains("lucide")).toBe(true);
  });

  it("takes a size", () => {
    expect(render(<icons.RepoIcon size={11} />).querySelector("svg")?.getAttribute("width")).toBe("11");
  });

  it("draws the Settings icon as Lucide's gear", () => {
    expect(render(<icons.SettingsIcon />).querySelector("svg")?.classList.contains("lucide-settings")).toBe(true);
  });

  it("draws the globe crossed out when the web is off", () => {
    expect(render(<icons.GlobeIcon off={false} />).querySelector("svg")?.classList.contains("lucide-globe")).toBe(true);
    expect(render(<icons.GlobeIcon off />).querySelector("svg")?.classList.contains("lucide-globe-off")).toBe(true);
  });
});

describe("hand-drawn icons", () => {
  const renderer = join(import.meta.dirname, "..");

  /** Every .tsx file of the renderer below a folder, tests excluded. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "brand" || entry.name === "testing" ? [] : sources(path);
      return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
    });
  }

  // The files below draw charts, meters and flow lines, which are data, not icons.
  const DRAWS_DATA = ["insights/MachineChart.tsx", "insights/MachineTab.tsx", "insights/Meter.tsx", "insights/UsageChart.tsx", "templates/FlowDiagram.tsx"];

  it("leaves no inline <svg> outside brand/ except the files that draw data", () => {
    const drawn = sources(renderer)
      .filter((path) => readFileSync(path, "utf8").includes("<svg"))
      .map((path) => relative(renderer, path))
      .sort();
    expect(drawn).toEqual([...DRAWS_DATA].sort());
  });
});
