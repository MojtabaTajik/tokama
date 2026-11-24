// The app's one brand assets location (CLAUDE.md, logo rule). Screens import the logo from here,
// never copy or inline it, so replacing the logo is a file swap in this folder.
import markUrl from "./mark.svg";
import wordmarkUrl from "./wordmark.svg";

export const brand = { name: "Tokama", markUrl, wordmarkUrl } as const;
