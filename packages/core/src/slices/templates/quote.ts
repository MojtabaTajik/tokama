// Values from a template file go into problem messages, which are shown in the app and in logs.
// Control and bidi characters there could forge lines or reorder the text, so they are escaped.
import { cutText } from "../../kernel/text/index.js";

// C0, DEL, C1, and the bidi marks, embeddings, overrides and isolates. Matching control
// characters is the point of this pattern.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;
const MAX_CHARS = 80;

/** The value with unsafe characters escaped as `\u{..}` and cut to about 80 characters. */
export function clean(value: string): string {
  const cut = cutText(value, MAX_CHARS);
  return cut.replace(UNSAFE, (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}

/** The value cleaned and in double quotes, for a problem message. */
export const quote = (value: unknown): string => `"${clean(String(value)).replaceAll('"', '\\"')}"`;
