// The app's one brand assets location. Screens import the logo from here,
// never copy or inline it, so replacing the logo is a file swap in this folder.
import markUrl from "./mark.svg";
import mark32Url from "./mark-32.svg";
import wordmarkUrl from "./wordmark.svg";

/** `mark32Url` is the cut for 17 to 43 px; `markUrl` is the full mark for larger sizes. */
export const brand = { name: "Tokama", markUrl, mark32Url, wordmarkUrl } as const;
