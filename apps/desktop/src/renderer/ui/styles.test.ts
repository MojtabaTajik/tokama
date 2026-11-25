import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Every stylesheet of the renderer, read as a file: Vitest turns CSS imports into empty modules.
const renderer = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(renderer, path), "utf8");
const SHEETS = readdirSync(renderer, { recursive: true, encoding: "utf8" })
  .filter((path) => path.endsWith(".css"))
  .map((path) => relative(renderer, join(renderer, path)).replaceAll("\\", "/"))
  .sort();
const theme = read("theme.css");
const tokens = read("ui/tokens.css");
const motion = read("ui/motion.css");
const defined = (name: string) => [theme, tokens, motion].some((css) => css.includes(`${name}:`));
// Screens: every sheet but the theme and the shared ones in ui/.
const SCREENS = SHEETS.filter((path) => path !== "theme.css" && !path.startsWith("ui/"));

/** The declarations of a sheet, one per entry, with their line, without comments. */
const declarations = (css: string) =>
  css.split("\n").flatMap((text, index) => {
    const match = /^\s*([a-z-]+)\s*:\s*([^;{}]+);(.*)$/.exec(text);
    return match === null ? [] : [{ line: index + 1, property: match[1]!, value: match[2]!, rest: match[3]! }];
  });

it("finds the stylesheets", () => {
  expect(SHEETS).toContain("app.css");
  expect(SHEETS).toContain("ui/motion.css");
  expect(SCREENS.length).toBeGreaterThan(15);
});

describe.each(SHEETS.filter((path) => path !== "theme.css"))("%s", (path) => {
  const css = read(path);
  it("takes every colour from the theme tokens: no colour literals", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]);
  });

  it("uses only tokens that theme.css or ui/ defines", () => {
    // Custom properties a screen sets for itself are its own; one read with a fallback (such as
    // --drawer-w, which the layout sets inline) need not be a token.
    const own = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]));
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]!));
    expect([...used].filter((name) => !own.has(name) && !defined(name))).toEqual([]);
  });
});

describe.each(SCREENS)("%s", (path) => {
  const css = read(path);
  it("defines no keyframes and no reduced-motion block of its own: they live in ui/motion.css", () => {
    expect(css).not.toMatch(/@keyframes|prefers-reduced-motion/);
  });

  it("takes spacing and corner radius from the tokens: no px literals but 0 and 1px", () => {
    const literal = declarations(css).filter(
      ({ property, value, rest }) =>
        /^(?:padding|margin|gap|row-gap|column-gap)(?:-[a-z-]+)?$|^border(?:-[a-z]+)*-radius$/.test(property) &&
        /(?<![\d.])(?!1px)\d+(?:\.\d+)?px/.test(value) &&
        !rest.includes("px: off-scale"),
    );
    expect(literal.map(({ line, property, value }) => `${line}: ${property}: ${value}`)).toEqual([]);
  });

  it("draws no buttons of its own: the pointer cursor belongs to ui/button.css", () => {
    // A clickable element that is not a button (a summary, an option) says so on the line.
    const pointer = declarations(css).filter(({ property, value, rest }) => property === "cursor" && value.trim() === "pointer" && !rest.includes("pointer: not a button"));
    expect(pointer.map(({ line }) => line)).toEqual([]);
  });
});

describe("the shared sheets", () => {
  it("load after the theme and before every screen's sheet, so a screen's class can place a component; ui/motion.css comes last so its reduced-motion fallbacks win", () => {
    const html = read("index.html");
    const sheets = [...html.matchAll(/href="\.\/([^"]+\.css)"/g)].map((match) => match[1]!);
    expect(sheets.slice(0, 3)).toEqual(["theme.css", "ui/tokens.css", "ui/base.css"]);
    expect(sheets.at(-1)).toBe("ui/motion.css");
    const firstScreen = sheets.findIndex((sheet) => sheet !== "theme.css" && !sheet.startsWith("ui/"));
    const lastShared = sheets.findLastIndex((sheet) => sheet.startsWith("ui/") && sheet !== "ui/motion.css");
    expect(lastShared).toBeLessThan(firstScreen);
    // Every sheet is linked, so none is written and never loaded.
    expect([...sheets].sort()).toEqual(SHEETS);
  });
});
