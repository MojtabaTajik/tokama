// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { faFire, faWrench } from "@fortawesome/free-solid-svg-icons";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { DEFAULT_ICON, ICONS, TAG_COLORS, TemplateIcon } from "./TemplateIcon.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function draw(icon?: string, color?: string): SVGSVGElement {
  const container = document.createElement("div");
  act(() => createRoot(container).render(<TemplateIcon icon={icon} color={color} />));
  return container.querySelector("svg")!;
}
const pathOf = (svg: SVGSVGElement) => svg.querySelector("path")?.getAttribute("d");

describe("TemplateIcon", () => {
  it("draws a listed icon as an inline SVG in the current colour", () => {
    const svg = draw("fire", "rose");
    expect(svg.getAttribute("data-icon")).toBe("fire");
    expect(pathOf(svg)).toBe(faFire.icon[4]);
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${faFire.icon[0]} ${faFire.icon[1]}`);
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });

  it("finds an icon by an older name that Font Awesome keeps as an alias", () => {
    expect(pathOf(draw("tools"))).toBe(pathOf(draw("screwdriver-wrench")));
    expect(pathOf(draw("wrench"))).toBe(faWrench.icon[4]);
  });

  it.each([["an unknown name", "no-such-icon"], ["a brands icon", "github"], ["an object key", "constructor"], ["no name", undefined]])(
    "falls back to the neutral default for %s",
    (_what, name) => {
      const svg = draw(name);
      expect(svg.getAttribute("data-icon")).toBe(DEFAULT_ICON.iconName);
      expect(pathOf(svg)).toBe(DEFAULT_ICON.icon[4]);
    },
  );

  it.each(TAG_COLORS)("tints the icon with the %s tag colour", (color) => {
    expect(draw("fire", color).getAttribute("data-tag")).toBe(color);
  });

  it.each([["an unknown colour", "chartreuse"], ["a CSS colour", "#ff0000"], ["no colour", undefined]])("draws no tint for %s", (_what, color) => {
    expect(draw("fire", color).hasAttribute("data-tag")).toBe(false);
  });

  it("lists every icon under its own name", () => {
    for (const [name, definition] of ICONS) expect(definition.icon[4], name).toMatch(/^M/);
    expect(ICONS.get("fire")).toBe(faFire);
  });
});

describe("Font Awesome licence", () => {
  const desktop = join(import.meta.dirname, "..", "..", "..");

  it("is credited in the notices file that ships with the app", () => {
    const notices = readFileSync(join(desktop, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain("Font Awesome Free");
    expect(notices).toContain("CC BY 4.0");
    expect(notices).toContain("MIT");
  });

  it("depends on the solid set only, never the brands set", () => {
    const pkg = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as { dependencies?: object; devDependencies?: object };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) => name.startsWith("@fortawesome/"));
    expect(names).toContain("@fortawesome/free-solid-svg-icons");
    expect(names.filter((name) => name.includes("brands"))).toEqual([]);
  });
});
