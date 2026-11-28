// Takes secrets out of text that leaves the machine: a check command and its output sent to a
// cloud agent. It replaces only what looks like a secret and leaves paths, URLs, repo names, hashes
// and ordinary words alone, because the agent needs them to fix the failure. Plain patterns, each
// one starting only at the start of a word or a run, so a long input stays linear.
export const REDACTED = "<redacted>";

// A value that is not a secret: already hidden, empty, a literal, a reference to another variable,
// a command substitution, or a shell operator.
const NOT_A_SECRET = /^(?:<[a-z-]+>|\*+|x+|null|undefined|true|false|none|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|\$\(.*|`.*|[<>|&]+)$/i;
// A value that looks like a secret: 8 or more characters with a digit and a letter.
const LOOKS_SECRET = /^(?=.*\d)(?=.*[A-Za-z])\S{8,}$/;
// `_KEY` names that are no secret.
const PLAIN_KEY = /^(?:PRIMARY|SORT|CACHE|PUBLIC|FOREIGN|PARTITION|SHARD|ROW|MAP)_KEY$/;

const KNOWN_SHAPES: readonly RegExp[] = [
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic; a digit keeps out names such as `sk-loading-placeholder-component`
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g, // GitLab
  /\bnpm_[A-Za-z0-9]{36}\b/g, // npm
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[A-Za-z0-9_-]{35}\b/g, // Google API key
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  // A private key block (also PGP); one that never ends is taken to the end of the text.
  /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
];

// `scheme://user:password@host`: the password goes, the user and host stay.
const URL_PASSWORD = /(?<![A-Za-z0-9+.-])([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:/@'"<>]*:)[^\s/@'"<>]+(?=@)/g;

// `Authorization: Bearer abc`, `Proxy-Authorization: Basic abc`, `X-Api-Key: abc`; the scheme word stays.
const HEADER = /(?<![A-Za-z0-9-])((?:proxy-)?authorization|x-[a-z-]*(?:token|key|secret))(["']?[ \t]*:[ \t]*["']?)(?:(Bearer|Basic|Token|Digest)[ \t]+)?([^\s'"]+)/gi;
// `Bearer` followed by a long token, with no header name before it.
const BEARER = /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}/gi;

// A key that ends in a secret word, then `=` or `:`, then its value: `NPM_TOKEN=...`, `DB_PASSWORD=...`,
// `"client_secret": "..."`, `--api-key=...`, `_authToken=...`. The word must end the key, so
// `token_count=5` and `author=x` stay. A quoted value goes whole, spaces too. Not `==`, `=>`, `!=`.
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|account[_-]?key|shared[_-]?access[_-]?key|private[_-]?key|credentials?|auth)["']?)([ \t]*(?:=(?![=>])|:)[ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s'",;&})]+)/gi;
// An upper-case environment variable that ends in `_KEY`, `_PASS`, `_PWD` or `_KEY_BASE`: `STRIPE_KEY=...`, `DB_PASS=...`.
const KEY_VARIABLE = /(?<![A-Za-z0-9_.-])([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:KEY|PASS|PWD|KEY_BASE))(=)(?![=>])("[^"\n]*"|'[^'\n]*'|[^\s'",;&})]+)/g;
// `curl -u user:password`, `--user user:password`. Not `-u 1000:1000`, a user and group id.
const USER_PASSWORD = /(?<![A-Za-z0-9-])((?:-u|--user)[ \t]+[^\s:'"]+:)(?!\d+(?:[\s'"]|$))[^\s'"]+/g;
// A flag with its value after a space: `--token abc`, `--password "a b"`. Not `--token-count 5` or `--password-stdin`.
const FLAG = /(?<![A-Za-z0-9-])(--[a-z0-9-]*(?:token|password|passwd|secret|api-key|apikey)(?![a-z0-9-])[ \t]+)(?!-)("[^"\n]*"|'[^'\n]*'|[^\s'"]+)/gi;

/** `text` with each secret it holds replaced by `<redacted>`. Pure; never throws. */
export function scrubTokens(text: string): string {
  let out = text;
  for (const shape of KNOWN_SHAPES) out = out.replace(shape, REDACTED);
  out = out.replace(URL_PASSWORD, `$1${REDACTED}`);
  out = out.replace(USER_PASSWORD, `$1${REDACTED}`);
  out = out.replace(HEADER, (match, name: string, colon: string, scheme: string | undefined, value: string) =>
    NOT_A_SECRET.test(value) ? match : `${name}${colon}${scheme === undefined ? "" : `${scheme} `}${REDACTED}`,
  );
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(ASSIGNMENT, (match, key: string, separator: string, value: string) => assigned(match, key, separator, value));
  out = out.replace(KEY_VARIABLE, (match, key: string, separator: string, value: string) => (PLAIN_KEY.test(key) ? match : assigned(match, key, separator, value)));
  out = out.replace(FLAG, (match, flag: string, value: string) => (NOT_A_SECRET.test(unquote(value)) ? match : `${flag}${REDACTED}`));
  return out;
}

function unquote(value: string): string {
  return value.length > 1 && (value[0] === '"' || value[0] === "'") ? value.slice(1, -1) : value;
}

function assigned(match: string, key: string, separator: string, value: string): string {
  const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
  const bare = unquote(value);
  if (bare === "" || NOT_A_SECRET.test(bare)) return match;
  // `NAME=value`, a quoted value after a colon (`"token": "..."`) and a value after an upper-case
  // name (`DB_PASSWORD: ...` in YAML) are secrets. Anything else is code or prose until the value
  // looks like a secret: `const token = await login()`, `token: string`.
  const sure = separator === "=" || (separator.includes(":") && (quote !== "" || /^["']?[A-Z][A-Z0-9_]*["']?$/.test(key)));
  if (!sure && !LOOKS_SECRET.test(bare)) return match;
  return `${key}${separator}${quote}${REDACTED}${quote}`;
}
