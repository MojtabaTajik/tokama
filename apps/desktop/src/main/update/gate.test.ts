import { describe, expect, it, vi } from "vitest";
import { checksEnabled, linuxPackageKind } from "./gate.js";

const none = () => undefined;

describe("checksEnabled", () => {
  it("never checks in a development build", () => {
    const inApplications = vi.fn(() => true);
    expect(checksEnabled({ platform: "darwin", isPackaged: false, inApplications, linuxPackage: none })).toEqual({ ok: false, reason: "development" });
    expect(checksEnabled({ platform: "linux", isPackaged: false, inApplications, linuxPackage: () => "deb" })).toEqual({ ok: false, reason: "development" });
    expect(inApplications).not.toHaveBeenCalled();
  });

  it("leaves updates manual on Windows, and never asks about Applications", () => {
    const inApplications = vi.fn(() => true);
    expect(checksEnabled({ platform: "win32", isPackaged: true, inApplications, linuxPackage: () => "deb" })).toEqual({ ok: false, reason: "platform" });
    expect(inApplications).not.toHaveBeenCalled();
  });

  it("does not check from outside Applications", () => {
    expect(checksEnabled({ platform: "darwin", isPackaged: true, inApplications: () => false, linuxPackage: none })).toEqual({ ok: false, reason: "not_in_applications" });
  });

  it("checks for a packaged Mac app in Applications", () => {
    expect(checksEnabled({ platform: "darwin", isPackaged: true, inApplications: () => true, linuxPackage: none })).toEqual({ ok: true });
  });

  it.each<"deb" | "rpm">(["deb", "rpm"])("checks for an installed Linux .%s, and never asks about Applications", (kind) => {
    const inApplications = vi.fn(() => true);
    expect(checksEnabled({ platform: "linux", isPackaged: true, inApplications, linuxPackage: () => kind })).toEqual({ ok: true });
    expect(inApplications).not.toHaveBeenCalled();
  });

  it("leaves updates manual on Linux when the app is not an installed .deb or .rpm", () => {
    expect(checksEnabled({ platform: "linux", isPackaged: true, inApplications: () => true, linuxPackage: none })).toEqual({ ok: false, reason: "platform" });
  });
});

describe("linuxPackageKind", () => {
  it.each([
    ["deb\n", "deb"],
    ["rpm", "rpm"],
    [" rpm \n", "rpm"],
    ["pacman\n", undefined],
    ["AppImage", undefined],
    ["", undefined],
    [undefined, undefined],
  ])("reads %j as %j", (text, kind) => {
    expect(linuxPackageKind(text)).toBe(kind);
  });
});
