// Whether this run checks for updates at all.
import type { UpdateState } from "../../shared/update.js";

export type UnavailableReason = Extract<UpdateState, { status: "unavailable" }>["reason"];

/**
 * A development build never checks, and neither does a system that has no updater yet. On a Mac
 * the app must also run from Applications. `inApplications` is only called on macOS, where
 * Electron has it.
 */
export function checksEnabled(input: { platform: NodeJS.Platform; isPackaged: boolean; inApplications: () => boolean }): { ok: true } | { ok: false; reason: UnavailableReason } {
  if (!input.isPackaged) return { ok: false, reason: "development" };
  if (input.platform !== "darwin") return { ok: false, reason: "platform" };
  return input.inApplications() ? { ok: true } : { ok: false, reason: "not_in_applications" };
}
