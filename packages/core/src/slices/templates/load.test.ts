import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateRecordSchema } from "../../kernel/schemas/index.js";
import { BUILTIN_TEMPLATES, loadBuiltins, loadTemplates, templateJsonSchema, type TemplateLoad } from "./index.js";
import type { AgentLocation } from "./validate.js";

const AGENTS: ReadonlyMap<string, AgentLocation> = new Map([
  ["architect", { cloud: true }],
  ["builder", { cloud: true }],
  ["reviewer", { cloud: true }],
]);

const template = (name: string, instructions = "Do the work.") => `format: 1
name: ${name}
steps:
  - id: work
    name: Work
    agent: builder
    instructions: ${instructions}
    data: repo-and-diff
finish: [findings]
`;

let root: string;
let outside: string;
beforeEach(() => {
  // realpath: on macOS the temp folder is behind the /var -> /private/var link.
  root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-templates-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "tokama-templates-outside-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Makes a repo folder with the given files under `.tokama/templates/`. */
function repo(id: string, files: Record<string, string> = {}): { id: string; path: string } {
  const path = join(root, id);
  const dir = join(path, ".tokama", "templates");
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { id, path };
}

const templatesDir = (repoPath: string) => join(repoPath, ".tokama", "templates");
const failures = (loads: TemplateLoad[]) => loads.filter((load) => !load.ok);
const loaded = (loads: TemplateLoad[]) => loads.flatMap((load) => (load.ok ? [load.template] : []));

describe("loadTemplates", () => {
  it("loads each repo's templates as <repo>/<id>, keeping the same id in two repos apart", async () => {
    const orders = repo("orders-api", { "quick-fix.yaml": template("Orders fix") });
    const billing = repo("billing", { "quick-fix.yaml": template("Billing fix") });
    const loads = await loadTemplates({ repos: [orders, billing], agents: AGENTS });

    expect(failures(loads)).toEqual([]);
    expect(loaded(loads).map((t) => [t.ref, t.id, t.name, t.source])).toEqual([
      ["orders-api/quick-fix", "quick-fix", "Orders fix", { kind: "repo", repoId: "orders-api", file: ".tokama/templates/quick-fix.yaml" }],
      ["billing/quick-fix", "quick-fix", "Billing fix", { kind: "repo", repoId: "billing", file: ".tokama/templates/quick-fix.yaml" }],
      ["builtin/quick-fix", "quick-fix", "Quick fix", { kind: "builtin" }],
      ["builtin/quick-change", "quick-change", "Quick change", { kind: "builtin" }],
      ["builtin/plan-and-build", "plan-and-build", "Plan and build", { kind: "builtin" }],
      ["builtin/review-only", "review-only", "Review only", { kind: "builtin" }],
    ]);
  });

  it("loads a reviewer step with if_failed and warns with the line of the field", async () => {
    const text = `${template("Review it").replace("finish: [findings]\n", "")}  - id: review
    name: Review
    agent: reviewer
    instructions: Review the diff.
    done_when: reviewer approves
    if_failed: { back: work }
    data: repo-and-diff
finish: [findings]
`;
    const orders = repo("orders-api", { "a.yaml": text });
    const [first] = await loadTemplates({ repos: [orders], agents: AGENTS });
    expect(first).toMatchObject({
      ok: true,
      warnings: ['Line 14: Step "review": "if_failed" has no effect on a reviewer step; use "if_changes_requested".'],
    });
  });

  it("keeps machine paths out of the records", async () => {
    const orders = repo("orders-api", { "a.yaml": template("A", "instructions/a.md"), "instructions/a.md": "Steps.\n" });
    const loads = await loadTemplates({ repos: [orders], agents: AGENTS });
    expect(failures(loads)).toEqual([]);
    expect(JSON.stringify(loads)).not.toContain(root);
  });

  it("reads instruction files next to the template", async () => {
    const orders = repo("orders-api", { "a.yaml": template("A", "instructions/a.md"), "instructions/a.md": "Fix it.\n" });
    const [first] = loaded(await loadTemplates({ repos: [orders], agents: AGENTS }));
    expect(first?.steps[0]?.instructions).toEqual({ file: "instructions/a.md", text: "Fix it.\n" });
  });

  it("reports a missing instructions file with its line", async () => {
    const orders = repo("orders-api", { "a.yaml": template("A", "instructions/gone.md") });
    expect(failures(await loadTemplates({ repos: [orders], agents: AGENTS }))).toEqual([
      {
        ok: false,
        ref: "orders-api/a",
        origin: "orders-api",
        file: ".tokama/templates/a.yaml",
        problems: [{ line: 7, message: 'Step "work": the instructions file "instructions/gone.md" does not exist.' }],
        text: template("A", "instructions/gone.md"),
      },
    ]);
  });

  it("keeps the text of every file it could read", async () => {
    const orders = repo("orders-api", { "good.yaml": template("Good"), "bad.yaml": "name: [\n" });
    const loads = await loadTemplates({ repos: [orders], agents: AGENTS });
    expect(loads.map((load) => [load.ok ? load.template.ref : load.ref, load.text])).toEqual(
      expect.arrayContaining([
        ["orders-api/good", template("Good")],
        ["orders-api/bad", "name: [\n"],
        ["builtin/quick-fix", BUILTIN_TEMPLATES.get("quick-fix")],
      ]),
    );
  });

  it("reports a broken template without hiding the others", async () => {
    const orders = repo("orders-api", { "bad.yaml": "name: [\n", "good.yaml": template("Good") });
    const loads = await loadTemplates({ repos: [orders], agents: AGENTS });
    expect(failures(loads).map((load) => !load.ok && load.ref)).toEqual(["orders-api/bad"]);
    expect(loaded(loads).map((t) => t.ref)).toContain("orders-api/good");
  });

  it("ignores files that are not .yaml, folders, and a repo without a templates folder", async () => {
    const orders = repo("orders-api", { "notes.md": "x", "sub/inner.yaml": template("Nested") });
    const bare = { id: "billing", path: join(root, "billing") };
    mkdirSync(bare.path);
    expect(await loadTemplates({ repos: [orders, bare], agents: AGENTS })).toHaveLength(BUILTIN_TEMPLATES.size);
  });

  it("refuses a file name that is not a template id", async () => {
    const orders = repo("orders-api", { "Quick Fix.yaml": template("A") });
    const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
    expect(failure).toMatchObject({ ok: false, file: ".tokama/templates/Quick Fix.yaml", problems: [{ line: 1 }] });
    expect(failure && !failure.ok && failure.ref).toBeUndefined();
  });

  it("refuses a repo named builtin, so builtin/<id> always means a built-in", async () => {
    const named = repo("builtin", { "quick-fix.yaml": template("Fake") });
    const loads = await loadTemplates({ repos: [named], agents: AGENTS });
    expect(failures(loads)).toEqual([
      { ok: false, origin: "builtin", file: ".tokama/templates", problems: [{ line: 1, message: expect.stringContaining('cannot be named "builtin"') }] },
    ]);
    expect(loaded(loads).map((t) => t.name)).toEqual(["Quick fix", "Quick change", "Plan and build", "Review only"]);
  });

  it("refuses a repo named personal, so personal/<id> is kept for personal templates", async () => {
    const named = repo("personal", { "quick-fix.yaml": template("Fake") });
    const loads = await loadTemplates({ repos: [named], agents: AGENTS });
    expect(failures(loads)).toEqual([
      { ok: false, origin: "personal", file: ".tokama/templates", problems: [{ line: 1, message: expect.stringContaining('cannot be named "personal"') }] },
    ]);
    expect(loaded(loads).map((t) => t.name)).toEqual(["Quick fix", "Quick change", "Plan and build", "Review only"]);
  });

  describe("files refused by the safe reads", () => {
    it("refuses a symlinked template file", async () => {
      const orders = repo("orders-api");
      writeFileSync(join(outside, "real.yaml"), template("Outside"));
      symlinkSync(join(outside, "real.yaml"), join(templatesDir(orders.path), "linked.yaml"));
      expect(failures(await loadTemplates({ repos: [orders], agents: AGENTS }))).toEqual([
        {
          ok: false,
          ref: "orders-api/linked",
          origin: "orders-api",
          file: ".tokama/templates/linked.yaml",
          problems: [{ line: 1, message: `Tokama doesn't follow links in config folders: ".tokama/templates/linked.yaml"` }],
        },
      ]);
    });

    it("refuses a linked template file that stays inside the templates folder", async () => {
      const orders = repo("orders-api", { "real.yaml": template("Real") });
      symlinkSync(join(templatesDir(orders.path), "real.yaml"), join(templatesDir(orders.path), "linked.yaml"));
      const loads = await loadTemplates({ repos: [orders], agents: AGENTS });
      expect(loaded(loads).map((t) => t.ref)).toContain("orders-api/real");
      expect(failures(loads)).toEqual([
        {
          ok: false,
          ref: "orders-api/linked",
          origin: "orders-api",
          file: ".tokama/templates/linked.yaml",
          problems: [{ line: 1, message: `Tokama doesn't follow links in config folders: ".tokama/templates/linked.yaml"` }],
        },
      ]);
    });

    it("refuses a template that is too big", async () => {
      const orders = repo("orders-api", { "big.yaml": `${template("Big")}# ${"x".repeat(300 * 1024)}\n` });
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems[0]?.message).toMatch(/^The template is too big/);
    });

    it("reports a .yml file and asks for .yaml", async () => {
      const orders = repo("orders-api", { "old.yml": template("Old") });
      expect(failures(await loadTemplates({ repos: [orders], agents: AGENTS }))).toEqual([
        {
          ok: false,
          origin: "orders-api",
          file: ".tokama/templates/old.yml",
          problems: [{ line: 1, message: 'The file "old.yml" ends in .yml; Tokama reads only .yaml templates, so rename it to "old.yaml".' }],
        },
      ]);
    });

    it("quotes an unsafe file name instead of printing its control characters", async () => {
      const orders = repo("orders-api", { "bad\u001b[2Jname\u202e.yaml": template("A") });
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      const message = failure && !failure.ok ? (failure.problems[0]?.message ?? "") : "";
      expect(message).toContain('"bad\\u{1b}[2Jname\\u{202e}.yaml"');
      expect(message.includes("\u001b") || message.includes("\u202e")).toBe(false);
    });

    it("refuses a symlinked instructions file", async () => {
      const orders = repo("orders-api", { "a.yaml": template("A", "a.md") });
      writeFileSync(join(outside, "secret.md"), "secret");
      symlinkSync(join(outside, "secret.md"), join(templatesDir(orders.path), "a.md"));
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems).toEqual([
        { line: 7, message: `Step "work": the instructions file "a.md" is not read. Tokama doesn't follow links in config folders: ".tokama/templates/a.md".` },
      ]);
    });

    it("refuses an instructions file reached through a linked folder, also one that stays inside", async () => {
      const orders = repo("orders-api", { "a.yaml": template("A", "shared/deep/a.md"), "real/deep/a.md": "Do the work." });
      writeFileSync(join(outside, "a.md"), "secret");
      mkdirSync(join(outside, "deep"));
      symlinkSync(outside, join(templatesDir(orders.path), "shared"));
      const refused = `Step "work": the instructions file "shared/deep/a.md" is not read. Tokama doesn't follow links in config folders: `;
      let [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems).toEqual([{ line: 7, message: `${refused}".tokama/templates/shared".` }]);

      // A link deeper on the path, to a folder inside the templates folder.
      rmSync(join(templatesDir(orders.path), "shared"));
      mkdirSync(join(templatesDir(orders.path), "shared"));
      symlinkSync(join(templatesDir(orders.path), "real", "deep"), join(templatesDir(orders.path), "shared", "deep"));
      [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems).toEqual([{ line: 7, message: `${refused}".tokama/templates/shared/deep".` }]);
    });

    it("refuses a templates folder that links outside the repo", async () => {
      const path = join(root, "orders-api");
      mkdirSync(join(path, ".tokama"), { recursive: true });
      writeFileSync(join(outside, "x.yaml"), template("Outside"));
      symlinkSync(outside, join(path, ".tokama", "templates"));
      const loads = await loadTemplates({ repos: [{ id: "orders-api", path }], agents: AGENTS });
      expect(failures(loads)).toEqual([
        { ok: false, origin: "orders-api", file: ".tokama/templates", problems: [{ line: 1, message: `Tokama doesn't follow links in config folders: ".tokama/templates"` }] },
      ]);
    });

    it("refuses a linked templates or .tokama folder that stays inside the repo", async () => {
      const path = join(root, "orders-api");
      mkdirSync(join(path, "team", "templates"), { recursive: true });
      writeFileSync(join(path, "team", "templates", "x.yaml"), template("Team"));
      mkdirSync(join(path, ".tokama"));
      symlinkSync(join(path, "team", "templates"), join(path, ".tokama", "templates"));
      const refused = (file: string) => [{ ok: false, origin: "orders-api", file: ".tokama/templates", problems: [{ line: 1, message: `Tokama doesn't follow links in config folders: "${file}"` }] }];
      expect(failures(await loadTemplates({ repos: [{ id: "orders-api", path }], agents: AGENTS }))).toEqual(refused(".tokama/templates"));

      rmSync(join(path, ".tokama"), { recursive: true });
      symlinkSync(join(path, "team"), join(path, ".tokama"));
      expect(failures(await loadTemplates({ repos: [{ id: "orders-api", path }], agents: AGENTS }))).toEqual(refused(".tokama"));
    });
  });
});

describe("built-in templates", () => {
  it("ships Quick fix: Start (text, one repo), Fix until checks pass, then a commit", async () => {
    const [load] = await loadBuiltins(AGENTS);
    if (!load?.ok) throw new Error(JSON.stringify(load));
    expect(TemplateRecordSchema.parse(load.template)).toEqual(load.template);
    expect(load.template).toMatchObject({
      ref: "builtin/quick-fix",
      name: "Quick fix",
      icon: expect.any(String),
      color: expect.any(String),
      uses: { repos: { picked: "edit", named: [] } },
      start: { needs: ["text", "repo"] },
      finish: ["commit"],
    });
    expect(load.template.steps).toEqual([
      expect.objectContaining({
        id: "fix",
        name: "Fix",
        agentId: "builder",
        doneWhen: "checks pass",
        ifFailed: { action: "retry" },
        maxAttempts: 3,
        data: "repo-and-diff",
      }),
    ]);
  });

  it("loads clean with a local builder too", async () => {
    const [load] = await loadBuiltins(new Map([["builder", { cloud: false }]]));
    expect(load?.ok).toBe(true);
  });

  it("reports a missing builder agent", async () => {
    const [load] = await loadBuiltins(new Map());
    expect(load).toMatchObject({ ok: false, ref: "builtin/quick-fix", origin: "builtin", problems: [{ line: 12, message: expect.stringContaining('agent "builder", which is not set up') }] });
  });
});

describe("templateJsonSchema", () => {
  it("describes the file format for editors", () => {
    const schema = templateJsonSchema() as { properties: Record<string, unknown>; required: string[]; additionalProperties: boolean };
    expect(schema.required).toEqual(["format", "name", "steps", "finish"]);
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["name", "uses", "start", "setup", "steps", "finish", "budget"]));
    expect(JSON.stringify(schema)).toContain('"reviewer approves"');
  });
});
