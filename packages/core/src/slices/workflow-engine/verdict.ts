// The reviewer's verdict: the last non-empty line of its last message must be exactly
// `VERDICT: approve` or `VERDICT: changes`. Anything else is no verdict, which the run loop treats
// as a run failure: a reviewer that cannot follow the format has not reviewed.

export type Verdict = "approve" | "changes";

/** Added to a `reviewer approves` step's instructions. */
export const VERDICT_RULE = `

End your reply with one line that is exactly \`VERDICT: approve\` if the change is ready, or exactly \`VERDICT: changes\` if it needs changes. Put the changes you ask for above that line.`;

const LINE = /^VERDICT: (approve|changes)$/;
// A reviewer that writes its headline block below the verdict line has still given its verdict.
const BLOCK_LINE = /^(?:HEADLINE|POINT|READ):/;

export function parseVerdict(lastMessage: string): Verdict | undefined {
  const lines = lastMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  while (lines.length > 0 && BLOCK_LINE.test(lines.at(-1)!)) lines.pop();
  const last = lines.at(-1);
  const match = last === undefined ? null : LINE.exec(last);
  return match === null ? undefined : (match[1] as Verdict);
}
