// Names a gatherer never lists and never reads, whatever they hold: files that usually carry a
// token, a password or a private key. A guardrail by name; a secret written inside a build file is
// still sent, which is why the line that says what is sent names "build files".
const NAMES = new Set([".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials", "nuget.config", "gradle.properties", "local.properties", "settings.xml"]);
const PREFIXES = [".env", "id_", "credentials", "secrets"];
const SUFFIXES = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".tfvars"];

/** Case-insensitive, as a case-insensitive disk is: `.ENV` is the same file as `.env`. */
export function isSecretName(name: string): boolean {
  const lower = name.normalize("NFC").toLowerCase();
  return NAMES.has(lower) || PREFIXES.some((prefix) => lower.startsWith(prefix)) || SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

// Control, format (zero-width and bidi marks) and line or paragraph separator characters: a name
// with one could hide or change what the agent reads.
const ODD_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** A name worth showing: not secret and plain to read. */
export const isShownName = (name: string): boolean => name !== "" && !ODD_CHARACTER.test(name) && !isSecretName(name);
