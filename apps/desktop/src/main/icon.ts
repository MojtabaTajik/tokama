// Where the app icon files are. `scripts/make-icons.ts` writes them to `build/`, which a packager
// reads later. In dev the app shows them itself: the window icon on Linux and Windows (macOS takes
// the icon from the app bundle), and the dock icon on macOS, since the dev binary is Electron's.
// A packaged Linux app gets its icon from the desktop entry, and also sets the window icon from the
// PNG that the Linux package puts in its resources folder (an icon cannot be read from the asar).
import { join } from "node:path";

export interface AppIcons {
  /** The BrowserWindow icon; undefined where the OS takes it from the app bundle (macOS). */
  readonly window: string | undefined;
  /** The macOS dock icon to set at run time; undefined elsewhere and in a packaged app, which has its own. */
  readonly dock: string | undefined;
}

/** The file name of the window icon in a Linux package's resources folder; electron-builder.yml copies it there. */
export const LINUX_PACKAGED_ICON = "tokama.png";

/** The desktop entry name (and so the Wayland app_id and X11 WM_CLASS) of a dev run on Linux; a package uses `desktopName` of package.json, tokama.desktop. `scripts/linux-dev-entry.ts` writes the entry of this name. */
export const LINUX_DEV_DESKTOP_NAME = "tokama-dev.desktop";

export function appIcons(platform: NodeJS.Platform, appDir: string, isPackaged: boolean, resourcesPath: string): AppIcons {
  const build = join(appDir, "build");
  const linux = isPackaged ? join(resourcesPath, LINUX_PACKAGED_ICON) : join(build, "icons", "512x512.png");
  return {
    window: platform === "linux" ? linux : platform === "win32" ? join(build, "icon.ico") : undefined,
    dock: platform === "darwin" && !isPackaged ? join(build, "icon.png") : undefined,
  };
}
