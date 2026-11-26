// Where the notes of an update are. The app has no notes for a version it has not installed, so
// the link goes to the release page of that version on the product site, in the browser. The
// address is built here from the version, which must be a plain `x.y.z`; nothing from the window
// or the feed is put in it.
import type { UpdateState } from "../../shared/update.js";

const RELEASES = "https://tokama.dev/releases/";

/** The release page of `version`; undefined unless it is a plain `x.y.z`. */
export function releaseNotesUrl(version: string): string | undefined {
  return /^\d+\.\d+\.\d+$/.test(version) ? `${RELEASES}v${version}` : undefined;
}

/** The release page of the update that downloads or is ready; undefined in any other state. */
export function updateNotesUrl(state: UpdateState): string | undefined {
  return state.status === "downloading" || state.status === "ready" ? releaseNotesUrl(state.version) : undefined;
}
