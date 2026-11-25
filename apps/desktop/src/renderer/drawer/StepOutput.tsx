// What a step's agent wrote last in an attempt (the `step_output` query): in the drawer's
// approval card, collapsed under each attempt on the Steps tab, and as a short preview on the
// Needs you row. The text is shown with StepText, as React text only.
import type { StepOutputResult } from "@tokama/core";
import { useEffect, useState } from "react";
import type { TokamaBridge } from "../../shared/bridge.js";
import { StepText } from "./StepText.js";

const TEXT = {
  loading: "Loading the step's output",
  missing: "This attempt has no saved output.",
  failed: (message: string) => `Could not load the output: ${message}`,
  empty: "The agent wrote no final message.",
  truncated: "Showing the first 64 KiB. The rest is in the item's folder on this machine.",
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

/** The output in a focusable scroll box, so a long plan can be read with the keyboard. */
export function StepOutput({ state, label }: { readonly state: OutputState; readonly label: string }) {
  switch (state.kind) {
    case "loading":
      return <p className="placeholder">{TEXT.loading}</p>;
    case "missing":
      return <p className="step-output-none">{TEXT.missing}</p>;
    case "failed":
      return (
        <p className="drawer-error" role="alert">
          <span className="symbol" aria-hidden="true">
            ✕
          </span>
          {TEXT.failed(state.message)}
        </p>
      );
    case "loaded":
      if (state.output.text.trim() === "") return <p className="step-output-none">{TEXT.empty}</p>;
      return (
        <>
          <div className="step-output-text" tabIndex={0} role="region" aria-label={label}>
            <StepText text={state.output.text} />
          </div>
          {state.output.truncated && (
            <p className="step-output-cut">
              <span className="symbol" aria-hidden="true">
                !
              </span>
              {TEXT.truncated}
            </p>
          )}
        </>
      );
  }
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
