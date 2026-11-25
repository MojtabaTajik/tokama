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
    { id: "node", name: "Node.js", version: "installed on this machine", role: "runs the engine", licence: "MIT", site: "nodejs.org", copyright: "Copyright Node.js contributors",
      text: "Node.js runs the Tokama engine as a background service." },
    { id: "react", name: "React and React DOM", version: reactVersion, role: "the interface", licence: "MIT", site: "react.dev", copyright: "Copyright Meta Platforms, Inc. and affiliates",
      text: "React draws every screen in the app." },
  ];
}
