// What a step's agent wrote last in an attempt (the `step_output` query): in the drawer's
// approval card, collapsed under each attempt on the Steps tab, and as a short preview on the
// Needs you row. The text is shown with Markdown, as React text only.
import type { StepOutputResult } from "@tokama/core";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { Markdown } from "../ui/Markdown.js";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/status.js";
import { Placeholder } from "../ui/EmptyState.js";

const TEXT = {
  loading: "Loading the step's output",
  missing: "This attempt has no saved output.",
  failed: (message: string) => `Could not load the output: ${message}`,
  empty: "The agent wrote no final message.",
  truncated: "Showing the first 64 KiB. The rest is in the item's folder on this machine.",
  showFullPlan: "Show full plan",
  showFullOutput: "Show full output",
} as const;

export type OutputState =
  | { readonly kind: "loading" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "loaded"; readonly output: StepOutputResult };

const LOADING: OutputState = { kind: "loading" };

/**
 * A step attempt's output, asked for again when `key` changes (a new decision, another attempt).
 * The answer is kept with its key, so a newer question never shows an older attempt's text. No
 * query while `key` is undefined.
 */
export function useStepOutput(bridge: TokamaBridge, itemId: string, stepIndex: number, attempt: number | undefined, key: string | undefined): OutputState | undefined {
  const [answer, setAnswer] = useState<{ readonly for: string; readonly state: OutputState } | undefined>(undefined);
  const asked = key === undefined ? undefined : `${itemId} ${key}`;
  useEffect(() => {
    if (asked === undefined) return;
    let current = true;
    void bridge
      .query({ type: "step_output", itemId, stepIndex, ...(attempt !== undefined && { attempt }) })
      .then((reply) => {
        if (!current) return;
        const state: OutputState = reply.ok ? { kind: "loaded", output: reply.data } : reply.error.code === "not_found" ? { kind: "missing" } : { kind: "failed", message: reply.error.message };
        setAnswer({ for: asked, state });
      })
      .catch((cause: unknown) => {
        if (current) setAnswer({ for: asked, state: { kind: "failed", message: String(cause) } });
      });
    return () => {
      current = false;
    };
  }, [bridge, itemId, stepIndex, attempt, asked]);
  if (asked === undefined) return undefined;
  return answer?.for === asked ? answer.state : LOADING;
}

function Cut() {
  return (
    <p className="step-output-cut">
      <span className="symbol" aria-hidden="true">
        !
      </span>
      {TEXT.truncated}
    </p>
  );
}

/** The output in a focusable scroll box, so a long plan can be read with the keyboard. */
export function StepOutput({ state, label }: { readonly state: OutputState; readonly label: string }) {
  switch (state.kind) {
    case "loading":
      return <Placeholder>{TEXT.loading}</Placeholder>;
    case "missing":
      return <p className="step-output-none">{TEXT.missing}</p>;
    case "failed":
      return (
        <p className="inline-error" role="alert">
          <StatusMark status="failed" className="symbol" />
          {TEXT.failed(state.message)}
        </p>
      );
    case "loaded":
      if (state.output.text.trim() === "") return <p className="step-output-none">{TEXT.empty}</p>;
      return (
        <>
          <div className="step-output-text" tabIndex={0} role="region" aria-label={label}>
            <Markdown text={state.output.text} />
          </div>
          {state.output.truncated && <Cut />}
        </>
      );
  }
}

/**
 * The first lines of the output, faded where they are cut, for the approval card. When the whole
 * output fits it is shown as it is; when it does not, "Show full plan" (a Plan step) or "Show full output" goes to the place that has it all.
 */
export function StepPreview({ state, label, isPlan, onShowFull }: { readonly state: OutputState; readonly label: string; readonly isPlan: boolean; readonly onShowFull: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const loaded = state.kind === "loaded";
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const measure = () => setCut(element.scrollHeight > element.clientHeight + 1);
    measure();
    // The drawer can be dragged wider or narrower, which moves the line breaks.
    if (typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver(measure);
    watcher.observe(element);
    return () => watcher.disconnect();
  }, [state, loaded]);
  if (state.kind !== "loaded" || state.output.text.trim() === "") return <StepOutput state={state} label={label} />;
  return (
    <>
      <div ref={box} className="step-output-preview" data-cut={cut ? "true" : undefined} role="region" aria-label={label}>
        <Markdown text={state.output.text} />
      </div>
      {cut && (
        <Button variant="link" className="step-output-more" onClick={onShowFull}>
          {isPlan ? TEXT.showFullPlan : TEXT.showFullOutput}
        </Button>
      )}
      {state.output.truncated && <Cut />}
    </>
  );
}

/** The first lines of the output as plain words, without Markdown marks, for a preview. */
export function previewOf(text: string, lines = 3): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("```"))
    .slice(0, lines)
    .map((line) => line.replace(/^(?:#{1,6}|[-*+]|\d{1,9}[.)])\s+/, ""))
    .join("\n");
}
