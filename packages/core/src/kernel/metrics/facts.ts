// General facts about this machine for diagnostics: OS and version, architecture, CPU family and
// cores, RAM and GPU memory as ranges, GPU model when known. Never exact amounts, the display or
// the locale. The OS-specific part is `OsFacts`, one implementation per OS; each reads files only
// and starts no command.
import { readdir, readFile } from "node:fs/promises";
import { arch, cpus, release, totalmem } from "node:os";
import { join } from "node:path";
import { MachineFactsSchema, type MachineFacts, type RamRange, type VramRange } from "../schemas/index.js";

const GB = 1024 ** 3;

/** What one OS adds to the facts Node gives on every OS. */
export interface OsFacts {
  readonly os: MachineFacts["os"];
  osVersion(): Promise<string | null>;
  distro(): Promise<string | null>;
  /** `cpuFamily` is the normalised CPU family, for a GPU that is part of the chip. */
  gpu(cpuFamily: string): Promise<MachineFacts["gpu"]>;
}

/** Reads a small text file; undefined when it is missing or unreadable. */
export type ReadText = (path: string) => Promise<string | undefined>;
export type ListDir = (path: string) => Promise<string[]>;

export interface FactsDeps {
  readonly readText: ReadText;
  readonly listDir: ListDir;
}

const defaultDeps: FactsDeps = {
  readText: async (path) => {
    try {
      // Only small system files are read here; the cut keeps a strange one from costing much.
      return (await readFile(path, "utf8")).slice(0, 64 * 1024);
    } catch {
      return undefined;
    }
  },
  listDir: async (path) => {
    try {
      return await readdir(path);
    } catch {
      return [];
    }
  },
};

export function ramRange(bytes: number): RamRange {
  const gb = Math.round(bytes / GB);
  return gb < 8 ? "<8" : gb < 16 ? "8-16" : gb < 32 ? "16-32" : gb < 64 ? "32-64" : gb < 128 ? "64-128" : "128+";
}

export function vramRange(bytes: number): VramRange {
  const gb = Math.round(bytes / GB);
  return gb < 4 ? "<4" : gb < 8 ? "4-8" : gb < 16 ? "8-16" : gb < 32 ? "16-32" : "32+";
}

/** The CPU's family from its model string: `Apple M3 Pro`, `Intel Core i7`, `AMD Ryzen 9`; `Other` when unknown. */
export function cpuFamily(model: string): string {
  const apple = /\bApple (M\d+)(?: (Pro|Max|Ultra))?\b/.exec(model);
  if (apple) return ["Apple", apple[1], apple[2]].filter(Boolean).join(" ");
  if (/\bIntel\b/i.test(model)) {
    const core = /\bCore\b(?:\(TM\))?\s+(?:(Ultra) )?(i[3579]|[3579])\b/i.exec(model);
    if (core) return ["Intel Core", core[1], core[2]].filter(Boolean).join(" ");
    if (/\bXeon\b/i.test(model)) return "Intel Xeon";
    return "Intel";
  }
  if (/\bAMD\b/i.test(model)) {
    const ryzen = /\bRyzen (Threadripper|[3579])\b/i.exec(model);
    if (ryzen) return `AMD Ryzen ${ryzen[1]}`;
    if (/\bEPYC\b/i.test(model)) return "AMD EPYC";
    return "AMD";
  }
  if (/\bNeoverse\b/i.test(model)) return "ARM Neoverse";
  return "Other";
}

/** A GPU model name in the family-name form: letters, digits and spaces, at most 40 characters. */
export function gpuModel(name: string): string | null {
  const cleaned = name
    .replace(/\((?:R|TM)\)/gi, " ")
    .replace(/[^A-Za-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40)
    .trim();
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : null;
}

/** `ProductVersion` of macOS's SystemVersion.plist. */
export function parseSystemVersion(plist: string): string | null {
  return /<key>ProductVersion<\/key>\s*<string>([0-9.]{1,20})<\/string>/.exec(plist)?.[1] ?? null;
}

/** `ID` and `VERSION_ID` of /etc/os-release. */
export function parseOsRelease(text: string): { distro: string | null; version: string | null } {
  const field = (name: string) => {
    const value = new RegExp(`^${name}=(.*)$`, "m").exec(text)?.[1]?.trim().replace(/^"(.*)"$/, "$1");
    return value === undefined || value === "" ? null : value;
  };
  const distro = field("ID");
  const version = field("VERSION_ID");
  return {
    distro: distro !== null && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(distro) ? distro : null,
    version: version !== null && /^[0-9A-Za-z][0-9A-Za-z._+-]{0,39}$/.test(version) ? version : null,
  };
}

/** The `Model:` line of /proc/driver/nvidia/gpus/<id>/information. */
export function parseNvidiaInformation(text: string): string | null {
  const model = /^Model:\s*(.+)$/m.exec(text)?.[1];
  return model === undefined ? null : gpuModel(model);
}

const PCI_VENDORS: Readonly<Record<string, string>> = { "0x10de": "NVIDIA", "0x1002": "AMD", "0x8086": "Intel" };

export function macosFacts(deps: FactsDeps = defaultDeps): OsFacts {
  return {
    os: "macos",
    osVersion: async () => {
      const plist = await deps.readText("/System/Library/CoreServices/SystemVersion.plist");
      return plist === undefined ? null : parseSystemVersion(plist);
    },
    distro: async () => null,
    // Apple silicon: the GPU is part of the chip and shares its memory. An Intel Mac's GPU is not
    // in any file this reads.
    gpu: async (family) => (family.startsWith("Apple ") ? { model: family, vramGb: null } : null),
  };
}

export function linuxFacts(deps: FactsDeps = defaultDeps): OsFacts {
  const release = (async () => {
    const text = await deps.readText("/etc/os-release");
    return text === undefined ? { distro: null, version: null } : parseOsRelease(text);
  })();
  return {
    os: "linux",
    osVersion: async () => (await release).version,
    distro: async () => (await release).distro,
    gpu: async () => {
      // The NVIDIA driver names its GPUs; for others the PCI vendor is all a file gives.
      for (const id of (await deps.listDir("/proc/driver/nvidia/gpus")).sort()) {
        const text = await deps.readText(join("/proc/driver/nvidia/gpus", id, "information"));
        const model = text === undefined ? null : parseNvidiaInformation(text);
        if (model !== null) return { model, vramGb: null };
      }
      for (const card of (await deps.listDir("/sys/class/drm")).filter((name) => /^card\d+$/.test(name)).sort()) {
        const device = join("/sys/class/drm", card, "device");
        const vendor = PCI_VENDORS[(await deps.readText(join(device, "vendor")))?.trim() ?? ""];
        if (vendor === undefined) continue;
        // amdgpu reports its memory; other drivers do not.
        const vram = Number((await deps.readText(join(device, "mem_info_vram_total")))?.trim());
        return { model: vendor, vramGb: Number.isSafeInteger(vram) && vram > 0 ? vramRange(vram) : null };
      }
      return null;
    },
  };
}

export function windowsFacts(): OsFacts {
  return { os: "windows", osVersion: async () => release(), distro: async () => null, gpu: async () => null };
}

function otherFacts(): OsFacts {
  return { os: "other", osVersion: async () => null, distro: async () => null, gpu: async () => null };
}

/** The OS facts for this OS. */
export function osFactsFor(platform: NodeJS.Platform = process.platform): OsFacts {
  if (platform === "darwin") return macosFacts();
  if (platform === "linux") return linuxFacts();
  if (platform === "win32") return windowsFacts();
  return otherFacts();
}

export interface NodeFacts {
  readonly cpuModel: string;
  readonly cores: number;
  readonly totalBytes: number;
  readonly arch: string;
}

const nodeFacts = (): NodeFacts => {
  const list = cpus();
  return { cpuModel: list[0]?.model ?? "", cores: list.length, totalBytes: totalmem(), arch: arch() };
};

/**
 * This machine's facts. A value that does not fit the schema becomes null (or `Other`), so a
 * strange reading never stops an entry from being recorded. Never throws.
 */
export async function readMachineFacts(osFacts: OsFacts = osFactsFor(), node: NodeFacts = nodeFacts()): Promise<MachineFacts> {
  const family = cpuFamily(node.cpuModel);
  const settle = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  };
  const [osVersion, distro, gpu] = await Promise.all([settle(osFacts.osVersion, null), settle(osFacts.distro, null), settle(() => osFacts.gpu(family), null)]);
  const facts: MachineFacts = {
    os: osFacts.os,
    osVersion,
    distro,
    arch: node.arch,
    cpu: { family, cores: Math.max(1, node.cores) },
    ramGb: ramRange(node.totalBytes),
    gpu,
  };
  const checked = MachineFactsSchema.safeParse(facts);
  if (checked.success) return checked.data;
  // Field by field, so one odd value does not lose the rest.
  const field = <K extends keyof MachineFacts>(key: K, fallback: MachineFacts[K]) =>
    MachineFactsSchema.shape[key].safeParse(facts[key]).success ? facts[key] : fallback;
  return { os: facts.os, osVersion: field("osVersion", null), distro: field("distro", null), arch: field("arch", "unknown"), cpu: field("cpu", { family: "Other", cores: 1 }), ramGb: facts.ramGb, gpu: field("gpu", null) };
}
