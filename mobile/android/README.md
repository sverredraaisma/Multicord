# Multicord for Android

The phase-2 host from [docs/mobile.md](../../docs/mobile.md): a thin Kotlin app that runs the desktop app's own TypeScript bundles (module engines, the native chat view) in system WebViews, and does natively what Electron's main process does on the desktop. App id `app.multicord` (`app.multicord.debug` for debug builds). No Google Play Services, no local servers, no cleartext traffic. AGPL-3.0-or-later; see [NOTICE](NOTICE).

**Status: milestone 1.** One module instance, Matrix (`matrix-native`), runs end to end: its engine boots, talks to its homeserver through the native HTTP bridge, keeps its secrets in the Keystore-backed store, and its native chat view shows in the shell (its sign-in screen, checked on a OnePlus CPH2663 with Android 14 and WebView 154). There is no rail, no settings and no background service yet; see [What is left](#what-is-left).

## Build

You need JDK 17 or newer (CI uses 21), the Android SDK (platform 36 and build-tools), and the desktop build:

```
npm ci && npm run build          # at the repository root: makes dist/, whose bundles the app runs
cd mobile/android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
./gradlew testDebugUnitTest      # JVM unit tests
```

`npm run build` must run first: the `bundleWeb` task copies `dist/engines/matrix.js` and the native view (`native.html`, `native.js`, `native.css`, `shell.css`, the RNNoise worklet and LiveKit's E2EE worker) into the app's assets, and fails naming that command when they are missing. Point Gradle at the SDK with `ANDROID_HOME` or a `local.properties` file here (`sdk.dir=…`; git ignores it). The APK is `app/build/outputs/apk/debug/app-debug.apk` (about 12 MB, most of it the Matrix engine with its WebAssembly crypto).

Install with `adb install -r app/build/outputs/apk/debug/app-debug.apk`. The app logs under the tag `Multicord` (`adb logcat -s Multicord`). Debug builds allow WebView inspection over adb (`chrome://inspect`); release builds do not.

## Architecture

```
MainActivity
  status line (engine state, account)
  ShellView      WebView, Profile "shell", https://shell.multicord.invalid/native.html
                 document-start shell.js -> window.multicordNative (NativeApi), page world
                 relay.js + listener "multicordShell" (shell origin only), isolated world
  EngineHost     WebView per instance, Profile "engine-<instance>", 1x1 and invisible
                 https://<instance>.engine.multicord.invalid/engine.html, CSP connect-src 'none'
                 document-start engine.js -> window.multicordEngine (EngineBridge), page world
                 relay.js + listener "multicordHost" (that engine's origin only), isolated world
    EngineSockets + OkHttpSockets   bridged WebSockets (bridgeWebSocket)
    HttpBridge + OkHttpTransport    bridged HTTP (bridgeFetch)
    SecretStore scope               this instance's secrets (KeystoreCipher)
NetPolicy, WebUrl, PublicDns        what engines may contact (ported from src/main/netPolicy.ts)
Validators, Wire                    the desktop's validators (src/shared), JSON with {"$b64"} bytes
```

| Kotlin | Desktop counterpart |
|---|---|
| `net/NetPolicy.kt`, `net/WebUrl.kt` | `src/main/netPolicy.ts` (checkUrl, isPrivateHost, host locks) and `new URL()` |
| `net/HttpBridge.kt`, `net/OkHttpNet.kt` | `performHttp`, the address guard, the HTTP bridge's session |
| `engine/EngineSockets.kt`, `engine/OkHttpSockets.kt` | `src/core/engineSockets.ts`, `src/main/webSockets.ts` (relay page) |
| `engine/EngineHost.kt` | `src/main/engineHost.ts` (EngineHub), `src/preload/engine.ts` |
| `shell/ShellView.kt` | the native view's WebContentsView and `src/preload/native.ts` |
| `secrets/` | `src/main/credentials.ts` with `safeStorage` |
| `bridge/BridgeScripts.kt`, `assets/bridge/` | the preloads (`src/preload/engine.ts`, `native.ts`) with context isolation and `contextBridge` |
| `bridge/Validators.kt` | `isEngineRequest`, `isHttpRequest`, `isEngineEvent`, `isNativeAction`, `isServiceSettingStatus` |

Pages and native code exchange JSON strings over `WebMessageListener`. The bridge API a page uses (`engine.js`, `shell.js`) runs in the page's own world and hands its strings to `relay.js` in DOM events (`<channel>:out`, answered with `<channel>:in`); the relay and the listener live in an isolated world named `multicord-bridge` where the WebView supports `JS_INJECTION_IN_FRAME_AND_WORLD`, and in the page's world otherwise (`BridgeScripts`; the log says which, per WebView). a `Uint8Array` travels as `{"$b64": "<base64>"}` and the bridge scripts turn it back. Engine requests are answered by id; commands, view actions and socket events are pushed. Everything native runs on the main thread except HTTP (a small pool per engine) and secrets (one thread per engine, so writes and reads keep their order).

## Security model

The rules are the desktop's (docs/mobile.md, section 5); this is where each is enforced here.

- **Identity from the WebView.** Each listener is registered on one WebView, for one origin. A message counts only if it comes from that very WebView, its top frame and that origin; the instance it speaks for is the one native code started in that WebView. Nothing in a message names an engine, a secret's owner or a socket of another engine.
- **Origin-restricted injection.** The scripts and the listener are restricted to the one origin they serve; the engine page has no `multicordShell`, the shell no `multicordHost` (checked on the phone).
- **An isolated world for the bridge**, where the WebView has `JS_INJECTION_IN_FRAME_AND_WORLD`: the listener object exists only in the `multicord-bridge` world, so the page's scripts (and anything injected into them) never hold it and cannot post to native code except through the relay, as strings; native code hears only that world. The page can still send whatever the relay forwards, so this narrows the surface rather than adding a trust boundary: identity still comes from the WebView and everything is still validated natively.
- **Validated natively.** Every engine request and event, and every view action, is checked with the ported validators before anything happens; a malformed request is refused, a malformed event or action dropped. Render state must be an object and goes only to that instance's view.
- **No network of their own.** Engine pages get `connect-src 'none'` (their fetch and WebSocket fail on the phone; that the CSP header rather than the request interception is what stops them is still to confirm) and their origin serves only their page and bundle; requests to any other host get a 404 from `shouldInterceptRequest`. All their HTTP and sockets go through native code: `https:`/`wss:` only, no credentials in URLs, no local or private hosts (all numeric address forms included, as the URL parser reads them), only the module's hosts or a narrower lock, each redirect re-checked, cookies dropped both ways, responses and frames capped. `PublicDns` refuses a name when any address it resolves to is private, at connection time, on the addresses connected to; there is no proxy so that check sees where the connection goes.
- **The shell view** gets no permissions, connects nowhere (`connect-src 'self'`), and may load pictures and media only over https from public hosts its engine may reach (`shouldInterceptRequest`). The WebView resolves those names again itself, so this check is weaker than the engines' (see below).
- **Storage apart.** One Profile per engine instance (its own cookies, IndexedDB, service workers) and its own origin; the shell has another. Engine Profiles accept no cookies.
- **Secrets** are encrypted with a non-exportable AES-256-GCM Keystore key (StrongBox when present), one file per instance in app-private storage, each value bound to its instance and key as associated data. No backups (`allowBackup="false"`, data extraction rules exclude everything).
- **Platform:** `INTERNET` is the only permission; cleartext is off and only system CAs are trusted; navigation is blocked in engines, and links from the view open in the browser.
- **Weaker than the desktop**, accepted for now: all WebViews share one renderer process (no per-engine sandbox, docs/mobile.md section 5); on WebViews without `JS_INJECTION_IN_FRAME_AND_WORLD` the relay and the listener run in the page's main world (they are glue, not the boundary; the log says "bridge relay in the main world"); the shell's image loads are checked by name, then resolved again by the WebView.

## Tests

`./gradlew testDebugUnitTest` runs JVM tests (36 in all):

- `NetPolicyFixtureTest` runs **every case of `tests/fixtures/netpolicy-cases.json`** (93: private and public hosts, numeric address forms, host patterns, checkUrl refusals, narrowing, resolved addresses, dropped headers, redirects, the redirect limit). The `copyFixtures` task copies the file from the repository root at build time; it is never duplicated.
- `WebUrlTest`: the URL parser against browser behaviour (IPv4 and IPv6 forms, IDN, relative redirects).
- `HttpBridgeTest`: the HTTP bridge with a scripted network (redirect checks, limits, cookies, PublicDns).
- `ValidatorsTest` runs **every case of `tests/fixtures/engine-validator-cases.json`** (over 300 engine requests, HTTP requests, engine events, image URLs and view actions, each to accept or refuse), which `tests/shared/validatorCases.test.ts` runs against the TypeScript validators; the fixture states the limits it relies on, and both sides check them against their own constants. Copied in by `copyFixtures` as the network policy's cases are.
- `SecretStoreTest`: scoping, associated data, quota (AES-GCM in software; the Keystore exists only on a device).
- `EngineSocketsTest`: the socket relay's rules and caps.

## What is left

For milestone 1:
- Signing in. Matrix's sign-in uses the browser (OAuth) or single sign-on; both need the shell to open the browser and take the answer back for that engine only (an app link or a custom-tab redirect, in place of the desktop's loopback). File picking (`pickFiles`/`readFile`) is refused for now.

For phase 2:
- The shell with `src/core` (registry, settings, EngineAdapter) in the shell WebView, a phone layout (rail as a drawer), several instances, and the settings page.
- A foreground service that keeps engines and their sockets alive in the background, and notifications.
- Fluxer, Stoat, Spacebar, Nerimity and Telegram engines (their sockets already have the relay), web-client modules as plain WebViews.
- Calls: camera and microphone permissions for the view only, LiveKit's connections, audio routing.
- Binary messages as `ArrayBuffer`s (`WEB_MESSAGE_ARRAY_BUFFER`) instead of base64 for large bodies; a cap on incoming socket frames before they are read whole.
- Release signing, an F-Droid build, and a minimum WebView version check beyond the three features checked now.
