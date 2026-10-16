# Writing a platform module

Every platform in Multicord is a *module*: a manifest the shell reads, plus the code that talks to the platform. The shell knows platforms only through the manifest (`ModuleManifest` in `src/core/modules.ts`) and the adapter contract (`PlatformAdapter` in `src/shared/adapter.ts`), so a new platform needs no changes to the shell.

Modules are compiled in, never loaded from disk. Review a new module as you would any change to the app.

## Pick a kind

| | Web client | Native engine |
|---|---|---|
| What runs | The platform's own web app, in a sandboxed view with its own session | Your TypeScript client, in a hidden sandboxed *engine* page, rendering in Multicord's own chat view |
| Rail | One entry; unread state from the page title | Servers, groups, a home (DM) entry, Messages-tab conversations, notifications |
| Effort | One line | A client: sign-in, API, state, adapter |
| Examples | `stoat`, `matrix` (Element), `spacebar`, `nerimity`, `mumble`, `web` in `src/main/modules/web.ts` | `stoat-native` (`src/modules/stoat`), `fluxer`, `matrix-native`, `telegram`, `spacebar-native`, `nerimity-native` |

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

Where the service has an address that should answer, give it as `check: { name: "Example's API answers", path: "/api/" }`. The shell then asks that path on the configured address's own host when the service starts and every five minutes, and Settings > Diagnostics shows whether it answered (any status below 500 counts). The request goes through a session of the shell's own, in memory, so none of the page's cookies or storage go with it: https only, every redirect on the same host and at a public address, 10 seconds at most (`src/main/serviceReach.ts`). Instances at a local or private address are not checked. Leave `check` out where the service is not known from the address (Element, whose homeserver is chosen inside it).

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

Adding the module to `BUILT_IN` in `src/core/platforms.ts` is optional. That list is for services every user gets (Discord, Fluxer, Telegram). Other modules are added by users in Settings, which offers every `configurable` module.

### The manifest

`ModuleManifest`, `src/core/modules.ts`. Fields for every module:

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
| `peerToPeerCalls` | The module's calls are peer-to-peer WebRTC (Nerimity), not through a voice server. The desktop then gives its view Chromium's WebRTC IP handling policy `default_public_interface_only`, so no local network or VPN address is offered to peers. Only for modules with `voice` (tested). |
| `holdsMedia` | The engine holds media back until the view asks (`mediaKey` and `loadMedia`). The view then gets this service's limit for media that loads by itself, and Settings offers a per-service choice of it. Give such attachments their `size` where the platform says it: media of unknown size waits for a click unless any size may load. |
| `sendsTyping` | The module tells others while the user types. Settings then offers the service a choice of following the general "Send typing indicators" switch or its own on or off, and the engine gets the answer as `typing` (`TYPING_SETTING`) in its settings values, beside its declared fields, with changes through `applySettings()`. Send no typing indicator while it is `false`, and stop one already running when it turns off. No module may declare a field named `typing`. |

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

Matrix (`readReceipts`, `slidingSync`, `forgetCallServices`) and Telegram (`forgetApiId`) show how. Settings the shell itself offers per service (notifications, the limit for media that loads by itself, typing indicators) are not fields: they follow from the manifest (`holdsMedia`, `sendsTyping`).

### The engine side

An engine has no network, storage or files of its own beyond its page. Everything goes through the `EngineBridge` (`src/preload/engine.ts`). Use the helpers in `src/engine/runtime.ts` rather than raw requests:

- `engineInfo(bridge)`: the instance's id, name, url and the OS, and its values for the manifest's `settings`. Call it first; the shell holds commands until it does.
- `bridgeFetch(bridge)`: a `fetch` that goes through the main process. The engine page's CSP does not allow `fetch` to other origins, so this is the only way to make HTTP requests.
- `bridgeSecrets(bridge)`: this instance's secret store (`load`, `save`, `delete`). Keep tokens here, never in web storage.
- `lockHosts(bridge, hosts)`: from now on, reach only these hosts. Call it once you know the instance's API, socket and file hosts (Stoat, Matrix, Spacebar, Nerimity and the template do). A lock can only narrow; the shell refuses one that widens or names a private host. Treat a refusal as non-fatal, as the template does.
- `pickFiles(bridge)`: files the user picked, read in ranges through handles. It works only within 10 seconds of the user pressing attach in the module's view.
- `ssoSignIn(bridge, url)`: single sign-on the way Matrix does it (`m.login.sso`). The shell opens `url`, a homeserver's SSO redirect (`https://<host>/_matrix/client/v3/login/sso/redirect`, optionally `/<idp id>`, without a query; on a host the engine may reach), in the user's browser with a `redirectUrl` of its own: `http://127.0.0.1:<random port>/sso/<random path>`. It listens there, on 127.0.0.1 only, for one request (others get 404), for at most five minutes, and answers the engine with the `loginToken` that comes back (checked for form); the engine then signs in with `m.login.token`. It works only within 10 seconds of the user submitting a sign-in step (`prompt`) in the module's own view, once per submit, and a new sign-on cancels one still waiting. The token reaches only the engine that asked, as the answer to its request.
- `fileSource(bridge, file)`: opens a file the shell hands over in a `sendFile` action: a favourite, or a sticker sent as a picture (only the shell makes this action; views cannot). A module that sets `can.attach` handles it: it goes out at once into the open conversation as an upload, like a picked file, or waits with the files already picked. Pass it to the adapter as `files.open` (`EngineFiles`).
- `serveAdapter(bridge, adapter)`: serves the adapter to the shell. Rail servers, conversations, notifications, incoming calls, the settings status and the adapter's own `health()` checks of its service (at most 8, each a name, whether it is ok and a detail; Settings > Diagnostics shows them after the engine's, and a failing one while signed in brings one notification) go out as events; shell commands (`openHome`, `openServer`, `openConversation`, `toggleGroup`, `visible`, `signOut`, `settings`, `settingAction`) and view actions come in. Call the returned `sync()` after each render, so account and home-badge changes reach the shell.
- WebSockets: take the socket factory as a parameter of your engine, defaulting to the bridged one (`createSocket: SocketFactory = bridgeWebSocket(bridge)`, as Fluxer, Stoat, Spacebar and Nerimity do), so tests can pass a fake. The engine page's CSP refuses its own `new WebSocket(url)`. A library that opens its sockets itself and takes no factory gets one through a build alias instead: Telegram's GramJS imports the `websocket` package, which `scripts/build.mjs` points at `src/modules/telegram/websocket.ts` for that engine alone; its `w3cwebsocket` gives bridged sockets on the bridge the engine's entry hands it at start (`useSocketBridge`).
- `bridgeWebSocket(bridge)`: a socket factory whose sockets the shell opens and relays (`BridgedWebSocket`), on the desktop as on a phone later. The shell checks each one (`wss:` only, the module's hosts or lock, public addresses by what the name resolves to) and caps them: at most 8 sockets per engine (`MAX_SOCKETS`), frames up to 16 MB (`MAX_SOCKET_FRAME`), 32 MB waiting to be sent (`MAX_SOCKET_QUEUE`); a socket is closed when it breaks a cap, and all of them when the engine reloads or stops. Its sockets behave as a page's WebSocket as far as modules use one (ready states, `open`, `message`, `error` and `close` events as listeners or `on*` handlers, `send()`, `close()`), with binary messages as ArrayBuffers. The factory takes subprotocols as a page's WebSocket does (`(url, protocols?)`: HTTP tokens, at most 8 of up to 64 characters, none twice), and `protocol` says which one the server chose. On the desktop the shell opens them in a hidden relay page of its own per engine (`src/main/webSockets.ts`), in the engine's session, so they use Chromium's network stack with the system's proxy settings and certificates, as the engine's own sockets did; servers see the relay's origin, `multicord-engine://<engine>.relay`. Electron has no main-process WebSocket on Chromium's stack (`net` covers HTTP only), hence the page.

The view shows what the engine renders: `bridge.render(state)` with a `NativeViewState` (`src/shared/native.ts`). The `login` screen takes an email or username and password; the `mfa` screen takes codes; `prompt` screens are sign-in steps the module defines (Telegram's phone and code), and may carry `qr`, text (printable ASCII, at most 200 characters) that the view draws as a QR code itself, redrawn as it changes while the step lasts: put a credential there (Telegram's sign-in link) only while the step needs it; `connecting` shows a status; `chat` shows the sidebar, the open channel with its messages, typing, pending uploads, and the voice session. Each open channel says what it takes besides text in `can` (`reply`, `react`, `attach`, `typing`, `members`), and the view offers only those: report them truthfully, per conversation where it differs (Matrix turns them off in locked rooms), so no control does nothing. Editing and deleting are per message (`canEdit`, `canDelete`), and `locked` rules out sending altogether. Sidebar rows say `muted` when the conversation's notifications are muted on the platform (the view dims them and marks them "Muted"), and `canMute` where the module can mute and unmute it from here: the row then gets a bell that sends `{ type: "mute", channelId, mute }`. In the same way, `archived` says a conversation is in the platform's archive and `canArchive` gives its row an archive button that sends `{ type: "archive", channelId, archive }`. A muted conversation raises no notification and no count beyond what the platform itself would. A conversation the user is invited to goes in the sidebar with `invite` (and `from`, who sent it, where the platform says): the row offers Accept and Decline, which send `{ type: "join", channelId }` and `{ type: "decline", channelId }`. A row with `joinable` (one the user may join, such as a space's room) offers Join, which sends `join` too. A `category` row with `collapsible` is a button that folds the rows under it away (up to the next category), all but the open conversation; `collapsed` says how it starts, and the view keeps what the user chose while it is open, without telling the module. Give such a category the `unread` and `mentions` of its rows: the view shows them while it is folded. Where the platform has folders of the user's own (Telegram's chat folders), put them on the chat state as `folders` (each with an `id` of up to 32 letters, digits, `-` and `_`, a `name`, whether it is `active`, and its `unread` and `mentions`): the view shows them as tabs above the sidebar (at most 30), and picking one sends `{ type: "folder", id }`. The module then lists only that folder's conversations in `sidebar` and marks it `active`. With `joinAddress` in the chat state (the field's example, such as "#room:example.org"), the sidebar has a field to join by address: `{ type: "joinAddress", address }`, one word of at most 255 printable characters, which the module checks as an address of its own kind. When a conversation is opened with unread messages, note where they began before marking it read, and put `unread` on the open channel while it stays open: `firstId` (the first unread message, once it is loaded) and `count` (how many were new, where the platform says). The view draws a "N new messages" divider there and brings it into sight; while it is above the loaded messages (no `firstId` yet) it offers "Jump to unread", which sends `loadOlder` a page at a time until it appears. With `members`, the conversation header gets a member panel toggle: it sends `{ type: "members", open }`, and while the panel is open the module puts the open conversation's `members` on the channel (sections such as "Admins" or "Online", each member with an id, name, and optionally an avatar, a presence, a `#rrggbb` colour and a status line), fetched only once asked. `{ type: "loadMembers", offset }` asks for the next page while `hasMore` is set; `offset` is how many are listed, so ignore a request that does not match. Fetch in pages and stop at a bound of your own, counting the rest in `more`: the view shows at most 200 rows (`MEMBER_ROWS_SHOWN`) and says how many more there are. Give messages an `authorId` (the same opaque id as the author's member row) and the author's name and picture, like member rows, open a profile card: the view shows it at once with what it has and sends `{ type: "profile", id }`, and the module may answer with `profile` in the chat state (username, about text, roles, presence) for that id. Put only what the platform shows other users there, never e.g. phone numbers. Set `mentionsMe` on a message that mentions the user (by name, through a role they have, or everyone) as far as the platform tells; the view highlights it. Typing `@` and a name in the composer suggests the conversation's recent authors and, while the member panel shows them, its members; picking one inserts their `authorMention` (on a message) or `mention` (on a member row) in the platform's syntax, such as `<@id>`, or else their name. Make it plain text the module recognises when the message is sent (at most 100 characters, one line). Put link previews the platform made on a message's `embeds` (site, title, https `url`, description, `#rrggbb` colour, and a picture by `url` or `mediaKey`, small with `thumbnail`); the view shows at most 5 as cards and opens the title's link in the browser. Only pass on what the platform supplies: never fetch a page to make a preview, as that would tell the site who reads the message. Mark pinned messages with `pinned`, and set `canPin` where the user may pin or unpin one: its menu then sends `{ type: "pin", messageId, pin }` (the platform has the last word; show a refusal as the chat's `error`). With `can.pins`, the header gets a pins toggle that sends `{ type: "pins", open }`; while open, put the conversation's pinned messages on the channel as `pins` (`messages`, each with an id, author, text and time, and `loading`, `error` or a `note`), newest pin first, and drop it when another conversation opens. Clicking one brings it into sight: the view sends `loadOlder` a page at a time (up to 20) until it is loaded, so give listed messages the same ids as loaded ones. A reply's preview (`reply`) does the same when it names the original's `id` and `timestamp`: clicking the quote brings the original into sight, and the banner says when it could not be loaded. With `can.search`, the header gets a search button: the view sends `{ type: "search", query }` (at most 200 characters) and shows the channel's `search` (the `query` answered, and messages as for pins, newest first, with a `note` for what the search cannot find, such as encrypted messages) in the same panel; an empty query ends the search, and another conversation drops it. Search on the platform's servers only, as far as they offer it. With `can.forward`, a message's menu offers "Forward": the view lists the module's other text, DM and thread rows from its sidebar and sends `{ type: "forward", messageId, channelId }`. Forward natively where the platform can; else send a new message saying who it came from, with the text and links to the files. Never across modules: one module's engine never gets another's messages (the view's "Copy text" puts a message's text on the clipboard instead). With `can.threads`, messages can have a thread of their own: give the root message a `thread` summary (`count` of replies, and the `latest` reply's author) and leave the replies out of `messages`; its menu offers "Thread" and the summary opens it. The view sends `{ type: "thread", rootId }` (no rootId closes it), and the module puts the thread on the channel as `thread` (`rootId`; `messages`, the root and its replies oldest first, at most 200 shown; `loading`, `error`, a `note`, and `locked` where nothing may be sent into it), dropping it when another conversation opens. The thread panel has a composer of its own, which sends `{ type: "send", content, thread: rootId }`, with `replyTo` where the user answers one of the thread's messages ("Reply" in its menu there). The panel's messages take the conversation's `react`, `edit` and `delete` actions as the conversation's do (by `can.react` and their own `canEdit`, `canDelete`), so find them among the thread's too; their held-back media loads by itself under the same limit. Platforms whose threads are conversations of their own (Fluxer) list them in the sidebar as `thread` rows instead. A message may carry a `poll` (question; options with an id, text, and where shown their `votes`, whether the user `chosen` them and a quiz's `correct` one; `multiple`, `closed`, `total`): with `canVote` its options are buttons that send `{ type: "vote", messageId, options }`, the user's whole choice (empty takes the vote back), and with `canEnd` (a poll the user started, still open) the message menu's "End poll" sends `{ type: "endPoll", messageId }`. Where `can.polls` is on, the composer's poll button opens a form that sends `{ type: "createPoll", question, answers, multiple, anonymous? }`: a question of at most 255 characters and 2 to 10 distinct answers of at most 100 (one line each), and `anonymous` only where `can.anonymousPolls` offers the choice (without it the module decides). The view sends `NativeAction`s back to `adapter.handleAction()`. The main process checks every action's shape first (`isNativeAction`): channel and message ids must be numeric snowflakes or ULIDs, and texts have length limits.

Emoji, stickers and GIFs: the composer's picker shows what the module says can be used in the open conversation, so list only that, honestly per platform (another server's emoji only where the platform lets this account use them there). In the chat state:

- `customEmoji`: each with an `id` and `name`, `animated`, and optionally its picture (`url`, https or a data: URL; else `<emojiBase>/<id>.webp`), the server or pack it comes from (`source`, shown with it), what goes into the message in the module's own syntax (`text`; `<:name:id>` by default) and its reaction key (`key`; `name:id` by default), and `react: false` where it may not be reacted with. The view reads them through `customEmojiList()`.
- `emojiUrls`: pictures of the custom emoji in the shown messages, by the id in their `<:name:id>` (`<a:name:id>` when animated), where `emojiBase` cannot serve them: ids other than snowflakes (Stoat's ULIDs, Matrix media ids), or data: URLs the engine made. An emoji without a picture shows as `:name:`. Read through `emojiUrls()`.
- `stickers`: packs (a server's stickers, a sticker set) of stickers with an `id`, `name`, `format` (`png`, `apng`, `webp`, `gif`, `avif`, `webm` or `lottie`), the emoji they stand for, and a picture: `url` (for Lottie, a still of it) or a `mediaKey` the view asks for with `loadMedia` when it shows it. With `can.stickers`, picking one sends `{ type: "sendSticker", stickerId, replyTo? }` and the module sends it as a sticker. Without it, the shell sends the picture (or the WebM video) as a file through `sendFile`, where `can.attach` is on. Read through `stickerPacks()`.
- `gifs`: with `can.gifs`, the GIF tab sends `{ type: "searchGifs", query }` (empty for trending) and shows `gifs` (`query`, `results`, `loading`, `error`); each result has the address that is sent as the message's text (`url`) and what the picker shows (`preview`, a picture or, with `video`, a looping video), https only. Read through `gifResults()`.

The view sends `{ type: "picker", open }` when a picker opens and closes: the composer's, or a message's full reaction picker ("More emoji"), which lists the same custom emoji; it says `open: false` only once neither is open. Heavy picker data, such as sticker pictures as data: URLs, may stay out of the chat state while it is closed, so it does not travel with every update.

Favourites belong to the shell. A module never sees them: when the user sends one, the module gets a `sendFile` action like any other file.

Calls: a module with `voice` puts a `NativeVoiceSession` (LiveKit URL and token, and media keys for encrypted calls) in the chat state. The view runs the call (`src/renderer/voice.ts`) with the user's voice settings. Fluxer and Matrix show how. Voice rows in the sidebar join their call with `{ type: "joinVoice", channelId }`; a conversation that takes calls itself (a DM, or a text channel that is also a voice channel) sets `can.call`, and its header gets a call button that sends the same for its own id (hidden while the user is in that call). A call ringing for the user goes in the chat state as `incomingCall` (`channelId`, who it is `from`, `video`): the view shows it above the conversation with Accept, which sends `joinVoice`, and Decline, which sends `{ type: "declineCall", channelId }`. Emit it to the shell as an incoming call too (`incomingCalls`), so it rings while the view is not in front.

## What the sandbox guarantees

Each instance of a native module runs in its own engine (`EngineHub` in `src/main/engineHost.ts`):

- A hidden `WebContentsView` with Chromium's sandbox, context isolation, no Node, every permission denied, and no navigation or popups.
- Its page on its own origin, `multicord-engine://<engine>/`, serving only its page and bundle, with a strict CSP (`default-src 'none'`; scripts only from itself; connections only to itself).
- Its own session partition, so no cookies or storage are shared with any other module or instance.
- Requests through the bridge use a separate cookie-less session: `https:` only, public addresses only (names are checked by what they resolve to), only the module's `hosts` or lock if set, every redirect re-checked. Cookie, `Host`, hop-by-hop, proxy and `sec-` request headers are dropped, `Set-Cookie` response headers are dropped, and bodies are capped at 50 MB (`src/main/netPolicy.ts`).
- WebSockets and the view's own loads (images, call servers) get the same host and address rules. Bridged sockets (`bridgeWebSocket`) are checked by the shell first (`EngineSockets` in `src/core/engineSockets.ts`), named to the engine only by ids it hands out, and opened by the engine's relay page (`src/main/webSockets.ts`): hidden, sandboxed, without Node, on an origin of its own that the engine cannot frame, open or reach, with a preload that exposes nothing to its page and acts only on the main process's commands. The engine's session lets WebSockets through only from that page.
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
- [ ] Sockets through `bridgeWebSocket`; for a library that opens its own, a build alias to a shim on it (as Telegram's).
- [ ] `usesVoiceSettings` and `screenShare` if it runs calls with screen sharing.
- [ ] `sendsTyping` if it sends typing indicators, and none while its `typing` value is `false`.
- [ ] `notice` if using the platform here carries a risk users should know about.
- [ ] `settings` for anything users may want to change or reset per service, instead of a screen or secret of the module's own.
- [ ] Added to `MODULES` in `src/main/modules/index.ts`, and the expected lists in `tests/main/modules.test.ts` updated.
- [ ] Tokens only in the scoped secret store; no Electron, Node or `main/` imports.
- [ ] Unit tests in `tests/modules/<module>/`, and a live suite in `tests/live/` if a server can be run locally.
- [ ] `npm run check` passes, and `npm run build` produces `dist/engines/<engine>.js`.
- [ ] README: the module in the list of built-in modules and in the Layout section.
