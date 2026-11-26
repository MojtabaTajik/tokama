// Every visible word of the release notes screens: the card, the chip and the About history.
import { fixesLine, SECURITY_LINE } from "../../shared/whats-new.js";

export const TEXT = {
  eyebrow: "Updated",
  cardTitle: "What's new in Tokama",
  seeAll: "See all",
  gotIt: "Got it",
  security: "Security",
  securityLine: SECURITY_LINE,
  fixesLine,
  updatedTo: "Updated to",
  chipFixes: "fixes",
  chipSecurity: "Security",
  heading: "What's new",
  site: "tokama.dev",
  thisVersion: "this version",
  loading: "Reading the notes…",
  failed: "Could not read the notes.",
  empty: "Notes appear here after an update.",
  kindFixes: "Fixes",
  kindSecurity: "Security",
  kindHighlights: (count: number) => `${count} ${count === 1 ? "highlight" : "highlights"}`,
} as const;
