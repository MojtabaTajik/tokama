// Whether this run checks for updates at all.
import type { UpdateState } from "../../shared/update.js";

export type UnavailableReason = Extract<UpdateState, { status: "unavailable" }>["reason"];

/** The kind of Linux package this app was installed from: the text of `resources/package-type` that the build writes; undefined for anything else (an AppImage, a pacman package, a missing file). */
export function linuxPackageKind(text: string | undefined): "deb" | "rpm" | undefined {
  const kind = text?.trim();
  return kind === "deb" || kind === "rpm" ? kind : undefined;
}

/**
 * A development build never checks, and neither does a system that has no updater yet. On a Mac
 * the app must also run from Applications; on Linux it must be an installed .deb or .rpm.
 * `inApplications` is only called on macOS, where Electron has it.
 */
export function checksEnabled(input: { platform: NodeJS.Platform; isPackaged: boolean; inApplications: () => boolean; linuxPackage: () => "deb" | "rpm" | undefined }): { ok: true } | { ok: false; reason: UnavailableReason } {
  if (!input.isPackaged) return { ok: false, reason: "development" };
  if (input.platform === "linux") return input.linuxPackage() === undefined ? { ok: false, reason: "platform" } : { ok: true };
  if (input.platform !== "darwin") return { ok: false, reason: "platform" };
  return input.inApplications() ? { ok: true } : { ok: false, reason: "not_in_applications" };
}
