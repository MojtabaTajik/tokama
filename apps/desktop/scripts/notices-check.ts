// What the licence checks share: reading the packages a built bundle contains, and the licence texts
// THIRD_PARTY_NOTICES.md holds.

export interface PackageVersion {
  readonly name: string;
  readonly version: string;
}

/**
 * The packages whose files a built bundle contains. The bundler marks each file's origin with its
 * path in pnpm's store: `.pnpm/<name>@<version>[_<peers>]/node_modules/`, a scoped name as
 * `@scope+name`. Sorted and without duplicates.
 */
export function bundledPackages(code: string): PackageVersion[] {
  const found = new Map<string, PackageVersion>();
  for (const match of code.matchAll(/\.pnpm\/((?:@[^+/@]+\+)?[^@/]+)@([^_/]+)(?:_[^/]*)?\/node_modules\//g)) {
    const name = (match[1] ?? "").replace("+", "/");
    const version = match[2] ?? "";
    found.set(`${name} ${version}`, { name, version });
  }
  return [...found.values()].sort((a, b) => `${a.name} ${a.version}`.localeCompare(`${b.name} ${b.version}`));
}

/** The folder pnpm gives a package (without the peer suffix): a scoped name has `+` for its slash. */
export const pnpmFolder = ({ name, version }: PackageVersion): string => `${name.replace("/", "+")}@${version}`;

/** The licence texts of the notices: `### <package> <version>` and then a fenced block, or a plain line for a package without a licence file. */
export function noticeSections(notices: string): Array<PackageVersion & { text: string | undefined }> {
  const texts = notices.slice(notices.indexOf("\n# Licence texts\n"));
  return [...texts.matchAll(/^### (\S+) (\S+)\n\n(?:```text\n([\s\S]*?)\n```|(.+))$/gm)].map((match) => ({ name: match[1] ?? "", version: match[2] ?? "", text: match[3] }));
}

/** What differs between the packages built into the app and the ones the notices hold a text for, each as `<name> <version>`. */
export function noticesDifference(bundled: readonly PackageVersion[], noticed: readonly PackageVersion[]): { missing: string[]; stale: string[] } {
  const key = ({ name, version }: PackageVersion) => `${name} ${version}`;
  const bundledKeys = new Set(bundled.map(key));
  const noticedKeys = new Set(noticed.map(key));
  return { missing: [...bundledKeys].filter((entry) => !noticedKeys.has(entry)).sort(), stale: [...noticedKeys].filter((entry) => !bundledKeys.has(entry)).sort() };
}
