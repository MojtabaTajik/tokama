// The open-source parts the app is built with, shown in About. THIRD_PARTY_NOTICES.md lists the
// same parts for the repo; a test keeps the two in step.
import { version as reactVersion } from "react";

export interface Notice {
  readonly id: string;
  readonly name: string;
  /** What this part does for the app. */
  readonly role: string;
  readonly licence: string;
  readonly copyright: string;
  readonly site: string;
  readonly text: string;
}

/** The Node.js version the packaged app ships; a test keeps it equal to packaging/node-runtime.json. */
const NODE_VERSION = "26.13.1";

/** The notices, with the versions that come from the running app: Electron's own and React's. */
export function notices(electronVersion: string): ReadonlyArray<Notice & { readonly version: string }> {
  const inElectron = `in Electron ${electronVersion.split(".")[0] ?? electronVersion}`;
  return [
    { id: "fa", name: "Font Awesome Free", version: "7.3.1", role: "template and step icons", licence: "CC BY 4.0 · MIT", site: "fontawesome.com", copyright: "Copyright Fonticons, Inc.",
      text: "The template and step icons are Font Awesome Free icons (solid style). Only the icons the app lists are bundled, as SVG path data; the font, the CSS and the brands set are not used. Icons: CC BY 4.0, shapes unchanged. Code in @fortawesome/free-solid-svg-icons: MIT." },
    { id: "electron", name: "Electron", version: electronVersion, role: "desktop shell", licence: "MIT", site: "electronjs.org", copyright: "Copyright Electron contributors, Copyright GitHub Inc.",
      text: "Electron runs the desktop app. It bundles Chromium and Node.js, which carry their own licences, listed below." },
    { id: "chromium", name: "Chromium", version: inElectron, role: "renders the window", licence: "BSD-3-Clause and others", site: "chromium.org", copyright: "Copyright The Chromium Authors",
      text: "Chromium includes many third-party components under their own licences. The full list ships with the app as LICENSES.chromium.html." },
    { id: "node", name: "Node.js", version: NODE_VERSION, role: "runs the engine", licence: "MIT", site: "nodejs.org", copyright: "Copyright Node.js contributors",
      text: "The packaged app ships the official Node.js binary for macOS (arm64), unchanged except for its file name and code signature. It runs the Tokama engine as a background service. Node's licence file, which also lists the licences of the parts Node bundles, ships beside it as LICENSE-node. In development the engine runs on the Node found on PATH." },
    { id: "react", name: "React and React DOM", version: reactVersion, role: "the interface", licence: "MIT", site: "react.dev", copyright: "Copyright Meta Platforms, Inc. and affiliates",
      text: "React draws every screen in the app." },
    { id: "yaml", name: "yaml", version: "2.9.1", role: "reads and writes YAML files", licence: "ISC", site: "eemeli.org/yaml", copyright: "Copyright Eemeli Aro",
      text: "yaml reads and writes the YAML files of templates, agents and repos. It is built into the engine bundle and into the app's main process." },
    { id: "zod", name: "Zod", version: "4.6.7", role: "checks data", licence: "MIT", site: "zod.dev", copyright: "Copyright Colin McDonnell",
      text: "Zod checks stored and incoming data. It is built into the engine bundle and into the app's main process." },
  ];
}
