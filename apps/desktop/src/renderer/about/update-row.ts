// What the Updates row of About says for each update state: a mark, one main line, a sub line, an
// optional progress bar and one button. Pure, so every state is tested without React.
import { CANT_TELL, QUIT_TOKAMA, RESTART_TOKAMA, RESTARTING, STALLED, STALLED_ACTION, STALLED_LINUX, type UpdateState } from "../../shared/update.js";
import { clock, sameDay, shortDate } from "../format/time.js";
import { markOf } from "../ui/status.js";

export type UpdatesTone = "pass" | "live" | "link" | "fail" | "muted";

export interface UpdatesRow {
  /** A symbol, so colour is never the only signal. */
  readonly mark: string;
  readonly tone: UpdatesTone;
  readonly main: string;
  readonly sub?: string;
  /** The version whose notes the "What's new in" link opens: while it downloads and when it is ready. */
  readonly notes?: string;
  /** Download progress, 0 to 100. */
  readonly progress?: { readonly percent: number; readonly label: string };
  readonly action?: { readonly label: string; readonly kind: "check" | "restart"; readonly primary: boolean; readonly disabled: boolean };
}

const DONE = markOf("passed").symbol;
const BUSY = markOf("running").symbol;
const FAILED = markOf("failed").symbol;
const MB = 1024 * 1024;
const mb = (bytes: number) => Math.round(bytes / MB);

const DOWN = "tokama.dev did not answer. Check your connection, then try again.";
const items = (count: number) => (count === 1 ? "1 item is" : `${count} items are`);

/** When the last check ran: `today at 09:12`, or the day. */
function checked(at: number, now: number): string {
  return sameDay(at, now) ? `today at ${clock(at)}` : `${shortDate(at)} at ${clock(at)}`;
}

/** The row for `state`, or undefined when About shows no row (a development build, or a copy outside Applications). `running` is the number of items running now. */
export function updatesRow(state: UpdateState, version: string, running: number, now: number, busy?: { readonly running?: number }, linux = false): UpdatesRow | undefined {
  const check = { label: "Check now", kind: "check", primary: false } as const;
  switch (state.status) {
    case "unavailable":
      return state.reason === "platform" ? { mark: "·", tone: "muted", main: "Updates are manual on this system." } : undefined;
    case "idle":
      return state.checkedAt === undefined
        ? { mark: "·", tone: "muted", main: "Not checked yet", sub: `Version ${version}`, action: { ...check, disabled: false } }
        : { mark: DONE, tone: "pass", main: "Up to date", sub: `Version ${version} · checked ${checked(state.checkedAt, now)}`, action: { ...check, disabled: false } };
    case "checking":
      return { mark: BUSY, tone: "live", main: "Checking tokama.dev…", sub: `Version ${version}`, action: { ...check, disabled: true } };
    case "downloading": {
      const percent = Math.max(0, Math.min(100, Math.round(state.percent)));
      return {
        mark: "↓",
        tone: "link",
        notes: state.version,
        main: `Downloading ${state.version} · ${percent}%`,
        sub: `${mb(state.transferred)} of ${mb(state.total)} MB · you can keep working`,
        progress: { percent, label: `Downloading Tokama ${state.version}` },
        action: { ...check, disabled: true },
      };
    }
    case "ready": {
      // The engine refused the restart: it runs items the window did not list, or would not say.
      if (busy !== undefined) {
        const count = busy.running ?? 0;
        return {
          mark: "↻",
          tone: "link",
          notes: state.version,
          main: `${state.version} is ready`,
          sub: count > 0 ? `${items(count)} running. You can restart when ${count === 1 ? "it finishes" : "they finish"}. Tokama never restarts by itself.` : `${CANT_TELL}. Try again in a moment. Tokama never restarts by itself.`,
          action: { label: "Restart now", kind: "restart", primary: true, disabled: true },
        };
      }
      return {
        mark: "↻",
        tone: "link",
        notes: state.version,
        main: `${state.version} is ready`,
        sub:
          running > 0
            ? `${items(running)} running. You can restart when ${running === 1 ? "it finishes" : "they finish"}. Tokama never restarts by itself.`
            : linux
              ? "Restart now to install it. Your system asks for your password. Tokama never installs it by itself."
              : "Restart now, or Tokama installs it when you quit with nothing running. It never restarts by itself.",
        action: { label: "Restart now", kind: "restart", primary: true, disabled: running > 0 },
      };
    }
    case "stalled":
      if (linux) return { mark: "!", tone: "fail", main: STALLED_LINUX, sub: `Tokama is still on ${version}. Quit and open it again to try the update again.`, action: { label: QUIT_TOKAMA, kind: "restart", primary: true, disabled: false } };
      return { mark: "!", tone: "fail", main: STALLED, sub: STALLED_ACTION, action: { label: RESTART_TOKAMA, kind: "restart", primary: true, disabled: false } };
    case "installing":
      return { mark: BUSY, tone: "live", main: RESTARTING, sub: `Version ${version}` };
    case "error": {
      const again = { label: "Try again", kind: "check", primary: false, disabled: false } as const;
      if (state.stage === "install") return { mark: FAILED, tone: "fail", main: "Couldn’t install the update", sub: "Tokama kept this version. Try again later.", action: again };
      return { mark: FAILED, tone: "fail", main: state.stage === "download" ? "Couldn’t download the update" : "Couldn’t check for updates", sub: DOWN, action: again };
    }
  }
}
