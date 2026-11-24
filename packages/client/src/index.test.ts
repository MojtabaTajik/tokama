import { API_VERSION, parseClientMessage, type CommandMessageInput, type QueryMessageInput } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { builtOn, packageName } from "./index.js";

describe("@tokama/client", () => {
  it("imports @tokama/core", () => {
    expect(packageName).toBe("@tokama/client");
    expect(builtOn).toBe("@tokama/core");
  });

  // Typed against core's built .d.ts: outbound messages take ids as plain strings, no casts.
  it("builds outbound messages from plain string ids", () => {
    const itemId: string = "item_0b9f3c1e-6a2d-4f7b-9c1a-2e3d4f5a6b7c";
    const decisionId: string = "decision_2d3e4f5a-6b7c-4d8e-9f0a-1b2c3d4e5f6a";
    const query: QueryMessageInput = { apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "item", itemId } };
    const command: CommandMessageInput = {
      apiVersion: API_VERSION,
      kind: "command",
      requestId: "r2",
      command: { type: "resolve_decision", itemId, decisionId, choice: "approve" },
    };
    expect(parseClientMessage(query)).toEqual({ ok: true, value: query });
    expect(parseClientMessage(command)).toEqual({ ok: true, value: command });
  });
});
