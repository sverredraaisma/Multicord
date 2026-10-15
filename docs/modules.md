# Writing a platform module

Every platform in Multicord is a *module*: a manifest the shell reads, plus the code that talks to the platform. The shell knows platforms only through the manifest (`ModuleManifest` in `src/main/modules/types.ts`) and the adapter contract (`PlatformAdapter` in `src/shared/adapter.ts`), so a new platform needs no changes to the shell.

Modules are compiled in, never loaded from disk. Review a new module as you would any change to the app.

## Pick a kind

| | Web client | Native engine |
|---|---|---|
| What runs | The platform's own web app, in a sandboxed view with its own session | Your TypeScript client, in a hidden sandboxed *engine* page, rendering in Multicord's own chat view |
| Rail | One entry; unread state from the page title | Servers, groups, a home (DM) entry, Messages-tab conversations, notifications |
| Effort | One line | A client: sign-in, API, state, adapter |
| Examples | `stoat`, `matrix` (Element), `spacebar`, `nerimity`, `mumble`, `web` in `src/main/modules/web.ts` | `stoat-native` (`src/modules/stoat`), `fluxer`, `matrix-native`, `telegram` |

Start with a web client when the platform has one. Write a native engine module when you need more of the rail, or when no web client exists.

A third form exists: a manifest with a `load()` function that wires its own view in the main process (only `discord.ts`). That code runs with full main-process privileges, outside the engine sandbox. Don't use it for new platforms.

## A web-client module

1. Add one line to `src/main/modules/web.ts`:

   ```ts
   export const exampleModule = webClientModule({ id: "example", name: "Example", label: "Example", color: "#336699", defaultUrl: "https://app.example.org" });
   ```

2. Add it to `MODULES` in `src/main/modules/index.ts`. The order there is the order in Settings.
3. Update the expected lists in `tests/main/modules.test.ts` ("ships Discord, Fluxer and generic web modules").

`webClientModule` makes the module `configurable`: users add instances in Settings, or in `platforms.json` as `{"id": "...", "name": "...", "url": "...", "module": "example"}`. The page runs with no preload in its own `persist:<instance id>` partition, sandboxed and context-isolated (`secureView` in `src/main/app.ts`). Same-origin popups stay in the app; other links open in the browser.

## A native engine module

The template in `src/modules/_template` is a complete, minimal module: sign-in, one conversation, sending. Its tests are in `tests/modules/_template`. It is never registered, so it never ships, but it is type-checked and tested with everything else. Copy it to start.

### Files

For a module with engine id `example`:

| File | What it is |
|---|---|
| `src/modules/example/adapter.ts` | The client: a class extending `BaseAdapter` (`src/shared/baseAdapter.ts`) that implements `PlatformAdapter` with `mode = "native"`, plus `start()` and `handleAction()`. Split protocol, state and types into more files as it grows (see `src/modules/stoat`). |
| `src/modules/example/engine.ts` | `startExampleEngine(bridge)`: builds the adapter on the bridge helpers and serves it. Copy `_template/engine.ts`. |
| `src/entries/engine-example.ts` | The bundle entry (see below). Its file name is the engine id. |
| `src/main/modules/example.ts` | The manifest (see below). Copy `src/main/modules/_template.ts`. |
| `src/main/modules/index.ts` | Add the module to `MODULES`. |
| `tests/modules/example/*.test.ts` | Unit tests, with a fake bridge and a fake service. |

The entry is the same three lines for every engine:

```ts
import type { EngineBridge } from "../preload/engine";
import { startExampleEngine } from "../modules/example/engine";

void startExampleEngine((window as unknown as { multicordEngine: EngineBridge }).multicordEngine);
```

`scripts/build.mjs` bundles every `src/entries/engine-<id>.ts` into `dist/engines/<id>.js`. Nothing else in the build needs to change. The build fails on an id that is not lowercase letters, digits or dashes (at most 32), since the engine host refuses those. An engine that needs extra esbuild options (WebAssembly, shims, build-time values) gets them in `engineOptions` in `scripts/build.mjs`, under its id; Matrix and Telegram show how.

Don't add an entry for code that should not ship. A test checks that the entries and the registered engines match exactly.

Adding the module to `BUILT_IN` in `src/main/platforms.ts` is optional. That list is for services every user gets (Discord, Fluxer, Telegram). Other modules are added by users in Settings, which offers every `configurable` module.

### The manifest

`ModuleManifest`, `src/main/modules/types.ts`. Fields for every module:

| Field | What it does |
|---|---|
| `id` | Module id; what `platforms.json` names in `module`. Unique (tested). |
| `name` | Full name in Settings, e.g. "Stoat". |
| `label`, `color` | Short name and `#rrggbb` colour for the rail's module badge and tooltips (tested). |
| `configurable` | Users may add instances (more servers or accounts) in Settings. |
| `defaultUrl` | Address prefilled for new instances. For a native module, the instance's origin, given to the engine as `EngineInfo.url`. |
| `fixedUrl` | With `defaultUrl`: the only address allowed (Discord, Telegram). |
| `notice` | What users should know before using the module, e.g. a risk to their account. Settings shows it with the module's services. |
| `preload` | The view's preload, relative to `dist`. Native modules use `"preload-native.js"` (tested), which connects Multicord's chat view. |
| `protocols` | Link schemes the module opens (e.g. `discord`), when the user lets Multicord handle them. The adapter needs `openLink()`. |
| `usesVoiceSettings` | The view gets the voice settings (devices, processing) and updates to them. Set it when the module runs calls (tested for native modules with `voice`). |
| `forwardPushToTalk`, `voiceKeys` | Web clients with their own push to talk and mute/deafen keys (Discord). |
| `settings` | Settings each service of the module has, shown under it in Settings > Services (below). |

Native engine fields:

| Field | What it does |
|---|---|
| `engine` | The engine id: `dist/engines/<engine>.js`, served at `multicord-engine://<engine>/`. Matches `src/entries/engine-<engine>.ts` (tested). A manifest without `load()` must set it. |
| `hosts` | When set, the only hosts the engine may reach: `"example.org"` or `"*.example.org"`. Leave it out for self-hostable platforms, whose hosts you can't know in advance, and lock at runtime instead (below). |
| `storage` | Keep the engine's web storage (IndexedDB) on disk, e.g. for end-to-end encryption keys (Matrix). Otherwise it is in memory and gone on restart. Either way it is the instance's own partition (`persist:engine_<instance id>` or `engine_<instance id>`), cleared when the instance is removed. |
| `home` | The module has a home (DM) entry in the rail. The adapter needs `openHome()` and `homeBadge()`. |
| `capabilities` | `{ directMessages, messagePreviews, voice, screenShare }`. The shell reads the manifest's, not the adapter's, so keep them equal: export the adapter's as `CAPABILITIES` from `adapter.ts`, and a test in `tests/main/modules.test.ts` compares them for every native module. |
| `screenShare` | Route `getDisplayMedia` in the module's view through the shell's screen picker. Set it exactly when `capabilities.screenShare` is set (tested for modules with `voice`). |

#### Service settings

Put settings a user may want to change per service in `settings`, not in the module's own screens or secrets, so they sit with every other setting. A field is one of:

- `{ kind: "toggle", key, label, hint?, default }`: on or off.
- `{ kind: "choice", key, label, hint?, options: [{ value, label }], default }`: one of 2 to 16 fixed values (lowercase letters, digits and dashes).
- `{ kind: "action", key, label, hint?, confirm? }`: a button that has the running service do something once, such as forget what it learned. With `confirm`, it asks for a second click.

Keys are camelCase (`/^[a-z][A-Za-z0-9]{0,31}$/`), at most 16 fields, labels up to 80 characters and hints up to 300 (tested for every manifest). There is no free-text field.

The values are stored in `settings.json` under the service (`services[id].options`) and checked against the fields every time they are read: a missing or unfitting value gives the default, and keys no field declares are dropped. Settings rejects a change that names another field or does not fit. A service only ever gets its own values:

- An engine gets them in `engineInfo(bridge).settings`, and changes as `applySettings(values)` on its adapter. Action buttons call `runSettingAction(key)`.
- The adapter's `settingsStatus()` says what Settings shows with each field: `{ [key]: { text?, disabled? } }`, e.g. what is remembered, or `disabled` when an action has nothing to do. `serveAdapter` sends it when it changes (after each `sync()` and each Settings command). Texts are capped at 500 characters, and Settings shows only declared keys. Never put secrets in it.
- A `load()` module reads its values from `ModuleHost.settings()`; changes reach its adapter's `applySettings()`.

Matrix (`typing`, `forgetCallServices`) and Telegram (`forgetApiId`) show how.

### The engine side

An engine has no network, storage or files of its own beyond its page. Everything goes through the `EngineBridge` (`src/preload/engine.ts`). Use the helpers in `src/engine/runtime.ts` rather than raw requests:

- `engineInfo(bridge)`: the instance's id, name, url and the OS, and its values for the manifest's `settings`. Call it first; the shell holds commands until it does.
- `bridgeFetch(bridge)`: a `fetch` that goes through the main process. The engine page's CSP does not allow `fetch` to other origins, so this is the only way to make HTTP requests.
- `bridgeSecrets(bridge)`: this instance's secret store (`load`, `save`, `delete`). Keep tokens here, never in web storage.
- `lockHosts(bridge, hosts)`: from now on, reach only these hosts. Call it once you know the instance's API, socket and file hosts (Stoat, Matrix and the template do). A lock can only narrow; the shell refuses one that widens or names a private host. Treat a refusal as non-fatal, as the template does.
- `pickFiles(bridge)`: files the user picked, read in ranges through handles. It works only within 10 seconds of the user pressing attach in the module's view.
- `serveAdapter(bridge, adapter)`: serves the adapter to the shell. Rail servers, conversations, notifications, incoming calls and the settings status go out as events; shell commands (`openHome`, `openServer`, `openConversation`, `toggleGroup`, `visible`, `signOut`, `settings`, `settingAction`) and view actions come in. Call the returned `sync()` after each render, so account and home-badge changes reach the shell.
- WebSockets: use the page's own `new WebSocket(url)`. Only `wss:` to allowed public hosts gets through.

The view shows what the engine renders: `bridge.render(state)` with a `NativeViewState` (`src/shared/native.ts`). The `login` screen takes an email or username and password; the `mfa` screen takes codes; `prompt` screens are sign-in steps the module defines (Telegram's phone and code); `connecting` shows a status; `chat` shows the sidebar, the open channel with its messages, typing, pending uploads, and the voice session. Each open channel says what it takes besides text in `can` (`reply`, `react`, `attach`, `typing`, `members`), and the view offers only those: report them truthfully, per conversation where it differs (Matrix turns them off in locked rooms), so no control does nothing. Editing and deleting are per message (`canEdit`, `canDelete`), and `locked` rules out sending altogether. With `members`, the conversation header gets a member panel toggle: it sends `{ type: "members", open }`, and while the panel is open the module puts the open conversation's `members` on the channel (sections such as "Admins" or "Online", each member with an id, name, and optionally an avatar, a presence, a `#rrggbb` colour and a status line), fetched only once asked. `{ type: "loadMembers", offset }` asks for the next page while `hasMore` is set; `offset` is how many are listed, so ignore a request that does not match. Fetch in pages and stop at a bound of your own, counting the rest in `more`: the view shows at most 200 rows (`MEMBER_ROWS_SHOWN`) and says how many more there are. Give messages an `authorId` (the same opaque id as the author's member row) and the author's name and picture, like member rows, open a profile card: the view shows it at once with what it has and sends `{ type: "profile", id }`, and the module may answer with `profile` in the chat state (username, about text, roles, presence) for that id. Put only what the platform shows other users there, never e.g. phone numbers. The view sends `NativeAction`s back to `adapter.handleAction()`. The main process checks every action's shape first (`isNativeAction`): channel and message ids must be numeric snowflakes or ULIDs, and texts have length limits.

Calls: a module with `voice` puts a `NativeVoiceSession` (LiveKit URL and token, and media keys for encrypted calls) in the chat state. The view runs the call (`src/renderer/voice.ts`) with the user's voice settings. Fluxer and Matrix show how.

## What the sandbox guarantees

Each instance of a native module runs in its own engine (`EngineHub` in `src/main/engineHost.ts`):

- A hidden `WebContentsView` with Chromium's sandbox, context isolation, no Node, every permission denied, and no navigation or popups.
- Its page on its own origin, `multicord-engine://<engine>/`, serving only its page and bundle, with a strict CSP (`default-src 'none'`; scripts only from itself; connections only to itself and `wss:`).
- Its own session partition, so no cookies or storage are shared with any other module or instance.
- Requests through the bridge use a separate cookie-less session: `https:` only, public addresses only (names are checked by what they resolve to), only the module's `hosts` or lock if set, every redirect re-checked. Cookie, `Host`, hop-by-hop, proxy and `sec-` request headers are dropped, `Set-Cookie` response headers are dropped, and bodies are capped at 50 MB (`src/main/netPolicy.ts`).
- WebSockets and the view's own loads (images, call servers) get the same host and address rules.
- Secrets are scoped: the store prefixes every key with the instance id (`CredentialStore.scope`, `src/main/credentials.ts`), so an engine cannot name another instance's keys. An instance may keep at most 64 secrets and 512K characters. Removing the instance forgets them and clears its storage.
- Every message is validated in the main process and bound to the engine that sent it: events (`isEngineEvent`), requests (`isEngineRequest`) and view actions (`isNativeAction`). Display state goes only to the engine's own view, and that view's actions only back to it.
- A crashing engine restarts with growing delays, and is left stopped once it has crashed more than 5 times in a row. Settings > Diagnostics shows its health.

### What a module must never do

These are enforced by tests in `tests/main/modules.test.ts` ("module boundaries"), which scan every file under `src/modules` and `src/engine`, and `src/main/modules` and `src/main/adapters` for the secret store:

- Import Electron, Node (`node:*`, `fs`, `path`, `os`, `child_process`, `net`, `http`, `https`) or anything under `main/`, in any form (`import`, `export ... from`, `import()`, `require()`). Type-only imports count too. Engine code shares only `src/shared` and `src/engine` with the shell.
- Touch the OS secret store or the credential file (`safeStorage`, `credentials.json`, `CredentialStore`). Use the scoped store you are given.

And by review, since no test can catch them:

- Don't send tokens or message content anywhere but the platform's own servers. Lock your hosts as soon as you know them.
- Don't keep secrets in web storage or in render state. The view gets display data only.
- Treat everything from the server as untrusted. The shell validates what you send it, but your own state is yours to keep sane.
- Don't widen what the shell offers (e.g. a `load()` function, a new IPC channel, a new preload) to make a module work. If the bridge lacks something, extend the engine protocol in `src/shared/engine.ts` with a validator and tests, for every module at once.

The boundaries of the protocol and sandbox are covered in `tests/main/engineHost.test.ts`, `tests/main/netPolicy.test.ts`, `tests/main/credentials.test.ts`, `tests/shared/engine.test.ts` and `tests/shared/native.test.ts`.

## Testing

`npm run check` runs the type check and all tests with coverage. Coverage must stay at 95% for lines, statements, functions and branches across `src` (only `src/entries` and the types-only `src/shared/adapter.ts` are excluded), so a new module comes with tests that cover it.

- **Unit tests**, `tests/modules/<module>/*.test.ts`. Test the adapter against a fake service: a `fetch` stub and an in-memory secret store, as in `tests/modules/_template/adapter.test.ts`. Assert on what it renders and emits. Test the engine with a fake bridge that answers `info`, `secretLoad` and `http` like the main process does, as in `tests/modules/_template/engine.test.ts` and `tests/modules/stoat/engine.test.ts`. Cover failures: wrong password, expired session, network errors, a refused host lock.
- **Interop tests**, also in `tests/modules/<module>`, run in the normal suite against an in-memory server with the platform's own client library on the other side. `tests/modules/matrix/interop.test.ts` drives Multicord's Matrix code and matrix-js-sdk through `interopServer.ts`.
- **Live tests**, `tests/live/<module>.live.test.ts`, run against a real server and are skipped by `npm run check` and CI. Wrap the suite in `describe.skipIf(!SERVER)(...)`, with the server named by an environment variable `MULTICORD_LIVE_<MODULE>`, and say in the file's header comment how to start the server and run it, e.g. `MULTICORD_LIVE_STOAT=https://localhost:14443 npx vitest run tests/live`. Register fresh accounts per run so runs don't share state. See `tests/live/stoat.live.test.ts`.

## Checklist

- [ ] Web client: one `webClientModule(...)` line in `src/main/modules/web.ts`.
- [ ] Native: `src/modules/<module>/` with the adapter and `engine.ts`, copied from `_template`.
- [ ] Native: `src/entries/engine-<engine>.ts`, three lines; build options in `scripts/build.mjs` only if needed.
- [ ] Manifest in `src/main/modules/<module>.ts`: unique `id`, `label`, `#rrggbb` `color`, `configurable` and `defaultUrl`; for native modules `preload: "preload-native.js"`, `engine`, `home`, `capabilities` equal to the adapter's.
- [ ] `hosts` if the platform has fixed hosts; otherwise `lockHosts()` once they are known.
- [ ] `storage` only if the module must keep keys across restarts.
- [ ] `usesVoiceSettings` and `screenShare` if it runs calls with screen sharing.
- [ ] `notice` if using the platform here carries a risk users should know about.
- [ ] `settings` for anything users may want to change or reset per service, instead of a screen or secret of the module's own.
- [ ] Added to `MODULES` in `src/main/modules/index.ts`, and the expected lists in `tests/main/modules.test.ts` updated.
- [ ] Tokens only in the scoped secret store; no Electron, Node or `main/` imports.
- [ ] Unit tests in `tests/modules/<module>/`, and a live suite in `tests/live/` if a server can be run locally.
- [ ] `npm run check` passes, and `npm run build` produces `dist/engines/<engine>.js`.
- [ ] README: the module in the list of built-in modules and in the Layout section.
