// One plan window as a meter: a bar whose fill is grey until the window is high, then takes the
// level's colour, with a symbol or a word beside it, never colour alone. `Meter` adds the window's
// name, percentage and a line under it (the rail tooltip); `MeterBar` is the bar alone (the Limits
// list on the Usage tab).
import type { ReactNode } from "react";
import { LEVEL_SPOKEN, LEVEL_TONE, LEVEL_WORD, levelOf } from "./usage-model.js";

export interface MeterBarProps {
  /** What the meter shows, for screen readers too, e.g. "Fable weekly window". */
  readonly name: string;
  readonly usedPercent: number;
}

export function MeterBar({ name, usedPercent }: MeterBarProps) {
  // The level follows the shown number, so "60%" never reads as ok.
  const shown = Math.round(usedPercent);
  const level = levelOf(shown);
  return (
    <svg className="meter" width="100%" height="6" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, shown)} aria-valuetext={`${shown}%, ${LEVEL_SPOKEN[level]}`}>
      <rect className="meter-track" width="100%" height="6" rx="3" />
      {usedPercent > 0 && <rect className="meter-fill" data-tone={LEVEL_TONE[level]} width={`${Math.min(100, Math.max(1, usedPercent))}%`} height="6" rx="3" />}
    </svg>
  );
}

export interface MeterProps extends MeterBarProps {
  /** The visible label; default: `name`. */
  readonly label?: ReactNode;
  /** The line under the bar. */
  readonly children?: ReactNode;
}

export function Meter({ name, label = name, usedPercent, children }: MeterProps) {
  const shown = Math.round(usedPercent);
  const level = levelOf(shown);
  const word = LEVEL_WORD[level];
  return (
    <div className="ins-window">
      <div className="ins-window-head">
        <span className="ins-window-name">{label}</span>
        {word !== undefined && (
          <span className="ins-tone" data-tone={LEVEL_TONE[level]}>
            {word}
          </span>
        )}
        <span className="mono ins-pct">{shown}%</span>
      </div>
      <MeterBar name={name} usedPercent={usedPercent} />
      {children !== undefined && <p className="muted ins-reset">{children}</p>}
    </div>
  );
}
