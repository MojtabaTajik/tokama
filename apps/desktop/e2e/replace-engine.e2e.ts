// An older engine still running when the app starts, as after an update: a fake engine of the
// previous API version, a socket server in this test run whose lock names a harmless process. Idle,
// the app asks it to stop and replaces it by itself; busy, it shows the question. Nothing may ever
// signal the process the lock names: a stop is the shutdown request alone. Screenshots go to
// `<outDir>/screenshots`.
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { API_VERSION } from "@tokama/core";
import { afterEach, expect } from "vitest";
import { flow } from "./harness.js";

/** The app's sample engine dir in a test, as the harness sets it. */
const engineDir = (tmp: string) => join(tmp, "e", "sample");

interface FakeEngine {
  /** Items it reports on each hello; undefined: it does not say. */
  running: number | undefined;
  /** What it received first on each connection: `hello`, `shutdown`. */
  readonly messages: string[];
  /** The process its lock names. */
  readonly child: ChildProcess;
  readonly server: Server;
}

let fake: FakeEngine | undefined;

afterEach(() => {
  fake?.child.kill("SIGKILL");
  fake?.server.close();
  fake = undefined;
});

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * An engine of the previous API version in the app's engine dir: a 0700 dir, a token, a socket and
 * a lock `<pid> <id>`. Like an engine from before `ifIdle`, it answers a hello with an
 * unsupported_version refusal that says how many items it runs, and a shutdown request by
 * accepting it and going away.
 */
async function startFakeEngine(dir: string, running: number | undefined): Promise<FakeEngine> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "engine.token"), "fake-token\n", { mode: 0o600 });
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  const messages: string[] = [];
  const line = (message: object) => `${JSON.stringify(message)}\n`;
  const fakeEngine: FakeEngine = {
    running,
    messages,
    child,
    server: createServer((socket) => {
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const message = JSON.parse(buffer.slice(0, end)) as { kind?: string; apiVersion?: number; ifIdle?: boolean };
        messages.push(`${message.kind}${message.ifIdle === true ? " ifIdle" : ""}`);
        if (message.kind === "shutdown") {
          socket.end(line({ kind: "shutdown_accepted", apiVersion: API_VERSION - 1 }));
          for (const name of ["engine.lock", "engine.token"]) {
            try {
              unlinkSync(join(dir, name));
            } catch {
              // Already gone.
            }
          }
          fakeEngine.server.close();
          return;
        }
        socket.end(
          line({
            kind: "connection_error",
            apiVersion: API_VERSION - 1,
            code: "unsupported_version",
            message: `engine speaks API version ${API_VERSION - 1}, client sent ${message.apiVersion}`,
            ...(fakeEngine.running !== undefined && { runningItems: fakeEngine.running }),
          }),
        );
      });
    }),
  };
  await new Promise<void>((resolve) => fakeEngine.server.listen(join(dir, "engine.sock"), resolve));
  chmodSync(join(dir, "engine.sock"), 0o600);
  writeFileSync(join(dir, "engine.lock"), `${child.pid} old-${child.pid}\n`, { mode: 0o600 });
  return fakeEngine;
}

const seed = (running: number | undefined) => async (_home: string, tmp: string) => {
  fake = await startFakeEngine(engineDir(tmp), running);
};

const QUESTION = "An older Tokama engine is still running. Restart it?";

flow(
  "replaces an idle older engine by itself with a shutdown request, and connects to the new one",
  async ({ page, connection }) => {
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    await page.locator(".pl-row").first().waitFor();
    // The engine does not know ifIdle, so it got a plain shutdown, and no signal reached its process.
    expect(fake?.messages).toEqual(["hello", "shutdown"]);
    expect(alive(fake?.child.pid)).toBe(true);
  },
  "older",
  seed(0),
);

flow(
  "asks before it restarts a busy older engine; Try again keeps the question until nothing runs, then replaces it",
  async ({ page, connection, screenshot }) => {
    const failure = page.locator(".board .failure");
    await failure.getByText(QUESTION).waitFor();
    expect(await failure.getByRole("button").allInnerTexts()).toEqual(["Restart engine now", "Try again"]);
    expect(await failure.locator(".log").innerText()).toContain(`pid   ${fake?.child.pid}`);
    await screenshot("103-older-engine-busy");

    // Still busy: the question stays, and nothing was sent to stop it.
    await failure.getByRole("button", { name: "Try again" }).click();
    await failure.getByText(QUESTION).waitFor();
    expect(fake?.messages).not.toContain("shutdown");

    if (fake !== undefined) fake.running = 0;
    await failure.getByRole("button", { name: "Try again" }).click();
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    expect(fake?.messages.at(-1)).toBe("shutdown");
    expect(alive(fake?.child.pid)).toBe(true);
  },
  "older",
  seed(3),
);

flow(
  "restarts a busy older engine on Restart engine now, with a shutdown request alone",
  async ({ page, connection }) => {
    const failure = page.locator(".board .failure");
    await failure.getByText(QUESTION).waitFor();
    await failure.getByRole("button", { name: "Restart engine now" }).click();
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    expect(fake?.messages).toContain("shutdown");
    expect(alive(fake?.child.pid)).toBe(true);
  },
  "older",
  seed(3),
);

flow(
  "asks before it restarts an older engine that does not say whether it is busy",
  async ({ page, connection, screenshot }) => {
    const failure = page.locator(".board .failure");
    await failure.getByText(QUESTION).waitFor();
    expect(await failure.getByRole("button").allInnerTexts()).toEqual(["Restart engine now", "Try again"]);
    await screenshot("103-older-engine");
    await failure.getByRole("button", { name: "Restart engine now" }).click();
    await expect.poll(async () => (await connection()).status, { timeout: 30_000 }).toBe("connected");
    expect(alive(fake?.child.pid)).toBe(true);
  },
  "older",
  seed(undefined),
);
