import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Read as a file: Vitest turns CSS imports into empty modules.
const theme = readFileSync(join(import.meta.dirname, "theme.css"), "utf8");
const app = readFileSync(join(import.meta.dirname, "app.css"), "utf8");

// The app UI colours, each a token in theme.css.
const TOKENS: Record<string, string> = {
  "--ground": "#0b0f17",
  "--panel": "#121826",
  "--raised": "#18213a",
  "--input": "#0f1420",
  "--hairline": "#1f262e",
  "--text": "#e6edf3",
  "--text-2": "#d5dce3",
  "--muted": "#7d8894",
  "--link": "#7fb2ff",
  "--live": "#5c8cff",
  "--primary-border": "#1f5bff",
  "--primary-fill": "#0f2257",
  "--primary-text": "#e4ecff",
  "--warn": "#d9a93a",
  "--fail": "#e07a70",
  "--pass": "#6fb884",
  "--agent-1": "#8f73f2",
  "--agent-2": "#22a98b",
  "--agent-3": "#b23a6e",
  "--agent-neutral": "#4a5563",
  "--tag-slate": "#aeb6c0",
  "--tag-sky": "#6f9fd8",
  "--tag-teal": "#58b8bc",
  "--tag-moss": "#a9a862",
  "--tag-sand": "#dccba6",
  "--tag-clay": "#b9866f",
  "--tag-rose": "#d08ab2",
  "--tag-plum": "#a288c8",
};

describe("theme.css", () => {
  it.each(Object.entries(TOKENS))("defines %s as %s", (name, value) => {
    expect(theme).toMatch(new RegExp(`${name}:\\s*${value};`, "i"));
  });
  it("gives primary button text at least 4.5:1 contrast on its fill", () => {
    expect(contrast(TOKENS["--primary-text"]!, TOKENS["--primary-fill"]!)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(Object.keys(TOKENS).filter((name) => name.startsWith("--tag-")))("reads %s at 4.5:1 or better on the ground and the panel", (name) => {
    for (const ground of ["--ground", "--panel"]) expect(contrast(TOKENS[name]!, TOKENS[ground]!)).toBeGreaterThanOrEqual(4.5);
  });
  it("tints a template icon with each tag colour, and only the icon", () => {
    for (const tag of ["slate", "sky", "teal", "moss", "sand", "clay", "rose", "plum"]) {
      expect(app).toMatch(new RegExp(`\\.tpl-icon\\[data-tag="${tag}"\\]\\s*\\{\\s*color:\\s*var\\(--tag-${tag}\\);\\s*\\}`));
    }
    expect(app).not.toMatch(/(?:background|fill|border)[a-z-]*:\s*var\(--tag-/);
  });
});

/** The WCAG contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const SCREENS = { "app.css": app, "drawer/drawer.css": readFileSync(join(import.meta.dirname, "drawer", "drawer.css"), "utf8"), "newwork/newwork.css": readFileSync(join(import.meta.dirname, "newwork", "newwork.css"), "utf8") };

describe.each(Object.entries(SCREENS))("%s", (_name, css) => {
  it("takes every colour from the theme tokens: no colour literals", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]);
  });

  it("uses only tokens that theme.css defines", () => {
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
    const missing = [...used].filter((name) => !theme.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});
