// openai.svg = OAI_OpenAI-Blossom_White.svg from https://cdn.openai.com/brand/openai-logos.zip (https://openai.com/brand/), checked 2026-11-26.
// claude-code.svg = "Claude Spark - Clay.svg" from the Anthropic press kit https://www.anthropic.com/press-kit (https://www.anthropic.com/news), checked 2026-11-26.
// The one place that names the AI CLIs Tokama runs and holds their official icons, so removing or
// swapping an icon is a change in this folder. The SVGs are the publishers' own files, unmodified,
// and they identify the tool that runs an agent; they are never Tokama's branding. A CLI without
// an icon (a local model) shows its neutral monogram.
import type { AiCliId } from "@tokama/core";
import claudeCodeUrl from "./claude-code.svg";
import openaiUrl from "./openai.svg";

export interface Backend {
  readonly name: string;
  /** The name for tight spots. */
  readonly shortName: string;
  /** Two letters shown where there is no icon. */
  readonly monogram: string;
  readonly iconUrl: string | undefined;
  /** How much larger than its slot the icon box is drawn, because some files keep wide clear space around the mark. */
  readonly iconScale: number;
}

const BACKENDS: Readonly<Record<AiCliId, Backend>> = {
  "claude-code": { name: "Claude Code", shortName: "Claude Code", monogram: "CC", iconUrl: claudeCodeUrl, iconScale: 1 },
  "codex-cli": { name: "Codex CLI", shortName: "Codex", monogram: "CX", iconUrl: openaiUrl, iconScale: 1.5 },
  ollama: { name: "Ollama", shortName: "Ollama", monogram: "OL", iconUrl: undefined, iconScale: 1 },
};

export const BACKEND_IDS = Object.keys(BACKENDS) as readonly AiCliId[];

export const backendOf = (cliId: AiCliId): Backend => BACKENDS[cliId];
