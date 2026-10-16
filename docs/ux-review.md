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
| 2 | High | Offline (or when a web service is down), Discord's view is a blank white page: Chromium's error page with nothing in it. It is the first screen of a first run. | **Left** (main process): load a page of the shell's own on `did-fail-load` for web services, saying the service could not be reached, with Try again. |
| 3 | High | Errors from the native engines leaked internals: "Could not reach Fluxer: Error invoking remote method 'engine:invoke': Error: net::ERR_NAME_NOT_RESOLVED", also in Settings > Diagnostics. | Fixed in `6879552`: "Could not reach Fluxer: the server's address could not be found; check your internet connection". |
| 4 | High | At phone width a long conversation name widened the list past the screen: unread badges and Sign out were cut off and the page scrolled sideways. | Fixed in `e7c7184`. |
| 5 | High | The member list had no close button and no Escape; in narrow windows and on phones it lies over the conversation and covers its own toggle, so it could not be closed. | Fixed in `baf304d`. |
| 6 | Medium | Contrast below 4.5:1: red error text (3.7), the unread divider (3.4), red badges and red buttons under white text (3.4 to 3.8), the thread link in the accent colour (3.0), green status text (4.3), module badges on light module colours (2.4 to 3.3), muted channels (4.3), a switched-off service's buttons (2.6). | Fixed in `cf0c8fe` and `be9b456`; the contrast table is below. |
| 7 | Medium | Dialogs dropped focus to the page on closing (profile card, forward dialog); search and pins did not close with Escape. | Fixed in `baf304d` and `fb67a5c`: focus goes back to what opened them. |
| 8 | Medium | Screen readers heard nothing when a message arrived: no live region (the list is redrawn on every update, so it cannot be one). | Fixed in `b10ba9a`: a polite status line, "Bo: hello". |
| 9 | Medium | ARIA errors (axe critical/serious): `aria-expanded` on the composer's textarea, the unread divider a `separator` inside the message list, the composer unnamed when read only. | Fixed in `85ed12b` and `be9b456`. |
| 10 | Medium | Hit targets: mute toggles 20px, category toggles 17px, text buttons 22px, author names 18px; on the phone the header buttons 32px, composer buttons 40px, call strip 40px, settings controls 26px. | Fixed in `e7c7184`, `ee41f39` and `be9b456` (24px desktop, 44px phone). In-message reactions (25px) and inline links are left at their size on the phone. |
| 11 | Medium | Tab never leaves the rail: each part of the window (rail, service, Settings) is a view of its own, and focus wraps inside it. A keyboard user cannot get from the rail to the conversation or back. | **Left** (main process): F6 and Shift+F6 to move focus between the rail and the content view, as browsers move between their frames. |
| 12 | Medium | The phone drawer's Messages entry gained one more unread badge on every redraw. | Fixed in `4fe29d7`. |
| 13 | Medium | No light theme: every page is dark only (`color-scheme: dark`) and ignores `prefers-color-scheme`. | **Left**: a design decision, and a theme for every page. |
| 14 | Low | Adding a service happens at the bottom of a long Services page while the "takes effect after a restart" notice is at the top, out of sight. | Fixed in `ee41f39`: the notice stays in sight. |
| 15 | Low | A service's own settings squeezed their label to a word a line on the phone. | Fixed in `ee41f39`. |
| 16 | Low | The Messages page's empty state sat at the bottom of the window. | Fixed in `592b7a9`. |
| 17 | Low | Forwarding listed invitations the user had not accepted. | Fixed in `baf304d`. |
| 18 | Low | An incoming call's Accept and Decline sit at the bar's right end, where an open profile card or dialog covers them. | **Left**: move the cards below the call bar, or the buttons to the left. |
| 19 | Low | Pinned messages and search results show raw Markdown (`**Bold**`, `# Release notes`). | **Left**: strip or render Markdown in those excerpts. |
| 20 | Low | Sign-in screens: Telegram's "my.telegram.org" is plain text, not a link; the drawer does not move focus into itself or close with Escape (on Android, back closes it). | **Left**. |
| 21 | Low | Moderate axe findings left: heading levels skip (h2 sidebar title, h3 panel headings), no h1 in the chat view. | **Left**: cosmetic for screen readers; `npm run a11y --all` lists them. |

### Contrast

Ratios on the panels (`--bg` #1e1f22, `--panel` #2b2d31, `--surface`
#313338). Only the dark theme exists.

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
- **On a phone** the bar's menu opens the drawer (Messages, each service's
  home, servers and unread DMs, Settings); a conversation shows on its own
  with a back arrow, and in a call compact controls sit over it.

A new user finds their way: the gear and Messages are where they expect
them, each service now has a recognisable bubble, sign-in screens say what
they need, and empty states say what to do next. The rough edges left are
the offline Discord page (2), keyboard travel between the rail and the
content (11) and the missing light theme (13).
