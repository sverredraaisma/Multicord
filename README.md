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
- **Discord, hidden engine:** loads discord.com, hides its guild bar with CSS and reads the hidden guild items to build our rail. Navigation clicks the hidden items so Discord's own router handles it, with `pushState` + `popstate` as a fallback. It never calls `loadURL()`.
- **DM home entry** with a mention badge, worked out from the title's total minus the guild mentions.
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
  main/                  main process: app glue, registry, adapters, policies
  preload/discord/       Discord view preload (DOM hooks live in dom.ts)
  preload/shell.ts       contextBridge API for rail and picker
  renderer/              rail and screen-share picker UI
  entries/               bundle entry points (thin; excluded from coverage)
tests/                   Vitest; tests/mocks/electron.ts fakes the Electron API
```

## Testing policy

Coverage is enforced at **95%** for lines, statements, functions and branches (`vitest.config.mts`). `npm run coverage` fails below that. The only files excluded are the one-line bundle entries and the types-only adapter contract. Keep Electron glue thin and put logic in modules that can be tested.

## Known limitations / next steps

- Guild selectors (`dom.ts`) are heuristics from Discord's current DOM. They need a health-check harness against the live client, and possibly a move to webpack store reads.
- Guilds inside collapsed folders are not listed yet.
- DM bubbles (level 2), incoming-call detection, notifications routing, updater/installer, push-to-talk: not started.
- macOS/Linux screen share audio (CoreAudio tap / venmic) is not wired up.

## License

[GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).
