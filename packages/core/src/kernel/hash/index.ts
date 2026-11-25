// SHA-256 as lowercase hex. Stored digests are compared across versions, so the output format
// (lowercase hex of the UTF-8 bytes of a string, or of the bytes as given) must never change.
import { createHash } from "node:crypto";

/** The SHA-256 of `data` in lowercase hex; its first `length` characters when given. A string is hashed as UTF-8. */
export function sha256Hex(data: string | Uint8Array, length?: number): string {
  const hex = createHash("sha256").update(data).digest("hex");
  return length === undefined ? hex : hex.slice(0, length);
}
