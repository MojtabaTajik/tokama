// Sentinels for the redaction tests: made-up paths, names, emails and tokens. None of their
// fragments may appear in a cleaned stack, a diagnostics file or a reply.
import type { RedactionContext } from "./redact.js";

export const SENTINEL = {
  home: "/home/northwind-dev",
  spacedHome: "/Users/Jane Doe",
  tokamaHome: "/home/northwind-dev/.tokama",
  repoPath: "/srv/work/orders-api-checkout",
  repoId: "orders-api",
  userName: "northwind-dev",
  email: "jane.doe@northwind.example",
  url: "https://deploy:hunter2@git.northwind.example/orders-api.git",
  anthropic: "sk-ant-api03-SENTINELabcdefghijklmnopqrstuvwxyz0123",
  github: "ghp_SENTINEL0123456789abcdefghijklmnop",
  githubPat: "github_pat_11SENTINEL0_abcdefghijklmnopqrstuvwxyz",
  aws: "AKIASENTINEL12345678",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRU5USU5FTCJ9.c2VudGluZWxzaWduYXR1cmU",
  hex: "5e47a1c0ffee5e47a1c0ffee5e47a1c0ffee5e47",
  base64: "U0VOVElORUxzZWNyZXRrZXltYXRlcmlhbDEyMzQ1Njc4OTA=",
  windowsPath: "C:\\Users\\jane\\orders-api\\src\\billing.ts",
  relativePath: "src/billing/secret-invoice.ts",
  password: "password=Tr0ub4dor",
} as const;

/** Fragments that must never survive cleaning. */
export const FORBIDDEN = ["northwind", "orders-api", "Jane", "jane", "Doe", "hunter2", "SENTINEL", "billing", "secret-invoice", "AKIA", "eyJ", "5e47a1c0ffee", "U0VOVElO", "Tr0ub4dor", "/srv/", "/home/", "/Users/"];

export const SENTINEL_CONTEXT: RedactionContext = {
  codeRoots: ["/opt/tokama"],
  paths: [SENTINEL.home, SENTINEL.spacedHome, SENTINEL.tokamaHome, SENTINEL.repoPath],
  repoNames: [SENTINEL.repoId, "orders-api-checkout"],
  userName: SENTINEL.userName,
};

/** A stack that carries every sentinel, in the shapes real stacks and messages have. */
export function sentinelStack(): string {
  return [
    `Error: cannot open ${SENTINEL.home}/projects/${SENTINEL.repoId}/src/index.ts for ${SENTINEL.email} at ${SENTINEL.url}`,
    `  token ${SENTINEL.anthropic} ${SENTINEL.github} ${SENTINEL.githubPat} ${SENTINEL.aws} Bearer ${SENTINEL.jwt} ${SENTINEL.hex} ${SENTINEL.base64} ${SENTINEL.password}`,
    `  also ${SENTINEL.windowsPath} and ${SENTINEL.relativePath} and ${SENTINEL.spacedHome}/Library/x.json and repo ${SENTINEL.repoId} by ${SENTINEL.userName}`,
    `    at readConfig (file://${SENTINEL.repoPath}/node_modules/thing/index.js:10:5)`,
    `    at load (${SENTINEL.tokamaHome}/items/x/events.jsonl:3:1)`,
    "    at run (/opt/tokama/apps/engine/dist/engine.js:120:17)",
    "    at step (/opt/tokama/src/secret-invoice.ts:1:1)",
    "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
  ].join("\n");
}
