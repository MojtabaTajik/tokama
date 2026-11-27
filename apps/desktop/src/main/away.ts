// Whether the user has been away: the window was not in front, or the screen was locked, or the
// computer slept, for 15 minutes or more. Idle in front of the window does not count. This keeps
// the one state the "While you were away" strip is built from (see `AwayState`) and saves it in
// `desktop.json`. Electron's window and power events come in through the caller, so one
// implementation serves every OS and a test drives it with a fake clock.
import type { AwayInfo, AwayState } from "../shared/desktop-state.js";
import type { DesktopStore } from "./desktop-store.js";

/** How long the user must be away before the strip is due. */
export const AWAY_MS = 15 * 60_000;

export interface AwayDeps {
  readonly store: Pick<DesktopStore, "get" | "update">;
  readonly now: () => number;
  /** Told whenever what the window shows of the state changes. */
  readonly onChange: (info: AwayInfo) => void;
}

export interface Away {
  /** Reads the saved state at launch: the user is back after the time since they left or since the last launch ended. */
  start(): void;
  /** The window lost the front, the screen locked or the computer is going to sleep. Ignored while already away. */
  left(): void;
  /** The window is in front again. Ignored when the user was not away. */
  back(): void;
  /** What the window shows of the state. */
  info(): AwayInfo;
  /** Got it: everything up to now is seen. */
  close(): void;
}

const infoOf = ({ seenUntil, due, backAt }: AwayState): AwayInfo => ({ seenUntil, due, ...(backAt === undefined ? {} : { backAt }) });

export function createAway(deps: AwayDeps): Away {
  const { store, now, onChange } = deps;
  // The state before the first start has nothing to show.
  const read = (): AwayState => store.get().away ?? { seenUntil: now(), due: false };
  const write = (next: AwayState) => {
    const before = infoOf(read());
    store.update((state) => ({ ...state, away: next }));
    const after = infoOf(next);
    if (JSON.stringify(before) !== JSON.stringify(after)) onChange(after);
  };
  /** The user is in front now: due when they were away for the time, or already were and did not press Got it. */
  const returned = (state: AwayState, since: number): AwayState => {
    const t = now();
    const due = state.due || t - since >= AWAY_MS;
    // A strip already due keeps its first return time, so the time away does not grow with each blur.
    return { seenUntil: state.seenUntil, due, ...(due ? { backAt: state.due && state.backAt !== undefined ? state.backAt : t } : {}) };
  };
  return {
    start: () => {
      const saved = store.get().away;
      // The first launch has nothing to report; a launch after a crash has no `leftAt`, so the time since `seenUntil` stands in.
      write(saved === undefined ? { seenUntil: now(), due: false } : returned(saved, saved.leftAt ?? saved.seenUntil));
    },
    left: () => {
      const state = read();
      if (state.leftAt !== undefined) return;
      const t = now();
      // What came before the user left is seen, unless they have not dealt with an earlier strip.
      write({ ...state, leftAt: t, ...(state.due ? {} : { seenUntil: t }) });
    },
    back: () => {
      const state = read();
      if (state.leftAt === undefined) return;
      write(returned(state, state.leftAt));
    },
    info: () => infoOf(read()),
    close: () => write({ seenUntil: now(), due: false }),
  };
}
