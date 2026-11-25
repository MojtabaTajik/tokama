// The one place that names the AI CLIs Tokama runs and holds their official icons, so removing or
// swapping an icon is a change in this folder. The SVGs are the publishers' own files, unmodified,
// and they identify the tool that runs an agent; they are never Tokama's branding. A CLI without
// an icon (a local model) shows its neutral monogram.
import type { AiCliId } from "@tokama/core";
import claudeCodeUrl from "./claude-code.svg";
import openaiUrl from "./openai.svg";

export interface Backend {
  readonly name: string;
  /** Two letters shown where there is no icon. */
  readonly monogram: string;
  readonly iconUrl: string | undefined;
}

const BACKENDS: Readonly<Record<AiCliId, Backend>> = {
  "claude-code": { name: "Claude Code", monogram: "CC", iconUrl: claudeCodeUrl },
  "codex-cli": { name: "Codex CLI", monogram: "CX", iconUrl: openaiUrl },
  ollama: { name: "Ollama", monogram: "OL", iconUrl: undefined },
};

export const backendOf = (cliId: AiCliId): Backend => BACKENDS[cliId];
