# Multicord

A unified chat client: Discord's genuine web client plus alternative platforms behind one server rail.
See `Unified chat client Discord + alternatives integration study.md` for the design rationale.

## Getting started

```sh
npm install
npm start          # build and launch
npm test           # run the test suite
npm run coverage   # tests with the 95% coverage gate
npm run check      # typecheck + coverage; run this before pushing
npm run gallery    # build and open the component gallery in your browser
npm run dist       # build installers into release/ (electron-builder)
```

If `npm start` reports that Electron failed to install, run `node node_modules/electron/install.js`.

**Releases.** `npm run dist` builds an NSIS installer on Windows, a DMG on macOS and an AppImage on Linux; `npx electron-builder --publish always` (with a `GH_TOKEN`) uploads them to the GitHub releases, where installed copies find updates. Installed copies check for updates at start and every six hours, download them in the background and install them on restart (Settings > About also checks on request); runs from source never update themselves. Not yet done: code signing (Windows Azure Trusted Signing or a certificate, macOS notarization; configure `win.signtoolOptions`/`mac.identity` and `notarize` in the `build` section of `package.json`), and a full-size app icon (`static/icon.png` is 32×32; installers want at least 256×256).

## What v0.1 does

- **Platform modules:** every platform is a module with a manifest in `src/main/modules` (id, label, colour, which view it uses, whether users may add instances, and for native modules its engine, hosts and capabilities). The shell knows platforms only through this interface; a new platform is a new module, with no changes to the shell. The built-in modules are `discord`, `fluxer`, `telegram` and `web`.
- **Isolated module engines:** a native module's logic (Fluxer, Telegram) does not run in the main process. It runs in an *engine*: a hidden renderer with Chromium's sandbox, no Node, its own in-memory session, and a page on its own origin (`multicord-engine://<module>`) with a strict CSP. The engine reaches the shell only through a bridge the main process validates and binds to that one engine:
  - its own secrets (stored encrypted with `safeStorage`, under its instance id; it cannot name another instance's keys),
  - HTTP through the main process with the engine's own cookie-less session: https only, never local or private addresses, only the module's declared hosts if it declares any, each redirect checked again,
  - WebSockets only to the same allowed hosts,
  - files only through handles for what the user picked for it,
  - display state only to its own view, and that view's actions only back to it.

  A module therefore cannot read another module's tokens, cookies, storage or messages. Code under `src/modules` and `src/engine` may not import Electron, Node or main-process code; a test enforces it. Web-view modules (Discord, generic web apps) run their pages in their own sandboxed, partitioned views, with only narrow preload bridges.

  A crashed engine restarts after 2 seconds, then with doubling delays up to 30 seconds. After five crashes in a row it stays stopped. Settings > Diagnostics shows whether each engine is running and responsive, and how often it has restarted.
- **Your own server order:** servers and folders from every platform form one list in the rail. Drag them into any order; the order is saved in `rail-order.json`, and new servers join at the end. Each platform's Home and DM bubbles stay at the top.
- **Module labels:** hovering a rail icon shows a small dot in its module's colour with the module's initial (D, F, W) in the corner, and the hover name says it too, e.g. "Alpha · Fluxer".
- **Unified Messages:** the button at the top of the rail lists the direct messages of every service in one list, most recently active first, with the last message where the service provides it (Fluxer and Telegram do, Discord does not) and a search box. Picking one opens it beside the list in its own service; the services hide their own DM sidebars meanwhile. The button shows the unread DM count.
- **Settings** (the gear at the bottom of the rail, or the tray menu):
  - **Services and accounts:** turn services on and off, rename them, add web apps, self-hosted Fluxer instances and extra Discord or Fluxer accounts (each account is its own service, with its own session), remove added ones (which also deletes their saved sign-in), and see who is signed in. Sign out of each service from here too. Service changes are written to `platforms.json` and apply after a restart, which the page offers.
  - **Voice and video:** microphone, speakers and camera, with a level meter, a test sound and a camera preview, plus echo cancellation, noise suppression and automatic gain control, and optional enhanced noise suppression with RNNoise (the open stand-in for Krisp, run in an AudioWorklet). These apply to Fluxer calls; Discord and web apps keep their own voice settings.
  - **General:** keep running in the tray, start with your computer (Windows and macOS), desktop notifications, spell check, grouping servers by service in the rail (the study's open question, now a choice; one mixed list in your own order by default), zoom for the content area (also Ctrl and +, − or 0), opening `discord://` links in Multicord (off by default, since an installed Discord app may want them; modules declare the link schemes they open), and streamer mode: automatic while OBS or other streaming software runs (the study's auto-detect), always, or off. It keeps message content out of notifications and the Messages list.
  - **Rich Presence** (General, off by default): a local server speaking Discord's IPC protocol, as arRPC does, on the first free `discord-ipc-0` to `-9`, so games show "Playing …" on your Discord account. Activities are cut down to the fields Discord shows (text trimmed, only uploaded image names, at most two https buttons). The app's name and images come from Discord's public application endpoints. Discord's page then publishes the activity through its own `LOCAL_ACTIVITY_UPDATE`, the one action Multicord dispatches in Discord. Any program on the computer can set the status, as with the desktop app.
  - **Voice > Keybinds:** system-wide shortcuts for toggling mute, toggling deafen and showing or hiding Multicord. They need a modifier, or F13 to F24 alone, and a shortcut another app already holds is flagged. Mute and deafen act on Fluxer calls and send Discord its own Ctrl+Shift+M and Ctrl+Shift+D. A push-to-talk key works in Fluxer calls. With "Push to talk in the background" on, it works while Multicord is not in front too. A keyboard hook (uiohook-napi) is loaded only then, and only presses and releases of that one key leave it. The key is also passed on to Discord, whose own push to talk then works in the background (set the same key there). macOS asks for the Accessibility permission.

  Settings are stored in `settings.json` in the user-data folder.
- **Markdown and emoji:** messages render Discord-flavoured Markdown (headings, emphasis, spoilers, code, quotes, lists, links) and custom emoji. `:shortcodes:` become emoji, and emoji-only messages show large. An emoji picker with search, groups and the server's custom emoji sits in the composer and on reactions.
- One `BaseWindow` with a shell rail view and one `WebContentsView` per platform, each in its own `persist:<id>` partition, with `contextIsolation` and `sandbox` on.
- **Discord, hidden engine:** loads discord.com, hides its guild bar with CSS and reads the hidden guild items to build our rail, keeping their order and unread state. Server names and icons come from Discord's `GuildStore` through the store bridge, with DOM fallbacks. Navigation clicks the hidden items so Discord's own router handles it, with `pushState` + `popstate` as a fallback. It never calls `loadURL()`.
- **DMs in the rail:** a Home entry plus unread DM bubbles (avatar and mention count, newest first, up to 10; mentions from any extra DMs are added to the Home badge). A small script in Discord's page (`storeBridge.ts`) reads its channel, read-state and user stores. It only reads them, and its output is validated in the preload and again in the main process. All DMs are also available through `listDirectConversations()` for a future Messages tab.
- **One notification path:** Discord's notifications are relayed from its page (a small script replaces the page's `Notification` constructor, a browser API, not Discord internals) and shown by Multicord like every other platform's, so the notification switch and streamer mode apply to them too. Clicking one runs Discord's own click handler, so Discord navigates itself.
- **Incoming calls:** when someone calls you on Discord while another view is in front (where Discord's own ringing is hidden), Multicord rings itself: an urgent notification that stays until handled, and a taskbar flash. Clicking it opens the call's DM in Discord. The store bridge reads ringing calls from Discord's `CallStore`; adapters report calls through the same contract, so other platforms can ring the same way.
- **Server folders:** a collapsed folder is a tile in the folder's colour that previews up to four of its servers and shows their combined badge. An expanded folder groups its servers in one tinted container under a folder icon. Clicking a folder clicks Discord's own hidden folder header, so Discord keeps track of which folders are open. Folder structure comes from `SortedGuildStore`, which also covers servers inside collapsed folders. Without it, folders are detected from the DOM.
- **Hover names:** hovering any rail item shows its name in a tooltip. The rail view is only 72px wide, so the tooltip is drawn in a transparent overlay view beside it.
- **Fluxer, native:** a built-in Fluxer client. Multicord talks to Fluxer's API itself and shows the chat in its own view, instead of embedding Fluxer's web app. It covers:
  - signing in, including Fluxer's proof-of-work captcha, authenticator codes and backup codes
  - the server list with folders, unread badges and mentions, in the shared rail
  - DM bubbles
  - channel lists, message history, sending messages and marking channels read
  - replies, reactions (with quick reactions), and editing and deleting your own messages
  - typing indicators
  - attachment uploads, picked with the OS file dialog
  - threads under their channel, and forum channels with their posts and a form for new ones
  - voice channels with who is in them, and calls with microphone, camera and screen share (through LiveKit, as Fluxer uses)
  - desktop notifications that follow your Fluxer notification settings (mutes, server and channel levels, @everyone suppression)

  Large servers (over 250 members) are subscribed to while open, so they deliver every message.

  The client runs in its sandboxed engine; the session token is stored encrypted and never reaches a web page. Multicord identifies itself to Fluxer honestly, as Multicord. Self-hosted instances and extra accounts can be added in Settings or in `platforms.json` with `"module": "fluxer"` and the instance URL.
- **Telegram, native (direct messages):** a built-in Telegram client for one-to-one chats, over MTProto (GramJS) from its engine, which may only reach Telegram's web endpoints (`*.web.telegram.org`). It covers signing in with phone number, code and two-step password; the chat list with unread counts and profile pictures, as DM bubbles and in the unified Messages page with previews; history, sending, replying, and editing and deleting your own messages; and notifications. Messages show as plain text, with a short label for media (photo, video, voice message, sticker, file, location, poll). Groups and channels are not listed yet.

  Telegram gives API credentials per app (my.telegram.org, "API development tools"). Builds can include them via the `MULTICORD_TELEGRAM_API_ID` and `MULTICORD_TELEGRAM_API_HASH` environment variables; otherwise Multicord asks for an API ID and hash on first sign-in and stores them encrypted.
- **Component gallery:** `npm run gallery` opens `dist/gallery.html`, which shows every component with sample data. Use it to check designs without signing in anywhere.
- **Extra platforms** as web views (shallow tier: one rail icon, unread state from the page title). Settings offers the open-source platforms from the study by name, each with its own label and colour and its public instance prefilled (self-hosted instances take their own address): Matrix (through Element web), Stoat, Spacebar and Nerimity, plus any other web chat app. Settings writes them to `platforms.json` in the app's user-data folder (`%APPDATA%\Multicord` on Windows), which can also be edited by hand:

  ```json
  [
    { "id": "element", "name": "Element", "url": "https://app.element.io" },
    { "id": "work", "name": "Work", "module": "discord" },
    { "id": "fluxer", "enabled": false }
  ]
  ```

  An entry with a built-in id (`discord`, `fluxer`) only renames it or turns it off. Any entry can have `"enabled": false`.

- Tray with minimize-to-tray, single instance, saved window state, and mention counts in the title, badge and taskbar flash.
- Screen share through our own picker, with system audio on Windows, and on macOS 13 and later (Electron captures it through ScreenCaptureKit, or Apple's CoreAudio tap from 14.2; untested on a Mac so far). Multicord's own sound (the call itself) is left out of it (Chromium's `restrictOwnAudio`, set for Discord in its page and for Fluxer calls), so others don't hear themselves.
- Permission allowlist; same-origin popups stay in the app and other links open in the browser.

## Layout

```
src/
  shared/adapter.ts      PlatformAdapter contract (from the study)
  shared/ipc.ts          IPC channels + validators for every renderer payload
  main/                  main process: app glue, registry, adapters, policies, credential store
  preload/discord/       Discord view preload (DOM hooks in dom.ts, store reads in storeBridge.ts)
  preload/shell.ts       contextBridge API for rail and picker
  preload/native.ts      bridge for native chat views (display state in, actions out)
  preload/settings.ts    bridge for the settings page
  shared/settings.ts     app settings, services list and settings actions, with validators
  main/settings*.ts      settings store and the controller behind the settings page
  main/services.ts       edits to platforms.json
  main/modules/          platform module manifests (discord, fluxer, telegram, web) and their registry
  main/engineHost.ts     runs module engines: sandboxed views, the validated bridge, session lockdown
  main/netPolicy.ts      what engines may contact, and the HTTP bridge
  shared/engine.ts       the engine protocol and its validators
  engine/runtime.ts      engine-side helpers: bridged fetch, secrets, files; serving an adapter
  modules/fluxer/        Fluxer client (engine): discovery, captcha, REST, gateway, state, adapter
  modules/telegram/      Telegram client (engine): GramJS glue and adapter
  preload/engine.ts      the engine bridge
  renderer/components/   the component library: server icons, channel lists, messages,
                         markdown, reactions, emoji picker, forums, voice panel, forms
  renderer/              rail, tooltip, screen-share picker, native chat view, settings page, gallery
  entries/               bundle entry points (thin; excluded from coverage)
tests/                   Vitest; tests/mocks/electron.ts fakes the Electron API
```

## Testing policy

Coverage is enforced at **95%** for lines, statements, functions and branches (`vitest.config.mts`). `npm run coverage` fails below that. The only files excluded are the one-line bundle entries and the types-only adapter contract. Keep Electron glue thin and put logic in modules that can be tested.

## Known limitations / next steps
- Rich Presence covers apps using the Discord IPC socket; it does not scan running processes for known games (the desktop app's game detection), and the WebSocket transport some browser-based apps use is not offered.
- Guild selectors (`dom.ts`) and store names (`storeBridge.ts`) follow Discord's current client. Settings > Diagnostics checks them against the running client (each hook, and what breaks if it fails); an automated check against a logged-in client, and AI-assisted repair proposals as the study suggests, are not built. Guilds could later move to store reads too.
- Rich Presence (arRPC) is not started.
- Linux screen share audio needs a PipeWire helper (venmic), which is not built in.
- Fluxer (native) does not support:
  - **Security keys (WebAuthn):** they are bound to Fluxer's own web origin, and Multicord won't impersonate it. Accounts protected only by a security key can sign in with a backup code.
  - **End-to-end encrypted voice channels:** Fluxer's scheme is undocumented, so Multicord refuses them rather than joining unencrypted.
  - **Calls in DMs:** voice works in server voice channels only.
  - **Archived threads:** only open threads and forum posts are listed.
  - **Instances without presigned uploads:** attachments need the presigned upload flow, which fluxer.app supports.
- Fluxer's docs don't state a policy on third-party clients. The client is built to Fluxer's documented API and stays well under its rate limits. Requests are spaced out because a global rate-limit hit revokes a user's session.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-or-later`).
