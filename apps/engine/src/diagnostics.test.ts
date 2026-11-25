import type { Command } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { usageAction } from "./diagnostics.js";

const items = new Map([["item_a", { kind: "task" }], ["item_b", { kind: "investigation" }]]);
const item = (id: string) => items.get(id);
const action = (command: unknown, data: unknown = null) => usageAction(command as Command, item, data);

describe("usageAction", () => {
  it("names each counted command by its action alone", () => {
    expect(action({ type: "start_item" }, { itemId: "item_a" })).toBe("start_task");
    expect(action({ type: "start_item" }, { itemId: "item_b" })).toBe("start_investigation");
    expect(action({ type: "start_item" }, { itemId: "item_missing" })).toBeUndefined();
    expect(action({ type: "resolve_decision", choice: "approve" })).toBe("approve");
    expect(action({ type: "resolve_decision", choice: "request_changes" })).toBe("request_changes");
    expect(action({ type: "resolve_decision", choice: "retry" })).toBe("answer_decision");
    expect(action({ type: "stop_item" })).toBe("stop_item");
    expect(action({ type: "finish_item", action: "pull_request" })).toBe("finish_pull_request");
    expect(action({ type: "accept_git_changes" })).toBe("accept_git_changes");
    expect(action({ type: "add_repo" })).toBe("add_repo");
    expect(action({ type: "remove_repo" })).toBe("remove_repo");
  });

  it("counts nothing for other commands", () => {
    expect(action({ type: "update_repo" })).toBeUndefined();
    expect(action({ type: "report_diagnostic" })).toBeUndefined();
  });
});
