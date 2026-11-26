// The code of a Node system error (`ENOENT`, `EEXIST`, ...), read from any thrown value.

/** The string `code` of a thrown value, as Node system errors carry it; undefined for anything else. */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** Whether a thrown value is a system error with this code. */
export const hasCode = (error: unknown, code: string): boolean => errnoCode(error) === code;
