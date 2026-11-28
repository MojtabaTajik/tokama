# Tokama desktop

The Electron app: `src/main` (main process), `src/preload`, `src/renderer` (screens and the brand assets in `src/renderer/brand`), `scripts` (icons, packaging, package checks).

## The app icon on Linux

The desktop shows the icon of the launcher entry (`.desktop` file) that matches the window. Electron sets the window's Wayland `app_id` and X11 `WM_CLASS` to its desktop name without `.desktop`:

- Installed `.deb` or `.rpm`: `desktopName` in `package.json` is `tokama.desktop`, the same as the installed `/usr/share/applications/tokama.desktop`, whose `StartupWMClass` is `tokama` and whose `Icon` is the `tokama` icon in the hicolor sizes 16 to 512.
- `pnpm dev`: there is no installed entry, so the window is named `tokama-dev.desktop`. On X11 the window icon (`build/icons/512x512.png`, made from the brand art by `pnpm --filter @tokama/desktop icons`) is enough. GNOME on Wayland ignores the window icon and shows the generic gear unless an entry named `tokama-dev.desktop` exists. Install one once (it does not start the app and is hidden from the app grid), then start `pnpm dev` again:

The entry only gives the window its icon: "New Window" and "Pin" on it do nothing (its `Exec` is `true`), and the helper refuses to write through a symbolic link at the entry's path.

```sh
pnpm --filter @tokama/desktop linux:dev-entry            # writes ~/.local/share/applications/tokama-dev.desktop
pnpm --filter @tokama/desktop linux:dev-entry --remove   # removes it
```
