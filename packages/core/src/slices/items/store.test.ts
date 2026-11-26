import * as nodeFs from "node:fs";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { manualClock } from "../../kernel/clock/index.js";
import { HostIdSchema, ItemIdSchema, parseTemplateRecord, type ItemId, type RepoId, type StoredItem } from "../../kernel/schemas/index.js";
import { readLog, type LogFs } from "./log.js";
import { EVENTS_FILE, ItemStore, loadHostId, templateSnapshot } from "./store.js";
import { BUILD, HOST, OTHER_HOST, T0, TEMPLATE } from "./testing/events.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokama-items-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const input = { template: TEMPLATE, title: "Fix the checkout timeout", text: "Times out", repoIds: ["orders-api" as RepoId] };

function openStore(options: { fs?: LogFs; hostId?: typeof HOST } = {}) {
  return ItemStore.open({ home, hostId: options.hostId ?? HOST, clock: manualClock(T0), ...(options.fs && { fs: options.fs }) });
}

function createItem(store: ItemStore): StoredItem {
  const created = store.create(input);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

const logFile = (id: ItemId) => join(home, "items", id, EVENTS_FILE);

describe("ItemStore", () => {
  it("creates an item with a UUIDv7 id, a private folder and a 0600 log", () => {
    const { store } = openStore();
    const item = createItem(store);
    expect(item.id).toMatch(/^item_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // UUIDv7: the first 48 bits are the creation time.
    expect(Number.parseInt(item.id.slice(5, 13) + item.id.slice(14, 18), 16)).toBe(T0);
    expect(statSync(join(home, "items")).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "items", item.id)).mode & 0o777).toBe(0o700);
    expect(statSync(logFile(item.id)).mode & 0o777).toBe(0o600);
    expect(item.template).toEqual(templateSnapshot(TEMPLATE));
    expect(store.itemDir(item.id)).toBe(join(home, "items", item.id));
  });

  it("reads a stored version 1 template record as version 2 and leaves the stored copy and its hash alone", () => {
    const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "kernel", "schemas", "testing", "fixtures", "template-snapshot-v1.json"), "utf8")) as { sha256: string; record: Record<string, unknown> };
    const parsed = parseTemplateRecord(fixture.record);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
    expect(parsed.value).toEqual({ ...fixture.record, schemaVersion: 2 });
    // The log keeps the JSON as it was written: its hash is the one the item recorded.
    expect(templateSnapshot(fixture.record as never).sha256).toBe(fixture.sha256);
    expect(fixture.record["schemaVersion"]).toBe(1);
  });

  it("appends events without rewriting earlier lines, and reloads the same item from the log", () => {
    const { store } = openStore();
    const item = createItem(store);
    const before = readFileSync(logFile(item.id), "utf8");
    const appended = store.append(item.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
    ]);
    expect(appended.ok).toBe(true);
    const after = readFileSync(logFile(item.id), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.split("\n").filter(Boolean)).toHaveLength(3);
    const lines = after.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => [line["seq"], line["hostId"], line["schemaVersion"], typeof line["at"]])).toEqual([
      [0, HOST, 1, "number"],
      [1, HOST, 1, "number"],
      [2, HOST, 1, "number"],
    ]);

    const { store: reopened, problems } = openStore();
    expect(problems).toEqual([]);
    expect(reopened.get(item.id)).toEqual(store.get(item.id));
  });

  it("refuses a batch that does not fit, and writes none of it", () => {
    const { store } = openStore();
    const item = createItem(store);
    const before = readFileSync(logFile(item.id), "utf8");
    const result = store.append(item.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 5 },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "rejected" } });
    expect(readFileSync(logFile(item.id), "utf8")).toBe(before);
    expect(store.get(item.id)?.lastSeq).toBe(0);
  });

  it("refuses an event the schema refuses, such as an absolute path", () => {
    const { store } = openStore();
    const item = createItem(store);
    for (const dir of ["/Users/someone/repo/.tokama/wt/x", "../outside", "~/wt", "C:\\wt"]) {
      const result = store.append(item.id, [{ type: "worktree_added", repoId: "orders-api" as RepoId, branch: "tokama/x", dir }]);
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_event" } });
    }
    expect(store.append(item.id, [{ type: "check_result", stepId: BUILD, attempt: 1, command: "x", exitCode: 0, passed: true, outputFile: "/tmp/out.log" }])).toMatchObject({
      ok: false,
      error: { code: "invalid_event" },
    });
  });

  it("refuses to write to an item another host owns", () => {
    const { store } = openStore({ hostId: OTHER_HOST });
    const item = createItem(store);
    const { store: mine } = openStore();
    expect(mine.append(item.id, [{ type: "step_started", stepId: BUILD }])).toMatchObject({ ok: false, error: { code: "other_host" } });
  });

  it("tolerates a last line cut short by a crash, and the next append cuts it off first", () => {
    const { store } = openStore();
    const item = createItem(store);
    store.append(item.id, [{ type: "step_started", stepId: BUILD }]);
    // A crash in the middle of writing the next event.
    appendFileSync(logFile(item.id), '{"schemaVersion":1,"itemId":"item_01');

    const read = readLog(logFile(item.id));
    expect(read.ok && read.value.tornTail).toBe(true);
    expect(read.ok && read.value.events).toHaveLength(2);

    const { store: reopened, problems } = openStore();
    expect(problems).toEqual([]);
    expect(reopened.get(item.id)?.lastSeq).toBe(1);
    expect(reopened.append(item.id, [{ type: "attempt_started", stepId: BUILD, attempt: 1 }]).ok).toBe(true);

    const again = readLog(logFile(item.id));
    expect(again.ok && again.value).toMatchObject({ tornTail: false });
    expect(again.ok && again.value.events.map((e) => e.type)).toEqual(["item_created", "step_started", "attempt_started"]);
  });

  it("cuts a torn tail with no complete line before it back to an empty file", () => {
    const { store } = openStore();
    const item = createItem(store);
    writeFileSync(logFile(item.id), '{"schemaVer');
    const read = readLog(logFile(item.id));
    expect(read.ok && read.value).toEqual({ events: [], tornTail: true });
  });

  it("reports a log with a broken complete line, leaves its item out, and loads the others", () => {
    const { store } = openStore();
    const broken = createItem(store);
    const good = createItem(store);
    appendFileSync(logFile(broken.id), "not json\n");
    const { store: reopened, problems } = openStore();
    expect(problems).toEqual([{ itemId: broken.id, message: expect.stringMatching(/line 2 is not JSON/) }]);
    expect(reopened.get(good.id)).toBeDefined();
    expect(reopened.get(broken.id)).toBeUndefined();
  });

  it("writes, fsyncs the log, then fsyncs the new folders, and only then tells listeners", () => {
    const calls: string[] = [];
    const recording: LogFs = {
      ...nodeFs,
      openSync: ((path: nodeFs.PathLike, ...rest: [never, never]) => {
        const fd = nodeFs.openSync(path, ...rest);
        names.set(fd, String(path).endsWith(EVENTS_FILE) ? "log" : String(path).endsWith("items") ? "items-dir" : "item-dir");
        return fd;
      }) as LogFs["openSync"],
      writeSync: ((fd: number, ...rest: [never]) => {
        calls.push(`write ${names.get(fd)}`);
        return nodeFs.writeSync(fd, ...rest);
      }) as LogFs["writeSync"],
      fsyncSync: (fd) => {
        calls.push(`fsync ${names.get(fd)}`);
        nodeFs.fsyncSync(fd);
      },
    };
    const names = new Map<number, string>();
    const { store } = openStore({ fs: recording });
    store.subscribe(() => calls.push("listener"));

    const item = createItem(store);
    expect(calls).toEqual(["write log", "fsync log", "fsync item-dir", "fsync items-dir", "listener"]);

    calls.length = 0;
    store.append(item.id, [{ type: "step_started", stepId: BUILD }]);
    expect(calls).toEqual(["write log", "fsync log", "listener"]);
  });

  it("stores no absolute paths, home folder or user name", () => {
    const { store } = openStore();
    const item = createItem(store);
    store.append(item.id, [
      { type: "worktree_added", repoId: "orders-api" as RepoId, branch: "tokama/0190a000", dir: ".tokama/wt/0190a000" },
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
      { type: "process_started", stepId: BUILD, attempt: 1, role: "agent", pid: 4242, bootTime: T0 - 1000 },
      { type: "check_result", stepId: BUILD, attempt: 1, command: "pnpm test", exitCode: 0, passed: true, outputFile: "checks/build-1.log" },
    ]);
    const forbidden = [home, tmpdir(), homedir(), `/${userInfo().username}`, `${userInfo().username}/`];
    for (const file of readdirSync(join(home, "items"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())) {
      const content = readFileSync(join(file.parentPath, file.name), "utf8");
      for (const value of forbidden) expect(content).not.toContain(value);
    }
  });
});

describe("ItemStore robustness", () => {
  it("tells listeners about the item reloaded after a failed write, so the index matches the log", () => {
    let failNext = false;
    const failing: LogFs = {
      ...nodeFs,
      // Writes the first event of the batch, then the disk fills up.
      writeSync: ((fd: number, data: Buffer, offset: number, length: number) => {
        if (!failNext) return nodeFs.writeSync(fd, data, offset, length);
        failNext = false;
        const firstLine = data.subarray(offset, offset + length).indexOf(0x0a) + 1;
        nodeFs.writeSync(fd, data, offset, firstLine);
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }) as LogFs["writeSync"],
    };
    const { store } = openStore({ fs: failing });
    const item = createItem(store);
    const heard: StoredItem[] = [];
    store.subscribe((changed) => heard.push(changed));
    failNext = true;
    const result = store.append(item.id, [
      { type: "step_started", stepId: BUILD },
      { type: "attempt_started", stepId: BUILD, attempt: 1 },
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "write_failed" } });
    // The first event is on disk; the store and its listeners both have it.
    expect(store.get(item.id)?.lastSeq).toBe(1);
    expect(heard.map((changed) => changed.lastSeq)).toEqual([1]);
    expect(openStore().store.get(item.id)).toEqual(store.get(item.id));
  });

  it("removes the folder of an item whose creation crashed before its first event, without a problem", () => {
    const { store } = openStore();
    createItem(store);
    const empty = join(home, "items", "item_0190a000-0000-7000-8000-0000000000e1");
    const torn = join(home, "items", "item_0190a000-0000-7000-8000-0000000000e2");
    nodeFs.mkdirSync(empty);
    nodeFs.mkdirSync(torn);
    writeFileSync(join(torn, EVENTS_FILE), '{"schemaVersion":1,"ite');
    const { store: reopened, problems } = openStore();
    expect(problems).toEqual([]);
    expect(reopened.list()).toHaveLength(1);
    expect(nodeFs.existsSync(empty)).toBe(false);
    expect(nodeFs.existsSync(torn)).toBe(false);
  });

  it("keeps a folder with other files even when its log has no event, and reports it", () => {
    const dir = join(home, "items", "item_0190a000-0000-7000-8000-0000000000e3");
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.md"), "keep me");
    const { problems } = openStore();
    expect(problems).toEqual([{ itemId: "item_0190a000-0000-7000-8000-0000000000e3", message: expect.stringMatching(/cannot read/) }]);
    expect(nodeFs.existsSync(join(dir, "notes.md"))).toBe(true);
  });

  it("reports an empty log that has another file beside it as an empty log", () => {
    const dir = join(home, "items", "item_0190a000-0000-7000-8000-0000000000e4");
    nodeFs.mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, EVENTS_FILE), "");
    writeFileSync(join(dir, ".DS_Store"), "x");
    const { problems } = openStore();
    expect(problems).toEqual([{ itemId: "item_0190a000-0000-7000-8000-0000000000e4", message: "the log is empty" }]);
  });

  it("reports a log that throws while it is parsed (deeply nested JSON) as a problem, and loads the others", () => {
    const { store } = openStore();
    const good = createItem(store);
    const bad = createItem(store);
    const line = readFileSync(logFile(bad.id), "utf8").replace('"record":{', `"record":{"deep":${"[".repeat(100_000)}${"]".repeat(100_000)},`);
    writeFileSync(logFile(bad.id), line);
    const { store: reopened, problems } = openStore();
    expect(problems).toEqual([{ itemId: bad.id, message: expect.stringMatching(/RangeError/) }]);
    expect(reopened.get(good.id)).toBeDefined();
  });
});

describe("loadHostId", () => {
  it("makes a host id once, keeps it in a 0600 file, and returns the same id afterwards", () => {
    const first = loadHostId(home, manualClock(T0));
    expect(first.ok && HostIdSchema.safeParse(first.value).success).toBe(true);
    expect(statSync(join(home, "host.json")).mode & 0o777).toBe(0o600);
    expect(loadHostId(home)).toEqual(first);
  });

  it("does not replace a host file it cannot read", () => {
    writeFileSync(join(home, "host.json"), "{}");
    expect(loadHostId(home)).toMatchObject({ ok: false });
    expect(readFileSync(join(home, "host.json"), "utf8")).toBe("{}");
  });
});

it("ignores entries in the items folder that are not item folders", () => {
  const { store } = openStore();
  createItem(store);
  nodeFs.mkdirSync(join(home, "items", "not-an-item"));
  writeFileSync(join(home, "items", ".DS_Store"), "");
  const { store: reopened, problems } = openStore();
  expect(problems).toEqual([]);
  expect(reopened.list()).toHaveLength(1);
  expect(ItemIdSchema.safeParse(reopened.list()[0]?.id).success).toBe(true);
});

describe("templateSnapshot", () => {
  // Known vector: the full SHA-256 hex of the canonical JSON (keys sorted, undefined left out).
  // Stored items carry it, so the format must not change.
  it("is the SHA-256 hex of the record's canonical JSON", () => {
    const record = { steps: [{ id: "s1" }], name: "Fix", id: "t1", gone: undefined } as unknown as Parameters<typeof templateSnapshot>[0];
    expect(templateSnapshot(record).sha256).toBe("b424242a8e77a9e2ba7f5c96043af1ec603ff596bf9bfde6534934189df73f1d");
  });
});
