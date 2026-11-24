// Where the app icon files are. `scripts/make-icons.ts` writes them to `build/`, which a packager
// reads later. In dev the app shows them itself: the window icon on Linux and Windows (macOS takes
// the icon from the app bundle), and the dock icon on macOS, since the dev binary is Electron's.
import { join } from "node:path";

export interface AppIcons {
  /** The BrowserWindow icon; undefined where the OS takes it from the app bundle (macOS). */
  readonly window: string | undefined;
  /** The macOS dock icon to set at run time; undefined elsewhere and in a packaged app, which has its own. */
  readonly dock: string | undefined;
}

export function appIcons(platform: NodeJS.Platform, appDir: string, isPackaged: boolean): AppIcons {
  const build = join(appDir, "build");
  return {
    window: platform === "linux" ? join(build, "icon.png") : platform === "win32" ? join(build, "icon.ico") : undefined,
    dock: platform === "darwin" && !isPackaged ? join(build, "icon.png") : undefined,
  };
}
