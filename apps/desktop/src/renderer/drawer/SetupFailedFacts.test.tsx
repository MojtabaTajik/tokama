// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SetupFailedFacts, type SetupFailedFactsProps } from "./SetupFailedFacts.js";

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

const FAILED: SetupFailedFactsProps["failed"] = {
  when: "checks",
  command: "pnpm install --frozen-lockfile",
  ended: "failed",
  exitCode: 1,
  durationMs: 12_000,
  lastLine: 'ERR_PNPM_OUTDATED_LOCKFILE <img src=x onerror=alert(1)> Cannot install with "frozen-lockfile"',
  checksNotRun: 3,
};

const show = (failed = FAILED, over: Partial<SetupFailedFactsProps> = {}) => act(() => root.render(<SetupFailedFacts failed={failed} onSeeOutput={undefined} onEdit={undefined} {...over} />));
const rows = () => [...container.querySelectorAll(".rc-row")].map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent]);

describe("a failed setup's facts", () => {
  it("names the command whole, how it ended, the last line as text, the checks that did not run and the kept change", () => {
    show();
    expect(rows()).toEqual([
      ["Setup ran", "pnpm install --frozen-lockfile"],
      ["Ended", "✕ Failed, exit 1 · after 12 s"],
      ["It said", 'ERR_PNPM_OUTDATED_LOCKFILE <img src=x onerror=alert(1)> Cannot install with "frozen-lockfile"'],
      ["Checks", "– 3 not run: they need the setup to pass first"],
      ["The change", "kept in the worktree, nothing committed"],
    ]);
    // Text only: the markup in the output is not an element.
    expect(container.querySelector("img")).toBeNull();
  });

  it("words a timeout and a command that could not start, and leaves out the last line when there is none", () => {
    show({ ...FAILED, ended: "timed_out", durationMs: 1_200_000, lastLine: "" });
    expect(rows()[1]).toEqual(["Ended", "✕ Timed out · after 20 m 00 s"]);
    expect(rows().map(([label]) => label)).not.toContain("It said");
    show({ ...FAILED, ended: "could_not_start", exitCode: 127 });
    expect(rows()[1]).toEqual(["Ended", "✕ Could not start"]);
  });

  it("at Start has no checks and no change to speak of", () => {
    show({ ...FAILED, when: "start", checksNotRun: 0 });
    expect(rows().map(([label]) => label)).toEqual(["Setup ran", "Ended", "It said"]);
  });

  it("offers See the whole output and Edit the setup command only when asked to", () => {
    show();
    expect(container.querySelector(".sf-links")).toBeNull();
    const output = vi.fn();
    const edit = vi.fn();
    show(FAILED, { onSeeOutput: output, onEdit: edit });
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".sf-links button")];
    expect(buttons.map((button) => button.textContent)).toEqual(["See the whole output →", "Edit the setup command…"]);
    act(() => buttons[0]!.click());
    act(() => buttons[1]!.click());
    expect(output).toHaveBeenCalledOnce();
    expect(edit).toHaveBeenCalledOnce();
  });
});
