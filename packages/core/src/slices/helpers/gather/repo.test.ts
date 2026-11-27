import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProcessRunner } from "../../../kernel/process/index.js";
import { HELPER_INPUTS } from "../definition.js";
import { writeSampleRepo } from "../testing/sample-repos.js";
import { createRepoGatherer } from "./repo.js";

const SECRET = "TOKEN-9f3a-do-not-send";
const NAMES_CAP = HELPER_INPUTS["repo-file-names"].maxBytes;
const BUILD_CAP = HELPER_INPUTS["repo-build-files"].maxBytes;

let root: string;
let user: string;
let home: string;
let repo: string;
let outside: string;
let worktreeFolders: string[];
const signal = new AbortController().signal;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tk-gather-")));
  user = join(root, "user");
  home = join(user, ".tokama");
  repo = join(user, "code", "orders-api");
  outside = join(root, "outside");
  worktreeFolders = [".tokama/wt"];
  for (const dir of [home, repo, outside]) mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (path: string, text = SECRET) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const gatherer = () => createRepoGatherer({ tokamaHome: home, userHome: user, worktreeFolders: () => worktreeFolders });
async function gather(path = repo) {
  const result = await gatherer()({ path }, signal);
  if (!result.ok) throw new Error(result.error);
  return { names: result.value["repo-file-names"] ?? "", builds: result.value["repo-build-files"] ?? "" };
}
const refusal = async (path: string): Promise<string> => {
  const result = await gatherer()({ path }, signal);
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
};
const lines = (text: string): string[] => text.split("\n").filter((line) => line !== "");
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("secret files", () => {
  // Every pattern, in mixed case, at the top, in a subfolder and as a folder.
  const SECRET_FILES = [
    ".env", ".ENV.local", ".envrc", ".npmrc", ".NpmRc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials", "NuGet.Config", "Gradle.Properties", "LOCAL.properties",
    "Settings.XML", "server.PEM", "tls.Key", "a.p12", "a.PFX", "release.jks", "debug.keystore", "prod.TFVARS", "id_rsa", "ID_ed25519", "Credentials.json", "SECRETS.yml",
  ];

  it("never names or reads one, at the top or one folder down", async () => {
    for (const name of SECRET_FILES) {
      put(join(repo, name));
      put(join(repo, "config", name));
    }
    put(join(repo, ".env.d", "token.txt"));
    put(join(repo, "secrets", "key.txt"));
    put(join(repo, "package.json"), '{ "scripts": { "test": "vitest run" } }');
    const { names, builds } = await gather();
    for (const name of SECRET_FILES) {
      expect(names.toLowerCase()).not.toContain(name.toLowerCase());
      expect(builds.toLowerCase()).not.toContain(name.toLowerCase());
    }
    expect(names).not.toContain("secrets");
    expect(names).not.toContain("token.txt");
    expect(names + builds).not.toContain(SECRET);
    // The plain folder is listed; what is secret in it is not.
    expect(lines(names)).toEqual(["config/", "package.json"]);
  });

  it("never reads a secret-named workflow, project or readme file", async () => {
    put(join(repo, ".github", "workflows", "secrets.yml"));
    put(join(repo, ".github", "workflows", "ci.yml"), "name: ci\n");
    put(join(repo, "Credentials.csproj"));
    put(join(repo, "Orders.csproj"), "<Project />\n");
    const { names, builds } = await gather();
    expect(builds).toContain("--- .github/workflows/ci.yml ---");
    expect(builds).toContain("--- Orders.csproj ---");
    expect(names + builds).not.toContain(SECRET);
    expect((names + builds).toLowerCase()).not.toContain("credentials");
    expect((names + builds).toLowerCase()).not.toContain("secrets");
  });
});

describe("links and files that are not plain", () => {
  it("does not read a build file or a readme that links to a file outside, and names it as not included", async () => {
    put(join(outside, "secret.txt"));
    for (const name of ["package.json", "Makefile", "README.md"]) symlinkSync(join(outside, "secret.txt"), join(repo, name));
    const { names, builds } = await gather();
    expect(builds).not.toContain(SECRET);
    expect(builds).toContain("--- not included ---\npackage.json (a link)\nMakefile (a link)\nREADME.md (a link)\n");
    // A name is not a content: the link's name is listed like any other.
    expect(lines(names)).toEqual(["Makefile", "README.md", "package.json"]);
  });

  it("does not read a build file that links to a file inside the folder", async () => {
    put(join(repo, "real-package.json"), SECRET);
    symlinkSync(join(repo, "real-package.json"), join(repo, "package.json"));
    const { builds } = await gather();
    expect(builds).not.toContain(SECRET);
    expect(builds).toContain("package.json (a link)");
  });

  it("does not follow a folder link out of the folder, for names or for the workflows", async () => {
    put(join(outside, "secret-src", "inside.ts"));
    put(join(outside, "wf", "workflows", "evil.yml"), SECRET);
    symlinkSync(join(outside, "secret-src"), join(repo, "src"));
    symlinkSync(join(outside, "wf"), join(repo, ".github"));
    const { names, builds } = await gather();
    expect(names).not.toContain("inside.ts");
    expect(builds).not.toContain(SECRET);
    expect(builds).not.toContain("evil.yml");
  });

  it("does not follow a link to a folder inside the folder", async () => {
    put(join(repo, "docs", "guide.md"), "guide");
    symlinkSync(join(repo, "docs"), join(repo, "manual"));
    const { names } = await gather();
    expect(lines(names)).toEqual(["docs/", "manual", "docs/guide.md"]);
  });

  it.skipIf(process.platform === "win32")("does not block on a FIFO named as a build file, and names it as not a regular file", async () => {
    const made = await createProcessRunner().run({ command: { argv: ["mkfifo", join(repo, "Makefile")] }, cwd: repo, timeoutMs: 5_000 });
    expect(made).toMatchObject({ kind: "finished", exitCode: 0 });
    put(join(repo, "package.json"), "{}");
    const { builds } = await gather();
    expect(builds).toContain("--- package.json ---");
    expect(builds).toContain("Makefile (not a regular file)");
  });

  it("names a build file over 16 KiB as not included and never cuts it", async () => {
    put(join(repo, "pom.xml"), `<project>${"x".repeat(1_000_000)}</project>`);
    put(join(repo, "Cargo.toml"), "[package]\nname = 'orders'\n");
    const { builds } = await gather();
    expect(builds).toContain("pom.xml (larger than 16 KiB)");
    expect(builds).not.toContain("<project>");
    expect(builds).toContain("--- Cargo.toml ---");
  });

  it("names a build file that is not text", async () => {
    writeFileSync(join(repo, "go.mod"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    expect((await gather()).builds).toContain("go.mod (not text)");
  });
});

describe("the folder", () => {
  it.each([
    ["a relative path", () => "orders-api", /full path/],
    ["a path with a NUL", () => `${repo}\0`, /full path/],
    ["a folder that does not exist", () => join(repo, "nope"), /does not exist/],
    ["a file", () => { put(join(repo, "a.txt")); return join(repo, "a.txt"); }, /not a folder/],
    ["the Tokama home", () => home, /Tokama's own/],
    ["a folder inside the Tokama home", () => { mkdirSync(join(home, "repos"), { recursive: true }); return join(home, "repos"); }, /Tokama's own/],
    ["a link to the Tokama home", () => { symlinkSync(home, join(repo, "link-home")); return join(repo, "link-home"); }, /Tokama's own/],
    ["a link to a folder inside the Tokama home", () => { mkdirSync(join(home, "agents"), { recursive: true }); symlinkSync(join(home, "agents"), join(repo, "link-agents")); return join(repo, "link-agents"); }, /Tokama's own/],
    ["the user's home folder, which holds the Tokama home", () => user, /holds Tokama's own/],
    ["a folder above the Tokama home", () => root, /holds Tokama's own/],
    ["the file system root", () => "/", /holds Tokama's own/],
  ])("refuses %s", async (_name, path, message) => {
    expect(await refusal(path())).toMatch(message);
  });

  it("refuses the home folder even when the Tokama home is elsewhere", async () => {
    const elsewhere = createRepoGatherer({ tokamaHome: join(root, "elsewhere", ".tokama"), userHome: user, worktreeFolders: () => [] });
    const result = await elsewhere({ path: user }, signal);
    expect(result).toEqual({ ok: false, error: "This is the home folder, not a project's. Pick the project's folder." });
    // A project inside the home folder is the normal case.
    put(join(repo, "package.json"), "{}");
    expect((await elsewhere({ path: repo }, signal)).ok).toBe(true);
  });

  it("compares real paths in any letter case, as a case-insensitive disk does", async () => {
    expect(await refusal(home.toUpperCase())).toMatch(/does not exist|Tokama's own/);
    const gatherUpper = createRepoGatherer({ tokamaHome: home.toUpperCase(), userHome: user, worktreeFolders: () => [] });
    expect((await gatherUpper({ path: home }, signal)).ok).toBe(false);
  });

  it("reads a folder through a link to it, by its real path", async () => {
    put(join(repo, "package.json"), "{}");
    symlinkSync(repo, join(root, "alias"));
    expect((await gather(join(root, "alias"))).builds).toContain("--- package.json ---");
  });
});

describe("file names", () => {
  it("lists two levels, folders with a closing slash, and skips .git, node_modules and the worktree folders", async () => {
    for (const path of ["package.json", "src/index.ts", "src/lib/deep.ts", ".git/HEAD", "node_modules/x/index.js", "packages/a/node_modules/y.js", ".tokama/wt/item-1/file.ts", ".tokama/keep.md", "custom/wt/x.ts", "custom/other.ts"]) put(join(repo, path), "x");
    worktreeFolders = [".tokama/wt", "./custom/wt/"];
    const { names } = await gather();
    expect(lines(names)).toEqual([".tokama/", "custom/", "package.json", "packages/", "src/", ".tokama/keep.md", "custom/other.ts", "packages/a/", "src/index.ts", "src/lib/"]);
    expect(names).not.toContain("deep.ts");
    expect(names).not.toContain(".git");
    expect(names).not.toContain("node_modules");
    expect(names).not.toContain("item-1");
    expect(names).not.toContain("wt");
  });

  it("skips a name with a control character, and keeps a decomposed name as it is", async () => {
    const decomposed = "école.md";
    put(join(repo, decomposed), "x");
    put(join(repo, "bad\nname.txt"), "x");
    put(join(repo, "zero​width.txt"), "x");
    put(join(repo, "plain.txt"), "x");
    const { names } = await gather();
    expect(lines(names)).toEqual([decomposed, "plain.txt"]);
  });

  it("says so for a folder with no files", async () => {
    expect((await gather()).names).toBe("(no files)\n");
  });

  it("stays within its cap and says that names are left out", async () => {
    for (let i = 0; i < 2_000; i++) writeFileSync(join(repo, `some-quite-long-file-name-${String(i).padStart(5, "0")}.ts`), "x");
    const { names } = await gather();
    expect(bytes(names)).toBeLessThanOrEqual(NAMES_CAP);
    expect(names.endsWith("... (more names are not listed)\n")).toBe(true);
    expect(lines(names)[0]).toBe("some-quite-long-file-name-00000.ts");
  });
});

describe("build files", () => {
  it("reads each known file in priority order", async () => {
    writeSampleRepo(repo, "pnpm");
    const { builds } = await gather();
    const headers = builds.split("\n").filter((line) => line.startsWith("--- "));
    expect(headers).toEqual(["--- package.json ---", "--- pnpm-workspace.yaml ---", "--- .github/workflows/ci.yml ---", "--- README.md ---"]);
    expect(builds).toContain('"test": "vitest run"');
    expect(builds).not.toContain("pnpm-lock");
    expect(builds).not.toContain("export const orders");
  });

  it("finds a file by its name in any letter case", async () => {
    put(join(repo, "makefile"), "test:\n\ttrue\n");
    put(join(repo, "readme"), "hello\n");
    put(join(repo, "CONTRIBUTING.MD"), "rules\n");
    const { builds } = await gather();
    expect(builds).toContain("--- makefile ---");
    expect(builds).toContain("--- readme ---");
    expect(builds).toContain("--- CONTRIBUTING.MD ---");
  });

  it("reads only the first 8 KiB of a readme, and says so", async () => {
    put(join(repo, "README.md"), `${"a".repeat(8 * 1024)}END-OF-README`);
    const { builds } = await gather();
    expect(builds).toContain("--- README.md (the first 8 KiB) ---");
    expect(builds).not.toContain("END-OF-README");
  });

  it("reads at most 3 project files and 3 workflows, and only .yml or .yaml", async () => {
    for (const name of ["a", "b", "c", "d", "e"]) put(join(repo, `${name}.csproj`), "<Project />\n");
    for (const name of ["a.yml", "b.yaml", "c.yml", "d.yml", "notes.txt"]) put(join(repo, ".github", "workflows", name), "name: x\n");
    const { builds } = await gather();
    expect(builds.match(/^--- .*\.csproj ---$/gm)).toEqual(["--- a.csproj ---", "--- b.csproj ---", "--- c.csproj ---"]);
    expect(builds.match(/^--- \.github.* ---$/gm)).toEqual(["--- .github/workflows/a.yml ---", "--- .github/workflows/b.yaml ---", "--- .github/workflows/c.yml ---"]);
  });

  it("stops at 80 KiB in all, skips what does not fit and names it", async () => {
    const big = "y".repeat(14 * 1024);
    for (const name of ["package.json", "Makefile", "Cargo.toml", "go.mod", "pyproject.toml", "pom.xml", "Gemfile"]) put(join(repo, name), `${name}\n${big}`);
    const { builds } = await gather();
    expect(bytes(builds)).toBeLessThanOrEqual(BUILD_CAP);
    const [included, left] = builds.split("--- not included ---\n") as [string, string];
    expect(included.match(/^--- .* ---$/gm)).toEqual(["--- package.json ---", "--- Makefile ---", "--- Cargo.toml ---", "--- go.mod ---", "--- pyproject.toml ---"]);
    expect(left).toBe("pom.xml (would pass the 80 KiB limit)\nGemfile (would pass the 80 KiB limit)\n");
  });

  it("says so when there is nothing to read", async () => {
    expect((await gather()).builds).toBe("(no build files found)\n");
  });

  it("stops when it is cancelled", async () => {
    writeSampleRepo(repo, "pnpm");
    const stopped = new AbortController();
    stopped.abort();
    const result = await gatherer()({ path: repo }, stopped.signal);
    expect(result).toMatchObject({ ok: true, value: { "repo-build-files": "(no build files found)\n" } });
  });
});
