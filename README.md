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
```

If `npm start` reports that Electron failed to install, run `node node_modules/electron/install.js`.

## What v0.1 does

- One `BaseWindow` with a shell rail view and one `WebContentsView` per platform, each in its own `persist:<id>` partition, with `contextIsolation` and `sandbox` on.
- **Discord, hidden engine:** loads discord.com, hides its guild bar with CSS and reads the hidden guild items to build our rail, keeping their order and unread state. Server names and icons come from Discord's `GuildStore` through the store bridge, with DOM fallbacks. Navigation clicks the hidden items so Discord's own router handles it, with `pushState` + `popstate` as a fallback. It never calls `loadURL()`.
- **DMs in the rail:** a Home entry plus unread DM bubbles (avatar and mention count, newest first, up to 10; mentions from any extra DMs are added to the Home badge). A small script in Discord's page (`storeBridge.ts`) reads its channel, read-state and user stores. It only reads them, and its output is validated in the preload and again in the main process. All DMs are also available through `listDirectConversations()` for a future Messages tab.
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

  Everything that talks to Fluxer runs in the main process. The session token never reaches a web page and is stored encrypted with `safeStorage`. Multicord identifies itself to Fluxer honestly, as Multicord. Self-hosted instances can be added in `platforms.json` with `"kind": "fluxer"` and the instance URL. To remove a built-in platform, add `{ "id": "fluxer", "enabled": false }` (or `"discord"`).
- **Extra platforms** as web views (shallow tier: one rail icon, unread state from the page title), configured in `platforms.json` in the app's user-data folder (`%APPDATA%\Multicord` on Windows):

  ```json
  [{ "id": "element", "name": "Element", "url": "https://app.element.io" }]
  ```

- Tray with minimize-to-tray, single instance, saved window state, and mention counts in the title, badge and taskbar flash.
- Screen share through our own picker, with loopback system audio on Windows.
- Permission allowlist; same-origin popups stay in the app and other links open in the browser.

## Layout

```
src/
  shared/adapter.ts      PlatformAdapter contract (from the study)
  shared/ipc.ts          IPC channels + validators for every renderer payload
  main/                  main process: app glue, registry, adapters, policies, credential store
  main/fluxer/           Fluxer client: discovery, captcha, REST, gateway, state
  preload/discord/       Discord view preload (DOM hooks in dom.ts, store reads in storeBridge.ts)
  preload/shell.ts       contextBridge API for rail and picker
  preload/native.ts      bridge for native chat views (display state in, actions out)
  renderer/              rail, tooltip, screen-share picker and native chat view
  entries/               bundle entry points (thin; excluded from coverage)
tests/                   Vitest; tests/mocks/electron.ts fakes the Electron API
```

## Testing policy

Coverage is enforced at **95%** for lines, statements, functions and branches (`vitest.config.mts`). `npm run coverage` fails below that. The only files excluded are the one-line bundle entries and the types-only adapter contract. Keep Electron glue thin and put logic in modules that can be tested.

## Known limitations / next steps

- Guild selectors (`dom.ts`) and store names (`storeBridge.ts`) follow Discord's current client and are not yet checked against it automatically. They need a health-check harness against the live client. Guilds could later move to store reads too.
- Unified Messages tab (level 3), incoming-call detection, notifications routing, updater/installer, push-to-talk: not started.
- macOS/Linux screen share audio (CoreAudio tap / venmic) is not wired up.
- Fluxer (native) does not support:
  - **Security keys (WebAuthn):** they are bound to Fluxer's own web origin, and Multicord won't impersonate it. Accounts protected only by a security key can sign in with a backup code.
  - **End-to-end encrypted voice channels:** Fluxer's scheme is undocumented, so Multicord refuses them rather than joining unencrypted.
  - **Calls in DMs:** voice works in server voice channels only.
  - **Archived threads:** only open threads and forum posts are listed.
  - **Instances without presigned uploads:** attachments need the presigned upload flow, which fluxer.app supports.
  - **A full emoji picker:** reactions offer six quick emoji, plus toggling existing reactions.
- Fluxer's docs don't state a policy on third-party clients. The client is built to Fluxer's documented API and stays well under its rate limits. Requests are spaced out because a global rate-limit hit revokes a user's session.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-or-later`).
