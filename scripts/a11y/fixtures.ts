// Sample states for the accessibility check (scripts/a11y.mjs): the native chat
// view's screens and populated chat states, and the settings page, as the main
// process would send them. Bundled by the script with esbuild; typechecked with
// the rest of the repository, so they follow the real contracts.
import type { FavouritesState } from "../../src/shared/favourites";
import type { NativeChannelCan, NativeMemberList, NativeMessage, NativeSidebarItem, NativeViewState } from "../../src/shared/native";
import type { MessagesState, RailState, UnreachableState } from "../../src/shared/ipc";
import { DEFAULT_SETTINGS, type SettingsViewState } from "../../src/shared/settings";

type Chat = Extract<NativeViewState, { screen: "chat" }>;
type Channel = NonNullable<Chat["channel"]>;

/** A coloured square with a letter, as the base64 data URL views accept for pictures. */
export function image(color: string, letter: string, width = 64, height = 64): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${color}"/><text x="${width / 2}" y="${height / 2 + 10}" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

const ANA = image("#e67e22", "A");
const BO = image("#2980b9", "B");
const at = (minutes: number): string => new Date(Date.parse("2026-10-14T12:00:00Z") + minutes * 60_000).toISOString();
const base = { edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };

const MARKDOWN = ["# Release notes", "**Bold**, *italic*, `code` and ||a spoiler||.", "Links: https://fluxer.app and [masked](https://docs.fluxer.app).", "> Quotes keep **formatting**", "- lists", "```ts", 'const greeting = "hello";', "```"].join("\n");

export const MESSAGES: NativeMessage[] = [
  { ...base, id: "1001", author: "Ana", authorId: "11", avatarUrl: ANA, content: MARKDOWN, timestamp: at(0), pinned: true, canPin: true },
  {
    ...base,
    id: "1002",
    author: "Bo",
    authorId: "12",
    avatarUrl: BO,
    content: "Looks good! One question about the migration though.",
    timestamp: at(3),
    reply: { author: "Ana", content: "Release notes", id: "1001", timestamp: at(0) },
    reactions: [
      { key: "👍", label: "👍", count: 3, me: true },
      { key: "🎉", label: "🎉", count: 1, me: false },
    ],
    thread: { count: 4, latest: "Ana" },
  },
  { ...base, id: "1003", author: "Cy", authorId: "13", content: "@You can you check the build?", timestamp: at(5), mentionsMe: true, edited: true },
  {
    ...base,
    id: "1004",
    author: "You",
    authorId: "10",
    mine: true,
    canEdit: true,
    canDelete: true,
    content: "On it. Attached the log and a screenshot.",
    timestamp: at(7),
    attachments: [
      { name: "screenshot.png", kind: "image", url: image("#34495e", "S", 320, 180), width: 320, height: 180 },
      { name: "build-log.txt", kind: "file", url: "https://example.com/build-log.txt", size: 20_480 },
    ],
  },
  {
    ...base,
    id: "1005",
    author: "Ana",
    authorId: "11",
    avatarUrl: ANA,
    content: "Which day works?",
    timestamp: at(9),
    poll: {
      question: "Which day works for the release party?",
      options: [
        { id: "a", text: "Friday", votes: 5, chosen: true },
        { id: "b", text: "Saturday", votes: 3 },
      ],
      multiple: false,
      closed: false,
      total: 8,
      canVote: true,
    },
  },
  ...Array.from({ length: 8 }, (_, i): NativeMessage => ({ ...base, id: String(2000 + i), author: i % 2 ? "Bo" : "Dee", authorId: i % 2 ? "12" : "14", content: `Message ${i + 1}`, timestamp: at(30 + i) })),
];

export const SIDEBAR: NativeSidebarItem[] = [
  { id: "300", name: "announcements", kind: "text", unread: false, mentions: 0, active: false },
  { id: "310", name: "Text channels", kind: "category", unread: false, mentions: 0, active: false, collapsible: true },
  { id: "301", name: "general", kind: "text", unread: false, mentions: 0, active: true },
  { id: "302", name: "release-plan-for-the-autumn-version-with-a-very-long-name", kind: "text", unread: true, mentions: 2, active: false, canMute: true },
  { id: "303", name: "ideas", kind: "forum", unread: true, mentions: 0, active: false },
  { id: "401", name: "Lounge", kind: "voice", unread: false, mentions: 0, active: false, members: [{ name: "Ana", avatarUrl: ANA, muted: false, video: true }, { name: "Bo", muted: true, video: false }] },
  { id: "501", name: "Cy", kind: "dm", iconUrl: image("#9b59b6", "C"), unread: true, mentions: 3, active: false, canMute: true },
  { id: "502", name: "Dee", kind: "dm", unread: false, mentions: 0, active: false, muted: true, canMute: true },
  { id: "601", name: "Board games", kind: "text", unread: false, mentions: 0, active: false, invite: { from: "Ana" } },
];

const CAN: NativeChannelCan = { reply: true, react: true, attach: true, typing: true, members: true, stickers: true, gifs: true, pins: true, search: true, forward: true, threads: true, call: true, polls: true };

export const MEMBERS: NativeMemberList = {
  sections: [
    { name: "Online", members: [{ id: "11", name: "Ana", avatarUrl: ANA, presence: "online", color: "#e67e22", status: "Shipping the release", mention: "<@11>" }, { id: "12", name: "Bo", avatarUrl: BO, presence: "idle", mention: "<@12>" }] },
    { name: "Offline", members: [{ id: "14", name: "Dee", presence: "offline", mention: "<@14>" }] },
  ],
  hasMore: false,
  loading: false,
};

const VOICE = { channelId: "401", channelName: "Lounge", guildName: "Open Source Hub", mute: false, deaf: false, video: false, stream: false };
const LISTED = MESSAGES.slice(0, 3).map(({ id, author, avatarUrl, content, timestamp }) => ({ id, author, ...(avatarUrl ? { avatarUrl } : {}), content: content.slice(0, 120), timestamp }));

/** A populated conversation, with whatever else the state or the channel should have. */
export function chat(extra: Partial<Chat> = {}, channel: Partial<Channel> = {}): Chat {
  return {
    screen: "chat",
    platform: "fluxer",
    title: "Open Source Hub",
    me: "You",
    sidebar: SIDEBAR,
    voice: null,
    customEmoji: [{ id: "55", name: "party", animated: false, url: image("#f1c40f", "P"), source: "Open Source Hub", text: "<:party:55>", key: "party:55" }],
    stickers: [{ id: "1", name: "Release crew", stickers: [{ id: "2", name: "Wave", format: "png", url: image("#4f8cf7", "W", 160, 160) }] }],
    gifs: { query: "", loading: false, results: [{ id: "g1", url: image("#8e44ad", "G", 200, 120), preview: image("#8e44ad", "G", 200, 120), video: false, width: 200, height: 120, name: "dance" }] },
    ...extra,
    channel: { id: "301", name: "general", messages: MESSAGES, loading: false, hasOlder: true, typing: ["Ana", "Bo"], pending: [], uploading: false, can: CAN, ...channel },
  };
}

/** The native view's states to check, by name, with what to do in the page before checking (a script, or nothing). */
export const NATIVE: { name: string; state: NativeViewState; then?: string; phone?: boolean }[] = [
  { name: "login", state: { screen: "login", platform: "fluxer", identity: "email", busy: false, error: "That email and password do not match." } },
  { name: "two-factor", state: { screen: "mfa", platform: "fluxer", codes: "totp", busy: false } },
  {
    name: "prompt",
    state: { screen: "prompt", platform: "telegram", busy: false, prompt: { id: "api", title: "Connect Multicord to Telegram", description: "Telegram asks every app for its own API ID.", fields: [{ name: "id", label: "API ID", type: "number" }, { name: "hash", label: "API hash", type: "text" }], submit: "Continue" } },
  },
  { name: "connecting", state: { screen: "connecting", platform: "fluxer", status: "Connecting to Fluxer…" } },
  { name: "chat, nothing open", state: { ...chat(), channel: null } },
  { name: "chat with members and unread divider", state: chat({}, { members: MEMBERS, unread: { firstId: "2002", count: 6 } }) },
  { name: "pinned messages", state: chat({}, { pins: { messages: LISTED, loading: false } }) },
  { name: "search", state: chat({}, { search: { query: "build", loading: false, messages: LISTED } }), then: `document.querySelector(".search-toggle").click()` },
  { name: "thread", state: chat({}, { thread: { rootId: "1002", loading: false, messages: MESSAGES.slice(1, 3) } }) },
  { name: "profile card", state: chat({ profile: { id: "11", name: "Ana", presence: "online", username: "ana", about: "Maintainer.", roles: [{ name: "Admin", color: "#e74c3c" }] } }, { members: MEMBERS }), then: `document.querySelector("button.member").click()` },
  { name: "picker: emoji", state: chat(), then: `document.querySelector(".emoji-button").click()` },
  { name: "picker: stickers", state: chat(), then: `document.querySelector(".emoji-button").click(); document.querySelectorAll(".composer-picker .picker-tab")[1].click()` },
  { name: "picker: GIFs", state: chat(), then: `document.querySelector(".emoji-button").click(); document.querySelectorAll(".composer-picker .picker-tab")[2].click()` },
  { name: "picker: favourites", state: chat(), then: `document.querySelector(".emoji-button").click(); document.querySelectorAll(".composer-picker .picker-tab")[3].click()` },
  { name: "mention suggestions", state: chat({}, { members: MEMBERS }), then: `(() => { const c = document.querySelector(".composer"); c.focus(); c.value = "Hey @b"; c.setSelectionRange(6, 6); c.dispatchEvent(new Event("input")); })()` },
  { name: "forward dialog", state: chat(), then: `[...document.querySelectorAll(".message-actions button")].find((b) => b.textContent === "Forward").click()` },
  { name: "new poll dialog", state: chat(), then: `document.querySelector(".poll-button").click()` },
  { name: "in a call, another ringing", state: chat({ voice: { ...VOICE, url: "wss://voice.example", token: "t" }, incomingCall: { channelId: "501", from: "Cy", video: true } }) },
  { name: "error and read-only", state: chat({ error: "Could not send: you are sending messages too quickly." }, { locked: "You do not have permission to send messages here." }) },
  { name: "phone: conversation list", state: { ...chat(), channel: null }, phone: true },
  { name: "phone: conversation", state: chat({}, { unread: { firstId: "2002", count: 6 } }), phone: true },
  { name: "phone: call strip", state: chat({ voice: { ...VOICE, url: "wss://voice.example", token: "t" } }), phone: true },
];

/** Favourites as the shell sends them to a view. */
export const FAVOURITES: FavouritesState = { categories: [], items: [], module: { name: "Fluxer", label: "Fluxer", color: "#4f8cf7" }, saving: [] };

/** The settings page with three services, one signed out, and a restart pending. */
export const SETTINGS: SettingsViewState = {
  settings: structuredClone(DEFAULT_SETTINGS),
  services: [
    { id: "discord", name: "Discord", url: "https://discord.com", module: "discord", moduleName: "Discord", label: "Discord", color: "#5865f2", enabled: true, builtIn: true, account: { state: "signed-in", name: "Sam" }, restartable: true, health: [{ name: "Discord's page has loaded", ok: true }] },
    { id: "fluxer", name: "Fluxer", url: "https://fluxer.app", module: "fluxer", moduleName: "Fluxer", label: "Fluxer", color: "#4f8cf7", enabled: true, builtIn: true, account: { state: "signed-out" }, restartable: true, sendsTyping: true, health: [{ name: "Instance found", ok: false, detail: "Could not reach Fluxer" }] },
    { id: "matrix", name: "Matrix", url: "https://matrix.org", module: "matrix-native", moduleName: "Matrix", label: "Matrix", color: "#0dbd8b", enabled: false, builtIn: false },
  ],
  modules: [
    { id: "discord", name: "Discord account", label: "Discord", color: "#5865f2", defaultUrl: "https://discord.com", fixedUrl: true, calls: true },
    { id: "matrix-native", name: "Matrix", label: "Matrix", color: "#0dbd8b", defaultUrl: "https://matrix.org", fixedUrl: false, calls: true },
  ],
  restartNeeded: true,
  secretsPersistent: true,
  launchAtLoginSupported: true,
  themes: true,
  version: "0.1.0",
  favourites: { categories: [], items: 0, cacheBytes: 0, pinned: 0 },
};

const FLUXER = { label: "Fluxer", color: "#4f8cf7" };
const DISCORD = { label: "Discord", color: "#5865f2" };

/** The rail with two services, a folder, servers with unread news and mentions, and a DM. */
export const RAIL: RailState = {
  entries: [
    { key: "discord:home", platform: "discord", kind: "home", name: "Discord", unread: false, mentions: 0, module: DISCORD },
    { key: "discord:dm:1", platform: "discord", kind: "dm", name: "Ana", iconUrl: ANA, unread: true, mentions: 2, module: DISCORD },
    { key: "fluxer:home", platform: "fluxer", kind: "home", name: "Fluxer", unread: false, mentions: 0, module: FLUXER },
    { key: "discord:g1", platform: "discord", kind: "server", name: "Open Source Hub", iconUrl: image("#16a085", "O"), unread: true, mentions: 3, module: DISCORD },
    { key: "fluxer:g2", platform: "fluxer", kind: "server", name: "Board games", unread: false, mentions: 0, module: FLUXER },
    { key: "discord:f1", platform: "discord", kind: "group", name: "Work", color: "#e67e22", expanded: false, previewIconUrls: [BO], unread: true, mentions: 0, module: DISCORD },
  ],
  activeKey: "discord:g1",
  messagesBadge: { unread: true, mentions: 2 },
};

/** The unified Messages list: conversations from two services, one open. */
export const MESSAGES_PAGE: MessagesState = {
  conversations: [
    { key: "discord:dm:1", platform: "discord", title: "Ana", avatarUrl: ANA, preview: "See you at eight!", lastActivity: Date.parse("2026-10-14T12:00:00Z"), unread: true, mentions: 2, module: DISCORD },
    { key: "fluxer:dm:2", platform: "fluxer", title: "Bo", avatarUrl: BO, preview: "Thanks!", lastActivity: Date.parse("2026-10-13T09:00:00Z"), unread: false, mentions: 0, module: FLUXER },
  ],
  activeKey: "fluxer:dm:2",
};

/** The couldn't-reach page over Discord, offline. */
export const UNREACHABLE: UnreachableState = { service: "Discord", reason: "the server's address could not be found; check your internet connection", code: "ERR_NAME_NOT_RESOLVED", retrying: false };
