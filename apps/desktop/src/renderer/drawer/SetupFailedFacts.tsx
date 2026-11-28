// What a failed setup command says on the decision card: which command ran, how it ended, the
// last line it printed, that the checks did not run (they did not fail), and that the change is
// still in the worktree. Everything from the engine is rendered as React text only; the command
// is shown whole and wraps.
import type { Decision } from "@tokama/core";
import { formatDuration } from "../format/duration.js";
import { Button } from "../ui/Button.js";
import { StatusMark } from "../ui/status.js";

const TEXT = {
  label: "What the setup did",
  ran: "Setup ran",
  ended: "Ended",
  said: "It said",
  checks: "Checks",
  change: "The change",
  notRun: (count: number) => `– ${count} not run: they need the setup to pass first`,
  kept: "kept in the worktree, nothing committed",
  failed: (exit: number | undefined, ms: number) => `${exit === undefined ? "Failed" : `Failed, exit ${exit}`} · after ${formatDuration(ms)}`,
  timedOut: (ms: number) => `Timed out · after ${formatDuration(ms)}`,
  couldNotStart: "Could not start",
  seeOutput: "See the whole output →",
  edit: "Edit the setup command…",
} as const;

export interface SetupFailedFactsProps {
  readonly failed: NonNullable<Decision["setupFailed"]>;
  /** Shows the item's Checks tab, where the whole output is. Without it the link is left out. */
  readonly onSeeOutput: (() => void) | undefined;
  /** Opens Edit repo on the item's repo. Without it the link is left out. */
  readonly onEdit: (() => void) | undefined;
}

export function SetupFailedFacts({ failed, onSeeOutput, onEdit }: SetupFailedFactsProps) {
  const ended = failed.ended === "timed_out" ? TEXT.timedOut(failed.durationMs) : failed.ended === "could_not_start" ? TEXT.couldNotStart : TEXT.failed(failed.exitCode, failed.durationMs);
  return (
    <>
      <dl className="rc-facts" aria-label={TEXT.label}>
        <div className="rc-row">
          <dt>{TEXT.ran}</dt>
          <dd className="mono sf-command">{failed.command}</dd>
        </div>
        <div className="rc-row">
          <dt>{TEXT.ended}</dt>
          <dd>
            <StatusMark status="failed" /> {ended}
          </dd>
        </div>
        {failed.lastLine !== "" && (
          <div className="rc-row">
            <dt>{TEXT.said}</dt>
            <dd className="mono sf-command">{failed.lastLine}</dd>
          </div>
        )}
        {failed.when === "checks" && (
          <>
            <div className="rc-row">
              <dt>{TEXT.checks}</dt>
              <dd>{TEXT.notRun(failed.checksNotRun)}</dd>
            </div>
            <div className="rc-row">
              <dt>{TEXT.change}</dt>
              <dd>{TEXT.kept}</dd>
            </div>
          </>
        )}
      </dl>
      {(onSeeOutput !== undefined || onEdit !== undefined) && (
        <p className="sf-links">
          {onSeeOutput !== undefined && (
            <Button variant="link" onClick={onSeeOutput}>
              {TEXT.seeOutput}
            </Button>
          )}
          {onEdit !== undefined && (
            <Button variant="link" onClick={onEdit}>
              {TEXT.edit}
            </Button>
          )}
        </p>
      )}
    </>
  );
}
