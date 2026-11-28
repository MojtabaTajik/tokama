// Opt-in helper for running Tokama from a checkout on Linux (`pnpm dev`): writes a launcher entry
// for the dev window, or removes it with --remove. GNOME on Wayland takes a window's icon only from
// the desktop entry that matches its app_id, so without this entry a dev window shows the generic
// gear. The entry is named after the dev window's desktop name, never starts the app (it is hidden
// from the app grid and runs `true`), and points its icon at the PNG in this checkout.
//   pnpm --filter @tokama/desktop linux:dev-entry            install
//   pnpm --filter @tokama/desktop linux:dev-entry --remove   remove
// The entry goes to $XDG_DATA_HOME/applications, ~/.local/share/applications by default. Start
// `pnpm dev` after the entry is there; a running window does not pick it up.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LINUX_DEV_DESKTOP_NAME } from "../src/main/icon.ts";

const appDir = join(import.meta.dirname, "..");

/** The text of the dev launcher entry; `iconPath` is absolute. */
export function devEntry(iconPath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Tokama (dev)",
    "Exec=true",
    `Icon=${iconPath}`,
    "NoDisplay=true",
    "Terminal=false",
    // The Wayland app_id and the X11 WM_CLASS of the dev window: its desktop name without ".desktop".
    `StartupWMClass=${LINUX_DEV_DESKTOP_NAME.replace(/\.desktop$/, "")}`,
    "",
  ].join("\n");
}

/** The folder of the user's own launcher entries. */
export function applicationsDir(env: NodeJS.ProcessEnv, home: string): string {
  const data = env.XDG_DATA_HOME;
  return join(data !== undefined && data.startsWith("/") ? data : join(home, ".local", "share"), "applications");
}

function main(): void {
  if (process.platform !== "linux") throw new Error("This helper is for Linux only.");
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--remove")) throw new Error("Usage: linux:dev-entry [--remove]");
  const dir = applicationsDir(process.env, homedir());
  const file = join(dir, LINUX_DEV_DESKTOP_NAME);
  if (args.length > 0) {
    rmSync(file, { force: true });
    console.log(`Removed ${file}`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, devEntry(join(appDir, "build", "icons", "512x512.png")));
  console.log(`Wrote ${file}. Start pnpm dev again to see the icon.`);
}

if (import.meta.main) main();
