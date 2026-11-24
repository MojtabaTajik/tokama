// The Attention popup behind the rail's "!" button: health issues the engineer has to fix outside
// Tokama. A logged-out AI CLI shows the command to run in a terminal. Tokama only shows the
// command; it never signs in for the user. Everything is fixed app text or a CLI name.
import { type CliIssue, cliName, LOGIN_COMMANDS } from "../model.js";

const TEXT = {
  title: "Attention",
  none: "Nothing needs attention.",
  failure: "Failure",
  loggedOut: (cli: string) => `${cli} logged out`,
  effect: "Its steps cannot run until you sign in again.",
  howTo: "How to log in",
  run: "Run this in a terminal, then come back:",
} as const;

export interface AttentionPopupProps {
  readonly id: string;
  readonly issues: readonly CliIssue[];
}

export function AttentionPopup({ id, issues }: AttentionPopupProps) {
  return (
    <div role="dialog" id={id} aria-label={TEXT.title} className="attention-popup">
      <p className="attention-title">{issues.length > 0 ? `${TEXT.title} · ${issues.length}` : TEXT.title}</p>
      {issues.length === 0 ? (
        <p className="attention-none">{TEXT.none}</p>
      ) : (
        <ul className="attention-list">
          {issues.map((issue) => (
            <li key={`${issue.cliId}:${issue.kind}`} className="attention-item" data-cli={issue.cliId}>
              <span className="attention-kind">
                <span className="symbol" aria-hidden="true">
                  ✕
                </span>
                {TEXT.failure}
              </span>
              <span className="attention-what">{TEXT.loggedOut(cliName(issue.cliId))}</span>
              <span>{TEXT.effect}</span>
              <span className="attention-login">
                <span className="attention-howto">{TEXT.howTo}</span>
                <span className="label">{TEXT.run}</span>
                <code className="attention-command mono">{LOGIN_COMMANDS[issue.cliId]}</code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
