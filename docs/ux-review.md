# UX and accessibility review

A walkthrough of Multicord as a new user would meet it, on the desktop and at
phone width, with keyboard-only and screen-reader checks, colour contrast and
an automated axe pass. October 2026, on Windows 11, against `main` from
commit `858162c` on. What was fixed is listed with its commit; what is left
needs a decision or more work than a review should make.

## Method

- **The real app, offline.** The built app in a scratch Electron with a fresh
  `--user-data-dir` and no name resolution (as `npm run smoke` runs it),
  driven over the DevTools protocol, with a small main-process hook that set
  the window size and composited every view of the window into one
  screenshot. Covered: first run, the rail, the Messages page, Settings on
  every tab, adding four services and removing one, each native module's
  sign-in screen (Fluxer, Telegram, Matrix, Stoat, Spacebar, Nerimity), and
  the window at its minimum width.
- **Populated states without accounts.** The built native chat view, the
  phone's shell page and the gallery in a scratch Electron whose preloads were
  fake bridges, fed sample states (messages with Markdown, replies,
  reactions, attachments, a poll, a thread, pins, search results, members, a
  profile card, every picker tab, mention suggestions, the forward and poll
  dialogs, a call with another ringing, an error banner, a read-only
  conversation, the unread divider and jump buttons) at 1280×800, at 700px
  and, with the phone bridge (`.mobile`), at 390×844.
- **Keyboard.** Tab and Shift+Tab walks recorded where focus went and whether
  it was visible; Enter, Escape and arrow keys in the composer's mention
  list, the picker, the profile card, the forward and poll dialogs, search
  and the drawer.
- **Measurements.** Hit targets under 24px (44px at phone width), horizontal
  overflow, landmarks, live regions and accessible names, read from the DOM;
  WCAG contrast ratios computed for the colour tokens.
- **axe-core** on every state above; this became `npm run a11y`
  (`scripts/a11y.mjs`), which now passes with an empty baseline.

The screenshots are not committed. They are in the session's scratchpad,
`ux/shots/`: `d*` the real app at desktop size, `v*` the populated native
view at desktop size, `p*` the native view at phone width, `m*` the phone
shell, `g*` the gallery, `after-*` the rail and Messages page after the fixes.

## Findings, most severe first

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High | Every service's home bubble in the rail read "DM": with three to seven services the rail was a column of identical circles, and the names were only in a hover tooltip. | Fixed in `69e88a3`: the service's initials, tinted in its module's colour; the name label also follows keyboard focus. |
| 2 | High | Offline (or when a web service is down), Discord's view is a blank white page: Chromium's error page with nothing in it. It is the first screen of a first run. | Fixed in round 2 (`2416994`). |
| 3 | High | Errors from the native engines leaked internals: "Could not reach Fluxer: Error invoking remote method 'engine:invoke': Error: net::ERR_NAME_NOT_RESOLVED", also in Settings > Diagnostics. | Fixed in `6879552`: "Could not reach Fluxer: the server's address could not be found; check your internet connection". |
| 4 | High | At phone width a long conversation name widened the list past the screen: unread badges and Sign out were cut off and the page scrolled sideways. | Fixed in `e7c7184`. |
| 5 | High | The member list had no close button and no Escape; in narrow windows and on phones it lies over the conversation and covers its own toggle, so it could not be closed. | Fixed in `baf304d`. |
| 6 | Medium | Contrast below 4.5:1: red error text (3.7), the unread divider (3.4), red badges and red buttons under white text (3.4 to 3.8), the thread link in the accent colour (3.0), green status text (4.3), module badges on light module colours (2.4 to 3.3), muted channels (4.3), a switched-off service's buttons (2.6). | Fixed in `cf0c8fe` and `be9b456`; the contrast table is below. |
| 7 | Medium | Dialogs dropped focus to the page on closing (profile card, forward dialog); search and pins did not close with Escape. | Fixed in `baf304d` and `fb67a5c`: focus goes back to what opened them. |
| 8 | Medium | Screen readers heard nothing when a message arrived: no live region (the list is redrawn on every update, so it cannot be one). | Fixed in `b10ba9a`: a polite status line, "Bo: hello". |
| 9 | Medium | ARIA errors (axe critical/serious): `aria-expanded` on the composer's textarea, the unread divider a `separator` inside the message list, the composer unnamed when read only. | Fixed in `85ed12b` and `be9b456`. |
| 10 | Medium | Hit targets: mute toggles 20px, category toggles 17px, text buttons 22px, author names 18px; on the phone the header buttons 32px, composer buttons 40px, call strip 40px, settings controls 26px. | Fixed in `e7c7184`, `ee41f39` and `be9b456` (24px desktop, 44px phone). Reactions fixed in round 2 (`21b8081`); links that stand on their own got 44px on the phone in round 3 (`e2f4a1d`); links within sentences keep the text's size. |
| 11 | Medium | Tab never leaves the rail: each part of the window (rail, service, Settings) is a view of its own, and focus wraps inside it. A keyboard user cannot get from the rail to the conversation or back. | Fixed in round 2 (`13083ab`). |
| 12 | Medium | The phone drawer's Messages entry gained one more unread badge on every redraw. | Fixed in `4fe29d7`. |
| 13 | Medium | No light theme: every page is dark only (`color-scheme: dark`) and ignores `prefers-color-scheme`. | Fixed in round 2 (`65dcd5e`). |
| 14 | Low | Adding a service happens at the bottom of a long Services page while the "takes effect after a restart" notice is at the top, out of sight. | Fixed in `ee41f39`: the notice stays in sight. |
| 15 | Low | A service's own settings squeezed their label to a word a line on the phone. | Fixed in `ee41f39`. |
| 16 | Low | The Messages page's empty state sat at the bottom of the window. | Fixed in `592b7a9`. |
| 17 | Low | Forwarding listed invitations the user had not accepted. | Fixed in `baf304d`. |
| 18 | Low | An incoming call's Accept and Decline sit at the bar's right end, where an open profile card or dialog covers them. | Fixed in round 2 (`281073f`). |
| 19 | Low | Pinned messages and search results show raw Markdown (`**Bold**`, `# Release notes`). | Fixed in round 2 (`1d8a0a0`). |
| 20 | Low | Sign-in screens: Telegram's "my.telegram.org" is plain text, not a link; the drawer does not move focus into itself or close with Escape (on Android, back closes it). | Fixed in round 3 (`2dee900`, `863b400`). |
| 21 | Low | Moderate axe findings left: heading levels skip (h2 sidebar title, h3 panel headings), no h1 in the chat view. | Fixed in round 2 (`dfe8efb`), but for one (see round 2). |

### Contrast

Ratios on the dark panels (`--bg` #1e1f22, `--panel` #2b2d31, `--surface`
#313338). The light theme came in round 2; its table is there.

| Text | Before | After |
|------|--------|-------|
| Body text #f2f3f5 | 12.4 | unchanged |
| Muted text #b5bac1 | 7.1 | unchanged |
| Red text (errors, unread divider, Sign out) | #f23f43: 3.7 | `--danger-text` #fa777a: 5.2 |
| Thread link | accent #5865f2: 3.0 | `--accent-text` #949cf7: 5.5 |
| Green status text | #23a55a: 4.3 | `--ok-text` #2dc770: 6.3 |
| White on red (badges, Leave, banner) | #f23f43: 3.8 | `--danger`/`--badge` #da373c: 4.6 |
| White on module badges | module colour: 2.4 to 3.3 | colour mixed 55% with black: 4.5 or more |
| Muted (notifications off) channel | 4.3 | 4.9 |

## Round 2

The findings round 1 left open, taken up in October 2026 from `57e064c` on,
with the same harness: the built app offline in a scratch Electron, and the
native view, phone shell and gallery fed sample states. Every screen that
changed was shot again in both themes, at desktop size and at 390px (the
scratchpad's `ux/shots/r2/`: `dark-*` and `light-*`, `d-` desktop and `p-`
phone for the native view, `m-` the phone shell, `narrow-` the real app at
600px).

| # | Round 1 finding | Now |
|---|-----------------|-----|
| 2 | Offline, Discord's view is a blank page. | Fixed in `2416994`: a page of the shell's own covers any web service whose page did not load ("Couldn't reach Discord", why in plain words, Try again, Open Settings, the error code small), and goes once the page loads. It holds nothing of the service. `npm run smoke` checks it offline, and Try again. |
| 11 | Tab never leaves the rail. | Fixed in `13083ab`: F6 and Shift+F6 (Ctrl+F6 too) move between the rail, the content (Settings, the Messages list and its conversation, a service, the couldn't-reach page) and, in the native view, its conversation list, conversation and open side panel. Focus lands with a ring on the open item, the last thing focused there, the composer or the first control. README's Keyboard entry documents it. |
| 13 | No light theme. | Fixed in `65dcd5e`: Settings > General > Appearance offers "As the system" (the default), Light and Dark for the rail, Messages, Settings, the native views, the picker, the couldn't-reach page and the phone shell. Web services keep their own themes. Colours are tokens in `shell.css`; the contrast table is below. |
| 18 | An incoming call's Accept and Decline hide under an open profile card or dialog. | Fixed in `281073f`: the call bar stays on top, and cards, dialogs and the side panels over the conversation start below it. A new call is announced once (an alert line); the bar is a named group that keeps focus across updates. |
| 19 | Pinned messages and search results show raw Markdown. | Fixed in `1d8a0a0`: an excerpt from the same parser, text nodes and inline elements only (nothing to click inside the entry's button), with spoilers kept hidden, cut at 200 characters. |
| 10 | Phone reaction chips are 25px. | Fixed in `21b8081`: 44px targets, the chip drawn compact inside. |
| 21 | Moderate axe findings: heading levels skip, no h1 in the chat view. | Fixed in `dfe8efb`: one h1 per screen, titles and panels h2, sections h3, and a message's own headings from h3 down. One moderate finding is left (below). |
| — | `npm run a11y` ran only by hand. | `e62c93b`: CI runs it on all three systems after the smoke test; `0fbc350` checks every page in both themes, plus the rail, the Messages page and the couldn't-reach page (82 page states, about two minutes). |
| — | The smoke test's relay check failed once with the relay page missing. | `6f3f171`: it waits (bounded, 15 s) for the relay page to be listed. The couldn't-reach check was made robust too (`93a5139`, `e131f20`): Windows reports a covered window's pages as hidden, so it no longer asks the page whether it is visible. |

### Contrast, light theme

Ratios on the light panels (`--bg` #e3e5e8, `--panel` #f2f3f5, `--surface`
#ffffff); the lower of the two where both are shown. `npm run a11y` now runs
axe's colour-contrast rule on every page in both themes.

| Text | Light |
|------|-------|
| Body text #060607 | 16.1 |
| Muted text #4e5058 | 6.4 |
| Muted (notifications off) channel, at 90% | 5.7 |
| Accent text (thread links) #4049b8 | 5.8 |
| Red text #b3242a | 5.2 |
| Green text #0f6230 (also on the selected row #d4d7dc) | 5.2 |
| Warning text ("Not signed in") #7a5000 | 6.4 |
| Links #0058b3 | 5.5 |
| White on the accent #5865f2 / on red #da373c | 4.6 / 4.6 |
| A role's colour (names, profile card) | mixed 55% with black, so the service's light colours read |

### Left for a human

- **The theme on the phone.** On Android the shell page and the chat views
  take light or dark from `prefers-color-scheme` as the WebView reports it,
  which depends on the app's own theme; that was not checked on a device.
  The Settings choice is offered on the desktop only: applying it on the
  phone needs native code (`src/mobile`, the WebViews' settings) and a device
  to check it on.
- **F6 inside web services.** F6 always gets out of Discord or Element (the
  shell takes the key first), but where focus lands inside them is theirs:
  coming back to a web service, Chromium restores what had focus there, and
  on a fresh page that is the page itself, without a visible ring.
- **One moderate axe finding:** on the phone's conversation list the page has
  no main landmark, as the conversation (the main) is out of sight on that
  pane. Making the list the main there means changing landmarks per pane.
- **From round 1, still open:** Telegram's "my.telegram.org" as plain text,
  and the phone drawer neither moving focus into itself nor closing with
  Escape (#20); inline links in messages keep their size on the phone (#10).

## Round 3

The small items round 2 left, from `85cf248` on. The phone's pages were
checked in the scratch Electron at 390px with the phone bridge, in both
themes; the Android side in JVM tests and builds (`assembleDebug`,
`testDebugUnitTest`, `lintDebug`, `assembleRelease`), not on a device.

| Round 2 left | Now |
|--------------|-----|
| The drawer neither takes focus nor closes with Escape (#20). | Fixed in `863b400`: opening it focuses the open entry (the server or DMs, else the service, else Messages); Tab wraps inside it and the rest of the page is inert while it is open (natively, the chat view under it is hidden from TalkBack too); Escape, back and a tap on the scrim close it and focus the menu button again. An entry keeps focus when the drawer is redrawn (an unread count changed). The menu button already had `aria-expanded` and `aria-controls`. |
| The theme on the phone: offered on the desktop only, and the WebViews always reported dark. | Fixed in `6e9cb6d` and `96f2d3a`: the tokens are `light-dark()` pairs, so a page follows `prefers-color-scheme` or a `data-theme` on its root; the phone's Settings offers the choice, the shell page applies it and tells native code, which passes it to every chat view and paints the screen behind the pages and the system bars. The app's theme is DayNight (Android 10 and later; light on 9), so "as the system" follows the phone, and algorithmic darkening is off in every WebView. |
| One moderate axe finding: no main landmark on the phone's conversation list. | Fixed in `56cbf2c`: on the list pane the chat layout is the main ("Conversations", the list's navigation inside it); on the conversation pane the conversation's own main is the only one. |
| Telegram's "my.telegram.org" is plain text (#20). | Fixed in `2dee900`: "Open my.telegram.org" under the explanation, to its API development tools page, opened in the browser as every link in the view is. |
| Inline links keep their size on the phone (#10). | `e2f4a1d`: links that stand on their own reach 44px (a file is a 44px line; a link preview's title and a sign-in step's link get padding the text does not move with, measured at 44 to 45px with the text where it was). Links inside a message's sentences keep the text's size, as WCAG 2.5.8's inline exception allows. "Load older messages" was already 44px. |
| — | `46ecbcd`: README's smoke-test paragraph names the couldn't-reach check and says the accessibility check runs after it. |

`npm run a11y` after these: 82 page states, both themes, no serious or
critical violations; with `--all` the only findings left are the rail's two
moderate ones (no main landmark, no h1), as the rail is a strip of its own
beside the content, whose page has both.

### Left for a human

- **On a device:** the theme in each setting, and switching the phone's dark
  theme while Multicord is open with "as the system" (the activity keeps
  running through the change; whether each WebView's
  `prefers-color-scheme` follows at once, or only for pages loaded after,
  is the WebView's); the drawer with TalkBack and with a hardware keyboard.
- **F6 inside web services** (round 2) is unchanged.

## How to navigate Multicord

- **The rail** on the left is the whole app: Messages at the top, then one
  bubble per service (its initials, in its module's colour; hover or focus
  shows the name), then servers and folders, and Settings (the gear) at the
  bottom. The bubble or page that is open has a white bar beside it.
- **A service's bubble** opens its home: the conversation list on the left of
  the chat view, the conversation on the right, with call, search, pinned
  messages and members at the top right, and the composer at the bottom
  (+ attach, poll, emoji/stickers/GIFs). Hover or focus a message for reply,
  react, forward, thread and copy. Escape closes what is open.
- **Messages** lists every service's direct messages in one place, newest
  first; opening one shows it beside the list.
- **Settings** has Services & accounts (sign in, add a second account, turn a
  service off, rename, remove), Voice & video, General, Favourites,
  Diagnostics and About. Adding or removing a service needs a restart, which
  the notice at the top offers.
- **From the keyboard,** F6 and Shift+F6 move between the rail, the content
  and (in a chat view) its list, conversation and side panel; Tab moves
  within a part, and Escape closes what is open.
- **On a phone** the bar's menu opens the drawer (Messages, each service's
  home, servers and unread DMs, Settings), with focus on what is open; back,
  Escape or a tap beside it closes it. A conversation shows on its own
  with a back arrow, and in a call compact controls sit over it.

A new user finds their way: the gear and Messages are where they expect
them, each service has a recognisable bubble, sign-in screens say what they
need, and empty states say what to do next. After round 2 an unreachable
service says so instead of showing a blank page, F6 gets a keyboard user
between the parts of the window, and the shell follows a light system theme;
after round 3 the phone takes the theme setting too, and its drawer works
from the keyboard and with a screen reader. What is left is listed under round 3.
