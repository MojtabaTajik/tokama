// URL specifiers load code that no other rule can classify.
export * from "data:text/javascript,export * from 'node:child_process'";
export const cp = await import("data:text/javascript,export * from 'node:child_process'");
