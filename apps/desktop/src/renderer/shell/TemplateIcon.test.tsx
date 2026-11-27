// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Bell,
  Book,
  Brain,
  Bug,
  ChartLine,
  CircleCheck,
  CircleQuestionMark,
  Clipboard,
  ClipboardCheck,
  Clock,
  Cloud,
  Code,
  Cog,
  Compass,
  Crosshair,
  Database,
  Eye,
  FileText,
  Flag,
  Flame,
  FlaskConical,
  Gauge,
  GitBranch,
  Hammer,
  KeyRound,
  Layers,
  Lightbulb,
  ListChecks,
  Lock,
  type LucideIcon,
  Microscope,
  Network,
  Package,
  Puzzle,
  RadioTower,
  Rocket,
  Route,
  Search,
  Send,
  Server,
  ShieldHalf,
  Stethoscope,
  Terminal,
  TextSearch,
  ToolCase,
  TriangleExclamationPoint,
  WandSparkles,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DEFAULT_ICON, DEFAULT_NAME, ICONS, TAG_COLORS, TemplateIcon, iconOf } from "./TemplateIcon.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: ReactNode): SVGSVGElement {
  const container = document.createElement("div");
  act(() => createRoot(container).render(node));
  return container.querySelector("svg")!;
}
const draw = (icon?: string, color?: string) => render(<TemplateIcon icon={icon} color={color} />);
const drawing = (svg: SVGSVGElement) => svg.innerHTML;
const drawingOf = (Icon: LucideIcon) => drawing(render(<Icon />));

/** The icon each name in a template or agent file draws. */
const EXPECTED: ReadonlyArray<readonly [string, LucideIcon]> = [
  ["bell", Bell],
  ["bolt", Zap],
  ["book", Book],
  ["box", Package],
  ["brain", Brain],
  ["bug", Bug],
  ["chart-line", ChartLine],
  ["circle-check", CircleCheck],
  ["circle-question", CircleQuestionMark],
  ["clipboard", Clipboard],
  ["clipboard-check", ClipboardCheck],
  ["clock", Clock],
  ["cloud", Cloud],
  ["code", Code],
  ["code-branch", GitBranch],
  ["compass", Compass],
  ["crosshairs", Crosshair],
  ["database", Database],
  ["diagram-project", Workflow],
  ["eye", Eye],
  ["file-lines", FileText],
  ["fire", Flame],
  ["flag", Flag],
  ["flask", FlaskConical],
  ["gauge", Gauge],
  ["gear", Cog],
  ["hammer", Hammer],
  ["key", KeyRound],
  ["layer-group", Layers],
  ["lightbulb", Lightbulb],
  ["list-check", ListChecks],
  ["lock", Lock],
  ["magnifying-glass", Search],
  ["magnifying-glass-chart", TextSearch],
  ["microscope", Microscope],
  ["paper-plane", Send],
  ["puzzle-piece", Puzzle],
  ["rocket", Rocket],
  ["route", Route],
  ["screwdriver-wrench", ToolCase],
  ["server", Server],
  ["shield-halved", ShieldHalf],
  ["sitemap", Network],
  ["stethoscope", Stethoscope],
  ["terminal", Terminal],
  ["tower-broadcast", RadioTower],
  ["triangle-exclamation", TriangleExclamationPoint],
  ["wand-magic-sparkles", WandSparkles],
  ["wrench", Wrench],
];

/** Older names that keep working, each with the name it draws like. */
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["project-diagram", "diagram-project"],
  ["zap", "bolt"],
  ["line-chart", "chart-line"],
  ["file-alt", "file-lines"],
  ["file-text", "file-lines"],
  ["dashboard", "gauge"],
  ["gauge-med", "gauge"],
  ["tachometer-alt-average", "gauge"],
  ["cog", "gear"],
  ["tasks", "list-check"],
  ["search", "magnifying-glass"],
  ["tools", "screwdriver-wrench"],
  ["shield-alt", "shield-halved"],
  ["exclamation-triangle", "triangle-exclamation"],
  ["warning", "triangle-exclamation"],
  ["magic-wand-sparkles", "wand-magic-sparkles"],
];

describe("TemplateIcon", () => {
  it("draws a listed icon as a Lucide line icon in the current colour", () => {
    const svg = draw("fire", "rose");
    expect(svg.getAttribute("data-icon")).toBe("fire");
    expect(drawing(svg)).toBe(drawingOf(Flame));
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("stroke-width")).toBe("2");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.classList.contains("tpl-icon")).toBe(true);
  });

  it.each(EXPECTED)("draws %s with its Lucide icon", (name, Icon) => {
    const svg = draw(name);
    expect(svg.getAttribute("data-icon")).toBe(name);
    expect(drawing(svg)).toBe(drawingOf(Icon));
  });

  it("lists every name once and nothing else", () => {
    expect([...ICONS.keys()].sort()).toEqual(EXPECTED.map(([name]) => name).sort());
  });

  it.each(ALIASES)("finds an icon by the older name %s", (alias, name) => {
    const svg = draw(alias);
    expect(svg.getAttribute("data-icon")).toBe(name);
    expect(drawing(svg)).toBe(drawing(draw(name)));
  });

  it.each([["an unknown name", "no-such-icon"], ["a brands icon", "github"], ["an object key", "constructor"], ["no name", undefined]])(
    "falls back to the neutral default for %s",
    (_what, name) => {
      const svg = draw(name);
      expect(svg.getAttribute("data-icon")).toBe("diagram-project");
      expect(drawing(svg)).toBe(drawingOf(Workflow));
      expect(iconOf(name)).toEqual({ name: DEFAULT_NAME, Icon: DEFAULT_ICON });
    },
  );

  it("sizes the icon", () => {
    expect(render(<TemplateIcon icon="bug" size={20} />).getAttribute("width")).toBe("20");
    expect(draw("bug").getAttribute("width")).toBe("12");
  });

  it.each(TAG_COLORS)("tints the icon with the %s tag colour", (color) => {
    expect(draw("fire", color).getAttribute("data-tag")).toBe(color);
  });

  it.each([["an unknown colour", "chartreuse"], ["a CSS colour", "#ff0000"], ["no colour", undefined]])("draws no tint for %s", (_what, color) => {
    expect(draw("fire", color).hasAttribute("data-tag")).toBe(false);
  });
});

describe("Lucide licence and dependency", () => {
  const desktop = join(import.meta.dirname, "..", "..", "..");

  it("is credited in the notices file that ships with the app", () => {
    const notices = readFileSync(join(desktop, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("## Lucide");
    expect(notices).toContain("ISC");
    expect(notices).not.toContain("Font Awesome");
  });

  it("depends on lucide-react at one exact version and on no Font Awesome package", () => {
    const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["lucide-react"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(all).filter((name) => name.startsWith("@fortawesome/"))).toEqual([]);
  });
});
