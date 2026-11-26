/** Shows the main window, and makes it again when it was closed. */
export function showMainWindow<W>(deps: { windows: () => readonly W[]; create: () => W; show: (window: W) => void }): void {
  deps.show(deps.windows()[0] ?? deps.create());
}
