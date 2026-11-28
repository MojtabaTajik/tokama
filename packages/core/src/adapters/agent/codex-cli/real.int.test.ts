import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { profileOverrides } from "./args.js";
import { NO_DAEMON, NO_DAEMON_FEATURE } from "./command.js";

// The permission profile this adapter builds, read by the real `codex sandbox`. Opt in with
// TOKAMA_REAL_CODEX=<absolute path of the codex to test>; it needs no login and makes no model call.
// Everything runs against a decoy home folder under a temp folder: the real home and its secret
// folders are never read, and Codex gets an empty CODEX_HOME of its own.

const codex = process.env["TOKAMA_REAL_CODEX"];
const enabled = codex !== undefined && codex.startsWith("/");

describe.skipIf(!enabled)("the Codex CLI permission profile against the real sandbox", () => {
  let root = "";
  let home = "";
  let work = "";
  const weird = 'we ird"dir ü';

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tokama-real-codex-")));
    home = join(root, "home");
    work = join(root, "work");
    for (const dir of [join(home, ".ssh"), join(home, ".docker"), join(home, "closed", weird), work, join(root, "chome")]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(home, ".ssh", "id_fake"), "FAKE-SSH\n");
    writeFileSync(join(home, ".docker", "config.json"), "FAKE-DOCKER\n");
    writeFileSync(join(home, ".netrc"), "FAKE-NETRC\n");
    writeFileSync(join(home, "closed", weird, "f.txt"), "FAKE-CLOSED\n");
    writeFileSync(join(home, "open.txt"), "OPEN\n");
    writeFileSync(join(work, "a.txt"), "hello\n");
    writeFileSync(join(work, ".env"), "API_KEY=FAKE-ENV\n");
    symlinkSync(join(home, ".ssh", "id_fake"), join(work, "link"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** `codex sandbox` under the profile for a step, with the decoy home. */
  function sandboxed(edit: boolean, command: string[]): { code: number | null; out: string } {
    const overrides = profileOverrides({ edit }, { tokamaHome: join(home, ".tokama"), closedDirs: [join(home, "closed", weird)] });
    if (!overrides.ok) throw new Error(overrides.error);
    const run = spawnSync(codex ?? "", [...NO_DAEMON, "sandbox", ...NO_DAEMON_FEATURE, "-C", work, ...overrides.value, "-P", "tokama", "--", ...command], {
      encoding: "utf8",
      timeout: 60_000,
      // The npm wrapper of Codex is a Node script: Node must be on the PATH.
      env: { PATH: `/usr/bin:/bin${delimiter}${dirname(process.execPath)}`, HOME: home, CODEX_HOME: join(root, "chome"), TMPDIR: join(root, "tmp") },
    });
    return { code: run.status, out: `${run.stdout}${run.stderr}` };
  }

  it.each([false, true])("runs a command and closes every secret path, with edit=%s", (edit) => {
    expect(sandboxed(edit, ["cat", "a.txt"])).toMatchObject({ code: 0, out: expect.stringContaining("hello") });
    expect(sandboxed(edit, ["cat", join(home, "open.txt")])).toMatchObject({ code: 0, out: expect.stringContaining("OPEN") });
    for (const [path, secret] of [
      [join(home, ".ssh", "id_fake"), "FAKE-SSH"],
      [join(home, ".docker", "config.json"), "FAKE-DOCKER"],
      [join(home, ".netrc"), "FAKE-NETRC"],
      [join(home, "closed", weird, "f.txt"), "FAKE-CLOSED"],
      [join(work, ".env"), "FAKE-ENV"],
      [join(work, "link"), "FAKE-SSH"],
    ] as const) {
      const result = sandboxed(edit, ["cat", path]);
      expect(result.code, path).not.toBe(0);
      expect(result.out, path).not.toContain(secret);
    }
    expect(sandboxed(edit, ["ls", join(home, ".ssh")]).code).not.toBe(0);
  });

  it("lets a read-only step write nothing, and an editing step write the working folder only", () => {
    expect(sandboxed(false, ["sh", "-c", "echo x > w.txt"]).code).not.toBe(0);
    expect(sandboxed(true, ["sh", "-c", "echo x > w.txt && echo done"])).toMatchObject({ code: 0, out: expect.stringContaining("done") });
    expect(sandboxed(true, ["sh", "-c", `echo x > ${join(home, "outside.txt")}`]).code).not.toBe(0);
    expect(sandboxed(true, ["sh", "-c", "echo x > /tmp/tokama-real-codex-probe"]).code).not.toBe(0);
  });

  it("gives commands no network", () => {
    const result = sandboxed(true, ["curl", "-sS", "-m", "8", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"]);
    expect(result.code).not.toBe(0);
    expect(result.out).not.toContain("200");
  });
});
