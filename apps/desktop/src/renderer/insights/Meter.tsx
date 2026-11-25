// One plan window as a meter: its name, the level's word or symbol, the percentage, a bar whose
// fill takes the level's colour, and a line under it (reset time, share, age). The Usage tab and
// the rail tooltip both use it.
import type { ReactNode } from "react";
import { LEVEL_SPOKEN, LEVEL_TONE, LEVEL_WORD, levelOf } from "./usage-model.js";

// The colour key: a square in each level's colour, beside its words. Not a status.
const SWATCH = "■"; // status-guard: not a status

export interface MeterProps {
  /** What the meter shows, for screen readers too, e.g. "Fable weekly window". */
  readonly name: string;
  /** The visible label; default: `name`. */
  readonly label?: ReactNode;
  readonly usedPercent: number;
  /** The line under the bar. */
  readonly children?: ReactNode;
}

export function Meter({ name, label = name, usedPercent, children }: MeterProps) {
  // The level follows the shown number, so "60%" never reads as ok.
  const shown = Math.round(usedPercent);
  const level = levelOf(shown);
  const word = LEVEL_WORD[level];
  const tone = LEVEL_TONE[level];
  return (
    <div className="ins-window">
      <div className="ins-window-head">
        <span className="ins-window-name">{label}</span>
        {word !== undefined && (
          <span className="ins-tone" data-tone={tone}>
            {word}
          </span>
        )}
        <span className="mono ins-pct">{shown}%</span>
      </div>
      <svg className="meter" width="100%" height="6" role="meter" aria-label={name} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, shown)} aria-valuetext={`${shown}%, ${LEVEL_SPOKEN[level]}`}>
        <rect className="meter-track" width="100%" height="6" rx="3" />
        {usedPercent > 0 && <rect className="meter-fill" data-tone={tone} width={`${Math.min(100, Math.max(1, usedPercent))}%`} height="6" rx="3" />}
      </svg>
      {children !== undefined && <p className="muted ins-reset">{children}</p>}
    </div>
  );
}

/** The key under the Usage tab's heading: what each colour means. */
export function MeterKey() {
  return (
    <span className="ins-key muted" aria-label="Meter colours: under 60% ok, 60 to 79% high, 80% or more near limit, 100% at limit">
      <span>
        <span className="ins-key-mark" data-tone="pass" aria-hidden="true">
          {SWATCH}
        </span>{" "}
        under 60%
      </span>
      <span>
        <span className="ins-key-mark" data-tone="warn" aria-hidden="true">
          {SWATCH}
        </span>{" "}
        60–79% · high
      </span>
      <span>
        <span className="ins-key-mark" data-tone="fail" aria-hidden="true">
          {SWATCH}
        </span>{" "}
        80%+ · {LEVEL_WORD.near}
      </span>
      <span>
        <span className="ins-key-mark" data-tone="fail" aria-hidden="true">
          {SWATCH}
        </span>{" "}
        100% · {LEVEL_WORD.limit}
      </span>
    </span>
  );
}
