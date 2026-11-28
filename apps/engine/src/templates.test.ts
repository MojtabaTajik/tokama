import { API_VERSION, encodeLine, MAX_TEMPLATE_ENTRIES, parseQueryResult, type TemplateLoad } from "@tokama/core";
import { describe, expect, it } from "vitest";
import { sampleTemplateLoads } from "./sample/templates.js";
import { templateDetail, templateEntries, type TemplateFiles } from "./templates.js";

const FOLDER_PROBLEM: TemplateLoad = { ok: false, origin: "inventory-service", file: ".tokama/templates", problems: [{ line: 1, message: "The templates folder cannot be read." }] };

async function files(repoPath: TemplateFiles["repoPath"] = () => undefined): Promise<TemplateFiles> {
  return { loads: [...(await sampleTemplateLoads()), FOLDER_PROBLEM], repoPath };
}

describe("templateEntries", () => {
  it("lists every file, loaded or not, by origin and repo-relative path", async () => {
    expect(templateEntries(await files())).toEqual([
      { origin: "orders-api", file: ".tokama/templates/plan-and-build.yaml", ref: "orders-api/plan-and-build", name: "Plan and build", icon: "hammer", color: "sky", problemCount: 0, openable: false },
      { origin: "checkout-web", file: ".tokama/templates/flaky-test-fix.yaml", ref: "checkout-web/flaky-test-fix", problemCount: 2, openable: false },
      { origin: "inventory-service", file: ".tokama/templates", problemCount: 1, openable: false },
    ]);
  });

  it("marks a file openable only when its repo is on this machine and the file was read", async () => {
    const entries = templateEntries(await files((id) => `/work/${id}`));
    expect(entries.map((entry) => entry.openable)).toEqual([true, true, false]);
  });

  it("never marks a built-in openable", () => {
    const builtin: TemplateLoad = { ok: false, ref: "builtin/quick-fix" as never, origin: "builtin", file: "builtin/quick-fix", problems: [{ line: 3, message: "x" }], text: "name: x\n" };
    expect(templateEntries({ loads: [builtin], repoPath: () => "/work/builtin" })[0]?.openable).toBe(false);
  });
});

describe("templateDetail", () => {
  it("gives a loaded template without its instruction text, with the file text and no path for a sample repo", async () => {
    const detail = templateDetail(await files(), { origin: "orders-api", file: ".tokama/templates/plan-and-build.yaml" });
    expect(detail?.problems).toEqual([]);
    expect(detail?.path).toBeNull();
    expect(detail?.text).toContain("name: Plan and build");
    expect(detail?.template?.steps.map((step) => [step.id, step.doneWhen, step.instructionsFile])).toEqual([
      ["plan", "you approve", "instructions/plan.md"],
      ["build", "checks pass", "instructions/build.md"],
      ["review", "reviewer approves", "instructions/review.md"],
    ]);
    expect(JSON.stringify(detail)).not.toContain("Keep the diff small");
    expect(parseQueryResult("template_detail", detail).ok).toBe(true);
  });

  it("gives the problems with their lines and no template when the file does not load", async () => {
    const detail = templateDetail(await files(), { origin: "checkout-web", file: ".tokama/templates/flaky-test-fix.yaml" });
    expect(detail?.template).toBeNull();
    expect(detail?.problems).toEqual([
      { line: 20, message: 'Step "review" uses agent "reviewr", which is not set up. Did you mean "reviewer"?' },
      { line: 24, message: 'Step "review": "if_changes_requested" goes back to "buld", which is not a step in this template. Did you mean "build"?' },
    ]);
    expect(parseQueryResult("template_detail", detail).ok).toBe(true);
  });

  it("says whether a step's agent may run commands, only when the caller can tell", async () => {
    const key = { origin: "orders-api", file: ".tokama/templates/plan-and-build.yaml" };
    expect(templateDetail(await files(), key)).not.toHaveProperty("agentsRunCommands");
    for (const answer of [true, false]) {
      const detail = templateDetail({ ...(await files()), agentsRunCommands: () => answer }, key);
      expect(detail?.agentsRunCommands).toBe(answer);
      expect(parseQueryResult("template_detail", detail).ok).toBe(true);
    }
    // A file that does not load has no template to ask about.
    const broken = templateDetail({ ...(await files()), agentsRunCommands: () => true }, { origin: "checkout-web", file: ".tokama/templates/flaky-test-fix.yaml" });
    expect(broken).not.toHaveProperty("agentsRunCommands");
  });

  it("gives the full path of a repo file on this machine", async () => {
    const detail = templateDetail(await files((id) => `/work/${id}`), { origin: "orders-api", file: ".tokama/templates/plan-and-build.yaml" });
    expect(detail?.path).toBe("/work/orders-api/.tokama/templates/plan-and-build.yaml");
  });

  it("gives no text and no path for a folder it could not list", async () => {
    const detail = templateDetail(await files((id) => `/work/${id}`), { origin: "inventory-service", file: ".tokama/templates" });
    expect(detail).toMatchObject({ text: null, path: null, template: null, problems: [{ line: 1 }] });
  });

  it("finds nothing at an unknown place", async () => {
    expect(templateDetail(await files(), { origin: "orders-api", file: ".tokama/templates/gone.yaml" })).toBeUndefined();
  });

  it("drops the text, not the problems, when the file would make the reply too large to send", () => {
    // 200 000 control characters: within the read limit, but over a megabyte as JSON.
    const text = "\u0001".repeat(200_000);
    const load: TemplateLoad = { ok: false, origin: "orders-api", file: ".tokama/templates/odd.yaml", problems: [{ line: 1, message: "The file cannot be read as a template." }], text };
    const detail = templateDetail({ loads: [load], repoPath: () => undefined }, { origin: "orders-api", file: ".tokama/templates/odd.yaml" });
    expect(detail).toMatchObject({ text: null, textTooLarge: true, problems: [{ line: 1 }] });
    const reply = encodeLine({ apiVersion: API_VERSION, kind: "reply", requestId: "r".repeat(128), result: { ok: true, data: detail } });
    expect(reply.ok).toBe(true);
  });

  it("sends the text of an ordinary file", async () => {
    const detail = templateDetail(await files(), { origin: "orders-api", file: ".tokama/templates/plan-and-build.yaml" });
    expect(detail?.textTooLarge).toBe(false);
  });

  it("lists no more files than a reply may hold", () => {
    const loads: TemplateLoad[] = Array.from({ length: MAX_TEMPLATE_ENTRIES + 5 }, (_, i) => ({ ok: false, origin: "orders-api", file: `.tokama/templates/t${i}.yaml`, problems: [{ line: 1, message: "x" }] }));
    const entries = templateEntries({ loads, repoPath: () => undefined });
    expect(entries).toHaveLength(MAX_TEMPLATE_ENTRIES);
    expect(parseQueryResult("templates", { templates: entries }).ok).toBe(true);
  });

  it("keeps a reply inside the schema's limits", () => {
    const many: TemplateLoad = { ok: false, origin: "orders-api", file: ".tokama/templates/big.yaml", problems: Array.from({ length: 150 }, (_, i) => ({ line: i + 1, message: "x".repeat(2000) })), text: "" };
    const detail = templateDetail({ loads: [many], repoPath: () => undefined }, { origin: "orders-api", file: ".tokama/templates/big.yaml" });
    expect(detail?.problems).toHaveLength(100);
    expect(detail?.entry.problemCount).toBe(150);
    expect(parseQueryResult("template_detail", detail).ok).toBe(true);
  });
});
