import type { StopResult } from "@tokama/client";
import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../../shared/update.js";
import { createUpdateController } from "./controller.js";
import { createInstaller, INSTALLER_MS, type InstallDeps } from "./install.js";
import type { FeedInfo, UpdateEngine } from "./port.js";
import { createQuitHandler } from "./quit.js";
import { next } from "./state.js";

/** The install's collaborators, as fakes that write their calls into one list. */
function setup(options: { state?: UpdateState; running?: number | undefined; stop?: StopResult | "throws"; quitThrows?: boolean; engineId?: string | undefined; countedApi?: number } = {}) {
  const calls: string[] = [];
  let state: UpdateState = options.state ?? { status: "ready", version: "0.2.0" };
  let installError: (() => void) | undefined;
  let timer: (() => void) | undefined;
  let timerMs: number | undefined;
  const reported: string[] = [];
  const deps: InstallDeps = {
    state: () => state,
    dispatch: (event) => {
      state = next(state, event);
      calls.push(`state:${state.status}`);
    },
    runningNow: async () => {
      calls.push("running");
      return { items: "running" in options ? options.running : 0, ...(options.countedApi !== undefined && { apiVersion: options.countedApi }) };
    },
    suspendWatch: async () => {
      calls.push("suspend");
      return options.engineId === undefined && "engineId" in options ? {} : { engineId: options.engineId ?? "engine-1", engine: { apiVersion: 15, runningItems: 0 } };
    },
    resumeWatch: () => calls.push("resume"),
    stopEngine: async ({ engineId, engine }) => {
      calls.push(`stop:${engineId ?? "-"}:${engine?.apiVersion ?? "-"}`);
      if (options.stop === "throws") throw new Error("no");
      return options.stop ?? { kind: "stopped", forced: false };
    },
    quitAndInstall: (relaunch) => {
      calls.push(`quitAndInstall:${relaunch}`);
      if (options.quitThrows === true) throw new Error("no");
    },
    quitApp: () => calls.push("quitApp"),
    watchInstallError: (listener) => {
      installError = listener;
      return () => void (installError = undefined);
    },
    reportFailure: () => reported.push("update_install_failed"),
    now: () => 7,
    after: (ms, fn) => {
      timerMs = ms;
      timer = fn;
      return () => void (timer = undefined);
    },
  };
  return { deps, calls, reported, state: () => state, failInstaller: () => installError?.(), timeOut: () => timer?.(), timerMs: () => timerMs };
}

describe("the install", () => {
  it("does nothing unless the update is ready", async () => {
    for (const state of [{ status: "idle" }, { status: "checking" }, { status: "installing", version: "0.2.0" }] as const) {
      const { deps, calls } = setup({ state });
      expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: false, reason: "not_ready" });
      expect(calls).toEqual([]);
    }
  });

  it("refuses while items run, and changes nothing", async () => {
    const { deps, calls, state } = setup({ running: 2 });
    expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: false, reason: "busy", running: 2 });
    expect(calls).toEqual(["running"]);
    expect(state().status).toBe("ready");
  });

  it("refuses when the engine does not say how many items run", async () => {
    const { deps, calls } = setup({ running: undefined });
    expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: false, reason: "busy" });
    expect(calls).toEqual(["running"]);
  });

  it("stops the engine it was connected to, then hands over, in that order", async () => {
    const { deps, calls, state } = setup();
    expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: true });
    expect(calls).toEqual(["running", "state:installing", "suspend", "stop:engine-1:15", "quitAndInstall:true"]);
    expect(state().status).toBe("installing");
  });

  it("hands over after an engine that another app replaced, or that was killed", async () => {
    for (const stop of [{ kind: "replaced" }, { kind: "stopped", forced: true }] as const) {
      const { deps, calls } = setup({ stop });
      expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: true });
      expect(calls.at(-1)).toBe("quitAndInstall:true");
    }
  });

  it("passes relaunch false on to the installer", async () => {
    const { deps, calls } = setup();
    await createInstaller(deps)({ relaunch: false });
    expect(calls.at(-1)).toBe("quitAndInstall:false");
  });

  it("puts everything back and hands nothing over when the engine refuses because an item started meanwhile", async () => {
    for (const refused of [{ kind: "refused", runningItems: 1 }, { kind: "refused" }] as const) {
      const { deps, calls, state } = setup({ running: 0, stop: refused });
      expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: false, reason: "busy", ...("runningItems" in refused && { running: refused.runningItems }) });
      expect(calls).toEqual(["running", "state:installing", "suspend", "stop:engine-1:15", "resume", "state:ready"]);
      expect(state()).toEqual({ status: "ready", version: "0.2.0" });
    }
  });

  it("takes the engine's API version from the count when the watch had no client, so the stop knows whether ifIdle is understood", async () => {
    const { deps, calls } = setup({ engineId: undefined, countedApi: 14 });
    await createInstaller(deps)({ relaunch: true });
    expect(calls).toContain("stop:-:14");
  });

  it("stops without an engine id when the connection had none", async () => {
    const { deps, calls } = setup({ engineId: undefined });
    await createInstaller(deps)({ relaunch: true });
    expect(calls).toContain("stop:-:-");
  });

  it("puts the engine back and shows the error when it cannot stop it", async () => {
    for (const stop of [{ kind: "still_running", pid: 4821 }, "throws"] as const) {
      const { deps, calls, state, reported } = setup({ stop });
      expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: false, reason: "failed" });
      expect(calls).toEqual(["running", "state:installing", "suspend", "stop:engine-1:15", "resume", "state:error"]);
      expect(calls).not.toContain("quitAndInstall:true");
      expect(state()).toEqual({ status: "error", stage: "install", at: 7, version: "0.2.0" });
      expect(reported).toEqual(["update_install_failed"]);
    }
  });

  it("stalls, and puts nothing back, when the installer throws at once: it may be armed already", async () => {
    const { deps, calls, state, reported } = setup({ quitThrows: true });
    expect(await createInstaller(deps)({ relaunch: true })).toEqual({ ok: false, reason: "failed" });
    expect(calls).not.toContain("resume");
    expect(state()).toEqual({ status: "stalled", version: "0.2.0" });
    expect(reported).toEqual(["update_install_failed"]);
  });

  it("stalls, and puts nothing back, when the installer refuses after the hand-over, and tells the caller once", async () => {
    const { deps, calls, state, reported, failInstaller } = setup();
    const onFailed = vi.fn();
    expect(await createInstaller(deps)({ relaunch: true, onFailed })).toEqual({ ok: true });
    failInstaller();
    failInstaller();
    expect(calls).not.toContain("resume");
    expect(state()).toEqual({ status: "stalled", version: "0.2.0" });
    expect(reported).toEqual(["update_install_failed"]);
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it("puts nothing back when the installer is only silent: a late swap must not land under a running engine", async () => {
    const { deps, calls, state, reported, timeOut, timerMs } = setup();
    const onSilent = vi.fn();
    const onFailed = vi.fn();
    await createInstaller(deps)({ relaunch: false, onSilent, onFailed });
    expect(timerMs()).toBe(INSTALLER_MS);
    timeOut();
    expect(onSilent).toHaveBeenCalledOnce();
    expect(onFailed).not.toHaveBeenCalled();
    expect(calls).not.toContain("resume");
    expect(state()).toEqual({ status: "stalled", version: "0.2.0" });
    expect(reported).toEqual([]);
  });

  it("only quits the app from the stalled state: the installer is never asked a second time, and nothing is counted, stopped or started", async () => {
    const { deps, calls, state, timeOut } = setup();
    const install = createInstaller(deps);
    await install({ relaunch: true });
    timeOut();
    expect(state().status).toBe("stalled");
    const before = calls.length;
    expect(await install({ relaunch: true })).toEqual({ ok: true });
    expect(await install({ relaunch: true })).toEqual({ ok: true });
    expect(calls.slice(before)).toEqual(["quitApp", "quitApp"]);
    expect(calls.filter((call) => call.startsWith("quitAndInstall"))).toEqual(["quitAndInstall:true"]);
    expect(calls).not.toContain("resume");
  });

  it("does not put the engine back when a refusal comes after the silence either", async () => {
    const { deps, calls, state, reported, timeOut, failInstaller } = setup();
    const onFailed = vi.fn();
    await createInstaller(deps)({ relaunch: true, onFailed });
    timeOut();
    failInstaller();
    expect(calls).not.toContain("resume");
    expect(state()).toEqual({ status: "stalled", version: "0.2.0" });
    expect(reported).toEqual(["update_install_failed"]);
    expect(onFailed).toHaveBeenCalledOnce();
  });

  it("does not run two installs at once", async () => {
    const { deps } = setup();
    const install = createInstaller(deps);
    const first = install({ relaunch: true });
    expect(await install({ relaunch: true })).toEqual({ ok: false, reason: "not_ready" });
    expect(await first).toEqual({ ok: true });
  });
});

describe("the quit", () => {
  function quitSetup(options: Parameters<typeof setup>[0] = {}) {
    const base = setup(options);
    const install = createInstaller(base.deps);
    const events: string[] = [];
    const handler = createQuitHandler({
      state: base.state,
      install,
      quit: () => events.push("quit"),
      teardown: () => events.push("teardown"),
    });
    const press = () => {
      const event = { preventDefault: vi.fn() };
      handler(event);
      return event;
    };
    return { ...base, events, press };
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("holds the first quit back, installs without relaunching, and tears down only on the installer's own quit", async () => {
    const { press, events, calls } = quitSetup();
    expect(press().preventDefault).toHaveBeenCalledOnce();
    await flush();
    expect(calls.at(-1)).toBe("quitAndInstall:false");
    expect(events).toEqual([]);
    // The installer quits the app: the second pass is not held back.
    expect(press().preventDefault).not.toHaveBeenCalled();
    expect(events).toEqual(["teardown"]);
  });

  it("quits without installing while items run", async () => {
    const { press, events, calls } = quitSetup({ running: 1 });
    expect(press().preventDefault).toHaveBeenCalledOnce();
    await flush();
    expect(calls).toEqual(["running"]);
    expect(events).toEqual(["quit"]);
    expect(press().preventDefault).not.toHaveBeenCalled();
    expect(events).toEqual(["quit", "teardown"]);
  });

  it("quits without installing when the engine cannot be stopped", async () => {
    const { press, events, calls } = quitSetup({ stop: { kind: "still_running" } });
    press();
    await flush();
    expect(calls).toContain("resume");
    expect(events).toEqual(["quit"]);
  });

  it("quits without installing when the installer fails or times out, once", async () => {
    const { press, events, failInstaller, timeOut } = quitSetup();
    press();
    await flush();
    failInstaller();
    timeOut();
    expect(events).toEqual(["quit"]);
  });

  it("quits after a silent installer, with the engine still stopped and nothing put back", async () => {
    const { press, events, calls, timeOut } = quitSetup();
    press();
    await flush();
    timeOut();
    expect(events).toEqual(["quit"]);
    expect(calls).not.toContain("resume");
    expect(press().preventDefault).not.toHaveBeenCalled();
    expect(events).toEqual(["quit", "teardown"]);
  });

  it("tears down at once when no update is ready", () => {
    const { press, events } = quitSetup({ state: { status: "idle" } });
    expect(press().preventDefault).not.toHaveBeenCalled();
    expect(events).toEqual(["teardown"]);
  });

  it("tears down at once while an install from a click runs", () => {
    const { press, events } = quitSetup({ state: { status: "installing", version: "0.2.0" } });
    expect(press().preventDefault).not.toHaveBeenCalled();
    expect(events).toEqual(["teardown"]);
  });
});

describe("the controller", () => {
  function controllerSetup(check: () => Promise<{ available: boolean }>) {
    const listeners: { available?: (info: FeedInfo) => void; downloaded?: (info: FeedInfo) => void; progress?: (p: { percent: number; transferred: number; total: number }) => void; error?: (error: Error) => void } = {};
    const engine: UpdateEngine = {
      check,
      onAvailable: (listener) => void (listeners.available = listener),
      onProgress: (listener) => void (listeners.progress = listener),
      onDownloaded: (listener) => void (listeners.downloaded = listener),
      onError: (listener) => void (listeners.error = listener),
      quitAndInstall: () => undefined,
    };
    const states: UpdateState[] = [];
    const reports: string[] = [];
    const controller = createUpdateController({ engine, initial: { status: "idle" }, now: () => 100, appVersion: "0.1.0", onChange: (s) => states.push(s), report: (code) => reports.push(code) });
    return { controller, listeners, states, reports };
  }

  it("follows a check that finds nothing", async () => {
    const { controller, states } = controllerSetup(async () => ({ available: false }));
    await controller.check();
    expect(states).toEqual([{ status: "checking" }, { status: "idle", checkedAt: 100 }]);
  });

  it("follows a check, a download and a ready update with the important flag", async () => {
    const { controller, listeners } = controllerSetup(async () => {
      listeners.available?.({ version: "0.2.2", minSafeVersion: "0.2.0" });
      listeners.progress?.({ percent: 50, transferred: 5, total: 10 });
      listeners.downloaded?.({ version: "0.2.2", minSafeVersion: "0.2.0" });
      return { available: true };
    });
    await controller.check();
    expect(controller.state()).toEqual({ status: "ready", version: "0.2.2", critical: { reason: "This update fixes a security problem." } });
  });

  it("is not important when the app is already at the minimum safe version, or the value is bad", async () => {
    for (const minSafeVersion of ["0.1.0", "0.0.9", "soon", 7]) {
      const { controller, listeners } = controllerSetup(async () => {
        listeners.available?.({ version: "0.2.2", minSafeVersion });
        listeners.downloaded?.({ version: "0.2.2", minSafeVersion });
        return { available: true };
      });
      await controller.check();
      expect(controller.state()).toEqual({ status: "ready", version: "0.2.2" });
    }
  });

  it("reports a failed feed once per run, with no text", async () => {
    const { controller, reports, states } = controllerSetup(async () => {
      throw new Error("https://updates.example.test/secret failed");
    });
    await controller.check();
    expect(controller.state()).toEqual({ status: "error", stage: "check", at: 100 });
    await controller.check();
    expect(reports).toEqual(["update_check_failed"]);
    expect(JSON.stringify(states)).not.toContain("secret");
  });

  it("names a failed download and keeps nothing ready", async () => {
    const { controller, listeners, reports } = controllerSetup(async () => {
      listeners.available?.({ version: "0.2.0" });
      return { available: true };
    });
    await controller.check();
    listeners.error?.(new Error("disk full"));
    expect(controller.state()).toMatchObject({ status: "error", stage: "download", version: "0.2.0" });
    expect(reports).toEqual(["update_download_failed"]);
  });

  it("does not check twice at once, and not while an update is ready", async () => {
    let release: () => void = () => undefined;
    const check = vi.fn(() => new Promise<{ available: boolean }>((resolve) => (release = () => resolve({ available: false }))));
    const { controller } = controllerSetup(check);
    const first = controller.check();
    void controller.check();
    expect(check).toHaveBeenCalledTimes(1);
    release();
    await first;
    const ready = controllerSetup(async () => ({ available: true }));
    ready.listeners.downloaded?.({ version: "0.2.0" });
    await ready.controller.check();
    ready.listeners.downloaded?.({ version: "0.2.0" });
    const before = ready.controller.state();
    await ready.controller.check();
    expect(ready.controller.state()).toBe(before);
  });

  it("sends an error during an install only to the install's listener", async () => {
    const { controller, listeners, reports } = controllerSetup(async () => ({ available: true }));
    listeners.downloaded?.({ version: "0.2.0" });
    controller.dispatch({ type: "install_started" });
    const heard = vi.fn();
    const stop = controller.watchInstallError(heard);
    listeners.error?.(new Error("signature"));
    expect(heard).toHaveBeenCalledOnce();
    expect(controller.state().status).toBe("installing");
    expect(reports).toEqual([]);
    stop();
  });
});
