// The item's push target: `origin` as the repo configures it, read when the worktree is made,
// before any agent runs. Only a network remote on a code host counts; Tokama records it without a
// password, and Open PR later pushes only while origin still points there, so a remote changed
// during the run cannot redirect the push.

/** A remote on a code host, e.g. github.com/acme/orders-api. */
export interface HostedRepo {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

const PART = /^(?!\.{1,2}$)[A-Za-z0-9_.-]+$/;
const HOST = /^[A-Za-z0-9.-]+$/;

/**
 * The URL without user info, except an SSH user name (`git@`); undefined for anything that is not
 * a network URL: a local path, `file://`, or a transport helper (`<helper>::<address>`).
 */
export function recordableRemote(url: string): string | undefined {
  const trimmed = url.trim();
  if (trimmed === "" || /[\s\p{Cc}]/u.test(trimmed) || trimmed.startsWith("-") || trimmed.includes("::")) return undefined;
  // A remote never needs these; they let one URL read as another host (`https://evil#@github.com/x`).
  if (/[#?\\]/.test(trimmed)) return undefined;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(trimmed);
  if (scheme !== null) {
    const kind = scheme[1]!.toLowerCase();
    if (!["https", "http", "ssh", "git"].includes(kind) || (scheme[2]!.match(/@/g)?.length ?? 0) > 1) return undefined;
    // The host, port and path as a URL parser reads them, so the pin compares what git connects to.
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return undefined;
    }
    if (parsed.hostname === "") return undefined;
    const keepUser = kind === "ssh" && parsed.username !== "";
    return `${kind}://${keepUser ? `${parsed.username}@` : ""}${parsed.host}${parsed.pathname}`;
  }
  // scp-like: [user@]host:path, where host has no "/" (else git reads it as a local path) and is
  // longer than one letter (a Windows drive, `C:/repo`); one "@" at most before the colon.
  const scp = /^(?:([^@/:]+)@)?([^@/:]{2,}):(?!\/\/)(.+)$/.exec(trimmed);
  return scp !== null ? `${scp[1] === undefined ? "" : `${scp[1]}@`}${scp[2]!.toLowerCase()}:${scp[3]}` : undefined;
}

/** The code host, owner and repo a recorded remote names; undefined when it does not name one. */
export function hostedRepo(url: string): HostedRepo | undefined {
  const parts = (host: string, path: string): HostedRepo | undefined => {
    const [owner = "", name = "", ...rest] = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "").split("/");
    if (rest.length > 0 || !PART.test(owner) || !PART.test(name) || !HOST.test(host)) return undefined;
    return { host: host.toLowerCase(), owner, name };
  };
  const scheme = /^([a-z]+):\/\/(?:[^/@]*@)?([^/:]+)(?::\d+)?(\/.*)$/i.exec(url);
  if (scheme !== null) return parts(scheme[2]!, scheme[3]!);
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(url);
  return scp === null ? undefined : parts(scp[1]!, scp[2]!);
}

/** Whether git pushes to this URL over SSH: `ssh://`, `git+ssh://`, `ssh+git://` or scp-like `host:path`. */
export function overSsh(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  if (scheme !== null) return ["ssh", "git+ssh", "ssh+git"].includes(scheme[1]!.toLowerCase());
  return recordableRemote(url) !== undefined;
}

/** `github.com/acme/orders-api`. */
export const pushTarget = (repo: HostedRepo): string => `${repo.host}/${repo.owner}/${repo.name}`;

/** Removes user info from every URL in a text, e.g. a git error message. */
export const withoutUserInfo = (text: string): string => text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/gi, "$1");
