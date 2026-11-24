import { describe, expect, it } from "vitest";
import type { ConnectionId, StepId } from "./ids.js";
import { connectionDerivedSteps } from "./template.js";

const step = (id: string, sees: string[] = [], connections = false) => ({
  id: id as StepId,
  sees: sees as StepId[],
  connections: connections ? [{ connectionId: "northwind-logs" as ConnectionId, access: "query" }] : [],
});

describe("connectionDerivedSteps", () => {
  it("has the steps with connections and every step that sees one, through chains", () => {
    const steps = [step("query", [], true), step("plan", ["query"]), step("build"), step("report", ["plan"]), step("review", ["build"])];
    expect([...connectionDerivedSteps(steps)].sort()).toEqual(["plan", "query", "report"]);
  });

  it("follows a sees that points forward", () => {
    const steps = [step("relay", ["query"]), step("review", ["relay"]), step("query", [], true)];
    expect([...connectionDerivedSteps(steps)].sort()).toEqual(["query", "relay", "review"]);
  });

  it("is empty without connections", () => {
    expect(connectionDerivedSteps([step("a"), step("b", ["a"])]).size).toBe(0);
  });
});
