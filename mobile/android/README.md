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
    PickedFiles + ContentDocuments  files the user picked for this engine, by handle
SsoBroker + SsoRedirectActivity    single sign-on: Custom Tab out, <applicationId>.sso:/<path> back
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
| `engine/PickedFiles.kt`, `engine/ContentDocuments.kt` | `EngineHub.pickFiles`, `readFile` and `src/main/files.ts` |
| `sso/SsoBroker.kt`, `sso/SsoRedirectActivity.kt` | `src/main/ssoLoopback.ts`, `EngineHub.ssoSignIn` |
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
- **No network of their own.** Engine pages get `connect-src 'none'` (their fetch and WebSocket fail; the CSP header is what stops them, see [Device checks](#device-checks)) and their origin serves only their page and bundle; requests to any other host get a 404 from `shouldInterceptRequest`. All their HTTP and sockets go through native code: `https:`/`wss:` only, no credentials in URLs, no local or private hosts (all numeric address forms included, as the URL parser reads them), only the module's hosts or a narrower lock, each redirect re-checked, cookies dropped both ways, responses and frames capped. `PublicDns` refuses a name when any address it resolves to is private, at connection time, on the addresses connected to; there is no proxy so that check sees where the connection goes.
- **The shell view** gets no permissions, connects nowhere (`connect-src 'self'`), and may load pictures and media only over https from public hosts its engine may reach (`shouldInterceptRequest`). The WebView resolves those names again itself, so this check is weaker than the engines' (see below).
- **Storage apart.** One Profile per engine instance (its own cookies, IndexedDB, service workers) and its own origin; the shell has another. Engine Profiles accept no cookies.
- **Secrets** are encrypted with a non-exportable AES-256-GCM Keystore key (StrongBox when present), one file per instance in app-private storage, each value bound to its instance and key as associated data. No backups (`allowBackup="false"`, data extraction rules exclude everything).
- **Files** are picked with the system's document picker (`ACTION_OPEN_DOCUMENT`, no storage permission), only within 10 s after the user asked to attach in that engine's view and once per ask, as on the desktop; one picker at a time. Each picked document gets a random handle kept for that engine only (the oldest forgotten past 200); `readFile` reads at most 16 MB per request (the validator's cap), clipped to the document's size, through the read grant the picker gave.
- **Single sign-on** (Matrix's `m.login.sso`) follows `EngineHub.ssoSignIn`: only within 10 s after the user submitted a sign-in step in that engine's view, once per submit, to an https homeserver SSO address (`/_matrix/client/{v3,r0}/login/sso/redirect[/<idp>]`, no credentials, query or fragment) on a host the engine may reach. The address opens in a Custom Tab (androidx.browser; the user's browser over the app) with `redirectUrl=<applicationId>.sso:/<48 random hex digits>` in place of the desktop's loopback server. The browser comes back to `SsoRedirectActivity` (exported, a `VIEW`/`BROWSABLE` filter for that scheme only, no UI, reads only the address), which hands the address to `SsoBroker`: one request waits at a time (a new one cancels it, as does its engine stopping), for 5 minutes; an address with another path changes nothing; the first with the path ends the request, with the `loginToken` if it has the desktop's token form (`[A-Za-z0-9._~+/=-]{1,1024}`) or as a failure. The token is the answer to the asking engine's own request only. **Any app could register the same scheme** (custom schemes are not verified, unlike https app links, which would need a domain of ours), so a redirect could reach another app; that is why the path is random and single-use, only one request waits, and the token's form is checked, and Matrix login tokens are short-lived and single-use themselves. An unexpected redirect is logged as ignored.
  - *Homeservers and a non-http redirect:* the spec allows any URI. matrix.org (Matrix Authentication Service's compatibility layer) accepts `app.multicord.sso:/<path>` (`/login/sso/redirect` answers 303 to its sign-in page, as for an https redirect; it answers 400 to a value that is no URL). Synapse without MAS takes any `redirectUrl` too; its `sso.client_whitelist` only decides whether the user first sees a "continue to your application" page, so a homeserver need not list Multicord, and that page's link is a tap, which the browser needs anyway to hand an address to an app (Element Android uses `element://connect` the same way). Not checked against a Synapse without MAS here.
  - *Browser sign-in* (Matrix's OAuth 2.0 device authorization grant, the first choice where the homeserver has an account service) needs no redirect: the view shows a code and a link, which opens in the browser like any https link from the view.
- **Platform:** `INTERNET` is the only permission; cleartext is off and only system CAs are trusted; navigation is blocked in engines, and links from the view open in the browser.
- **Weaker than the desktop**, accepted for now: all WebViews share one renderer process (no per-engine sandbox, docs/mobile.md section 5); on WebViews without `JS_INJECTION_IN_FRAME_AND_WORLD` the relay and the listener run in the page's main world (they are glue, not the boundary; the log says "bridge relay in the main world"); the shell's image loads are checked by name, then resolved again by the WebView.

## Device checks

What the JVM tests cannot show, probed in the engine page over the WebView debug socket (debug build):

| Check | Android 16 emulator, WebView 134 | OnePlus CPH2663, Android 14, WebView 154 |
|---|---|---|
| What stops an engine's own network | The CSP: a `securitypolicyviolation` (`connect-src`, enforce) for `fetch` to a public host, `fetch` to its own origin (which `shouldInterceptRequest` would have served with 200) and a `WebSocket`; each fails before reaching the interception | fetch and WebSocket fail (milestone 1); the event is still to read |
| WebAssembly under `script-src 'self' 'wasm-unsafe-eval'` | Instantiates (async and sync, a module exporting `add`); `eval` is refused | still to run |
| Bridge world | Main world (no `JS_INJECTION_IN_FRAME_AND_WORLD`); the relay carries requests and answers | the feature is present; the isolated world is still to see in the log |
| File picking | Refused before an attach and on a second pick; cancel answers `[]`; a picked file reads in ranges; unknown handle refused | still to run |
| Single sign-on | Refused before a sign-in submit; the Custom Tab opens on matrix.org's account service sign-in page; a redirect with another path is ignored and the request keeps waiting | still to run |
| Password sign-in form (plain HTTP through the bridge; matrix.org offers `m.login.password`) | Not reachable: the bundles do not run there | still to reach the password step, without credentials |

The emulator's WebView 134 cannot run the bundles themselves (`Uint8Array.fromBase64` arrived in Chrome 140), which is why the engine there never signs in; the minimum WebView check below should cover it.

## Tests

`./gradlew testDebugUnitTest` runs JVM tests (43 in all):

- `NetPolicyFixtureTest` runs **every case of `tests/fixtures/netpolicy-cases.json`** (93: private and public hosts, numeric address forms, host patterns, checkUrl refusals, narrowing, resolved addresses, dropped headers, redirects, the redirect limit). The `copyFixtures` task copies the file from the repository root at build time; it is never duplicated.
- `WebUrlTest`: the URL parser against browser behaviour (IPv4 and IPv6 forms, IDN, relative redirects).
- `HttpBridgeTest`: the HTTP bridge with a scripted network (redirect checks, limits, cookies, PublicDns).
- `ValidatorsTest` runs **every case of `tests/fixtures/engine-validator-cases.json`** (over 300 engine requests, HTTP requests, engine events, image URLs and view actions, each to accept or refuse), which `tests/shared/validatorCases.test.ts` runs against the TypeScript validators; the fixture states the limits it relies on, and both sides check them against their own constants. Copied in by `copyFixtures` as the network policy's cases are.
- `PickedFilesTest`: handles, the handle cap, ranges clipped to the size, types and names.
- `SsoBrokerTest`: which SSO addresses an engine may open, the redirect address, the one waiting request (other paths, schemes and authorities ignored, the first match ending it), token forms, the timeout and cancelling.
- `SecretStoreTest`: scoping, associated data, quota (AES-GCM in software; the Keystore exists only on a device).
- `EngineSocketsTest`: the socket relay's rules and caps.

## What is left

For milestone 1:
- Single sign-on all the way through with a real account (it is checked up to the homeserver's sign-in page, and the redirect's rules in unit tests).

For phase 2:
- The shell with `src/core` (registry, settings, EngineAdapter) in the shell WebView, a phone layout (rail as a drawer), several instances, and the settings page.
- A foreground service that keeps engines and their sockets alive in the background, and notifications.
- Fluxer, Stoat, Spacebar, Nerimity and Telegram engines (their sockets already have the relay), web-client modules as plain WebViews.
- Calls: camera and microphone permissions for the view only, LiveKit's connections, audio routing.
- Binary messages as `ArrayBuffer`s (`WEB_MESSAGE_ARRAY_BUFFER`) instead of base64 for large bodies; a cap on incoming socket frames before they are read whole.
- Release signing, an F-Droid build, and a minimum WebView version check beyond the three features checked now (at least 140, for `Uint8Array.fromBase64` in the bundles).
