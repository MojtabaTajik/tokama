import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineApi } from "./api.js";
import { openablePath, openTemplateFile } from "./template-file.js";

let root: string;
let home: string;
let repo: string;
let file: string;

beforeEach(() => {
  // realpath: on macOS the temp folder is behind the /var -> /private/var link.
  root = realpathSync(mkdtempSync(join(tmpdir(), "tk-open-")));
  home = join(root, "home", ".tokama");
  repo = join(root, "orders-api");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".tokama", "templates"), { recursive: true });
  file = join(repo, ".tokama", "templates", "plan.yaml");
  writeFileSync(file, "format: 1\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const write = (path: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "x\n");
  return path;
};

describe("openablePath", () => {
  it("allows a template file in a repo's .tokama folder", () => {
    expect(openablePath(file, home)).toEqual({ ok: true, path: file });
  });

  it("allows a .yaml file in the Tokama home", () => {
    const personal = write(join(home, "templates", "mine.yaml"));
    expect(openablePath(personal, home)).toEqual({ ok: true, path: personal });
  });

  it.each([
    ["a relative path", () => ".tokama/templates/plan.yaml", "plain full path"],
    ["a path with ..", () => `${repo}/.tokama/templates/../../evil.yaml`, "plain full path"],
    ["a file that is not .yaml", () => write(join(repo, ".tokama", "templates", "run.sh")), "only template files"],
    ["a .yaml outside any .tokama folder", () => write(join(repo, "config.yaml")), "not in a repo's .tokama folder"],
    ["a sibling folder such as .tokama-x", () => write(join(repo, ".tokama-x", "templates", "plan.yaml")), "not in a repo's .tokama folder"],
    ["a missing file", () => join(repo, ".tokama", "templates", "gone.yaml"), "does not exist"],
    ["a folder named .yaml", () => (mkdirSync(join(repo, ".tokama", "dir.yaml")), join(repo, ".tokama", "dir.yaml")), "not a file"],
  ])("refuses %s", (_case, path, why) => {
    const result = openablePath(path(), home);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(why);
  });

  it("refuses a link, also one that points to a template file", () => {
    const outside = write(join(root, "elsewhere", "app.yaml"));
    const link = join(repo, ".tokama", "templates", "out.yaml");
    symlinkSync(outside, link);
    expect(openablePath(link, home)).toMatchObject({ ok: false, message: expect.stringContaining("is a link") });
    const inner = join(repo, ".tokama", "templates", "in.yaml");
    symlinkSync(file, inner);
    expect(openablePath(inner, home)).toMatchObject({ ok: false, message: expect.stringContaining("is a link") });
  });

  it("refuses a file whose folder is a link leading out of .tokama", () => {
    const outside = join(root, "elsewhere");
    write(join(outside, "app.yaml"));
    symlinkSync(outside, join(repo, ".tokama", "linked"));
    expect(openablePath(join(repo, ".tokama", "linked", "app.yaml"), home)).toMatchObject({ ok: false, message: expect.stringContaining("not in a repo's .tokama folder") });
  });
});

describe("openTemplateFile", () => {
  const api = (data: unknown, ok = true): EngineApi & { query: ReturnType<typeof vi.fn> } => ({
    query: vi.fn(async () => (ok ? { ok: true, data } : { ok: false, error: { code: "not_found", message: "no template file x in orders-api" } })) as never,
    command: vi.fn() as never,
  });

  it("asks the engine for the path and opens the checked file", async () => {
    const engine = api({ path: file });
    const openPath = vi.fn(async () => "");
    expect(await openTemplateFile({ origin: "orders-api", file: ".tokama/templates/plan.yaml", type: "setup" }, { api: engine, tokamaHome: home, openPath })).toEqual({ ok: true });
    expect(engine.query).toHaveBeenCalledWith({ type: "template_detail", origin: "orders-api", file: ".tokama/templates/plan.yaml" });
    expect(openPath).toHaveBeenCalledWith(file);
  });

  it("opens nothing when the engine refuses, has no path, or gives a path the guard refuses", async () => {
    const openPath = vi.fn(async () => "");
    expect(await openTemplateFile({ origin: "orders-api", file: "x" }, { api: api(null, false), tokamaHome: home, openPath })).toEqual({ ok: false, message: "no template file x in orders-api" });
    expect(await openTemplateFile({ origin: "builtin", file: "builtin/quick-fix" }, { api: api({ path: null }), tokamaHome: home, openPath })).toMatchObject({ ok: false, message: expect.stringContaining("no file on this machine") });
    expect(await openTemplateFile({ origin: "orders-api", file: "x" }, { api: api({ path: "/bin/sh" }), tokamaHome: home, openPath })).toMatchObject({ ok: false, message: expect.stringContaining("only template files") });
    expect(await openTemplateFile("orders-api/x", { api: api({ path: file }), tokamaHome: home, openPath })).toMatchObject({ ok: false });
    expect(openPath).not.toHaveBeenCalled();
  });

  it("passes on the system's error", async () => {
    expect(await openTemplateFile({ origin: "orders-api", file: "x" }, { api: api({ path: file }), tokamaHome: home, openPath: async () => "no app for .yaml" })).toEqual({ ok: false, message: "The file did not open: no app for .yaml" });
  });
});
