// @vitest-environment happy-dom
import type { ItemRecord, TemplateSummary } from "@tokama/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Card } from "./Card.js";

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

const COMMIT = "a".repeat(40);
const template = { id: "builtin/quick-fix", name: "Quick fix" } as unknown as TemplateSummary;
const check = { command: "pnpm test", passed: true, exitCode: 0 };
const done = (fields: Record<string, unknown> = {}): ItemRecord =>
  ({
    schemaVersion: 1,
    id: "item_1",
    kind: "task",
    templateId: template.id,
    title: "Fix the null check",
    text: "",
    repoIds: ["orders-api"],
    privacy: "local_only",
    state: "done",
    createdAt: 0,
    cardLine: "commit 3f2a9c1 · tokama/00000011",
    steps: [{ name: "Run checks", state: "passed", stage: "verifying", data: "none", attempts: [{ attempt: 1, result: "passed", checks: [check] }] }],
    outcome: { kind: "done", commits: [{ repoId: "orders-api", commit: COMMIT }] },
    ...fields,
  }) as unknown as ItemRecord;

const line = (item: ItemRecord): string | undefined => {
  act(() => root.render(<Card item={item} agents={[]} template={template} selected={false} onSelect={() => undefined} now={60_000} />));
  return container.querySelector(".card-line")?.textContent ?? undefined;
};

describe("Card line", () => {
  it("shows the facts, not the commit, on a done card before any finish action", () => {
    expect(line(done())).toBe("checks 1/1");
    expect(line(done({ finish: { worktreeRemoved: false } }))).toBe("checks 1/1");
  });

  it("keeps the facts while a merge runs or after one was refused, since nothing is merged", () => {
    expect(line(done({ finish: { worktreeRemoved: false, running: "merge" } }))).toBe("checks 1/1");
    expect(line(done({ finish: { worktreeRemoved: false, failed: { action: "merge", detail: "dirty", reason: "dirty_checkout" } } }))).toBe("checks 1/1");
  });

  it("goes back to the engine's line once the item is merged, has a pull request or is discarded", () => {
    expect(line(done({ finish: { worktreeRemoved: true, merged: { baseBranch: "main", commit: COMMIT } } }))).toBe("commit 3f2a9c1 · tokama/00000011");
    expect(line(done({ finish: { worktreeRemoved: false, pullRequest: { url: "https://github.com/a/b/pull/12" } } }))).toBe("commit 3f2a9c1 · tokama/00000011");
    expect(line(done({ finish: { worktreeRemoved: true } }))).toBe("commit 3f2a9c1 · tokama/00000011");
  });
});
