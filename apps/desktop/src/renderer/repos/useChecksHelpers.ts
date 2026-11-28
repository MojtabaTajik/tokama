// The two helpers under the Checks field of the repo dialog: Suggest with AI (a helper run) and
// Try checks (a check trial). Both start with a command that answers with an id, then report
// through events; an event can come before the reply is read, so it is kept until the id is
// known. A run that ends without an event the window saw is found by a slow poll, and a run the
// engine no longer knows (it restarted) ends the line instead of leaving it running. Nothing here
// is saved with the repo, and closing the dialog stops what runs.
import type { AiCliId, CheckTrial, HelperRun, HelperSummary, SuggestChecksResult } from "@tokama/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { type Availability, availability, checkLines, type Failure, failureOf, setupText, tryProblem } from "./checks-model.js";

/** How often a running run or trial is asked for, in case its end was not heard. */
export const POLL_MS = 5_000;

export type SuggestState =
  | { readonly kind: "idle" }
  /** The first send to a cloud AI tool: the note that asks. */
  | { readonly kind: "consent" }
  | { readonly kind: "running"; readonly since: number; readonly phase: HelperRun["phase"] }
  | { readonly kind: "answer"; readonly id: string; readonly result: SuggestChecksResult }
  | { readonly kind: "failed"; readonly failure: Failure }
  | { readonly kind: "stopped" };

export type TrialState =
  | { readonly kind: "idle" }
  /** `trial` is absent until the engine's first update; the lines and the setup command are what was asked. */
  | { readonly kind: "running"; readonly lines: readonly string[]; readonly setup: string; readonly trial: CheckTrial | undefined }
  | { readonly kind: "ended"; readonly trial: CheckTrial }
  | { readonly kind: "error"; readonly message: string };

export interface ChecksHelpersArgs {
  readonly bridge: TokamaBridge;
  /** The repo folder as the engine can open it; absent: no helper can run. */
  readonly path: string | undefined;
  readonly baseBranch: string;
  /** The Checks field's text. */
  readonly checks: string;
  /** The Setup command field's text; empty when none. */
  readonly setup: string;
  /** Try checks needs a commit. */
  readonly canTry: boolean;
}

export interface ChecksHelpers {
  readonly summary: HelperSummary | undefined;
  /** Undefined while the `helpers` query has not answered; its absence in the list is `undefined` too, so `loaded` tells them apart. */
  readonly availability: Availability | undefined;
  readonly loaded: boolean;
  readonly suggest: SuggestState;
  readonly trial: TrialState;
  readonly canTry: boolean;
  /** Try checks has a setup command or a check to run. */
  readonly hasWork: boolean;
  /** Why Try checks is off for the lines in the field, or undefined. */
  readonly tryProblem: string | undefined;
  readonly startSuggest: () => void;
  readonly agree: () => void;
  readonly notNow: () => void;
  readonly stopSuggest: () => void;
  readonly startTrial: () => void;
  readonly stopTrial: () => void;
  readonly dismissTrial: () => void;
}

const gone = (code: string) => code === "not_found";

/** The tools of every list, each once, in the order first seen. */
const mergeTools = (...lists: ReadonlyArray<readonly AiCliId[]>): AiCliId[] => [...new Set(lists.flat())];

export function useChecksHelpers({ bridge, path, baseBranch, checks, setup: setupField, canTry }: ChecksHelpersArgs): ChecksHelpers {
  const setup = setupText(setupField);
  const [summary, setSummary] = useState<HelperSummary | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  // The AI tools the user already agreed to send to, remembered by the app.
  const [consent, setConsent] = useState<readonly AiCliId[]>([]);
  const [suggest, setSuggest] = useState<SuggestState>({ kind: "idle" });
  const [trial, setTrial] = useState<TrialState>({ kind: "idle" });
  const runId = useRef<string | undefined>(undefined);
  const trialId = useRef<string | undefined>(undefined);
  // Updates heard before the reply that names their run or trial, one pair for each helper.
  const startingRun = useRef(false);
  const earlyRun = useRef(new Map<string, HelperRun>());
  const startingTrial = useRef(false);
  const earlyTrial = useRef(new Map<string, CheckTrial>());
  // The start that waits for its reply, and whether Stop was pressed since; and whether the dialog closed. Either one cancels the run or trial the moment its id is known.
  const pendingRun = useRef<{ stop: boolean } | undefined>(undefined);
  const pendingTrial = useRef<{ stop: boolean } | undefined>(undefined);
  const closed = useRef(false);
  const lines = checkLines(checks);

  useEffect(() => {
    let live = true;
    void bridge
      .query({ type: "helpers" })
      .then((reply) => {
        if (!live) return;
        if (reply.ok) setSummary(reply.data.helpers.find((helper) => helper.helperId === "suggest-checks"));
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    void bridge
      .getDesktopState()
      .then((state) => live && setConsent((now) => mergeTools(now, state.helperConsent ?? [])))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [bridge]);

  const applyRun = useCallback((run: HelperRun) => {
    if (run.state === "running") return setSuggest((now) => (now.kind === "running" ? { ...now, phase: run.phase } : now));
    runId.current = undefined;
    if (run.state === "done" && run.result !== undefined) setSuggest({ kind: "answer", id: run.runId, result: run.result.value });
    else if (run.state === "cancelled") setSuggest({ kind: "stopped" });
    else setSuggest({ kind: "failed", failure: failureOf(run.error ?? { code: "crash", message: "" }) });
  }, []);

  const applyTrial = useCallback((next: CheckTrial) => {
    if (next.state === "running") return setTrial((now) => (now.kind === "running" ? { ...now, trial: next } : now));
    trialId.current = undefined;
    // A setup that did not pass is a result with its own line, not an error of the trial.
    if (next.state === "failed" && next.error?.code !== "setup_failed") setTrial({ kind: "error", message: next.error?.message ?? "The checks could not be tried." });
    else setTrial({ kind: "ended", trial: next });
  }, []);

  useEffect(
    () =>
      bridge.onEvent(({ event }) => {
        if (event.type === "helper_run_updated") {
          if (runId.current === event.run.runId) applyRun(event.run);
          else if (startingRun.current) earlyRun.current.set(event.run.runId, event.run);
        } else if (event.type === "check_trial_updated") {
          if (trialId.current === event.trial.trialId) applyTrial(event.trial);
          else if (startingTrial.current) earlyTrial.current.set(event.trial.trialId, event.trial);
        }
      }),
    [bridge, applyRun, applyTrial],
  );

  // A run or trial whose end was not heard: ask for it now and then.
  const suggesting = suggest.kind === "running";
  const trying = trial.kind === "running";
  useEffect(() => {
    if (!suggesting && !trying) return;
    const timer = setInterval(() => {
      const run = runId.current;
      if (run !== undefined) {
        void bridge
          .query({ type: "helper_run", runId: run })
          .then((reply) => {
            if (runId.current !== run) return;
            if (reply.ok) {
              if (reply.data.run.state !== "running") applyRun(reply.data.run);
            } else if (gone(reply.error.code)) {
              runId.current = undefined;
              setSuggest({ kind: "failed", failure: { head: "Stopped.", message: "The engine lost track of this run.", action: "retry" } });
            }
          })
          .catch(() => undefined);
      }
      const check = trialId.current;
      if (check !== undefined) {
        void bridge
          .query({ type: "check_trial", trialId: check })
          .then((reply) => {
            if (trialId.current !== check) return;
            if (reply.ok) {
              if (reply.data.trial.state !== "running") applyTrial(reply.data.trial);
            } else if (gone(reply.error.code)) {
              trialId.current = undefined;
              setTrial({ kind: "error", message: "The engine lost track of this run. Nothing was kept from it." });
            }
          })
          .catch(() => undefined);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [bridge, suggesting, trying, applyRun, applyTrial]);

  // Closing the dialog stops what runs.
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      if (runId.current !== undefined) void bridge.command({ type: "cancel_helper", runId: runId.current }).catch(() => undefined);
      if (trialId.current !== undefined) void bridge.command({ type: "cancel_check_trial", trialId: trialId.current }).catch(() => undefined);
    };
  }, [bridge]);

  const send = async () => {
    if (path === undefined) return;
    const cloud = summary?.agent?.runsOn === "cloud";
    setSuggest({ kind: "running", since: Date.now(), phase: "gathering" });
    startingRun.current = true;
    const mine = { stop: false };
    pendingRun.current = mine;
    earlyRun.current.clear();
    const reply = await bridge
      .command({ type: "run_helper", run: { helperId: "suggest-checks", input: { path } }, ...(cloud ? { cloud: "accepted" as const } : {}) })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    startingRun.current = false;
    if (pendingRun.current === mine) pendingRun.current = undefined;
    // Stop already ended the line, and a closed dialog has none: either way only the run itself is left to cancel.
    const gone = closed.current || mine.stop;
    if (!reply.ok) return gone ? undefined : setSuggest({ kind: "failed", failure: failureOf(reply.error) });
    if (gone) return void bridge.command({ type: "cancel_helper", runId: reply.data.runId }).catch(() => undefined);
    runId.current = reply.data.runId;
    const heard = earlyRun.current.get(reply.data.runId);
    if (heard !== undefined) applyRun(heard);
    earlyRun.current.clear();
  };

  const agree = () => {
    const tool = summary?.agent?.cliId;
    if (tool !== undefined && !consent.includes(tool)) {
      // Merged with what the app has stored now, so a list that had not loaded yet loses no tool.
      void bridge
        .getDesktopState()
        .catch(() => undefined)
        .then((state) => {
          const next = mergeTools(state?.helperConsent ?? [], consent, [tool]);
          setConsent(next);
          return bridge.saveLayout({ helperConsent: next });
        })
        .catch(() => undefined);
    }
    void send();
  };

  const startTrial = async () => {
    if (path === undefined || (lines.length === 0 && setup === "")) return;
    const asked = lines;
    setTrial({ kind: "running", lines: asked, setup, trial: undefined });
    startingTrial.current = true;
    const mine = { stop: false };
    pendingTrial.current = mine;
    earlyTrial.current.clear();
    const minutes = new Map(suggest.kind === "answer" ? suggest.result.checks.map((check) => [check.command, check.minutes] as const) : []);
    const reply = await bridge
      .command({
        type: "try_checks",
        path,
        ...(baseBranch.trim() === "" ? {} : { baseBranch: baseBranch.trim() }),
        checks: asked.map((command) => ({ command, ...(minutes.has(command) ? { minutes: minutes.get(command)! } : {}) })),
        ...(setup === "" ? {} : { setup }),
      })
      .catch((cause: unknown) => ({ ok: false as const, error: { code: "bridge_error", message: String(cause) } }));
    startingTrial.current = false;
    if (pendingTrial.current === mine) pendingTrial.current = undefined;
    const gone = closed.current || mine.stop;
    if (!reply.ok) return gone ? undefined : setTrial({ kind: "error", message: reply.error.message });
    if (gone) return void bridge.command({ type: "cancel_check_trial", trialId: reply.data.trialId }).catch(() => undefined);
    trialId.current = reply.data.trialId;
    const heard = earlyTrial.current.get(reply.data.trialId);
    if (heard !== undefined) applyTrial(heard);
    earlyTrial.current.clear();
  };

  const tool = summary?.agent?.cliId;
  return {
    summary,
    availability: path === undefined ? undefined : availability(summary),
    loaded,
    suggest,
    trial,
    canTry: canTry && path !== undefined,
    hasWork: lines.length > 0 || setup !== "",
    tryProblem: tryProblem(lines, setup),
    startSuggest: () => {
      if (path === undefined) return;
      if (summary?.agent?.runsOn === "cloud" && (tool === undefined || !consent.includes(tool))) setSuggest({ kind: "consent" });
      else void send();
    },
    agree,
    notNow: () => setSuggest({ kind: "idle" }),
    stopSuggest: () => {
      if (runId.current !== undefined) void bridge.command({ type: "cancel_helper", runId: runId.current }).catch(() => undefined);
      else if (pendingRun.current !== undefined) {
        // No id yet: the line ends now, and the run is cancelled when the reply names it.
        pendingRun.current.stop = true;
        setSuggest({ kind: "stopped" });
      }
    },
    startTrial: () => void startTrial(),
    stopTrial: () => {
      if (trialId.current !== undefined) void bridge.command({ type: "cancel_check_trial", trialId: trialId.current }).catch(() => undefined);
      else if (pendingTrial.current !== undefined) {
        pendingTrial.current.stop = true;
        setTrial({ kind: "idle" });
      }
    },
    dismissTrial: () => setTrial({ kind: "idle" }),
  };
}
