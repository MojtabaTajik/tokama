// @vitest-environment happy-dom
import type { DiffFile } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiffTab, type DiffTabProps, type ShownDiff } from "./DiffView.js";

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

const text = (selector: string) => container.querySelector(selector)?.textContent;
const modified: DiffFile = { path: "src/a.ts", status: "modified", added: 1, removed: 1, binary: false, cut: false, hunks: [{ header: "@@ -1 +1 @@", lines: ["-old", "+new"] }] };
const binary: DiffFile = { path: "logo.png", status: "modified", added: null, removed: null, binary: true, cut: true, hunks: [] };
const show = (diff: ShownDiff, props: Partial<DiffTabProps> = {}) => act(() => root.render(<DiffTab state={{ kind: "loaded", diff }} baseBranch="main" {...props} />));

describe("DiffTab for an ended item", () => {
  it("draws a diff without a worktree: the summary names no branch or base", () => {
    show({ files: [modified], moreFiles: 0, cut: false });
    expect(text(".dv-summary")).toBe("1 file+1 −1·");
    expect(container.querySelector(".dv-branch")).toBeNull();
  });

  it("puts the given header in place of the summary line", () => {
    show({ files: [modified], moreFiles: 0, cut: false }, { header: <p className="given">Merged as abc1234</p> });
    expect(text(".given")).toBe("Merged as abc1234");
    expect(container.querySelector(".dv-summary")).toBeNull();
  });

  it("sets the side-by-side heads from columns, else from the base branch", () => {
    const diff = { files: [modified], moreFiles: 0, cut: false };
    show(diff, { layout: "wide", columns: { before: "Before · main 85a75e3", after: "After · abc1234" } });
    expect([...container.querySelectorAll('[role="columnheader"]')].map((el) => el.textContent)).toEqual(["Before · main 85a75e3", "After · abc1234"]);
    show(diff, { layout: "wide" });
    expect([...container.querySelectorAll('[role="columnheader"]')].map((el) => el.textContent)).toEqual(["Before · main", "After · worktree"]);
  });

  it("names the repo path only when `where` has no folder, and the folder's path when it has one", () => {
    const diff = { files: [binary], moreFiles: 0, cut: true };
    show(diff, { where: { repoId: "orders-api" } });
    expect(text(".dv-note-text.mono")).toBe("In repo orders-api: logo.png");
    show(diff, { where: { repoId: "orders-api", dir: ".tokama/wt/a" } });
    expect(text(".dv-note-text.mono")).toBe("In repo orders-api: .tokama/wt/a/logo.png");
  });
});
