// @vitest-environment happy-dom
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { markOf, StatusMark } from "./status.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("markOf", () => {
  it("gives each status one symbol, word and tone", () => {
    expect(markOf("needs_you")).toEqual({ symbol: "⏸", word: "needs you", tone: "warn" });
    expect(markOf("failed")).toEqual({ symbol: "✕", word: "failed", tone: "fail" });
    expect(markOf("checking")).toEqual({ symbol: "◐", word: "checking", tone: "live" });
  });

  it("keeps the symbol and tone when a screen words it its own way", () => {
    expect(markOf("done", "merged")).toEqual({ symbol: "✓", word: "merged", tone: "pass" });
    expect(markOf("failed", "2 problems")).toEqual({ symbol: "✕", word: "2 problems", tone: "fail" });
  });
});

describe("StatusMark", () => {
  it("shows the symbol in its tone, hidden from screen readers", () => {
    act(() => root.render(<StatusMark status="failed" className="symbol" />));
    const mark = container.querySelector(".mark")!;
    expect(mark.className).toBe("mark symbol");
    expect(mark.getAttribute("data-tone")).toBe("fail");
    expect(mark.getAttribute("aria-hidden")).toBe("true");
    expect(container.textContent).toBe("✕");
  });

  it("says the word to screen readers when asked, and takes a mark already looked up", () => {
    act(() => root.render(<StatusMark status={markOf("done", "merged")} spoken />));
    expect(container.querySelector(".visually-hidden")?.textContent).toBe("merged");
    expect(container.querySelector(".mark")?.getAttribute("data-tone")).toBe("pass");
  });
});

// The guard: a status symbol written as a string anywhere else is a second status table in the
// making. Screens look symbols up with markOf or render StatusMark.
describe("status symbols", () => {
  const renderer = join(import.meta.dirname, "..");
  const SYMBOL_LITERAL = /(?:^|[:=?(,[]|return)\s*["'`](?:⏸|●|✓|✕|◐|○|◌|■)["'`]/m;
  const sources = readdirSync(renderer, { recursive: true, encoding: "utf8" }).filter(
    (path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith("ui/") && !path.startsWith("ui\\") && !path.startsWith("testing"),
  );

  it("finds the screens", () => {
    expect(sources.length).toBeGreaterThan(50);
  });

  it.each(sources)("%s writes no status symbol of its own", (path) => {
    const code = readFileSync(join(renderer, path), "utf8");
    const lines = code.split("\n").filter((line) => SYMBOL_LITERAL.test(line));
    expect(lines).toEqual([]);
  });
});
