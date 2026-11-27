// The clock every breathing mark shares. The animation itself is `[data-breathe]` in motion.css.
import { type CSSProperties, useMemo } from "react";

/** One breathing cycle, in ms: `--motion-breathe` in ui/motion.css. */
const BREATH_MS = 2_000;

/**
 * Every breathing mark on screen shares one 2 s clock: each starts its animation part-way into the
 * cycle, by the wall clock, so marks that appear at different times breathe together. A mark that
 * starts breathing after it is shown (`active` turns on) takes its delay then, not when it first showed.
 */
export function useBreath(active = true): CSSProperties {
  // The delay is fixed while the mark breathes: changing it would make a running animation jump.
  const delay = useMemo(() => -(Date.now() % BREATH_MS), [active]);
  return { animationDelay: `${delay}ms` };
}
