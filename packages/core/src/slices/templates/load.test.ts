import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TemplateRecordSchema } from "../../kernel/schemas/index.js";
import { BUILTIN_TEMPLATES, loadBuiltins, loadTemplates, templateJsonSchema, type TemplateLoad } from "./index.js";
import type { AgentLocation } from "./validate.js";

const AGENTS: ReadonlyMap<string, AgentLocation> = new Map([["builder", { cloud: true }]]);

const template = (name: string, instructions = "Do the work.") => `format: 1
name: ${name}
steps:
  - id: work
    name: Work
    agent: builder
    instructions: ${instructions}
    data: repo-and-diff
finish: [commit]
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
    ]);
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
      },
    ]);
  });

  it("reports a broken template without hiding the others", async () => {
    const orders = repo("orders-api", { "bad.yaml": "name: [\n", "good.yaml": template("Good") });
    const loads = await loadTemplates({ repos: [orders], agents: AGENTS });
    expect(failures(loads).map((load) => !load.ok && load.ref)).toEqual(["orders-api/bad"]);
    expect(loaded(loads).map((t) => t.ref)).toContain("orders-api/good");
  });

  it("ignores files that are not .yaml, and a repo without a templates folder", async () => {
    const orders = repo("orders-api", { "notes.md": "x", "old.yml": "x" });
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
    expect(loaded(loads).map((t) => t.name)).toEqual(["Quick fix"]);
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
          problems: [{ line: 1, message: "The template is a symlink, and Tokama does not follow symlinks in templates." }],
        },
      ]);
    });

    it("refuses a template that is too big", async () => {
      const orders = repo("orders-api", { "big.yaml": `${template("Big")}# ${"x".repeat(300 * 1024)}\n` });
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems[0]?.message).toMatch(/^The template is too big/);
    });

    it("refuses a template that is a folder", async () => {
      const orders = repo("orders-api");
      mkdirSync(join(templatesDir(orders.path), "folder.yaml"));
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems[0]?.message).toBe("The template is not a regular file.");
    });

    it("refuses a symlinked instructions file", async () => {
      const orders = repo("orders-api", { "a.yaml": template("A", "a.md") });
      writeFileSync(join(outside, "secret.md"), "secret");
      symlinkSync(join(outside, "secret.md"), join(templatesDir(orders.path), "a.md"));
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems).toEqual([
        { line: 7, message: 'Step "work": the instructions file "a.md" is a symlink, and Tokama does not follow symlinks in templates.' },
      ]);
    });

    it("refuses an instructions file reached through a symlinked folder outside the templates folder", async () => {
      const orders = repo("orders-api", { "a.yaml": template("A", "shared/a.md") });
      writeFileSync(join(outside, "a.md"), "secret");
      symlinkSync(outside, join(templatesDir(orders.path), "shared"));
      const [failure] = failures(await loadTemplates({ repos: [orders], agents: AGENTS }));
      expect(failure && !failure.ok && failure.problems).toEqual([
        { line: 7, message: 'Step "work": the instructions file "shared/a.md" is outside the templates folder.' },
      ]);
    });

    it("refuses a templates folder that links outside the repo", async () => {
      const path = join(root, "orders-api");
      mkdirSync(join(path, ".tokama"), { recursive: true });
      writeFileSync(join(outside, "x.yaml"), template("Outside"));
      symlinkSync(outside, join(path, ".tokama", "templates"));
      const loads = await loadTemplates({ repos: [{ id: "orders-api", path }], agents: AGENTS });
      expect(failures(loads)).toEqual([
        { ok: false, origin: "orders-api", file: ".tokama/templates", problems: [{ line: 1, message: expect.stringContaining("outside the repo") }] },
      ]);
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
