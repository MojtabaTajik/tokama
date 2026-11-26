# Third-party notices

## Font Awesome Free

The template icons in the app are icons from Font Awesome Free 7.3.1 (solid style), by Fonticons, Inc.
Only the icons the app lists in `src/renderer/shell/TemplateIcon.tsx` are bundled, as inline SVG path
data. The font, the CSS and the brands set are not used.

- Icons: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). No changes were made to the icon shapes.
- Code in the `@fortawesome/free-solid-svg-icons` package: MIT.
- Source and licence terms: https://fontawesome.com/license/free

## Electron

Electron 45 runs the desktop app (MIT, Copyright Electron contributors, Copyright GitHub Inc.). It bundles
Chromium and Node.js, which carry their own licences.

## Chromium

Chromium renders the window. It includes many third-party components under their own licences (BSD-3-Clause
and others); the full list ships with the app as `LICENSES.chromium.html`. Copyright The Chromium Authors.

## Node.js

The packaged app ships the official Node.js 26.13.1 binary for macOS (arm64), unchanged except for its
file name and code signature, as `Contents/Resources/engine/tokama-engine`. It runs the Tokama engine as a
background service (MIT, Copyright Node.js contributors). Node's licence file, which also lists the licences
of the parts Node bundles (V8, OpenSSL, libuv and others), ships beside it as `LICENSE-node`. In development
the engine runs on the Node found on PATH.

## React and React DOM

React draws every screen in the app (MIT, Copyright Meta Platforms, Inc. and affiliates).

## electron-updater and its dependencies

electron-updater 6.8.12 checks the update feed, downloads a new version and hands it to macOS to install
(MIT, Copyright Loopline Systems and the authors of the packages listed). It is built into the app's main
process with the packages it needs:

- MIT: builder-util-runtime, debug, ms, fs-extra, jsonfile, universalify, js-yaml, lazy-val,
  lodash.escaperegexp, lodash.isequal, tiny-typed-emitter.
- ISC: semver.
- BlueOak-1.0.0: graceful-fs, sax.
- Python-2.0: argparse.

## yaml

yaml 2.9.1 reads and writes the YAML files of templates, agents and repos (ISC, Copyright Eemeli Aro). It is
built into the engine bundle and into the app's main process.

## Zod

Zod 4.6.7 checks stored and incoming data (MIT, Copyright Colin McDonnell). It is built into the engine bundle
and into the app's main process.
