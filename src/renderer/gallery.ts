// A living style guide: every renderer component with sample data, for
// checking designs without signing in anywhere. Open dist/gallery.html
// (npm run gallery). Handlers only log, so everything is safe to click.
import type { Conversation, RailState } from "../shared/ipc";
import type { NativeMessage, NativeSidebarItem } from "../shared/native";
import { loginForm, mfaForm, setIdentityKind } from "./components/auth";
import { channelList } from "./components/channels";
import { conversationItem } from "./components/conversations";
import { el } from "./components/dom";
import { emojiPicker } from "./components/emojiPicker";
import { typingText } from "./components/format";
import { renderMarkdown } from "./components/markdown";
import { messageItem, type MessageHandlers } from "./components/message";
import { forumPosts, pendingFiles, postForm, replyBar, voicePanel } from "./components/panels";
import { quickReactions } from "./components/reactions";
import { renderRail } from "./rail";

/** A coloured square with a letter, as a data URL, standing in for real images. */
export function placeholderImage(color: string, letter: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><text x="32" y="42" font-family="sans-serif" font-size="28" fill="white" text-anchor="middle">${letter}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const DISCORD = { label: "Discord", color: "#5865f2" };
const FLUXER = { label: "Fluxer", color: "#4f8cf7" };
const WEB = { label: "Web", color: "#80848e" };

export const SAMPLE_RAIL: RailState = {
  activeKey: "fluxer:2",
  entries: [
    { key: "discord:home", platform: "discord", kind: "home", name: "Discord direct messages", unread: false, mentions: 0, module: DISCORD },
    { key: "discord:dm:1", platform: "discord", kind: "dm", name: "Ana", iconUrl: placeholderImage("#e67e22", "A"), unread: true, mentions: 2, module: DISCORD },
    { key: "fluxer:home", platform: "fluxer", kind: "home", name: "Fluxer direct messages", unread: true, mentions: 0, module: FLUXER },
    { key: "fluxer:2", platform: "fluxer", kind: "server", name: "Open Source Hub", iconUrl: placeholderImage("#16a085", "O"), unread: true, mentions: 0, module: FLUXER },
    { key: "discord:3", platform: "discord", kind: "server", name: "Gaming Club", unread: false, mentions: 0, module: DISCORD },
    {
      key: "discord:folder:4",
      platform: "discord",
      kind: "group",
      name: "Work",
      color: "#e91e63",
      expanded: false,
      previewIconUrls: [placeholderImage("#8e44ad", "W"), placeholderImage("#2980b9", "D"), placeholderImage("#c0392b", "Q")],
      unread: true,
      mentions: 5,
      module: DISCORD,
    },
    { key: "fluxer:folder:5", platform: "fluxer", kind: "group", name: "Friends", color: "#2ecc71", expanded: true, unread: false, mentions: 0, module: FLUXER },
    { key: "fluxer:6", platform: "fluxer", kind: "server", name: "Board Games", parentKey: "fluxer:folder:5", unread: false, mentions: 0, module: FLUXER },
    { key: "fluxer:7", platform: "fluxer", kind: "server", name: "Hiking", iconUrl: placeholderImage("#27ae60", "H"), parentKey: "fluxer:folder:5", unread: true, mentions: 1, module: FLUXER },
    { key: "element:app", platform: "element", kind: "server", name: "Element", iconUrl: placeholderImage("#0dbd8b", "E"), unread: false, mentions: 12, module: WEB },
  ],
};

const HOUR = 60 * 60 * 1000;
/** Fixed "now" for the samples, so their times read the same on every run. */
export const SAMPLE_NOW = Date.parse("2026-10-14T15:00:00");

export const SAMPLE_CONVERSATIONS: Conversation[] = [
  { key: "telegram:dm:7", platform: "telegram", title: "Mila", avatarUrl: placeholderImage("#2aabee", "M"), preview: "See you at eight!", lastActivity: SAMPLE_NOW - HOUR / 4, unread: true, mentions: 2, module: { label: "Telegram", color: "#2aabee" } },
  { key: "discord:dm:1", platform: "discord", title: "Ana", avatarUrl: placeholderImage("#e67e22", "A"), lastActivity: SAMPLE_NOW - 3 * HOUR, unread: true, mentions: 0, module: DISCORD },
  { key: "fluxer:dm:3", platform: "fluxer", title: "Bo", preview: "Pushed the fix, can you review?", lastActivity: SAMPLE_NOW - 30 * HOUR, unread: false, mentions: 0, module: FLUXER },
  { key: "discord:dm:4", platform: "discord", title: "Weekend plans", lastActivity: SAMPLE_NOW - 40 * 24 * HOUR, unread: false, mentions: 0, module: DISCORD },
];

export const SAMPLE_CHANNELS: NativeSidebarItem[] = [
  { id: "1", name: "announcements", kind: "text", unread: false, mentions: 0, active: false },
  { id: "2", name: "Text channels", kind: "category", unread: false, mentions: 0, active: false },
  { id: "3", name: "general", kind: "text", unread: true, mentions: 0, active: true },
  { id: "4", name: "release plan", kind: "thread", unread: false, mentions: 2, active: false },
  { id: "5", name: "ideas", kind: "forum", unread: true, mentions: 0, active: false },
  { id: "6", name: "Voice", kind: "category", unread: false, mentions: 0, active: false },
  {
    id: "7",
    name: "Lounge",
    kind: "voice",
    unread: false,
    mentions: 0,
    active: true,
    members: [
      { name: "Ana", avatarUrl: placeholderImage("#e67e22", "A"), muted: false, video: true },
      { name: "Bo", muted: true, video: false },
    ],
  },
  { id: "8", name: "Cy", kind: "dm", iconUrl: placeholderImage("#9b59b6", "C"), unread: true, mentions: 3, active: false },
];

const MARKDOWN_SAMPLE = [
  "# Release notes",
  "**Bold**, *italic*, __underline__, ~~strike~~, `inline code` and ||a spoiler||.",
  "Links: https://fluxer.app and [masked links](https://docs.fluxer.app). Emoji: :tada: :+1: <:party:55>",
  "> Quotes keep **formatting**",
  "- lists",
  "- with items",
  "```ts",
  "const greeting = \"hello\";",
  "```",
  "-# Small print",
].join("\n");

const base = { timestamp: "2026-10-14T12:00:00Z", edited: false, mine: false, canEdit: false, canDelete: false, reactions: [], attachments: [] };

export const SAMPLE_MESSAGES: NativeMessage[] = [
  { ...base, id: "1", author: "Ana", avatarUrl: placeholderImage("#e67e22", "A"), content: MARKDOWN_SAMPLE },
  {
    ...base,
    id: "2",
    author: "Bo",
    content: "Replying with reactions",
    reply: { author: "Ana", content: "Release notes" },
    reactions: [
      { key: "👍", label: "👍", count: 3, me: true },
      { key: "party:55", label: ":party:", imageUrl: placeholderImage("#f1c40f", "P"), count: 1, me: false },
    ],
  },
  { ...base, id: "3", author: "Cy", content: "This replies to a deleted message", reply: null, edited: true },
  {
    ...base,
    id: "4",
    author: "You",
    mine: true,
    canEdit: true,
    canDelete: true,
    content: "Attachments: an image, a file and an expired link",
    attachments: [
      { name: "screenshot.png", url: placeholderImage("#34495e", "▣"), kind: "image" },
      { name: "notes.txt", url: "https://example.com/notes.txt", kind: "file" },
      { name: "old.zip", kind: "file" },
    ],
  },
  { ...base, id: "5", author: "Ana", content: "😂🎉👍" },
];

const log =
  (name: string) =>
  (...args: unknown[]): void =>
    console.info(`[gallery] ${name}`, ...args);

const handlers: MessageHandlers = {
  onReply: log("reply"),
  onToggleReactionPicker: log("react"),
  onReact: log("toggle reaction"),
  onMoreReactions: log("more reactions"),
  onEdit: log("edit"),
  onDelete: log("delete"),
};

function section(doc: Document, title: string, description: string, ...content: Node[]): HTMLElement {
  const block = el(doc, "section", "gallery-section");
  const body = el(doc, "div", "gallery-body");
  body.append(...content);
  block.append(el(doc, "h2", undefined, title), el(doc, "p", "gallery-description", description), body);
  return block;
}

function wrap(doc: Document, tag: "ul" | "ol" | "div" | "nav", className: string, children: Node[]): HTMLElement {
  const element = el(doc, tag, className);
  element.append(...children);
  return element;
}

const emojiUrl = (id: string) => placeholderImage("#f1c40f", id === "55" ? "P" : "?");

/** Builds the whole gallery into `root`. */
export function renderGallery(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const rail = el(doc, "nav", "gallery-rail");
  rail.id = "rail";
  renderRail(rail, SAMPLE_RAIL, log("open"));

  const login = loginForm(doc, "Fluxer", log("login"));
  setIdentityKind(login, "email");
  const mfa = mfaForm(doc, "totp", { onSubmit: log("mfa"), onCancel: log("cancel") });

  const voiceConnecting = wrap(doc, "div", "voice-panel", voicePanel(doc, { channelId: "7", channelName: "Lounge", guildName: "Open Source Hub", mute: false, deaf: false, video: false, stream: false }, { onChange: log("voice"), onLeave: log("leave") }));
  const voiceLive = wrap(
    doc,
    "div",
    "voice-panel",
    voicePanel(doc, { channelId: "7", channelName: "Lounge", guildName: "", url: "wss://x", token: "t", mute: true, deaf: false, video: true, stream: false }, { onChange: log("voice"), onLeave: log("leave") }),
  );

  root.replaceChildren(
    el(doc, "h1", undefined, "Multicord components"),
    section(doc, "Server rail", "Homes and DM bubbles per platform, then one user-ordered list of servers and folders. Hover an icon to see which module it comes from.", rail),
    section(
      doc,
      "Direct messages",
      "The unified Messages list: every platform's DMs, most recent first, with previews where the platform gives them.",
      wrap(doc, "ul", "conversation-list", SAMPLE_CONVERSATIONS.map((c, i) => conversationItem(doc, c, { active: i === 1, now: SAMPLE_NOW, onOpen: log("open conversation") }))),
    ),
    section(doc, "Channel list", "Categories, text channels, threads, forums, voice channels with members, and DMs.", wrap(doc, "ul", "channels", channelList(doc, SAMPLE_CHANNELS, { onSelect: log("select"), onJoinVoice: log("join voice") }))),
    section(
      doc,
      "Messages",
      "Markdown, replies, reactions, attachments, edits, own messages (hover for actions) and emoji-only messages.",
      wrap(doc, "ol", "messages", SAMPLE_MESSAGES.map((m, i) => messageItem(doc, m, handlers, { customEmojiUrl: emojiUrl, reacting: i === 1 }))),
    ),
    section(doc, "Markdown", "The renderer on its own.", renderMarkdown(doc, MARKDOWN_SAMPLE, { customEmojiUrl: emojiUrl })),
    section(doc, "Reactions", "The quick palette with its more button.", quickReactions(doc, [{ key: "👍", label: "👍", count: 1, me: true }], log("react"), log("more"))),
    section(doc, "Emoji picker", "Server emoji first, then Unicode emoji by group; search by shortcode, name or tag.", emojiPicker(doc, log("picked"), [{ id: "55", name: "party", animated: false, url: emojiUrl("55") }])),
    section(
      doc,
      "Forum",
      "The new-post form and a forum's posts.",
      wrap(doc, "ol", "messages", [
        postForm(doc, log("new post")),
        ...forumPosts(doc, [
          { id: "1", name: "Dark mode", messageCount: 4, unread: true, mentions: 2 },
          { id: "2", name: "Bigger emoji", messageCount: 1, unread: false, mentions: 0 },
        ], log("open post")),
      ]),
    ),
    section(doc, "Composer extras", "Reply bar, pending uploads, upload progress and typing.", wrap(doc, "div", "reply-bar", replyBar(doc, "Ana", log("cancel reply"))), wrap(doc, "ul", "pending-files", pendingFiles(doc, [{ name: "cat.png", size: 204800 }, { name: "notes.txt", size: 512 }], true, log("remove"))), el(doc, "div", "typing", typingText(["Ana", "Bo"]))),
    section(doc, "Voice panel", "While connecting, and connected (muted, camera on).", voiceConnecting, voiceLive),
    section(doc, "Sign-in", "The login and two-factor forms.", wrap(doc, "div", "card", [login.form]), wrap(doc, "div", "card", [mfa.form])),
  );
}
