// The important flag of an update. A release does not carry it by itself: the feed names the
// lowest version that is safe (`minSafeVersion`), so a normal release after a security release
// keeps the flag for everyone who is still below it. The reason is fixed text, never feed text.
import { olderBuild } from "@tokama/client";
import type { Critical } from "../../shared/update.js";

export const IMPORTANT_REASON = "This update fixes a security problem.";

/** The feed's `minSafeVersion`: a plain `x.y.z`; undefined for anything else. */
export function minSafeVersionOf(value: unknown): string | undefined {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) ? value : undefined;
}

/** Important when this app's version is below the feed's `minSafeVersion`. A development build (0.0.0) never is. */
export function criticalOf(minSafeVersion: unknown, appVersion: string): Critical | undefined {
  const minSafe = minSafeVersionOf(minSafeVersion);
  return minSafe !== undefined && olderBuild(appVersion, minSafe) ? { reason: IMPORTANT_REASON } : undefined;
}
