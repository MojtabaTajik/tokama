import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Read as a file: Vitest turns CSS imports into empty modules.
const theme = readFileSync(join(import.meta.dirname, "theme.css"), "utf8");
const app = readFileSync(join(import.meta.dirname, "app.css"), "utf8");

// The app UI colours from CLAUDE.md ("App UI colors"), each a token in theme.css.
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
  "--warn": "#d9a93a",
  "--fail": "#e07a70",
  "--pass": "#6fb884",
  "--agent-1": "#8f73f2",
  "--agent-2": "#22a98b",
  "--agent-3": "#b23a6e",
  "--agent-neutral": "#4a5563",
};

describe("theme.css", () => {
  it.each(Object.entries(TOKENS))("defines %s as %s", (name, value) => {
    expect(theme).toMatch(new RegExp(`${name}:\\s*${value};`, "i"));
  });
});

describe("app.css", () => {
  it("takes every colour from the theme tokens: no colour literals", () => {
    expect(app.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi) ?? []).toEqual([]);
  });

  it("uses only tokens that theme.css defines", () => {
    const used = new Set([...app.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((match) => match[1]));
    const missing = [...used].filter((name) => !theme.includes(`${name}:`));
    expect(missing).toEqual([]);
  });
});
