// A size in bytes as every screen shows it: `20.4 GB`, `512 MB`.

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** `20.4 GB` from one GB up, else whole MB. */
export function formatBytes(bytes: number): string {
  return bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / MIB)} MB`;
}
