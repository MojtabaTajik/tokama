import { describe, expect, it } from "vitest";
import { API_VERSION, packageName, parseEngineMessage } from "./index.js";

describe("@tokama/core", () => {
  it("exposes its public entry", () => {
    expect(packageName).toBe("@tokama/core");
  });

  it("exposes the engine API parser", () => {
    const message = { apiVersion: API_VERSION, kind: "query", requestId: "r1", query: { type: "board", workspaceId: "northwind-prod" } };
    expect(parseEngineMessage(message)).toEqual({ ok: true, value: message });
  });
});
