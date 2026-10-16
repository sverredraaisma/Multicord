# Multicord for Android

The phase-2 host from [docs/mobile.md](../../docs/mobile.md): a thin Kotlin app that runs the desktop app's own TypeScript bundles (module engines, the native chat view) in system WebViews, and does natively what Electron's main process does on the desktop. App id `app.multicord` (`app.multicord.debug` for debug builds). No Google Play Services, no local servers, no cleartext traffic. AGPL-3.0-or-later; see [NOTICE](NOTICE).

**Status: milestone 2.** The shell WebView runs `src/core` (the registry, the settings store and controller, an EngineAdapter per service) as the main process does on the desktop; every native module runs (Matrix, Fluxer, Telegram, Stoat, Spacebar, Nerimity), as many instances as the user adds, each in its own Profile, origin and secrets scope; the screen is a bar with the rail as a drawer, one chat view at a time, back navigation and the settings page; a foreground service keeps everything connected in the background and posts notifications. Milestone 1 (one Matrix instance end to end) was checked on a OnePlus CPH2663 with Android 14 and WebView 154; milestone 2 so far on the Android 16 emulator only (see [Device checks](#device-checks)). See [What is left](#what-is-left).

## Build

You need JDK 17 or newer (CI uses 21), the Android SDK (platform 36 and build-tools), and the desktop build:

```
npm ci && npm run build          # at the repository root: makes dist/, whose bundles the app runs
cd mobile/android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
./gradlew testDebugUnitTest      # JVM unit tests
```

`npm run build` must run first: the `bundleWeb` task copies every native module's engine (`dist/engines/<engine>.js`), the native chat view (`native.html`, `native.js`, `native.css`, `shell.css`, the RNNoise worklet and LiveKit's E2EE worker), the settings page's `settings.css` and the Messages list's `messages.css`, and the shell page from `dist/mobile` (`shell.html`, `shell.js`, `mobile.css`, and `modules.json`, the table of each module's engine, hosts and storage) into the app's assets, and fails naming that command when they are missing. Point Gradle at the SDK with `ANDROID_HOME` or a `local.properties` file here (`sdk.dir=…`; git ignores it). The APK is `app/build/outputs/apk/debug/app-debug.apk` (about 18 MB, most of it the engines; Matrix's, with its WebAssembly crypto, is the largest).

Install with `adb install -r app/build/outputs/apk/debug/app-debug.apk`. The app logs under the tag `Multicord` (`adb logcat -s Multicord`). Debug builds allow WebView inspection over adb (`chrome://inspect`); release builds do not.

## Architecture

```
MainActivity        the screen: the shell page over the shown chat view; back; pickers, Custom Tabs
Hub                 outlives the activity; made by MulticordApp, kept alive by ConnectionService
  ShellHost         WebView, Profile "shell", https://shell.multicord.invalid/shell.html (dist/mobile)
                    runs src/core: registry, settings, EngineAdapters; the bar, drawer and settings page
                    document-start shell.js -> window.multicordShell (ShellBridge), page world
                    relay.js + listener "multicordShellHost" (shell origin only), isolated world
                    commands checked with ShellCommands (isShellCommand); files kept by ShellFiles
  ModuleTable       dist/mobile/modules.json: engine, host lock and storage per module
  per instance:
    EngineHost      WebView, Profile "engine-<instance>", never on screen
                    https://<instance>.engine.multicord.invalid/engine.html, CSP connect-src 'none'
                    document-start engine.js -> window.multicordEngine (EngineBridge), page world
                    relay.js + listener "multicordHost" (that engine's origin only), isolated world
      EngineSockets + OkHttpSockets   bridged WebSockets (bridgeWebSocket)
      HttpBridge + OkHttpTransport    bridged HTTP (bridgeFetch)
      SecretStore scope               this instance's secrets (KeystoreCipher)
      PickedFiles + ContentDocuments  files the user picked for this engine, by handle
    ChatView        WebView, Profile "view-<instance>", https://<instance>.view.multicord.invalid/native.html
                    made when first shown (three kept); document-start view.js -> window.multicordNative
                    relay.js + listener "multicordView" (that view's origin only), isolated world
  Notifier          message and call notifications, the launcher badge, the connected notification
ConnectionService   foreground service (specialUse): the process and the Hub keep running; Quit
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
| `shell/ShellHost.kt`, `Hub.kt` | `src/main/app.ts` (createShell) and its IPC; core itself runs in the page (`src/mobile`) |
| `shell/ChatView.kt`, `assets/bridge/view.js` | each native view's WebContentsView and `src/preload/native.ts` |
| `shell/ShellFiles.kt` | `src/main/settingsFiles.ts` (settings.json, platforms.json) and rail-order.json |
| `background/` | the tray and closeToTray (keeps running), Electron's `Notification`, `app.setBadgeCount` |
| `engine/PickedFiles.kt`, `engine/ContentDocuments.kt` | `EngineHub.pickFiles`, `readFile` and `src/main/files.ts` |
| `sso/SsoBroker.kt`, `sso/SsoRedirectActivity.kt` | `src/main/ssoLoopback.ts`, `EngineHub.ssoSignIn` |
| `secrets/` | `src/main/credentials.ts` with `safeStorage` |
| `bridge/BridgeScripts.kt`, `assets/bridge/` | the preloads (`src/preload/engine.ts`, `native.ts`) with context isolation and `contextBridge` |
| `bridge/Validators.kt` | `isEngineRequest`, `isHttpRequest`, `isEngineEvent`, `isEngineCommand`, `isNativeAction`, `isServiceSettingStatus` |
| `shell/ShellCommands.kt` | `isShellCommand` (`src/mobile/protocol.ts`) |

**Routes.** An engine's events go, checked with `isEngineEvent`, to the shell page, tagged with the instance native code started in that WebView; the page checks them again (`isNativeEvent`) before its EngineAdapter takes them. Its display state goes to its own chat view only, and a chat view's actions, checked with `isNativeAction`, to its own engine only. The shell page's commands for an engine (checked with `isEngineCommand`) go to the instance they name. Engines and chat views have no route to the shell page's bridge or to each other.

Pages and native code exchange JSON strings over `WebMessageListener`. The bridge API a page uses (`engine.js`, `shell.js`) runs in the page's own world and hands its strings to `relay.js` in DOM events (`<channel>:out`, answered with `<channel>:in`); the relay and the listener live in an isolated world named `multicord-bridge` where the WebView supports `JS_INJECTION_IN_FRAME_AND_WORLD`, and in the page's world otherwise (`BridgeScripts`; the log says which, per WebView). a `Uint8Array` travels as `{"$b64": "<base64>"}` and the bridge scripts turn it back. Engine requests are answered by id; commands, view actions and socket events are pushed. Everything native runs on the main thread except HTTP (a small pool per engine) and secrets (one thread per engine, so writes and reads keep their order).

## Security model

The rules are the desktop's (docs/mobile.md, section 5); this is where each is enforced here.

- **Identity from the WebView.** Each listener is registered on one WebView, for one origin. A message counts only if it comes from that very WebView, its top frame and that origin; the instance it speaks for is the one native code started in that WebView. Nothing in a message names an engine, a secret's owner or a socket of another engine.
- **Origin-restricted injection.** The scripts and the listener are restricted to the one origin they serve: an engine page has only `multicordEngine`, a chat view only `multicordNative`, the shell page only `multicordShell` (checked on the emulator for milestone 2, on the phone for milestone 1).
- **The shell page** runs core and draws the bar, the drawer and the settings page. It is ours, holds no service credentials, connects nowhere (`connect-src 'none'`) and gets no permissions. It names services and sends engine commands, but native code takes each module's engine, host lock and storage from its own table (`modules.json`, which the build writes from the manifests), and checks every command (`ShellCommands`: known shapes and sizes, no unknown keys). Its files (settings, platforms, rail order) live in app-private storage, written whole. It shows what engines report (names, icons) through the desktop's renderers, which set text only; the rich chat view, which shows message content, is a separate WebView per instance, as on the desktop.
- **An isolated world for the bridge**, where the WebView has `JS_INJECTION_IN_FRAME_AND_WORLD`: the listener object exists only in the `multicord-bridge` world, so the page's scripts (and anything injected into them) never hold it and cannot post to native code except through the relay, as strings; native code hears only that world. The page can still send whatever the relay forwards, so this narrows the surface rather than adding a trust boundary: identity still comes from the WebView and everything is still validated natively.
- **Validated natively.** Every engine request and event, and every view action, is checked with the ported validators before anything happens; a malformed request is refused, a malformed event or action dropped. Render state must be an object and goes only to that instance's view.
- **No network of their own.** Engine pages get `connect-src 'none'` (their fetch and WebSocket fail; the CSP header is what stops them, see [Device checks](#device-checks)) and their origin serves only their page and bundle; requests to any other host get a 404 from `shouldInterceptRequest`. All their HTTP and sockets go through native code: `https:`/`wss:` only, no credentials in URLs, no local or private hosts (all numeric address forms included, as the URL parser reads them), only the module's hosts or a narrower lock, each redirect re-checked, cookies dropped both ways, responses and frames capped. `PublicDns` refuses a name when any address it resolves to is private, at connection time, on the addresses connected to; there is no proxy so that check sees where the connection goes.
- **The chat views** get no permissions, connect nowhere (`connect-src 'self'`), and may load pictures and media only over https from public hosts their engine may reach (`shouldInterceptRequest`); the shell page loads icons from public hosts. The WebView resolves those names again itself, so this check is weaker than the engines' (see below).
- **Storage apart.** One Profile per engine instance (its own cookies, IndexedDB, service workers) and its own origin, one per chat view with its own origin; the shell has another. Engine Profiles accept no cookies. A module without `storage` starts with its engine's web storage emptied, as its in-memory session does on the desktop. Removing an instance stops it, forgets its secrets and deletes both Profiles; a Profile still in use (until the process ends) is emptied at once and deleted at the next start, and an id added again never finds the old instance's data.
- **Secrets** are encrypted with a non-exportable AES-256-GCM Keystore key (StrongBox when present), one file per instance in app-private storage, each value bound to its instance and key as associated data. No backups (`allowBackup="false"`, data extraction rules exclude everything).
- **Files** are picked with the system's document picker (`ACTION_OPEN_DOCUMENT`, no storage permission), only within 10 s after the user asked to attach in that engine's view and once per ask, as on the desktop; one picker at a time. Each picked document gets a random handle kept for that engine only (the oldest forgotten past 200); `readFile` reads at most 16 MB per request (the validator's cap), clipped to the document's size, through the read grant the picker gave.
- **Single sign-on** (Matrix's `m.login.sso`) follows `EngineHub.ssoSignIn`: only within 10 s after the user submitted a sign-in step in that engine's view, once per submit, to an https homeserver SSO address (`/_matrix/client/{v3,r0}/login/sso/redirect[/<idp>]`, no credentials, query or fragment) on a host the engine may reach. The address opens in a Custom Tab (androidx.browser; the user's browser over the app) with `redirectUrl=<applicationId>.sso:/<48 random hex digits>` in place of the desktop's loopback server. The browser comes back to `SsoRedirectActivity` (exported, a `VIEW`/`BROWSABLE` filter for that scheme only, no UI, reads only the address), which hands the address to `SsoBroker`: one request waits at a time (a new one cancels it, as does its engine stopping), for 5 minutes; an address with another path changes nothing; the first with the path ends the request, with the `loginToken` if it has the desktop's token form (`[A-Za-z0-9._~+/=-]{1,1024}`) or as a failure. The token is the answer to the asking engine's own request only. **Any app could register the same scheme** (custom schemes are not verified, unlike https app links, which would need a domain of ours), so a redirect could reach another app; that is why the path is random and single-use, only one request waits, and the token's form is checked, and Matrix login tokens are short-lived and single-use themselves. An unexpected redirect is logged as ignored.
  - *Homeservers and a non-http redirect:* the spec allows any URI. matrix.org (Matrix Authentication Service's compatibility layer) accepts `app.multicord.sso:/<path>` (`/login/sso/redirect` answers 303 to its sign-in page, as for an https redirect; it answers 400 to a value that is no URL). Synapse without MAS takes any `redirectUrl` too; its `sso.client_whitelist` only decides whether the user first sees a "continue to your application" page, so a homeserver need not list Multicord, and that page's link is a tap, which the browser needs anyway to hand an address to an app (Element Android uses `element://connect` the same way). Not checked against a Synapse without MAS here.
  - *Browser sign-in* (Matrix's OAuth 2.0 device authorization grant, the first choice where the homeserver has an account service) needs no redirect: the view shows a code and a link, which opens in the browser like any https link from the view.
- **Platform:** `INTERNET`, `POST_NOTIFICATIONS` (asked at start on Android 13+) the foreground service's (`FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`) and `RECEIVE_BOOT_COMPLETED` (for "Start with your phone", below); cleartext is off and only system CAs are trusted; navigation is blocked in engines, and links from the pages open in the browser. A tapped notification's target travels in our own immutable PendingIntent and is checked again when the (exported, launcher) activity receives it.
- **Background.** `ConnectionService` is a foreground service of type `specialUse`: none of the defined types fits keeping a user's own chat connections open (`dataSync` is capped at 6 hours a day from Android 15; `remoteMessaging` is for handing messages between a user's devices). The justification is in the manifest's `PROPERTY_SPECIAL_USE_FGS_SUBTYPE`; it matters for Play review only, and the F-Droid build comes first. Its notification is on a channel of its own ("Connection"), which the user can turn off to hide it; Quit stops everything. **Start with your phone** (Settings > General, the desktop's "Start with your computer", off by default): `BootReceiver` gets `BOOT_COMPLETED` (after the first unlock, when app-private storage can be read) and `MY_PACKAGE_REPLACED` (an update stops the process), reads the setting from the shell's settings file, and only when it is on starts `ConnectionService`, which brings up the Hub without a screen. Starting a foreground service from the background is refused from Android 12 on, but these two broadcasts are exemptions; Android 15 takes `BOOT_COMPLETED`'s away for the types `dataSync`, `camera`, `mediaPlayback`, `phoneCall`, `mediaProjection` and `microphone`, not for `specialUse`. Both are protected broadcasts, so the exported receiver hears them from the system only. Notifications are posted only as the shell page decides, after the general and per-service settings and streamer mode ("on"; there is nothing to detect on a phone), and never for the conversation on screen.
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

Milestone 2 on the Android 16 emulator (WebView 134, 1.5 GB), checked over the debug socket:
- The shell page boots core, which starts the services platforms.json turns on (a first run: Fluxer and Telegram, Discord turned off). The drawer lists each service; the settings page lists services with their accounts and settings; a `<select>` opens (the activity is the WebView's context while it is on screen); back closes the drawer, then the settings page, then leaves the app with the engines running. The activity can go and come back ("don't keep activities") without restarting anything.
- Engines boot: Fluxer, Telegram, Stoat, Spacebar and Nerimity reach "running"; Matrix and every chat view need WebView 140 (`Uint8Array.fromBase64`). Sockets through the relay: the Telegram engine opened `wss://vesta.web.telegram.org/apiws` with `binary` chosen and was refused an off-lock host; the Stoat engine opened `wss://events.stoat.chat/`.
- Each page has only its own bridge (`multicordShell`, `multicordEngine` or `multicordNative`); an engine's own `fetch` fails.
- Removing an instance: its view's Profile is deleted at once, its engine's (still in use) emptied and deleted at the next start. A start command carrying `hosts` is dropped.
- The foreground service runs with type `specialUse` and its notification ("Keeping 2 services connected"). A notify command shows with the badge number; tapping it opens that service; Quit stops the service and removes every notification.
- Timers in the background: an engine page (never on screen) reports `document.hidden` false and ran a 1 s interval at full rate; the shell page (off screen with the activity) is hidden and ran it at about half. Core is driven by events, not timers; Chromium's intensive throttling after 5 minutes hidden, and a night in the background under OEM battery management, are still to check on the phone.
- The WebView ran several renderer processes (`SandboxedProcessService0:0` to `:3`) with these Profiles; whether phones give each Profile a renderer of its own is still to find out (docs/mobile.md, section 5).

## Tests

`./gradlew testDebugUnitTest` runs JVM tests:

- `NetPolicyFixtureTest` runs **every case of `tests/fixtures/netpolicy-cases.json`** (93: private and public hosts, numeric address forms, host patterns, checkUrl refusals, narrowing, resolved addresses, dropped headers, redirects, the redirect limit). The `copyFixtures` task copies the file from the repository root at build time; it is never duplicated.
- `WebUrlTest`: the URL parser against browser behaviour (IPv4 and IPv6 forms, IDN, relative redirects).
- `HttpBridgeTest`: the HTTP bridge with a scripted network (redirect checks, limits, cookies, PublicDns).
- `ValidatorsTest` runs **every case of `tests/fixtures/engine-validator-cases.json`** (over 300 engine requests, HTTP requests, engine events, image URLs and view actions, each to accept or refuse), which `tests/shared/validatorCases.test.ts` runs against the TypeScript validators; the fixture states the limits it relies on, and both sides check them against their own constants. Copied in by `copyFixtures` as the network policy's cases are.
- `ShellCommandsTest` runs every `isShellCommand` case of `tests/fixtures/shell-bridge-cases.json`, which `tests/mobile/protocol.test.ts` runs against the TypeScript; `ValidatorsTest` also runs the shared `isEngineCommand` cases.
- `ShellFilesTest`: the shell's files (names, sizes) and reading the module table. `NotificationTargetTest`: what a tapped notification may name.
- `PickedFilesTest`: handles, the handle cap, ranges clipped to the size, types and names.
- `SsoBrokerTest`: which SSO addresses an engine may open, the redirect address, the one waiting request (other paths, schemes and authorities ignored, the first match ending it), token forms, the timeout and cancelling.
- `SecretStoreTest`: scoping, associated data, quota (AES-GCM in software; the Keystore exists only on a device).
- `EngineSocketsTest`: the socket relay's rules and caps.

## What is left

For milestone 2:
- Run it on the phone (WebView 154): Matrix and the chat views need WebView 140 or later, which the emulator lacks. Sign in to each service with a test account; check notifications from real messages, the drawer's DM entries and badges, the chat view's panes and back, and a night in the background.
- The unified Messages list in the drawer.
- Starting after a reboot (no boot receiver yet), and restarting an engine left stopped without restarting the app.
- A minimum WebView version check (140, for `Uint8Array.fromBase64` in the bundles) with a clear message, beyond the three features checked now.

For phase 2:
- Single sign-on all the way through with a real account (it is checked up to the homeserver's sign-in page, and the redirect's rules in unit tests).
- Web-client modules as plain WebViews; Discord (phase 3).
- Calls: camera and microphone permissions for the views only, LiveKit's connections, audio routing; the voice settings and favourites in the chat views.
- Binary messages as `ArrayBuffer`s (`WEB_MESSAGE_ARRAY_BUFFER`) instead of base64 for large bodies; a cap on incoming socket frames before they are read whole.
- Matrix push through UnifiedPush, so Matrix need not keep a connection open.
- Release signing and an F-Droid build.
