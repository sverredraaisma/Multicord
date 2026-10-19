# Third-party notices

Multicord is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). It ships the third-party code below. Each package's licence is compatible with that licence:
- The permissive licences let their code be combined with it.
- MPL-2.0 allows it file by file.
- GPL-3.0 code may be combined with AGPL-3.0 code (AGPL-3.0 section 13).

The build (`scripts/build.mjs`):
- writes the licence texts of everything it bundles into `dist/THIRD_PARTY_LICENSES.txt`, which ships with the app;
- fails when a shipped package is not named here, so each new one is looked at before it ships.

Packages installed beside the app keep their own licence files. The Android app has its own list in [mobile/android/NOTICE](mobile/android/NOTICE).

## Vendored in this repository

| What | Licence | Where |
|---|---|---|
| [Public Suffix List](https://publicsuffix.org/), commit `52b71b3` (2026-10-17) | MPL-2.0 | `src/core/publicsuffix` |

## Bundled into the app's scripts

| Package | Version | Licence | Used for |
|---|---|---|---|
| `@matrix-org/matrix-sdk-crypto-wasm` | 18.9.0 | Apache-2.0 | Matrix end-to-end encryption |
| `livekit-client` | 2.22.3 | Apache-2.0 | Matrix (Element Call) and Fluxer calls |
| `@livekit/mutex` | 1.1.1 | Apache-2.0 | inside livekit-client |
| `@bufbuild/protobuf` | 1.10.1 | Apache-2.0 AND BSD-3-Clause | inside livekit-client |
| `events` | 3.3.0 | MIT | inside livekit-client |
| `jose` | 6.2.12 | MIT | inside livekit-client |
| `loglevel` | 1.9.2 | MIT | inside livekit-client |
| `sdp` | 3.2.2 | MIT | inside livekit-client |
| `sdp-transform` | 2.15.0 | MIT | inside livekit-client |
| `webrtc-adapter` | 9.0.6 | BSD-3-Clause | inside livekit-client |
| `tslib` | 2.8.1 | 0BSD | inside livekit-client |
| `@sapphi-red/web-noise-suppressor` | 0.4.1 | MIT | RNNoise noise suppression (its worklet; RNNoise itself is BSD-3-Clause, by Xiph.Org and others) |
| `emojibase-data` | 17.0.0 | MIT | emoji names and shortcodes |
| `telegram` (GramJS) | 2.26.22 | MIT | the Telegram engine |
| `@cryptography/aes` | 0.1.1 | GPL-3.0-or-later | inside GramJS (github.com/spalt08/cryptography; the package has no licence file) |
| `async-mutex` | 0.3.2 | MIT | inside GramJS |
| `base64-js` | 1.5.1 | MIT | inside GramJS |
| `big-integer` | 1.6.52 | Unlicense | inside GramJS |
| `buffer` | 6.0.3 | MIT | inside GramJS |
| `dom-serializer` | 1.4.1 | MIT | inside GramJS |
| `domelementtype` | 2.3.0 | BSD-2-Clause | inside GramJS |
| `domhandler` | 4.3.1 | BSD-2-Clause | inside GramJS |
| `domutils` | 2.8.0 | BSD-2-Clause | inside GramJS |
| `entities` | 2.2.0 | BSD-2-Clause | inside GramJS |
| `htmlparser2` | 6.1.0 | MIT | inside GramJS |
| `ieee754` | 1.2.1 | BSD-3-Clause | inside GramJS |
| `mime` | 3.0.0 | MIT | inside GramJS |
| `pako` | 2.2.0 | MIT AND Zlib | inside GramJS |
| `path-browserify` | 1.0.1 | MIT | inside GramJS |
| `store2` | 2.14.4 | MIT | inside GramJS (the package has no licence file) |
| `ts-custom-error` | 3.3.1 | MIT | inside GramJS |

## Installed beside the app

| Package | Licence | Used for |
|---|---|---|
| `electron-updater` 6.8.9 and its dependencies (`builder-util-runtime`, `debug`, `fs-extra`, `graceful-fs`, `js-yaml`, `argparse`, `jsonfile`, `lazy-val`, `lodash.escaperegexp`, `lodash.isequal`, `ms`, `sax`, `semver`, `tiny-typed-emitter`, `universalify`) | MIT; ISC (`graceful-fs`, `semver`); Python-2.0 (`argparse`); BlueOak-1.0.0 (`sax`) | updates |
| `uiohook-napi` 1.5.5 (with `node-gyp-build`, MIT) | MIT; its libuiohook is LGPL-3.0-or-later | push-to-talk and other global shortcuts |
| `@vencord/venmic` 7.2.3, Linux only | MPL-2.0 | screen-share audio through PipeWire |

[Electron](https://www.electronjs.org/) (MIT) and Chromium are shipped by the installer with their own notices: `LICENSE.electron.txt` and `LICENSES.chromium.html`.

Rich Presence follows [arRPC](https://github.com/OpenAsar/arrpc)'s protocol but contains none of its code.
