# Multicord on phones: design note

Status: design written 2026-10-15; phase 1 (core extraction, desktop only) mostly done 2026-10-16; the phase 0 spike app (`mobile/android-spike`) built 2026-10-16, with first results from one phone in section 7. No mobile host code yet. Claims marked **(unverified)** come from memory, secondary sources or inference and need a device test before we rely on them.

## Summary

- **Most of the TypeScript carries over.** `src/modules/*`, `src/engine/*`, `src/shared/*` and most of `src/renderer/*` don't import Electron or Node, and a test already enforces that for modules and engines. What has to be replaced is the Electron main process (`src/main/*`) and the preloads, which are the code that creates views, keeps sessions apart, checks the network, stores secrets and validates IPC.
- **Recommended platform: a thin native host per OS, starting with Android**, that loads our existing bundles into several system WebViews. That means Kotlin with `androidx.webkit` on Android and later Swift with `WKWebView` on iOS. Capacitor, Tauri 2 mobile and React Native are each built around a single WebView, or treat multiple WebViews as experimental. None of them exposes the per-WebView profile, origin-scoped script injection and per-origin message channel APIs that our isolation model rests on. We could use Capacitor's tooling for builds, but its runtime would not do the job.
- **Android can keep the isolation model.** The building blocks exist: WebView `Profile`s (androidx.webkit 1.9+) stand in for `persist:<id>` partitions, `WebViewAssetLoader` with one https origin per engine stands in for `multicord-engine://`, and `addWebMessageListener` restricted to one origin stands in for the validated bridge. CSP plus native HTTP and WebSockets stand in for `netPolicy`, and Android Keystore stands in for `safeStorage`. **iOS 17+** has equivalents: `WKWebsiteDataStore(forIdentifier:)`, `WKURLSchemeHandler`, `WKContentWorld` and `WKScriptMessageHandler`.
- **Discord is the riskiest part.** Discord's web app is a desktop layout. On phones it is normally pushed toward the native app (unverified exactly how today), and voice and video in a mobile WebView are untested. Discord's terms forbid "unauthorized software designed to modify the services", the same exposure the desktop app has now. Apple's 5.2.2 requires permission from wrapped services. **Plan Discord for sideload and F-Droid builds, and for tablets first.** A store build may have to leave it out or ship it as an unmodified web view.
- **External cameras on Android work in two tiers.**
  - *Tier A (no code):* where the phone's camera HAL exposes a UVC camera through Camera2 (`LENS_FACING_EXTERNAL`), Chromium-based WebViews probably list it in `enumerateDevices` (unverified). Then Discord and our call view see it as a normal camera.
  - *Tier B (works on any USB-host phone):* read the camera in userspace over the USB Host API (libuvc). Send compressed frames (MJPEG or H.264) to the page over a `WebMessagePort`, decode them with WebCodecs, and feed a `MediaStreamTrackGenerator`. A `getUserMedia`/`enumerateDevices` patch, in the style of `screenAudio.ts`, lists it as "USB camera" in Discord and in our own LiveKit view.
- **External cameras on iOS:** USB-C **iPads** (iPadOS 17+) support UVC cameras natively, and Apple says WebKit uses them. **iPhones do not**: Apple's WWDC23 session says "only iPad supports external cameras", and nothing shows that changed through iOS 26.
- **Notifications are the other hard limit.** On Android a foreground service holding the engines' sockets works, though the right service type needs Play policy care. On iOS apps can't keep sockets in the background, and Discord, Fluxer, Stoat and Telegram (as a third-party API client) give us no push channel. On iOS, Multicord would only notify while it is open, except for Matrix through a push gateway.
- **Next step: a 1–2 week Android spike with three questions.**
  1. Does Discord run in an Android WebView with our document-start scripts, including voice and camera?
  2. Does a UVC camera appear in WebView `enumerateDevices` on a couple of phones?
  3. Does a generated video track work as a camera in a Discord call?

## 1. What in Multicord is Electron-specific

| Area | Today | Portable? |
|---|---|---|
| Module engines (`src/modules/*`, `src/engine/runtime.ts`, `src/entries/engine-*.ts`) | Run in sandboxed hidden renderers; reach the shell only through `EngineBridge` (`request`/`emit`/`render`/`onCommand`/`onAction`) | **Yes.** Only `src/preload/engine.ts` (an `ipcRenderer` binding) needs a mobile twin with the same `EngineBridge` interface. |
| Protocol validation (`src/shared/engine.ts`: `isEngineEvent`, `isEngineRequest`, limits) | Main process | **Yes**, pure TS. It must run in a trusted context (see section 4). |
| Shell UI, native chat view, settings, voice (`src/renderer/*`, LiveKit, RNNoise worklet) | Renderer pages | **Mostly.** These are plain web code, but the layout assumes a desktop window (72px rail, side-by-side views) and needs a phone layout. |
| Engine host (`src/main/engineHost.ts`) | `WebContentsView` per engine, `session.fromPartition`, `protocol.handle` for `multicord-engine://`, `webRequest.onBeforeRequest` to allow only WebSockets to allowed hosts, IPC bound to one `webContents` | **No.** Rewrite on the native side. |
| Network policy (`src/main/netPolicy.ts`) | Host allowlists, private-address checks, DNS check, redirect re-check, `performHttp` | The **logic** is portable. The enforcement point (the main process doing the HTTP) moves to native code. |
| Secrets (`src/main/credentials.ts`, `safeStorage`) | Encrypted per instance | Replace with Android Keystore or iOS Keychain. |
| Discord view (`src/main/modules/discord.ts`, `src/preload/discord/*`) | Preload in an isolated world plus `executeInMainWorld` for `storeBridge`, the `Notification` relay and `screenAudioPatch` | The main-world scripts are **portable**. The isolated-world preload must be reworked (section 2). |
| Screen share, system audio (venmic), push-to-talk (uiohook), global shortcuts, tray, Rich Presence (IPC socket and process scan), game detection, auto-update, badge | Electron and Node or native addons | **Drop** on mobile. Possible later: Android MediaProjection screen share, a headset-button PTT, Play or F-Droid updates. |

## 2. Platform options

### Requirements that decide the choice

1. Several **isolated persistent web sessions** (one per account or instance, like `persist:<id>`).
2. **Script injection at document start** into a third-party page (Discord), restricted by origin, ideally into an isolated world.
3. Serving our engine pages from **an origin of their own** (today `multicord-engine://<id>`), and **controlling or bridging their network access**.
4. A **per-WebView, origin-checked message channel** to native code.
5. **Secrets** in Keystore or Keychain.
6. **Background operation** and notifications.
7. **WebRTC** (`getUserMedia`, LiveKit), **WASM** (Matrix Rust crypto) and AudioWorklet in the WebView.
8. **Store policy.**

### Android: native Kotlin host with `android.webkit.WebView` and `androidx.webkit` (recommended)

- **Sessions.** The Multi-Profile API (`ProfileStore`, `Profile`, feature `MULTI_PROFILE`, androidx.webkit 1.9.0) gives each profile its own cookies, storage and service workers. Profiles can be created, listed and deleted by name. This maps directly onto `persist:<instance id>`, and deleting an instance deletes its profile. Older WebView builds without `MULTI_PROFILE` need a fallback: `setDataDirectorySuffix` per process (API 28+), at one process per profile, which is heavy. That fallback is a reason to require a recent WebView. Exactly how a profile is attached to a WebView (`WebViewCompat.setProfile`) and which WebView version is the minimum: unverified.
- **Injection.** `WebViewCompat.addDocumentStartJavaScript(webView, script, allowedOriginRules)` (feature `DOCUMENT_START_SCRIPT`) runs a script before the page's own scripts, only in frames whose origin matches. That is what `screenAudioPatch`, the `Notification` relay and `storeBridge` need. These scripts run in the **main world**. Newer androidx.webkit has `JavaScriptExecutionWorld` and an `addWebMessageListener` overload that receives messages from a given world (feature `JS_INJECTION_IN_FRAME_AND_WORLD`). That is Android's first isolated-world support, but it is new, and its availability on users' WebView versions is unverified. Design for "main world plus native-side validation" and treat isolated worlds as hardening.
- **Message channel.** `addWebMessageListener(webView, "multicord", allowedOriginRules, listener)` injects an object only into matching origins. The listener learns the sending WebView and origin. This is our "bind the IPC to one engine's `webContents`" check, and the native side applies it per WebView.
- **Engine origin.** Serve each engine from `https://<engine-id>.engine.multicord.invalid/` (or a domain we own) through `shouldInterceptRequest` or `WebViewAssetLoader` (which defaults to `https://appassets.androidplatform.net` and can change the domain). An https origin is a secure context, which `crypto.subtle`, WASM streaming, AudioWorklet and `getUserMedia` need. A custom scheme like `multicord-engine://` would not reliably be one (unverified on Android WebView). One origin per engine, in its own Profile, keeps the engines' storage apart twice over.
- **Network control** is the weak spot. `shouldInterceptRequest` sees URL, method and headers but **not request bodies** (unverified, but widely reported), and it does not see WebSocket connections. Plan:
  - (a) Engines already send HTTP through the bridge (`bridgeFetch`), so port `performHttp` and `netPolicy` to Kotlin (OkHttp with a DNS check and per-redirect checks). The TS tests' cases are a shared JSON fixture, `tests/fixtures/netpolicy-cases.json`, so both implementations are tested against the same URLs: private and public hosts, numeric address forms, host patterns, `checkUrl` with its kind of refusal (`invalid`, `scheme`, `credentials`, `private`, `host`), host locks, resolved addresses, the request headers that are dropped, and how each redirect status changes the method. A Kotlin or Swift test reads the same file and must pass every case; `tests/main/netPolicy.test.ts` shows how each is meant.
  - (b) Bridge **WebSockets natively** too (`bridgeWebSocket` in `runtime.ts`, done in phase 1), instead of letting the WebView open them. Native sockets can then also live in the foreground service (section 6). The native side has to keep the rules `src/core/engineSockets.ts` keeps on the desktop: ids it hands out, the host policy, and the caps in `src/shared/engine.ts`.
  - (c) Send a strict CSP header with each engine page (`connect-src 'none'` once WebSockets are bridged). We serve the page, so we control the header. CSP is then the backstop if a module tries a direct `fetch`.
  - A `lockHosts` narrowing then lives entirely in native code.
- **Secrets.** Encrypt each value with a non-exportable Android Keystore AES key and store it in app-private storage, keyed by instance id, as `credentials.ts` does with `safeStorage`.
- **WebRTC, WASM.** Android WebView supports `getUserMedia` once the app holds `CAMERA`/`RECORD_AUDIO` and grants `PermissionRequest.RESOURCE_VIDEO_CAPTURE`/`RESOURCE_AUDIO_CAPTURE` in `onPermissionRequest`. The docs warn to grant only an explicit list of resources. WASM, AudioWorklet and WebCodecs follow the Chromium version of the user's WebView (unverified per feature; see section 3).
- **Verdict:** every requirement is met with first-party APIs. The cost is writing the host in Kotlin.

### iOS and iPadOS: native Swift host with `WKWebView` (second)

- **Sessions.** `WKWebsiteDataStore(forIdentifier:)` (iOS 17 and macOS 14) creates multiple persistent stores. Before that only one persistent store existed. Stores can be listed and removed by UUID. Require iOS 17.
- **Injection.** `WKUserScript` at `.atDocumentStart` in a chosen `WKContentWorld` (`.page` for the main-world patches, a named world for a preload-like layer). This is real isolated-world support, closer to Electron than Android is. Restricting a script to one origin has to be done inside the script or by the navigation delegate (unverified detail).
- **Message channel.** `WKScriptMessageHandler` is registered per WebView and per content world. The message carries the frame's security origin.
- **Engine origin.** `WKURLSchemeHandler` serves a custom scheme. Whether a custom-scheme page counts as a secure context for WASM, AudioWorklet and `getUserMedia` is unverified. Capacitor reports media trouble from `capacitor://` frames. HTTP and WebSockets should go through native code (`URLSession`), as on Android.
- **WebRTC.** `getUserMedia` in WKWebView exists since iOS 14.3. `requestMediaCapturePermissionFor` is available since iOS 15.
- **Policy.** 2.5.6 requires WebKit (fine). Under 2.5.2 our engines are bundled, which is fine. Downloading module code would not be. Under 4.2 the native views make it "app-like". 5.2.2 is the problem: "If your app uses, accesses … or displays content from a third-party service, ensure that you are specifically permitted to do so under the service's terms of use. Authorization must be provided upon request." That puts Discord and probably Telegram's terms in question for an App Store build.

### Cross-platform frameworks

| Option | Several isolated sessions | Origin-scoped document-start injection / isolated world | Own origin and interception | Verdict |
|---|---|---|---|---|
| **Capacitor** | The app is one WebView. `@capacitor/inappbrowser` isolates its single in-app browser from the app (on Android via a separate process, API 28+). There is no per-account multi-profile API. | Not exposed; would need a custom plugin | Serves the app from `https://localhost` / `capacitor://localhost` | Usable as packaging and plugins around our own native code, but every hard part would be custom plugins anyway. No gain over a plain host. |
| **Tauri 2 mobile** (Wry) | Multi-webview was behind an unstable feature flag in the v2 beta. Wry has `data_store_identifier` (iOS). Mobile multi-webview status is unverified. | Initialization scripts (main frame or all frames); no isolated worlds on Android | Custom protocols via `shouldInterceptRequest` and `WKURLSchemeHandler` | Adds Rust to a TS codebase and lags the platform APIs we need (Profiles, origin rules). No. |
| **React Native + react-native-webview** | Per-WebView incognito or shared cookies, but no Profile API (unverified) | `injectedJavaScriptBeforeContentLoaded` (main world) | Limited | The shell would be rewritten in RN. No. |
| **GeckoView** (Android) | `GeckoRuntime` contexts (`contextId`) give per-context storage isolation (unverified detail) | WebExtensions content scripts (isolated worlds) | Extensions can block or redirect | Interesting for isolation and extension-based injection, but adds about 50+ MB and Discord on Firefox mobile is less tested. A fallback idea, not the plan. |
| Electron alternatives (NW.js, etc.) | Desktop only | | | Not applicable. |

**Decision:** native hosts. Shared TypeScript stays the bulk of the app. The Android host is mostly glue: WebView setup, Profiles, bridge routing, HTTP and WebSocket client, Keystore, notifications, a foreground service, file picker, and later the UVC camera.

## 3. Discord on mobile

- **Does `discord.com/app` work in a phone browser?** Discord has no mobile web client. On phones its start page steers you to the app, and users report needing "desktop mode" to get an "open in browser" option (Techlore forum, user report). With a desktop user agent the desktop web app loads, and users report using it in a phone browser for camera in voice channels when the Android app lacked that ("okay but not optimized for mobile"; Discord feedback forum, user post). No primary source for current behaviour was found, so this is **unverified** and spike item 1.
- **Expected problems.**
  - The desktop layout on a 6" screen: we already hide the guild bar, and could inject more CSS, but phone usability will be poor. Tablets and foldables in landscape are a much better first target.
  - hCaptcha at sign-in.
  - Touch input: hover-only controls in the desktop UI.
  - `Notification` is not available in Android WebView (unverified). That is harmless, since our relay replaces it anyway.
  - Voice: WebRTC should work. Background voice needs a foreground service with type `microphone` / `mediaPlayback`, otherwise the WebView's audio stops when backgrounded (unverified).
  - Screen share (`getDisplayMedia`) is not supported in Android WebView (unverified). It would need MediaProjection plus a generated track, the same machinery as the camera work.
- **Our hooks.** `storeBridge`, the notification relay and `screenAudioPatch` are main-world scripts already serialised by function. They carry over to `addDocumentStartJavaScript` / `WKUserScript`. The isolated-world half of `src/preload/discord/index.ts` (validation, `ipcRenderer`) becomes: page posts to `window.multicord` (WebMessageListener, Discord origin only), and native code relays to the shell, where the existing validators (`isBridgePayload`, etc.) run.
- **Account risk.** Discord's Terms (effective 2025-09-29) forbid "using any unauthorized software designed to modify the services" and reverse engineering. They do not mention third-party clients specifically. A WebView of Discord's own client, which reads its stores and changes a few browser APIs, carries the same risk as the desktop Multicord and client mods (BetterDiscord/Vencord-style). Enforcement has historically targeted automation and self-bots rather than mods, but that is not a guarantee (unverified, no official statement). The mobile WebView must keep to the same rules as desktop: never call Discord's APIs itself, never automate, only dispatch `LOCAL_ACTIVITY_UPDATE` (Rich Presence is dropped on mobile anyway).
- **Store risk.**
  - Apple 5.2.2: we cannot show Discord's permission.
  - Google Play has a similar policy on impersonation and unauthorized use of third-party services (unverified wording).
  - F-Droid: allowed, but tagged with the **NonFreeNet** anti-feature ("promote or depend entirely on a proprietary network service"). **Tethered** does not apply, because Multicord does not depend on one service and its open-platform modules take custom instances. AGPL is no obstacle for F-Droid. All dependencies must be free software (no Google Play Services / FCM), which favours sockets and UnifiedPush over FCM.
  - Plan two build flavours: `full` (F-Droid and sideload, with Discord) and possibly `store` (open platforms only, or Discord as a plain unmodified web view).

## 4. External cameras

### 4.1 Android, Tier A: the system's external camera support

- Android supports UVC webcams through the standard Camera2 API and the camera HAL, using the kernel's UVC/V4L2 driver and an external camera provider that enumerates devices as they are plugged in. It requires the USB host feature and `CONFIG_USB_VIDEO_CLASS`. Android positions this for "lightweight" uses like video chat, not high-resolution or high-frame-rate streaming. It has existed in AOSP since Android 9 (hardware level `EXTERNAL`). Camera2 reports such cameras with `LENS_FACING_EXTERNAL`, and Android's guide says "If an external camera is connected, the user probably prefers it as the default". The feature flag is `android.hardware.camera.external`.
- **Device support varies.** Whether a given phone ships the external camera provider is the OEM's choice. Many phones don't (unverified per model; reports suggest some Pixels on recent Android do, and Samsung varies). Android 14 QPR1's "use the phone *as* a webcam" is the opposite direction and does not help.
- **Does WebView see it?** Chromium on Android enumerates cameras through Camera2's camera ID list, so an external Camera2 camera *should* appear in `enumerateDevices` and be openable by `getUserMedia({video:{deviceId}})` in Chrome and WebView. **Unverified.** Old reports (Android 8–9) say WebView did not show USB cameras, but those devices likely had no external HAL. Spike item 2: a test page that lists devices and opens each, run in Chrome and in our WebView, on 2–3 phones with a UVC camera, plus a small Camera2 enumeration check.
- When Tier A works, Discord and our LiveKit view need **no code**. We only add an "external camera detected" hint, and grant `CAMERA`.

### 4.2 Android, Tier B: userspace UVC driver plus a virtual camera in the page

For phones without the external HAL: any phone with USB host/OTG.

1. **Capture natively.** Use the USB Host API (`UsbManager`, a user permission prompt per device, no root) and libuvc over libusb. The usual Android wrappers are saki4510t's *UVCCamera* (libuvc-based) and *AndroidUSBCamera* (jiangdongguo, built on UVCCamera, outputs MJPEG/H.264/YUV). Both look poorly maintained: README support up to Android 10, mirrors marked "update stopped". Either vendor and maintain one, or write a small libuvc JNI layer of our own, around a few hundred lines of C plus Kotlin (estimate). Licences: libuvc is BSD and UVCCamera Apache-2.0 (unverified), both AGPL-compatible.
2. **Choose the format.** Most UVC webcams offer **MJPEG** at 720p/1080p30, at around 50–200 KB per frame. Raw YUY2 at 720p30 is about 55 MB/s. Send MJPEG through untouched, or re-encode to H.264 with `MediaCodec` when the camera only offers YUV.
3. **Transport to the page.** Use a `WebMessagePort` (`createWebMessageChannel`) sending `ArrayBuffer` messages, which androidx.webkit supports (`WEB_MESSAGE_ARRAY_BUFFER`; version unverified). That is roughly 3–6 MB/s for MJPEG at 30 fps, which is fine. Avoid a localhost HTTP or WebSocket server, which any app on the phone could connect to.
4. **Build a track in the page.**
   - Decode with WebCodecs: `ImageDecoder` for JPEG, or `VideoDecoder` for H.264, to `VideoFrame`.
   - Write to `new MediaStreamTrackGenerator({kind:"video"})`. This is Chromium's Breakout Box, shipped around Chrome 94 and marked non-standard on MDN, which points to the standard `VideoTrackGenerator` (worker-only). WebView support follows Chromium (WebView 94+, per MDN compat data; unverified on device).
   - Fallback: draw to a canvas and use `canvas.captureStream(30)`. This works everywhere, costs more CPU, and gives a track whose `getSettings()` reports width, height and frameRate.
5. **Patch `getUserMedia` and `enumerateDevices`** with a document-start, main-world script shaped like `screenAudioPatch`. Serialise it, guard with `__multicord`, and touch only browser APIs, not Discord internals.
   - `enumerateDevices()` appends `{kind:"videoinput", deviceId:"multicord-usb-<n>", label:"USB camera (<name>)", groupId}` while a camera is attached.
   - `getUserMedia(c)`: when `c.video` asks for that deviceId (exact or ideal), call the original for audio only, then add the generated video track. Otherwise pass through.
   - Fire `devicechange` on attach and detach.
   - Implement `track.getSettings()` and `getCapabilities()` to report the real size and frame rate, since Discord and LiveKit read them to choose simulcast layers (unverified for Discord).
6. **Consumers.**
   - Our call view: LiveKit publishes any `MediaStreamTrack` (`new LocalVideoTrack(track)` / `publishTrack`). Voice settings can list the device through the same patched `enumerateDevices`.
   - Discord: its web client calls `getUserMedia` with a deviceId from `enumerateDevices`, so a patched list should be enough. **Spike item 3** is the real proof, checked from a second client. Discord may reject tracks whose settings look odd, or do its own capability probing (unverified).
7. **Performance (estimate).** Under 10% of one core for 720p30 MJPEG decode on a mid-range 2023 phone, plus the WebRTC encode Discord does anyway. 1080p30 is likely fine with `VideoDecoder` and hardware decode. JPEG `ImageDecoder` is software decoding and may cap at 720p (unverified; measure in the spike).

The same pipeline later gives **screen share** on Android: MediaProjection, then `MediaCodec` H.264, then a generated track, with `getDisplayMedia` patched in the same way.

### 4.3 iOS and iPadOS

- **iPad with USB-C, iPadOS 17+:** UVC cameras are first-class `AVCaptureDevice`s (`.external`, position unspecified, connect and disconnect notifications). Apple's WWDC23 session "Support external cameras in your iPadOS app": "iPads with USB-C connectors support external cameras … UVC", and "FaceTime, Code Scanner, and WebKit use external cameras". So **WKWebView `getUserMedia` likely lists them** (unverified on device; test in Safari, then WKWebView). If WKWebView doesn't, the fallback is the Android Tier B pattern with an `AVCaptureSession` source. WebKit lacks `MediaStreamTrackGenerator` (unverified whether `VideoTrackGenerator` shipped in Safari 18+), so use `canvas.captureStream`.
- **iPhone (USB-C models):** not supported. WWDC23: "only iPad supports external cameras". A developer reported in 2025 that iPhone 15 Pro on iOS 18.3 does not discover them, and there was still an unanswered 2025 forum request. No evidence of a change in iOS 26. A userspace UVC driver is not possible on iOS (no raw USB access for App Store apps without MFi or DriverKit, and DriverKit is iPadOS/macOS only; unverified for iPhone).

### 4.4 Network cameras (brief)

These work on both platforms but are native-side features: an RTSP or IP camera, or another phone running an "IP webcam" app (MJPEG over HTTP).
- Decode natively (Media3/ExoPlayer RTSP on Android, or a small MJPEG reader) and feed the same frame channel and virtual device as Tier B.
- Engines must not do this, since `netPolicy` rightly blocks private addresses. It has to be a user-configured host feature.
- NDI's SDK is proprietary and does not fit AGPL distribution, so skip it.

## 5. Proposed architecture for Multicord mobile

```
Native host (Kotlin / Swift)            Shared TypeScript (existing bundles)
-------------------------------          -------------------------------------------
Activity / window layout       ───────►  Shell WebView  (rail, Messages, settings, native chat view,
  phone: rail as drawer                   voice view; + "core": registry, settings controller,
                                          EngineAdapter logic, validators from src/shared)
Bridge router  ◄── per-origin WebMessageListener ──► Engine WebViews (one per instance,
  binds each channel to one WebView                   own Profile/DataStore, origin
                                                      https://<id>.engine…, CSP connect-src none)
Net service (OkHttp/URLSession):  HTTP + WebSocket per engine, netPolicy ported + shared test fixture
Secret store: Keystore / Keychain, keyed by instance id
Discord WebView (own Profile, desktop UA, document-start main-world scripts, origin-locked channel)
Web-client modules: plain WebViews in own Profiles, no scripts
Foreground service (Android): keeps engines + their native sockets alive, posts notifications
Camera service: Camera2 / USB host + libuvc / AVCapture → MessagePort → page virtual device
```

**Where the "main process" logic lives.** `src/main/*` mixed Electron glue with real logic. Phase 1 moved the logic into `src/core`, which imports neither Electron nor Node (a test in `tests/main/modules.test.ts` checks every file; its coverage is held to 100%), and both hosts use it:
- `core/registry.ts`: the rail, every service's servers and DMs in the user's order, and the Messages list.
- `core/layout.ts`: where the rail, content, Messages list and tooltip go (a phone layout will add to it).
- `core/platforms.ts`, `core/services.ts`, `core/modules.ts`: platforms.json and its edits, the module manifest and the list of modules users may add.
- `core/settingsStore.ts`, `core/settingsController.ts`: the settings and the settings page's state and actions. Files come in through `SettingsPersistence` and `PlatformsConfig`; `main/settingsFiles.ts` is the desktop's.
- `core/engineAdapter.ts`: the shell's stand-in for an engine (what it reported, commands to it, its health) and the restart rules.
- `core/engineSockets.ts`: the shell's side of bridged WebSockets.

`src/main` keeps the Electron glue: views, sessions, IPC, the HTTP bridge, the socket relay pages and `netPolicy` (portable too, but the mobile hosts will enforce it natively, against the shared fixture).
- On desktop it keeps running in the main process.
- On mobile it runs in the **shell WebView**, the one trusted page we ship, and native code only does what the Electron APIs did.
- The rule stays the same as now: every engine message is validated by `isEngineEvent` / `isEngineRequest` in trusted code before it reaches state or another view. Engines never get a channel to the shell page directly, only to the native router, which tags each message with the engine's instance id from the WebView it came from.

**Keeping a malicious module from reading another module's data:**
- Storage: one Profile or DataStore per instance, plus a distinct origin per engine.
- Secrets: the native store prefixes keys with the sender's instance id, decided by native code from the WebView identity, never taken from the message (as now).
- Network: no direct network (CSP); native HTTP and WebSockets checked against that engine's allowlist, with locks that only narrow.
- Files: handles only, as now.
- Views: render state goes only to that instance's view; actions come back only to it.
- The shell WebView holds no service credentials.
- The Discord page's channel accepts only the payload shapes the desktop validators accept.
- One weaker point than Electron on Android: no renderer-process sandbox *per* WebView. All WebViews in one app share the WebView renderer process unless multiprocess isolation applies (unverified). A renderer exploit in one engine would reach the others' memory. Electron's per-view sandboxed processes are stronger here. Accept this for v1 and document it.

**What is dropped on mobile:** tray, global shortcuts and keyboard-hook PTT (a headset button or on-screen PTT is possible later), Rich Presence and game detection, venmic system audio, auto-updater (stores and F-Droid update instead), taskbar badges (replaced by a launcher badge from the notification count), start-with-computer.

## 6. Background operation and notifications

- **Android.** Run engines (and their native sockets) in a **foreground service** with a persistent "Multicord is connected" notification, as Element's and Conversations' F-Droid builds do. Type choice:
  - `dataSync` is capped at **6 hours per 24 h** for apps targeting Android 15, so it is unsuitable.
  - `specialUse` needs a justification for Play review (unverified wording). `remoteMessaging` exists as a type (unverified fit).
  - For F-Droid builds this is acceptable either way.
  - Whether a WebView keeps running JS timers and sockets while the activity is stopped needs testing. That is another reason the sockets should be native.
  - Matrix can additionally use push through **UnifiedPush** (ntfy and similar) via a Matrix push gateway, which needs no Google services.
  - Discord, Fluxer, Stoat and Telegram have no third-party push, so they need the socket.
- **iOS.** Apps can't keep sockets open in the background. PushKit is only for real calls and requires CallKit. Ordinary notifications need APNs from a server that knows our device token. Only Matrix supports that (a Sygnal-style gateway that *we* would have to run). Other services would notify only while the app is in front or briefly in the background. That alone makes iOS much less useful for Multicord's main job.

## 7. Phased plan

| Phase | Scope | Rough effort (one developer) |
|---|---|---|
| **0. Spikes (retire the big risks)** | Throwaway Android app, about 300 lines of Kotlin, no SDK beyond androidx.webkit: (1) Discord in a WebView with a desktop UA and Profile: sign-in, messages, voice, camera, document-start script running, tablet and phone; (2) `enumerateDevices` test page plus a Camera2 dump with a UVC camera on 2–3 phones; (3) a fake camera (canvas or generated track) patched into `getUserMedia`, used in a Discord video call and checked from another client; (4) measure MJPEG to VideoFrame decode cost. | 1–2 weeks |
| **1. Core extraction** (desktop benefit too) | Move registry, settings controller and engine-adapter logic out of `src/main` into `src/core`. Shared netPolicy test fixture. A `bridgeWebSocket` in `runtime.ts`, used on desktop too. **Status below.** | 1–2 weeks |
| **2. Android MVP** | Kotlin host, shell WebView with a phone layout (rail as drawer, one view at a time), engine WebViews with Profiles, origin bridge, native HTTP and WebSockets, Keystore secrets, file picker, notifications through a foreground service. Modules: Matrix (including E2EE WASM) and Fluxer first, then Stoat and Telegram. Web-client modules as plain WebViews. F-Droid/sideload APK. | 6–10 weeks |
| **3. Discord on Android** | Discord view with ported hooks, rail and DM integration, call ringing, background voice. Tablet first. | 2–4 weeks (depends on spike 1) |
| **4. External cameras on Android** | Tier A: device listing and grants. Tier B: libuvc JNI, MessagePort transport, page virtual device, LiveKit and Discord. Hot-plug, permission prompts, a device matrix. | Tier A: days. Tier B: 3–6 weeks |
| **5. Voice extras** | Call view on mobile, Android screen share through MediaProjection plus a generated track, headset PTT | 2–4 weeks |
| **6. iPadOS/iOS** | Swift host (iOS 17+), the same structure. External cameras on iPad. Notifications limited. App Store build without Discord. | 6–10 weeks |

**Phase 0 status (2026-10-16).** The spike app is in `mobile/android-spike` (Kotlin, androidx.webkit 1.17.1, minSdk 28; its README says how to build and install it and what to send back). It has one screen per spike: 0.1 Discord in its own Profile, with an optional desktop user agent and an origin-restricted document-start report; 0.2 an `enumerateDevices` page plus a Camera2 and USB dump; 0.3 a generated "Multicord test camera" for that page or for Discord; 0.4 MJPEG to `VideoFrame` decode timing. It builds, and a smoke run on the Android 16 emulator (WebView 134) worked: every feature except `JS_INJECTION_IN_FRAME_AND_WORLD`, the document-start report on discord.com with the desktop user agent (Discord showed its login page), the test camera through `MediaStreamTrackGenerator`, and 720p JPEG decode. An emulator says nothing about phones, so every **(unverified)** above still stands until device results come in.

**First device results (2026-10-16): OnePlus CPH2663, Android 14, WebView 154.0.8037.106.**
- **Features:** all present, including `JS_INJECTION_IN_FRAME_AND_WORLD`, so the isolated-world hardening of section 2 is available on this phone.
- **0.1 Discord:** with the desktop user agent, the document-start script ran in discord.com's top frame and the user signed in and reached `/channels`. Microphone and camera were granted to https://discord.com only. `getDisplayMedia` and `Notification` are absent, as expected. With the mobile user agent `/app` also loaded; how usable it was is not recorded.
- **0.3 Test camera in Discord:** Discord listed "Multicord test camera" next to the 8 real devices, asked for 1280 wide, applied `max 1280x720`, and drew 418 frames in 14.0 s (29.9 fps) through `MediaStreamTrackGenerator`. Whether the far end saw the pattern still needs confirming from a second client.
- **0.2 Cameras:** the 4 built-in cameras list and open at 720x1280, 30 fps. The phone has `usb.host` but no `android.hardware.camera.external`, and a Logitech StreamCam (UVC, USB-C) was not listed by Camera2 or `enumerateDevices`. **Tier A does not work on this phone; Tier B (section 4.2) is needed.** The `[usb]` dump with the camera attached is still to come, to confirm `UsbManager` sees it (vendor `046d`) and that the phone powers it.
- **0.4 Decode:** `ImageDecoder` turns a 720p JPEG into an I420 `VideoFrame` in 4.4 ms on average (p95 6.7 ms), about 13% of a 30 fps frame budget. Decode plus write to a generated track held 30.2 fps for 10 s with no skipped ticks, busy about 41% of the time, with main-thread lag under 5 ms.

**Phase 1 status (2026-10-16).**
- Done: `src/core` as listed in section 5, with the boundary test and full coverage. The desktop behaves as before.
- Done: the shared fixture `tests/fixtures/netpolicy-cases.json` (section 2, (a)).
- Done: `bridgeWebSocket` (`src/engine/runtime.ts`), the socket requests and events with their validators (`src/shared/engine.ts`), and the shell's side (`src/core/engineSockets.ts`), with caps on sockets per engine, frame size and bytes waiting to be sent, and every socket closed when its engine reloads, crashes or goes away.
- Done: on the desktop the bridged sockets open in Chromium's network stack, so they keep the system's proxy settings and certificate store. Electron has no main-process WebSocket on that stack, so each engine gets a relay page (`src/main/webSockets.ts`, `src/preload/relay.ts`, `src/shared/relay.ts`): hidden, sandboxed, no Node, in the engine's own session but on an origin of its own (`multicord-engine://<engine>.relay`) that the engine cannot frame, open or reach, with a preload that exposes nothing to its page. The main process stays the policy point: it checks each socket first, the relay opens only what it is told, and its reports are taken only from that page. On a phone the native net service takes the relay's place.
- Done: Fluxer, Stoat, Spacebar and Nerimity open their sockets through `bridgeWebSocket`; Matrix uses none (its sync is HTTP). The engine page's CSP is `connect-src 'self'`, and the engine's session lets WebSockets through only from its relay page. The smoke test checks both: the Fluxer engine's own WebSocket is refused by its CSP, and a socket it bridges opens in its relay page.
- Left: Telegram. GramJS opens its MTProto sockets itself (`PromisedWebSockets`, through the `websocket` package's browser build) with the `binary` subprotocol and `onopen`/`onmessage`/`onclose`/`onerror` handlers, and listens for the window's `offline` event. A shim needs subprotocols in `socketOpen` and on the relay, `on*` properties on `BridgedWebSocket`, and an esbuild alias for `websocket`; not small, so Telegram's manifest sets `ownSockets`, which keeps `wss:` in its page's CSP and lets its page's own sockets through (same host and address rules). On mobile Telegram needs that shim, or its CSP cannot be `'none'`.
- Phase 1 is otherwise done. On mobile the engine CSP becomes `connect-src 'none'`, with HTTP and sockets in the native net service.

**What to prototype first:** spike 0.1 (Discord in an Android WebView, with voice and camera) together with 0.3 (a generated track accepted as a Discord camera). These decide whether "preferably for Discord too" is possible at all. Spike 0.2 decides whether Tier B is needed for the phones the user owns.

## 8. Risks and unknowns

1. Discord in a mobile WebView: layout, captcha, voice and video, background audio, possible blocking of mobile WebViews. Account action risk, as on desktop.
2. Store policy (Apple 5.2.2, Play): Discord, and maybe Telegram, could block store builds. F-Droid gets the NonFreeNet tag.
3. WebView feature availability on users' devices: `MULTI_PROFILE`, `DOCUMENT_START_SCRIPT`, ArrayBuffer messages, isolated worlds, Breakout Box. We should require a minimum WebView version and check `WebViewFeature.isFeatureSupported` at start.
4. Shared WebView renderer process: weaker isolation than Electron's per-view sandbox.
5. UVC userspace stack maintenance, and per-camera quirks.
6. Android background limits (foreground service types, OEM battery killers).
7. iOS: no background sockets, no external cameras on iPhone.
8. A desktop-first UI needs a real phone layout. This is a UI project of its own.

## Not verified (needs a device or a primary source)

- Whether Android System WebView's `enumerateDevices` / `getUserMedia` list Camera2 `LENS_FACING_EXTERNAL` cameras, and which current phones ship the external camera HAL.
- How Discord's web app behaves today in an Android WebView or WKWebView with a desktop or mobile UA: redirect, interstitial, voice and video.
- Whether Discord accepts a generated or canvas video track as a camera (`getSettings`/capabilities checks).
- WebView minimum versions for `MULTI_PROFILE`, `JS_INJECTION_IN_FRAME_AND_WORLD`, ArrayBuffer `WebMessage`, `MediaStreamTrackGenerator`, and whether WebView supports `getDisplayMedia` or `Notification`.
- `shouldInterceptRequest` lacking request bodies, and secure-context status of custom schemes on Android WebView and WKWebView.
- Whether WKWebView `getUserMedia` lists iPad external cameras, and `VideoTrackGenerator` in Safari.
- Tauri 2 mobile multi-webview status, and Play's wording for `specialUse` / `remoteMessaging` foreground services and for third-party service wrappers.
- Maintenance state and licences of UVCCamera and AndroidUSBCamera.

## Sources (all accessed 2026-10-15)

- Android, External USB cameras (AOSP): https://source.android.com/docs/core/camera/external-usb-cameras
- Android, Camera lenses and capabilities (`LENS_FACING_EXTERNAL`, external first): https://developer.android.com/media/camera/camera2/camera-enumeration
- Android, Use a device as a webcam (Android 14 QPR1): https://source.android.com/docs/core/camera/webcam
- androidx.webkit `ProfileStore` / `Profile` (Multi-Profile, 1.9.0): https://developer.android.com/reference/androidx/webkit/ProfileStore, https://developer.android.com/jetpack/androidx/releases/webkit
- androidx.webkit `WebViewCompat` (`addDocumentStartJavaScript`, `addWebMessageListener`, `JavaScriptExecutionWorld`): https://developer.android.com/reference/androidx/webkit/WebViewCompat
- Android `PermissionRequest`: https://developer.android.com/reference/android/webkit/PermissionRequest
- Android, Load in-app content (`WebViewAssetLoader`): https://developer.android.com/develop/ui/views/layout/webapps/load-local-content
- Android, Foreground service timeouts (Android 15 `dataSync` 6 h): https://developer.android.com/develop/background-work/services/fg-service-timeout
- Apple WWDC23, Support external cameras in your iPadOS app: https://developer.apple.com/videos/play/wwdc2023/10106
- Apple Developer Forums, external cameras not discovered on iPhone (iOS 18.3 report), and 2025 iPhone question: https://developer.apple.com/forums/thread/735004, https://developer.apple.com/forums/thread/761184
- WebKit blog, Building Profiles with new WebKit API (multiple persistent data stores, iOS 17): https://webkit.org/blog/14423/building-profiles-with-new-webkit-api/
- WKWebView WebRTC since iOS 14.3 (Kiosk Pro support note, Ionic forum): https://support.kioskgroup.com/article/920-webrtc-getusermedia-not-supported, https://forum.ionicframework.com/t/webrtc-in-ios-14-3-iframe-wkwebview-external-resource/202088
- Apple App Review Guidelines (2.5.2, 2.5.6, 4.2, 5.2.2): https://developer.apple.com/app-store/review/guidelines/
- Apple PushKit, responding to VoIP notifications (CallKit requirement): https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit
- Discord Terms of Service (effective 2025-09-29): https://discord.com/terms
- Discord feedback forum, using the desktop web app in a phone browser for camera (user report): https://support.discord.com/hc/en-us/community/posts/360063500211
- Techlore forum, Discord on mobile via desktop mode (user report): https://discuss.techlore.tech/t/how-do-you-use-discord-on-mobile/8298/4
- MDN, `MediaStreamTrackGenerator` (non-standard; see `VideoTrackGenerator`): https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrackGenerator
- Chrome Developers, Video processing with WebCodecs: https://developer.chrome.com/docs/web-platform/best-practices/webcodecs
- Capacitor InAppBrowser (storage isolation, separate process on Android): https://capacitorjs.com/docs/apis/inappbrowser
- Tauri v2 beta announcement (multi-webview behind an unstable flag): https://v2.tauri.app/blog/tauri-2-0-0-beta/
- F-Droid Inclusion Policy and Anti-Features: https://f-droid.org/en/docs/Inclusion_Policy/, https://f-droid.org/en/docs/Anti-Features/
- AndroidUSBCamera (UVCCamera-based wrapper; fork shown): https://github.com/apps-in/AndroidUSBCamera
- Stack Overflow (archived), USB camera not visible in Android WebView (2018, anecdotal): https://dev.library.kiwix.org/content/stackoverflow_en_nopic_2021-08/questions/52092939/access-an-external-usb-camera-from-the-webview-in-android
