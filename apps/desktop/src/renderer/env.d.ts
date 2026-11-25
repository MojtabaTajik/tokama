// Ambient types of the renderer. A script file (no imports), so the wildcard module works.

interface Window {
  /** Exposed by the preload script. */
  readonly tokama: import("../shared/bridge.js").TokamaBridge;
}

declare module "*.svg" {
  /** The asset's URL (Vite). */
  const url: string;
  export default url;
}

declare module "*?raw" {
  /** The file's text (Vite). */
  const text: string;
  export default text;
}
