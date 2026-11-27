// Which template New work suggests for the text being typed.
import { looksLikeQuestion, type TemplateRef } from "@tokama/core";

const ASK = "builtin/ask" as TemplateRef;

export interface Suggestion {
  readonly templateId: TemplateRef | null;
  readonly reason?: "question";
}

/** The only template that can start, when there is exactly one; else Ask for a question, when it can start; else none. */
export function suggestFrom(startable: readonly TemplateRef[], text: string): Suggestion {
  if (startable.length === 1) return { templateId: startable[0]! };
  if (startable.includes(ASK) && looksLikeQuestion(text)) return { templateId: ASK, reason: "question" };
  return { templateId: null };
}
