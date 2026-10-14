# Unified chat client: Discord + alternatives integration study

Oct 12, 2026 · @Plannie from Planaday

## Executive summary

Build a standalone Electron app that hosts Discord's web client as one partitioned view and Matrix, Fluxer, Stoat and others beside it, all behind one unified server rail. This lowers the barrier for people to try Discord alternatives without leaving the app they already use.

Key decisions so far:

- **Route:** an Electron shell, not a BetterDiscord plugin. The shell gives storage isolation, control over CSP and native features, and an independent update cadence.
- **Discord integration:** a "hidden engine" model. Discord's genuine web client handles login, the gateway and DAVE-encrypted voice; a minimal preload reads its state to drive our rail. No custom protocol client, no version spoofing, no loading Discord's native binaries.
- **Discord UI:** hide Discord's guild bar via CSS and replace it with our own rail, including a DM entry and unread DM badges.
- **Feature parity:** do not chase full parity in v1. Ship tray, notifications, updater and screen share with audio first; push-to-talk and Rich Presence next; never the in-game overlay.
- **Other platforms:** Matrix first as a native adapter; Fluxer and Stoat as embedded web views first, promoted to native adapters later behind one TypeScript adapter interface.
- **Starting point:** consider forking Vesktop (GPL-3.0, verify) to inherit solved problems, at the cost of rebasing on upstream.

The biggest standing risks are Discord ToS exposure for users, ongoing breakage when Discord updates its front end, and desktop-only reach.

## Route 1 evaluated: a BetterDiscord plugin

A BetterDiscord plugin is technically feasible but was rejected as the main route. Plugins run in Discord's renderer with access to its React and webpack modules, so a plugin could bundle `matrix-js-sdk`, inject spaces into the guild bar and mount its own chat view.

Why it was set aside:

- **Fragility.** Discord ships minified bundles whose module paths and class names change often; the guild bar and chat layout are among the most reshuffled parts.
- **Store contamination.** Feeding Matrix data into Discord's Flux stores could trigger side effects (acks, read states, API calls) and leak Matrix content to Discord. Any plugin would need its own state and components.
- **Security model.** Matrix access tokens and E2EE keys would live on the discord.com origin, readable by Discord's code and every other plugin. WASM crypto may also clash with Discord's CSP.
- **Voice.** Discord's voice runs through native modules; Matrix calling would be a separate WebRTC stack with no shared devices, overlay or push-to-talk.
- **Reach.** BetterDiscord is desktop only and used by a technical minority, the people least in need of a lower switching barrier.
- **ToS.** Client mods violate Discord's ToS. Discord has been [largely indifferent](https://github.com/Vendicated/Vencord) so far, but a mod built to move users to competitors gives it a reason to act.

One point in BetterDiscord's favour: plugins are single drop-in `.plugin.js` files, while Vencord user plugins must be compiled from source.

## Route 2 recommended: an Electron shell

The app is our own Electron program in which Discord's web client is one guest among several. [Vesktop](https://github.com/Vencord/Vesktop/releases/tag/v1.6.6) proves the Discord-in-your-own-shell part is viable and maintainable; Ferdium and Rambox are prior art for multi-service windows, but keep services as separate tabs. Our differentiator is one unified rail.

Structure:

- **Main process** owns one `BaseWindow` with several `WebContentsView`s (not the deprecated `BrowserView`), plus IPC, tray, notifications and `safeStorage`.
- **Shell UI view** renders the unified server rail and, eventually, our own chat UI for native adapters.
- **Discord view** loads discord.com in the `persist:discord` partition with a minimal preload.
- **Platform views** load Matrix, Fluxer, Stoat or other web clients, each in its own partition.

&#91;embedded content: shell architecture · main process, 3 view types, external services\]

Only the shell UI talks to Matrix directly; Discord, Fluxer and Stoat traffic comes from each platform's own web client inside its partition.

Why this beats the plugin route:

- **Isolation.** Each view has its own session, so Discord's JavaScript cannot read Matrix tokens or keys. Tokens at rest are encrypted with `safeStorage` (OS keychain or DPAPI).
- **Control.** We own the CSP of our views, so WASM crypto, websockets and Element Call embedding just work.
- **Security hygiene.** `contextIsolation` and `sandbox` stay on; the Discord preload exposes only a narrow `contextBridge` API, validated on the IPC side.

Distribution overhead: Windows code signing (Azure Trusted Signing is the cheaper option), macOS notarization, AppImage/Flatpak on Linux, `electron-updater`, and prompt Electron upgrades since we ship a browser engine. Expect 100 MB+ per platform.

## Discord integration: hidden engine and unified rail

Target the middle integration tier: hide Discord's guild bar with CSS, read its guild list through a minimal preload, and render Discord servers and other platforms interleaved in our rail.

| Tier | What we do | Seamlessness | ToS and breakage exposure |
| --- | --- | --- | --- |
| Shallow | Discord is one rail icon; unread count from title or favicon | Low, feels like two apps | Minimal |
| Middle (chosen) | CSS hides guild bar; preload reads guilds; rail mixes platforms | High | Small client-mod footprint |
| Deep | Patched internals and notification hooks, Vesktop-style | Highest | Highest, frequent breakage |

**Hidden-engine principle.** Discord's genuine web client keeps doing login, gateway and DAVE voice. Our preload reads its stores and relays our UI's actions back in. Discord only ever sees real web-client traffic, so there is nothing to spoof.

**Navigation.** Never use `loadURL()` to switch servers or DMs; it reloads the app and reconnects the gateway. Call Discord's internal router (the function client mods know as `transitionTo`), with `history.pushState()` plus a dispatched `popstate` event as a fallback.

### Discord DMs

DMs are the route `/channels/@me`, and a conversation is `/channels/@me/<channelId>`. Hiding the guild bar removes only the Home button; the DM list in the channel sidebar stays.

1. **Level 1, Home entry.** A rail icon that routes to `/channels/@me`. Near-trivial; ship with the hidden guild bar.
2. **Level 2, DM bubbles.** Rebuild Discord's unread DM avatars with mention counts. The preload reads the private-channel, read-state and user stores and sends a compact summary over IPC. About a week; ship before release, since missing badges feel like a regression.
3. **Level 3, unified Messages tab.** One list of Discord and Matrix DMs sorted by recent activity. Clicking routes the right view; Discord's own DM sidebar is hidden via CSS. Builds on level 2 plus last-message timestamps and previews.

**Incoming calls.** When another view is in front, Discord's ring UI is hidden. The preload must detect incoming calls from call state and notify the shell, which shows its own ring or switches to the Discord view. All notifications route through the main process so they work regardless of the visible view.

## Desktop feature parity

Practical parity with Discord's desktop app, excluding the overlay, is roughly 3 to 5 months of full-time work for one developer from scratch, or 1 to 2 months by forking Vesktop. Estimates assume a developer comfortable with TypeScript and Electron.

| Feature | Effort | Notes |
| --- | --- | --- |
| Tray, minimize-to-tray, autostart, single instance | \~1 week | Standard Electron APIs |
| Notifications, unread badges, taskbar flash | \~1 week | Unify badges across platforms; per-OS badge APIs |
| Spellcheck, zoom, window state, titlebar | Days | Mostly built in |
| Installer, auto-updater, code signing | 1–2 weeks | CI and certificates; blocks release |
| Screen share with picker and system audio | 3–6 weeks | See the screen share section |
| Global keybinds and push-to-talk | 2–4 weeks | Native hook (`uiohook-napi`); Wayland GlobalShortcuts portal; inject input into Discord view |
| Game detection and Rich Presence | 1–2 weeks | arRPC-style local RPC server plus process scanning; pushing activity is client-mod territory |
| Noise suppression | 1–2 weeks | Krisp is proprietary; RNNoise WASM in an AudioWorklet, or Discord web's built-in suppression |
| Streamer mode auto-detect | Days | Detect OBS and similar processes |
| `discord://` deep links | Days | Conflicts with an installed official client |
| In-game overlay | Skip | Game-process injection; anti-cheat risk |
| Native voice engine | Not possible | Closed module; WebRTC voice is close enough |

**Vesktop fork option.** Vesktop already solves Rich Presence, Linux screen-share audio, tray and macOS permission issues. Catches: it is GPL-3.0 as far as known (verify, plus bundled pieces like arRPC and venmic), it means rebasing on every upstream release, and it ships Vencord preinstalled, which we would keep, strip or replace.

**Maintenance is the real cost.** Electron upgrades break native modules and capture; Discord UI changes break the preload and CSS; OS updates change permissions. Budget a few days a month indefinitely, more around Discord redesigns.

**v1 scope.** Tray, notifications and badges, spellcheck, updater and basic screen share: about 4 to 6 weeks on top of the shell. Push-to-talk and Rich Presence next.

## Screen share with audio

Screen share with audio is achievable on all three desktop platforms by intercepting Discord's `getDisplayMedia()` call and returning our own video source and audio track. Discord then encodes the stream and handles DAVE encryption itself.

**Interception.** Register `setDisplayMediaRequestHandler` on the Discord partition (not `defaultSession`) and show our own picker, since Discord's picker is not in the web build:

```ts
import { session, desktopCapturer } from "electron";

const discordSession = session.fromPartition("persist:discord");

discordSession.setDisplayMediaRequestHandler(async (request, callback) => {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
  });
  const chosen = await showPicker(sources); // our own picker UI
  if (!chosen) return callback({});
  callback({
    video: chosen.source,
    audio: chosen.platformLoopback ? "loopback" : undefined,
  });
});
```

**The real problem is echo.** Whole-system loopback includes the other call participants' voices, who then hear themselves. The goal is "system audio except our app" or, better, "only the shared app", as the official client does.

| Platform | Approach | Echo handling | Effort |
| --- | --- | --- | --- |
| Windows | `audio: 'loopback'` works out of the box | Try the `restrictOwnAudio` constraint; else a WASAPI process-loopback native module (exclude our PID, or include only the game's PID) | Days, or 1–2 weeks with native module |
| macOS | `audio: 'loopback'`; Electron 39+ uses the CoreAudio Tap API on 14.2+ ([docs](https://electronjs.org/de/docs/latest/api/desktop-capturer)) | Test whether our call audio is included; else a native tap with process exclusion | Days if it behaves |
| Linux | Chromium cannot capture; reuse [venmic](https://github.com/Vencord/venmic) (PipeWire virtual mic with include/exclude rules) or its fork Equimic | Exclude rules built in | \~1 week, plus distro bug tail |

macOS needs the `NSAudioCaptureUsageDescription` Info.plist key on 14.2 and later; before macOS 13 system audio capture is unsupported. On Linux, expect Wayland portal and PipeWire issues, such as a broken picker when `DBUS_SESSION_BUS_ADDRESS` is unset. Check venmic's license before bundling.

**Joining our audio to Discord's stream.** When audio comes from our own code (Windows native module, Linux venmic), patch `getDisplayMedia` in the page's main world:

```ts
const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);

navigator.mediaDevices.getDisplayMedia = async (constraints) => {
  const stream = await original({ ...constraints, audio: false });
  const audioTrack = await window.__shell.getShareAudioTrack();
  if (audioTrack) stream.addTrack(audioTrack);
  return stream;
};
```

On Linux the track is `getUserMedia` on the venmic device. On Windows, PCM from the native module streams over a `MessagePort` into an AudioWorklet and out through `MediaStreamAudioDestinationNode`.

**Caveats.** Discord web may downmix stream audio to mono; test early. Resolution and frame-rate caps are partly client-side (loosenable) and partly Nitro-gated on the server. The shared picker UI takes about a week. Start with Windows to validate the flow end to end.

## Rejected and high-risk approaches

Four ways of integrating more directly with Discord were considered; none beats the hidden-engine model on risk versus effort.

| Approach | Verdict | Main reason |
| --- | --- | --- |
| Official bot / OAuth2 APIs | Not viable | Bots are separate accounts; no scope reads and sends a user's messages across servers |
| Discord Social SDK | Not viable | Built for games; comms access needs account linking, Rich Presence, invites and friends list; DMs capped at 100 sends per 2 hours ([docs](https://docs.discord.com/developers/discord-social-sdk/core-concepts/communication-features)) |
| Unofficial user-token client | Possible later, high risk | Most seamless UX, but a ToS gray zone; must look like an official client or trigger captchas and flags |
| Loading Discord's native `.node` modules | Not worth it | ABI coupling, silent interface churn, macOS library validation, low payoff |

### Unofficial protocol client

This is what Ripcord, Abaddon and the mautrix-discord bridge do. Voice is now more feasible than before: Discord has required DAVE support for all calls since early March 2026, and both the protocol and implementation are [open source](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted), so libdave plus WebRTC is a documented path. If ever built, ship it as a clearly labelled third-party client and tell users their account carries some risk.

### Calling Discord's binaries

Mechanically possible: an Electron app can `require()` a `.node` addon from the user's Discord install without redistributing it. In practice:

- **ABI coupling.** Non-N-API modules only load against Discord's exact Electron/Node version, which would pin ours and delay security updates.
- **Interface churn.** Undocumented interfaces change whenever Discord updates.
- **Platform locks.** macOS hardened runtime blocks libraries signed by another team unless library validation is disabled, a security and notarization concern. Some modules may check their caller; Vesktop not offering Krisp suggests that one is unusable outside Discord (verify).
- **Low payoff.** Voice has an open alternative (DAVE/libdave), game detection is reimplemented by arRPC, the overlay is out of scope.

Legally it is a gray zone: interface discovery for interoperability fits EU law best, but Discord licenses its software for use as Discord, so loading its components elsewhere likely falls outside the license and ToS.

### Version spoofing

Old clients keep working for weeks because Discord avoids disrupting connected sessions, not because it cannot distinguish clients. It can and does cut old versions off, as the [DAVE requirement](https://thenextweb.com/news/discord-end-to-end-encrypted-voice-video-all-users) did for voice in March 2026. Spoofing also fails on its own terms:

- A population stuck on one old build is itself an anomaly; claiming the current build means also behaving like it.
- The server sees far more than a version string: TLS and HTTP/2 characteristics, gateway behaviour, API call patterns, all analysable retroactively.
- If Discord ever acts, every user of the app is hit at once.

The hidden-engine design makes spoofing unnecessary: the app runs the genuine, current web client by definition.

## AI decompilation: relevance and limits

The 2026 wave of AI decompilation does not unlock Discord's native features in a practical or legal way, but it makes behaviour-level reimplementation and hook maintenance much cheaper.

**How it is done.** Agents perform *matching* decompilation: write C for one function, compile with the original toolchain, diff byte for byte, iterate. The compiler acts as a referee. One developer decompiled all 2,145 functions of N64 Snowboard Kids in 84 days versus 596 days for its sequel by hand ([AI Signal](https://aisignal.day/en/ai-game-decompilation-2026/)). Limits remain: agents get struct offsets and compiler quirks wrong, and that project would have stalled around 89–90% without human experts. A related technique is behavioural cloning: recreating a program from its observable behaviour without its source.

**Relevance here.**

- **Discord's JavaScript** ships readable (minified, not compiled). AI helps navigate it to find stable hooks; no decompilation needed.
- **Native modules** (voice, Krisp, overlay, game detection) are modern optimized C++ with unknown toolchains, so byte-matching is off the table. They embed large third-party code such as a WebRTC fork and Krisp.
- **Behavioural cloning fits.** The desktop client's JavaScript reveals what each native module exposes. We map that and implement equivalents with open components (arRPC, RNNoise, WebRTC), using tests on observable behaviour as the referee.
- **Best use: maintenance.** A harness loads the Discord view and checks every hook still resolves. On failure, an agent diffs old and new bundles and proposes a fix: a problem with a real referee.

**Legal limits (EU, not legal advice).** Article 6 of the EU Software Directive allows decompilation only to obtain interoperability information not otherwise available, and forbids building a program substantially similar in expression. Contract terms overriding that narrow right are void, but Discord can still enforce its ToS against accounts. Interface knowledge is closest to the permitted purpose; copying decompiled code is not, and AI rewording does not create independent authorship. It would also contaminate a GPL fork. If binaries are ever studied, use a clean room: one party documents behaviour, another implements from those notes only. Leave Krisp and the overlay alone entirely.

## Alternative platforms

Matrix, Fluxer and Stoat are the integration targets; Spacebar is one to watch. Discord's February 2026 age-verification announcement drove a migration wave that reshaped this field. Guilded is out: Roblox [shut it down](https://en.wikipedia.org/wiki/Guilded) on December 19, 2025.

| Platform | Open source | Self-host | API and client friendliness | Integration fit |
| --- | --- | --- | --- | --- |
| Matrix | Yes | Yes, federated | Open spec, mature SDKs, E2EE | Excellent; first native adapter |
| [Fluxer](https://docs.fluxer.app) | Yes (AGPL) | Yes | Discord-like API; docs cover client APIs and encourage third-party clients | Excellent; second integration |
| Stoat (ex-Revolt) | Yes | Yes | Public REST plus websocket; Discord migration tool exists | Very good; voice unreliable |
| [Spacebar](https://docs.spacebar.chat/) | Yes | Yes | Reimplements Discord's API so Discord clients can connect | Watch; alpha |
| Root | No | No | Unknown | Defer; treat like Discord |
| TeamSpeak, Mumble | Mixed | Yes | Voice-centric | Later, as voice-only entries |

**Fluxer.** Its API is intentionally Discord-like, and the gateway protocol is the part most likely to stay compatible, so Discord-style websocket code often transfers. Docs explicitly cover client-specific APIs. Caveat: a public beta largely built by one developer.

**Stoat.** Largest open-source clone, past 1 million registered users in early 2026. Servers, channels and roles map nearly one-to-one onto the rail, and a Discord-to-Stoat migration tool fits the switching pitch. A migration tool notes [voice channels may not work yet](https://pypi.org/project/discord-ferry/2.11.0/) because of a known Stoat bug.

**Spacebar.** Aims for any discord.com client to connect to its instances, so Discord integration code could in theory target it. As of early 2026, screen sharing, full API coverage and E2EE were incomplete.

**Others.** Root is proprietary with Discord server import. Nerimity is a smaller open-source option worth watching. Zulip, Rocket.Chat and Mattermost are team tools rather than Discord-style communities and are out of scope.

## Multi-platform integration plan

Every platform plugs into the shell through one TypeScript adapter interface, implemented either by an embedded web view or by a native adapter. The rail, unified Messages tab and notifications consume only that interface, so adding a platform never touches shell code.

### Two integration modes

| Mode | How it works | Strengths | Costs | Used for |
| --- | --- | --- | --- | --- |
| Embedded web view | Platform's own web client in a partitioned view; preload reads state, CSS hides its server bar | Fast to add; full platform features incl. voice | Depends on the platform's front-end internals | Discord (permanently), Fluxer and Stoat initially |
| Native adapter | We talk to the platform API and render in our own UI | Unified UX, shared notifications, full control | Most work per platform, especially voice | Matrix from day one; Fluxer, Stoat later |

Open-source web clients are far less painful to embed than Discord: their internals are public, breakage can be read in the source, and a small state API can be contributed upstream.

### Shared concept model

| Shell concept | Discord | Matrix | Fluxer | Stoat |
| --- | --- | --- | --- | --- |
| Account | User session | User on a homeserver | User on an instance | User on an instance |
| Server | Guild | Space | Guild | Server |
| Channel | Channel | Room in a space | Channel | Channel |
| DM | DM / group DM | Direct room | DM | DM / group |
| Unread | Read states | Notification counts | Read states | Unreads |

Mismatches to design for: Matrix power levels, threads and federation do not map onto role-based UIs; one account can join many Matrix homeservers or Fluxer/Stoat instances, so accounts and instances are first-class in the rail.

### Adapter interface (draft)

```ts
type PlatformId = "discord" | "matrix" | "fluxer" | "stoat" | (string & {});

interface AccountRef { platform: PlatformId; instance: string; accountId: string; }

interface RailServer {
  key: string;            // stable across sessions
  account: AccountRef;
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
}

interface DirectConversation {
  key: string;
  account: AccountRef;
  title: string;
  avatarUrl?: string;
  lastActivity: number;   // epoch ms, for the unified Messages tab
  preview?: string;       // optional; some modes cannot provide it
  unread: boolean;
  mentions: number;
}

interface IncomingCall { conversationKey: string; from: string; video: boolean; }

interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly mode: "webview" | "native";
  readonly capabilities: {
    directMessages: boolean;
    messagePreviews: boolean;
    voice: boolean;
    screenShare: boolean;
  };

  connect(account: AccountRef): Promise<void>;
  disconnect(): Promise<void>;

  listServers(): Promise<RailServer[]>;
  listDirectConversations(): Promise<DirectConversation[]>;

  // Push updates; the shell re-renders the rail and Messages tab.
  onServersChanged(cb: (servers: RailServer[]) => void): () => void;
  onDirectsChanged(cb: (dms: DirectConversation[]) => void): () => void;
  onNotification(cb: (n: { title: string; body: string; target: string }) => void): () => void;
  onIncomingCall(cb: (call: IncomingCall) => void): () => void;

  // Navigation: web-view adapters route inside their SPA; native ones open our view.
  openServer(key: string): Promise<void>;
  openConversation(key: string): Promise<void>;
}
```

Web-view adapters implement this by relaying preload data over IPC; native adapters implement it with the platform SDK. `capabilities` lets the shell hide features a platform or mode cannot support rather than faking them.

### Per-platform plan

1. **Discord: web view, permanently.** Hidden-engine model; rail data, DM bubbles and call detection from the preload. Never promoted to native.
2. **Matrix: native adapter.** `matrix-js-sdk` with Rust crypto (WASM) in a worker; sliding sync for fast startup; device verification, cross-signing and key backup UX; Element Call embedded for voice and video. Tokens via `safeStorage`.
3. **Fluxer: web view, then native.** First promotion candidate, because its Discord-shaped API and gateway align with models the shell already handles. Use its documented client APIs.
4. **Stoat: web view, then native.** REST plus websocket adapter; keep voice in its web client until Stoat voice stabilizes.
5. **Spacebar: watch.** Re-evaluate once screen share and API coverage mature; test whether Discord-side code can target its instances.
6. **Root, TeamSpeak, Mumble: defer.** Root as a web view like Discord if it ships one; voice-first apps as voice-only rail entries later.

### Cross-platform features

- **Unified rail:** servers from all adapters, grouped or interleaved by user preference, with per-account badges.
- **Unified Messages tab:** `listDirectConversations()` from every adapter, sorted by `lastActivity`.
- **Notifications and calls:** every adapter's events go through the main process, so alerts, badges and ringing work whichever view is visible.
- **Health checks:** an automated harness per web-view adapter verifies hooks after platform updates; AI-assisted repair proposals on failure.

## Phased roadmap

Ship Discord integration and desktop basics as v1 first, then add Matrix natively and broaden to Fluxer and Stoat once the adapter interface is proven.

&#91;embedded content: roadmap · 6 phases, 3 gates\]

Durations are shown only where they were estimated; Matrix and the native promotions still need sizing. Push-to-talk and Rich Presence can move earlier if gamers in the early user base ask for them.

## Risks and open questions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Discord acts against client mods or third-party shells | Users lose accounts; app unusable for Discord | Hidden-engine model, minimal preload, no spoofing, honest risk disclosure to users |
| Discord front-end changes break hooks | Rail, badges or calls stop working | Health-check harness, resilient module finders, AI-assisted repair, fast releases |
| Electron/OS updates break capture or native modules | Screen share or PTT regressions | Pin and test Electron upgrades; per-OS CI smoke tests |
| Desktop only | Users still need separate mobile apps | Accept for v1; recommend each platform's mobile app |
| Early-stage alternatives (Fluxer beta, Stoat voice, Spacebar alpha) | Adapters chase moving targets | Start as web views; promote only once stable |
| Licensing (GPL fork, venmic, arRPC) | Constrains our license | Verify licenses before forking or bundling |
| Matrix keys in our app | Security responsibility | Partition isolation, `safeStorage`, verification and key backup UX |

Open questions:

- [ ] Fork Vesktop or build from scratch?
- [ ] Does our Electron's Chromium honour `restrictOwnAudio` on Windows?
- [ ] Does the macOS CoreAudio tap path include our own call audio?
- [ ] Does Discord web downmix stream audio to mono?
- [ ] Licenses of Vesktop, venmic/Equimic and arRPC.
- [ ] Interleave platforms in the rail, or group them per platform?
- [ ] Is a legal review of the Discord integration approach worthwhile before public release?

## Sources

- [Vencord README: client mods and Discord ToS](https://github.com/Vendicated/Vencord)
- [Vesktop v1.6.6 release notes](https://github.com/Vencord/Vesktop/releases/tag/v1.6.6)
- [venmic: PipeWire screenshare audio](https://github.com/Vencord/venmic)
- [Electron desktopCapturer documentation](https://electronjs.org/de/docs/latest/api/desktop-capturer)
- [Discord: every voice and video call is now E2EE](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted)
- [The Next Web on DAVE enforcement](https://thenextweb.com/news/discord-end-to-end-encrypted-voice-video-all-users)
- [Discord Social SDK communication features](https://docs.discord.com/developers/discord-social-sdk/core-concepts/communication-features)
- [AI Signal: AI game decompilation and legal lines](https://aisignal.day/en/ai-game-decompilation-2026/)
- [Chris Lewis: using coding agents to decompile N64 games](https://blog.chrislewis.au/using-coding-agents-to-decompile-nintendo-64-games/)
- [Fluxer developer docs](https://docs.fluxer.app)
- [Spacebar docs](https://docs.spacebar.chat/)
- [Discord-to-Stoat migration tool (Ferry)](https://pypi.org/project/discord-ferry/2.11.0/)
- [Wikipedia: Guilded](https://en.wikipedia.org/wiki/Guilded)
- [Wikipedia: Fluxer](https://en.wikipedia.org/wiki/Fluxer)
- [Vecosys: Discord alternatives 2026](https://www.vecosys.com/best-discord-alternatives-2026/)
