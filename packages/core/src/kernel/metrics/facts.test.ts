import { describe, expect, it } from "vitest";
import { MachineFactsSchema } from "../schemas/index.js";
import { cpuFamily, gpuModel, linuxFacts, macosFacts, parseNvidiaInformation, parseOsRelease, parseSystemVersion, ramRange, readMachineFacts, vramRange, type FactsDeps } from "./index.js";

const GB = 1024 ** 3;

function files(map: Record<string, string>, dirs: Record<string, string[]> = {}): FactsDeps {
  return { readText: async (path) => map[path], listDir: async (path) => dirs[path] ?? [] };
}

describe("machine facts", () => {
  it("names CPU families without the exact model", () => {
    expect(cpuFamily("Apple M3 Pro")).toBe("Apple M3 Pro");
    expect(cpuFamily("Apple M1")).toBe("Apple M1");
    expect(cpuFamily("Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz")).toBe("Intel Core i7");
    expect(cpuFamily("Intel(R) Core(TM) Ultra 7 155H")).toBe("Intel Core Ultra 7");
    expect(cpuFamily("Intel(R) Xeon(R) Platinum 8370C CPU @ 2.80GHz")).toBe("Intel Xeon");
    expect(cpuFamily("AMD Ryzen 9 7950X 16-Core Processor")).toBe("AMD Ryzen 9");
    expect(cpuFamily("AMD EPYC 7763 64-Core Processor")).toBe("AMD EPYC");
    expect(cpuFamily("Neoverse-N1")).toBe("ARM Neoverse");
    expect(cpuFamily("")).toBe("Other");
  });

  it("gives RAM and VRAM as ranges", () => {
    expect(ramRange(7.6 * GB)).toBe("8-16");
    expect(ramRange(4 * GB)).toBe("<8");
    expect(ramRange(15.6 * GB)).toBe("16-32");
    expect(ramRange(36 * GB)).toBe("32-64");
    expect(ramRange(512 * GB)).toBe("128+");
    expect(vramRange(8 * GB)).toBe("8-16");
    expect(vramRange(2 * GB)).toBe("<4");
    expect(vramRange(48 * GB)).toBe("32+");
  });

  it("parses the OS version files", () => {
    expect(parseSystemVersion("<dict>\n\t<key>ProductName</key>\n\t<string>macOS</string>\n\t<key>ProductVersion</key>\n\t<string>15.2</string>\n</dict>")).toBe("15.2");
    expect(parseSystemVersion("<dict></dict>")).toBeNull();
    expect(parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\n')).toEqual({ distro: "ubuntu", version: "24.04" });
    expect(parseOsRelease("ID=\"bad id with spaces\"\n")).toEqual({ distro: null, version: null });
  });

  it("keeps GPU names to letters, digits and spaces", () => {
    expect(parseNvidiaInformation("Model: \t\t NVIDIA GeForce RTX 4090\nIRQ: 130\n")).toBe("NVIDIA GeForce RTX 4090");
    expect(gpuModel("AMD Radeon(TM) Pro 5500M")).toBe("AMD Radeon Pro 5500M");
    expect(gpuModel("!!!")).toBeNull();
  });

  it("reads macOS facts: the chip is the GPU, sharing memory", async () => {
    const os = macosFacts(files({ "/System/Library/CoreServices/SystemVersion.plist": "<key>ProductVersion</key><string>15.2</string>" }));
    const facts = await readMachineFacts(os, { cpuModel: "Apple M3 Pro", cores: 12, totalBytes: 36 * GB, arch: "arm64" });
    expect(facts).toEqual({ os: "macos", osVersion: "15.2", distro: null, arch: "arm64", cpu: { family: "Apple M3 Pro", cores: 12 }, ramGb: "32-64", gpu: { model: "Apple M3 Pro", vramGb: null } });
  });

  it("reads Linux facts: an NVIDIA model, or the PCI vendor and amdgpu memory", async () => {
    const release = { "/etc/os-release": "ID=ubuntu\nVERSION_ID=24.04\n" };
    const nvidia = linuxFacts(files({ ...release, "/proc/driver/nvidia/gpus/0000:01:00.0/information": "Model: NVIDIA GeForce RTX 3080\n" }, { "/proc/driver/nvidia/gpus": ["0000:01:00.0"] }));
    const node = { cpuModel: "AMD Ryzen 7 5800X 8-Core Processor", cores: 16, totalBytes: 32 * GB, arch: "x64" };
    expect(await readMachineFacts(nvidia, node)).toMatchObject({ os: "linux", osVersion: "24.04", distro: "ubuntu", cpu: { family: "AMD Ryzen 7" }, gpu: { model: "NVIDIA GeForce RTX 3080", vramGb: null } });
    const amd = linuxFacts(files({ ...release, "/sys/class/drm/card0/device/vendor": "0x1002\n", "/sys/class/drm/card0/device/mem_info_vram_total": `${16 * GB}\n` }, { "/sys/class/drm": ["card0", "card0-DP-1", "renderD128"] }));
    expect((await readMachineFacts(amd, node)).gpu).toEqual({ model: "AMD", vramGb: "16-32" });
    expect((await readMachineFacts(linuxFacts(files(release)), node)).gpu).toBeNull();
  });

  it("drops a value that does not fit the schema and keeps the rest", async () => {
    const odd = { os: "linux" as const, osVersion: async () => "has spaces in it", distro: async () => { throw new Error("boom"); }, gpu: async () => null };
    const facts = await readMachineFacts(odd, { cpuModel: "Intel(R) Core(TM) i5-8250U", cores: 8, totalBytes: 8 * GB, arch: "x64" });
    expect(facts).toMatchObject({ osVersion: null, distro: null, cpu: { family: "Intel Core i5", cores: 8 }, ramGb: "8-16" });
  });

  it("reads this machine's facts in the schema's form", async () => {
    expect(MachineFactsSchema.safeParse(await readMachineFacts()).success).toBe(true);
  });
});
