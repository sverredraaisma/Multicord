// Contract between a native adapter (main process) and its chat view. The view
// only receives display data; tokens and API access stay in the main process.

import type { PickedFile } from "./engine";

export const NATIVE_IPC = {
  state: "native:state",
  action: "native:action",
} as const;

export interface NativeSidebarItem {
  id: string;
  name: string;
  kind: "category" | "text" | "thread" | "forum" | "voice" | "dm";
  iconUrl?: string;
  unread: boolean;
  mentions: number;
  active: boolean;
  /** Voice channels: who is connected. */
  members?: NativeVoiceMember[];
  /** Its notifications are muted on the platform; the view shows it quieter. */
  muted?: boolean;
  /** The module can mute and unmute it from here (a `mute` action). */
  canMute?: boolean;
  /** It is in the platform's archive. */
  archived?: boolean;
  /** The module can move it into the archive and out again from here (an `archive` action). */
  canArchive?: boolean;
  /** An invitation the user has not answered: the row offers Accept (a `join` action) and Decline (`decline`). */
  invite?: NativeInvite;
  /** Not joined, but open to the user (e.g. a room its space lists): the row offers Join (a `join` action). */
  joinable?: boolean;
  /**
   * Categories: the user may fold its rows away. The view remembers what the
   * user chose while it is open; until then `collapsed` says how it starts.
   * `unread` and `mentions` sum up its rows, shown while it is folded.
   */
  collapsible?: boolean;
  collapsed?: boolean;
}

/** An invitation to a conversation, as far as the platform says who sent it. */
export interface NativeInvite {
  /** Who invited the user, by name. */
  from?: string;
}

/** Longest address the user may type to join a conversation by. */
export const MAX_JOIN_ADDRESS = 255;

export interface NativeVoiceMember {
  name: string;
  avatarUrl?: string;
  muted: boolean;
  video: boolean;
}

/**
 * A custom emoji the user may use in the open conversation. A module lists
 * only those that work there (e.g. another server's emoji only where the
 * platform lets this account use them), so the picker offers nothing the
 * message would lose.
 */
export interface NativeCustomEmoji {
  id: string;
  name: string;
  animated: boolean;
  /** Its picture (https: or a data: URL); without it, <emojiBase>/<id>.webp (.gif when animated). */
  url?: string;
  /** The server or pack it comes from, shown with it in the picker. */
  source?: string;
  /** What goes into the message, in the module's own syntax; `<:name:id>` (`<a:name:id>` when animated) without it. */
  text?: string;
  /** The reaction key; `name:id` without it. */
  key?: string;
  /** False where it may go into messages but not be reacted with. */
  react?: boolean;
}

/** How a sticker is stored, which decides how it shows and how it goes where it cannot be sent as a sticker. */
export type NativeStickerFormat = "png" | "apng" | "webp" | "gif" | "avif" | "webm" | "lottie";
export const STICKER_FORMATS = ["png", "apng", "webp", "gif", "avif", "webm", "lottie"] as const satisfies readonly NativeStickerFormat[];

/** A sticker the user may send here (natively with can.stickers, else as a picture or video file). */
export interface NativeSticker {
  /** Module-scoped; passed back in sendSticker. */
  id: string;
  name: string;
  format: NativeStickerFormat;
  /**
   * What to show and, sent as a file, what goes: a picture, or the video
   * for WebM. Lottie stickers cannot be drawn here: this is a still of it.
   * https: or a data: URL; absent while it has to be loaded (mediaKey).
   */
  url?: string;
  /** Set when the engine fetches the picture on request (a loadMedia action with this key). */
  mediaKey?: string;
  /** The emoji it stands for, for search. */
  emoji?: string;
}

/** A server's stickers, or a sticker set the user has. */
export interface NativeStickerPack {
  id: string;
  name: string;
  stickers: NativeSticker[];
}

/** A GIF from the platform's own GIF search. */
export interface NativeGif {
  id: string;
  /** What is sent: its page, as a message's text, which the platform shows as the GIF. */
  url: string;
  /** What the picker shows: a picture, or a looping video when `video` is set. */
  preview: string;
  video: boolean;
  width?: number;
  height?: number;
  name?: string;
}

/** The answer to the last searchGifs action. */
export interface NativeGifResults {
  /** What was searched for; empty for the platform's trending GIFs. */
  query: string;
  results: NativeGif[];
  loading: boolean;
  error?: string;
}

/** The user's own voice connection. The LiveKit grant is short-lived and scoped to this call. */
export interface NativeVoiceSession {
  channelId: string;
  channelName: string;
  guildName: string;
  /** LiveKit server URL and access token; absent while the server is assigning one. */
  url?: string;
  token?: string;
  mute: boolean;
  deaf: boolean;
  video: boolean;
  stream: boolean;
  /**
   * Set when the call's media is end-to-end encrypted (Matrix calls in
   * encrypted rooms): the view connects only with LiveKit's encryption on,
   * using these keys, and never unencrypted.
   */
  e2ee?: { keys: NativeMediaKey[] };
}

/** A participant's media key for an end-to-end encrypted call. */
export interface NativeMediaKey {
  /** The participant's LiveKit identity; the user's own identity for the key their media is encrypted with. */
  participant: string;
  /** The key's index (0–255): the latest set for a participant is the one in use. */
  index: number;
  /** The key's bytes, base64. */
  key: string;
}

/** What an attachment is, which decides how the view shows it. */
export type NativeMediaKind = "image" | "video" | "audio" | "sticker" | "file";

export interface NativeAttachment {
  name: string;
  kind: NativeMediaKind;
  /**
   * Where to show, play or open it: an https URL, or a data: URL the engine
   * made. Absent while it still has to be loaded (see mediaKey) or when the
   * link expired.
   */
  url?: string;
  /** A still picture to show before a video plays, or while media loads. */
  previewUrl?: string;
  width?: number;
  height?: number;
  /** Bytes, when known. */
  size?: number;
  /** MIME type, when known; a sticker of type "video/webm" plays as a looping video. */
  mime?: string;
  /** Set when the engine fetches the media on request (a loadMedia action with this key). */
  mediaKey?: string;
  /** A video that plays silently on a loop, as GIFs do (many services send GIFs as video). */
  loop?: boolean;
  /** Why it cannot be shown here (e.g. too large), in place of "link expired". */
  unavailable?: string;
}

export interface NativeReaction {
  /** Unicode emoji or name:id; passed back in react actions. */
  key: string;
  label: string;
  imageUrl?: string;
  count: number;
  me: boolean;
}

export interface NativeMessage {
  id: string;
  author: string;
  /** Who wrote it, as the module names people (NativeMember.id): the author's name and picture then open their profile. */
  authorId?: string;
  avatarUrl?: string;
  content: string;
  timestamp: string;
  edited: boolean;
  mine: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Raw text for editing (mentions unresolved); set when canEdit. */
  source?: string;
  /** Reply preview; null when the original message was deleted. */
  reply?: NativeReplyPreview | null;
  reactions: NativeReaction[];
  attachments: NativeAttachment[];
  /** It mentions the user (by name, a role they have, or everyone), as the platform says; the view highlights it. */
  mentionsMe?: boolean;
  /** What the composer inserts to mention the author, in the platform's syntax (e.g. `<@id>`, `@username`); read through mentionText(). */
  authorMention?: string;
  /** Link previews the platform made for it, shown as cards; read through messageEmbeds(). */
  embeds?: NativeEmbed[];
  /** It is pinned in its conversation. */
  pinned?: boolean;
  /** The user may pin or unpin it (a `pin` action), as far as the module can tell; the platform has the last word. */
  canPin?: boolean;
  /** A poll it carries; read by the view through messagePoll(). */
  poll?: NativePoll;
  /** It has replies in a thread of its own (NativeChannelCan.threads); read by the view through threadSummary(). */
  thread?: NativeThreadSummary;
}

/** A message's thread, as its summary under it says: how many replies, and who wrote the latest. */
export interface NativeThreadSummary {
  count: number;
  /** The latest reply's author, by name. */
  latest?: string;
}

/**
 * The message a reply answers, quoted above it. With the original's `id`
 * (as loaded messages have it) and `timestamp`, clicking the quote brings
 * the original into sight, loading older messages as a pin's jump does.
 */
export interface NativeReplyPreview {
  author: string;
  content: string;
  id?: string;
  /** ISO 8601; where loading older messages may stop looking. */
  timestamp?: string;
}

/** Where a reply's quote leads, as the view trusts it: the original as a listed message, with a usable id and time; undefined otherwise. */
export function replyTarget(value: unknown): NativeListedMessage | undefined {
  const v = record(value);
  const author = shortText(v?.author);
  if (!v || !id(v.id) || !author || typeof v.timestamp !== "string" || v.timestamp.length > 40 || Number.isNaN(Date.parse(v.timestamp))) return undefined;
  return { id: v.id as string, author, content: typeof v.content === "string" ? v.content.slice(0, MAX_LISTED_TEXT) : "", timestamp: v.timestamp };
}

/** A thread summary as the view trusts it: a positive count (capped) and a name cut short; undefined without replies. */
export function threadSummary(value: unknown): NativeThreadSummary | undefined {
  const v = record(value);
  const replies = count(v?.count);
  if (!v || replies === 0) return undefined;
  const summary: NativeThreadSummary = { count: replies };
  const latest = shortText(v.latest);
  if (latest) summary.latest = latest;
  return summary;
}

/** The thread open in the side panel: its root message and replies, as far as the module has them. */
export interface NativeThreadView {
  /** The message it hangs from (NativeMessage.id). */
  rootId: string;
  /** Oldest first: the root, where the module has it, then the replies. */
  messages: NativeMessage[];
  loading: boolean;
  /** Why the thread could not be (fully) loaded. */
  error?: string;
  /** Something the user should know about it, e.g. that only the latest replies are listed. */
  note?: string;
  /** Set when nothing may be sent into it: why, shown in place of its composer. */
  locked?: string;
}

/** Most messages the thread panel shows: the latest. */
export const MAX_THREAD_MESSAGES = 200;

/**
 * A thread as the view trusts it: a usable root id, at most
 * MAX_THREAD_MESSAGES messages with usable ids (the latest), texts cut
 * short. Undefined without one.
 */
export function threadView(value: unknown): NativeThreadView | undefined {
  const v = record(value);
  if (!v || !id(v.rootId)) return undefined;
  const messages = (Array.isArray(v.messages) ? v.messages : []).filter((m): m is NativeMessage => id(record(m)?.id)).slice(-MAX_THREAD_MESSAGES);
  const thread: NativeThreadView = { rootId: v.rootId as string, messages, loading: v.loading === true };
  const error = shortText(v.error, 300);
  if (error) thread.error = error;
  const note = shortText(v.note, 300);
  if (note) thread.note = note;
  const locked = shortText(v.locked, 1000);
  if (locked) thread.locked = locked;
  return thread;
}

/** A poll in a message, as far as the platform shows it to the user. */
export interface NativePoll {
  question: string;
  options: NativePollOption[];
  /** More than one option may be chosen. */
  multiple: boolean;
  /** Voting has ended. */
  closed: boolean;
  /** How many have voted, where the platform says. */
  total?: number;
  /** The user may vote here (`vote` actions); without it the poll only shows. */
  canVote?: boolean;
}

export interface NativePollOption {
  /** Module-scoped, passed back in vote actions. */
  id: string;
  text: string;
  /** Votes for it, where the platform shows them (often only after voting). */
  votes?: number;
  /** The user chose it. */
  chosen?: boolean;
  /** A quiz's right answer, once the platform tells. */
  correct?: boolean;
}

export const MAX_POLL_OPTIONS = 20;
const MAX_POLL_QUESTION = 300;
export const isPollOptionId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);

/** A poll as the view trusts it: a question, 1 to MAX_POLL_OPTIONS options with usable ids (each once) and texts cut short; undefined otherwise. */
export function messagePoll(value: unknown): NativePoll | undefined {
  const v = record(value);
  const question = shortText(v?.question, MAX_POLL_QUESTION);
  if (!v || !question) return undefined;
  const seen = new Set<string>();
  const options: NativePollOption[] = [];
  for (const raw of Array.isArray(v.options) ? v.options.slice(0, MAX_POLL_OPTIONS) : []) {
    const o = record(raw);
    const text = shortText(o?.text);
    if (!o || !isPollOptionId(o.id) || seen.has(o.id) || !text) continue;
    seen.add(o.id);
    const option: NativePollOption = { id: o.id, text };
    if (typeof o.votes === "number" && Number.isInteger(o.votes) && o.votes >= 0) option.votes = Math.min(o.votes, 100_000_000);
    if (o.chosen === true) option.chosen = true;
    if (o.correct === true) option.correct = true;
    options.push(option);
  }
  if (options.length === 0) return undefined;
  const poll: NativePoll = { question, options, multiple: v.multiple === true, closed: v.closed === true };
  if (typeof v.total === "number" && Number.isInteger(v.total) && v.total >= 0) poll.total = Math.min(v.total, 100_000_000);
  if (v.canVote === true) poll.canVote = true;
  return poll;
}

/** A message as a list of them shows it (pinned messages, search results): who, when, and its text. */
export interface NativeListedMessage {
  /** The message's id, as in NativeMessage.id: clicking it brings the message into sight where it can be loaded. */
  id: string;
  author: string;
  avatarUrl?: string;
  /** Its text, with the platform's markdown; a label such as "📷 Photo" for media. */
  content: string;
  timestamp: string;
}

/** Messages listed in the side panel, as far as the module has them. */
export interface NativeMessageList {
  messages: NativeListedMessage[];
  loading: boolean;
  /** Why the list could not be (fully) loaded. */
  error?: string;
  /** Something the user should know about the list, e.g. that encrypted rooms cannot be searched. */
  note?: string;
}

/** The results of a search in the open conversation, for the query they answer. */
export interface NativeSearchResults extends NativeMessageList {
  query: string;
}

export const MAX_SEARCH_QUERY = 200;

/** Search results as the view trusts them: a list as messageList() reads it, for a query cut to MAX_SEARCH_QUERY; undefined without any. */
export function searchResults(value: unknown): NativeSearchResults | undefined {
  const list = messageList(value);
  if (!list) return undefined;
  const query = (value as Record<string, unknown>).query;
  return { ...list, query: typeof query === "string" ? query.slice(0, MAX_SEARCH_QUERY) : "" };
}

export const MAX_LISTED_MESSAGES = 100;
const MAX_LISTED_TEXT = 300;

/**
 * A list of messages as the view trusts it: entries with a usable id,
 * author and time, texts cut short, at most MAX_LISTED_MESSAGES. Undefined
 * when there is no list.
 */
export function messageList(value: unknown): NativeMessageList | undefined {
  const v = record(value);
  if (!v) return undefined;
  const messages: NativeListedMessage[] = [];
  for (const raw of Array.isArray(v.messages) ? v.messages.slice(0, MAX_LISTED_MESSAGES) : []) {
    const m = record(raw);
    const author = shortText(m?.author);
    if (!m || !id(m.id) || !author || typeof m.timestamp !== "string" || m.timestamp.length > 40) continue;
    const listed: NativeListedMessage = { id: m.id as string, author, content: typeof m.content === "string" ? m.content.slice(0, MAX_LISTED_TEXT) : "", timestamp: m.timestamp };
    if (typeof m.avatarUrl === "string" && m.avatarUrl !== "") listed.avatarUrl = m.avatarUrl;
    messages.push(listed);
  }
  const list: NativeMessageList = { messages, loading: v.loading === true };
  const error = shortText(v.error, 300);
  if (error) list.error = error;
  const note = shortText(v.note, 300);
  if (note) list.note = note;
  return list;
}

/**
 * A link preview as the platform supplies it (Multicord never fetches pages
 * itself to make one). Every field is optional; a card needs at least a
 * title, a description or a picture.
 */
export interface NativeEmbed {
  /** Where the title leads: https only. */
  url?: string;
  /** The site's name, e.g. "YouTube". */
  site?: string;
  title?: string;
  /** Plain text with the platform's markdown. */
  description?: string;
  /** "#rrggbb", the bar along its side. */
  color?: string;
  image?: NativeEmbedImage;
}

export interface NativeEmbedImage {
  /** https, or a data: URL the engine made; absent while it has to be loaded (mediaKey). */
  url?: string;
  /** Set when the engine fetches the picture on request (a loadMedia action with this key). */
  mediaKey?: string;
  width?: number;
  height?: number;
  /** Bytes, when known. */
  size?: number;
  /** A small picture beside the text, rather than a large one under it. */
  thumbnail?: boolean;
}

export const MAX_EMBEDS = 5;
export const MAX_EMBED_TITLE = 256;
export const MAX_EMBED_DESCRIPTION = 1000;

/**
 * A message's link previews as the view trusts them: at most MAX_EMBEDS,
 * texts cut short, links https only, pictures only from addresses the view
 * may show (isShownUrl) or a media key; cards with nothing to show dropped.
 */
export function messageEmbeds(value: unknown): NativeEmbed[] {
  const embeds: NativeEmbed[] = [];
  for (const raw of Array.isArray(value) ? value.slice(0, MAX_EMBEDS * 2) : []) {
    if (embeds.length >= MAX_EMBEDS) break;
    const v = record(raw);
    if (!v) continue;
    const embed: NativeEmbed = {};
    if (isHttps(v.url)) embed.url = v.url;
    const site = shortText(v.site);
    if (site) embed.site = site;
    const title = shortText(v.title, MAX_EMBED_TITLE);
    if (title) embed.title = title;
    const description = shortText(v.description, MAX_EMBED_DESCRIPTION);
    if (description) embed.description = description;
    const color = colorOf(v.color);
    if (color) embed.color = color;
    const image = embedImage(v.image);
    if (image) embed.image = image;
    if (title || description || image) embeds.push(embed);
  }
  return embeds;
}

function embedImage(value: unknown): NativeEmbedImage | undefined {
  const v = record(value);
  if (!v) return undefined;
  const image: NativeEmbedImage = {};
  if (isShownUrl(v.url)) image.url = v.url;
  else if (isMediaKey(v.mediaKey)) image.mediaKey = v.mediaKey;
  else return undefined;
  if (count(v.width) && count(v.height)) {
    image.width = Math.min(count(v.width), 4096);
    image.height = Math.min(count(v.height), 4096);
  }
  if (count(v.size)) image.size = count(v.size);
  if (v.thumbnail === true) image.thumbnail = true;
  return image;
}

export interface NativeForumPost {
  id: string;
  name: string;
  messageCount?: number;
  unread: boolean;
  mentions: number;
}

export interface NativeChannelView {
  id: string;
  name: string;
  messages: NativeMessage[];
  loading: boolean;
  hasOlder: boolean;
  /** Names of people typing here right now. */
  typing: string[];
  /** Files picked for the next message. */
  pending: { name: string; size: number }[];
  uploading: boolean;
  /** Set for forum channels, which list posts instead of messages. */
  posts?: NativeForumPost[];
  /** Set when nothing may be sent here, e.g. an encrypted room: why, shown in place of the composer. */
  locked?: string;
  /** What this conversation takes from here besides text; the view offers only these. */
  can: NativeChannelCan;
  /**
   * Messages that were new when the conversation was opened: the first of
   * them (its firstUnreadId), once it is among the loaded messages, and how
   * many there were, where the platform says. Without `firstId` they begin
   * above the loaded ones. Read by the view through unreadMarker().
   */
  unread?: NativeUnread;
  /**
   * Who is here, while the member panel is open (after a `members` action
   * with open: true) and `can.members` is on. Read by the view through
   * memberList(), which bounds what it shows.
   */
  members?: NativeMemberList;
  /**
   * The conversation's pinned messages, newest pin first, while the pins
   * panel is open (after a `pins` action with open: true) and `can.pins` is
   * on. Read by the view through messageList().
   */
  pins?: NativeMessageList;
  /**
   * The results of the last `search` action in this conversation, newest
   * first, until the search ends (an empty query) or another conversation
   * opens. Read by the view through searchResults().
   */
  search?: NativeSearchResults;
  /**
   * The thread open in the side panel (after a `thread` action with a
   * rootId), while can.threads is on, until it is closed or another
   * conversation opens. Read by the view through threadView().
   */
  thread?: NativeThreadView;
}

export interface NativeUnread {
  firstId?: string;
  count?: number;
}

/**
 * The unread marker as the view trusts it: the first unread message only
 * when it is among `messages`, a count only when it is a positive whole
 * number (capped); undefined when nothing was new.
 */
export function unreadMarker(value: unknown, messages: readonly { id: string }[]): NativeUnread | undefined {
  const v = record(value);
  if (!v) return undefined;
  const marker: NativeUnread = {};
  if (typeof v.firstId === "string" && messages.some((m) => m.id === v.firstId)) marker.firstId = v.firstId;
  if (count(v.count) > 0) marker.count = Math.min(count(v.count), 1_000_000);
  return marker;
}

/** How present someone is, where the platform says. */
export type NativePresence = "online" | "idle" | "dnd" | "offline";
export const PRESENCES = ["online", "idle", "dnd", "offline"] as const satisfies readonly NativePresence[];

/** One person in a member list. */
export interface NativeMember {
  /** Opaque and module-scoped (the same as NativeMessage.authorId for the same person); passed back in profile actions. */
  id: string;
  name: string;
  avatarUrl?: string;
  presence?: NativePresence;
  /** "#rrggbb", e.g. the colour of their highest role. */
  color?: string;
  /** A short line under the name, e.g. "last seen recently" or "Bot". */
  status?: string;
  /** What the composer inserts to mention them, in the platform's syntax; without it, their name. */
  mention?: string;
}

/** A heading in the member list ("Admins", "Online"…) and who is under it. */
export interface NativeMemberSection {
  name: string;
  members: NativeMember[];
}

/** The open conversation's members, as far as the module has fetched them. */
export interface NativeMemberList {
  sections: NativeMemberSection[];
  /** Members known to exist beyond those listed, e.g. a big group's total minus the first page. */
  more?: number;
  /** A loadMembers action fetches the next page. */
  hasMore: boolean;
  loading: boolean;
  /** Why the list could not be (fully) loaded. */
  error?: string;
}

/**
 * A person's profile, answering a `profile` action. The view opens the card
 * at once with what it was opened from (a message's author, a member row)
 * and adds what this says once its id matches.
 */
export interface NativeProfile {
  id: string;
  name?: string;
  avatarUrl?: string;
  presence?: NativePresence;
  status?: string;
  /** How others find them, e.g. "@ana". */
  username?: string;
  /** Their own description (bio), plain text. */
  about?: string;
  roles?: { name: string; color?: string }[];
  /** More is being fetched. */
  loading?: boolean;
}

/**
 * What the module supports in a conversation, beyond sending text (which
 * `locked` rules out). Editing and deleting are per message
 * (NativeMessage.canEdit, canDelete). A flag is on only when it is `true`:
 * the view reads them with channelCan(), so a missing or malformed flag hides
 * the control rather than offering something the module would drop.
 */
export interface NativeChannelCan {
  /** Answer a message (send's replyTo). */
  reply: boolean;
  /** Add and remove reactions. */
  react: boolean;
  /** Pick files to send. */
  attach: boolean;
  /** Tell the others while the user types. */
  typing: boolean;
  /** List who is here (the member panel: `members` and `loadMembers` actions, NativeChannelView.members). */
  members: boolean;
  /** Send the module's own stickers as stickers (sendSticker); without it they go as files, where `attach` is on. */
  stickers?: boolean;
  /** Search the platform's GIFs (searchGifs; the chat state's gifs). */
  gifs?: boolean;
  /** List the pinned messages (the pins panel: `pins` actions, NativeChannelView.pins); pinning itself is per message (canPin). */
  pins?: boolean;
  /** Search the conversation's messages (`search` actions, NativeChannelView.search). */
  search?: boolean;
  /** Forward its messages into another of this module's conversations (`forward` actions). */
  forward?: boolean;
  /** Open a message's thread and reply in it (`thread` actions, send's `thread`, NativeChannelView.thread). */
  threads?: boolean;
  /** Start or join a call in it: the header's call button sends a `joinVoice` action with the conversation's id. */
  call?: boolean;
}

export const CHANNEL_CAN_FLAGS = ["reply", "react", "attach", "typing", "members", "stickers", "gifs", "pins", "search", "forward", "threads", "call"] as const satisfies readonly (keyof NativeChannelCan)[];

/** A conversation's flags as the view trusts them: each on only when it is exactly `true`. */
export function channelCan(value: unknown): Required<NativeChannelCan> {
  const flags = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(CHANNEL_CAN_FLAGS.map((flag) => [flag, flags[flag] === true])) as unknown as Required<NativeChannelCan>;
}

/** Most member rows the view shows at once, over all sections; the rest are counted as "N more". */
export const MEMBER_ROWS_SHOWN = 200;
export const MAX_MEMBER_SECTIONS = 20;
/** Highest offset a loadMembers action may ask for. */
export const MAX_MEMBER_OFFSET = 100_000;
const MAX_MEMBER_TEXT = 100;

/** A member or author id: opaque to the view, but plain enough to pass back (snowflakes, ULIDs, Matrix user ids). */
export const isMemberId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9@:._=+/-]{1,255}$/.test(value);

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
/** A non-empty string, cut to a length; undefined otherwise. */
const shortText = (value: unknown, max = MAX_MEMBER_TEXT): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined);
const presenceOf = (value: unknown): NativePresence | undefined => (PRESENCES as readonly unknown[]).includes(value) ? (value as NativePresence) : undefined;
const colorOf = (value: unknown): string | undefined => (typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : undefined);
const count = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 100_000_000) : 0);

/** A member row as the view trusts it; undefined without a usable id and name. */
function member(value: unknown): NativeMember | undefined {
  const v = record(value);
  const name = shortText(v?.name);
  if (!v || !isMemberId(v.id) || !name) return undefined;
  const row: NativeMember = { id: v.id, name };
  if (typeof v.avatarUrl === "string" && v.avatarUrl !== "") row.avatarUrl = v.avatarUrl;
  const presence = presenceOf(v.presence);
  if (presence) row.presence = presence;
  const color = colorOf(v.color);
  if (color) row.color = color;
  const status = shortText(v.status);
  if (status) row.status = status;
  const mention = mentionText(v.mention);
  if (mention) row.mention = mention;
  return row;
}

/** Longest text a module may have the composer insert to mention someone. */
export const MAX_MENTION_TEXT = 100;

/**
 * What to insert to mention someone (NativeMember.mention,
 * NativeMessage.authorMention) as the view trusts it: one line of plain text
 * without control or invisible formatting characters; undefined otherwise.
 */
export function mentionText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_MENTION_TEXT && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ? value : undefined;
}

/**
 * A member list as the view trusts it: malformed rows and sections dropped,
 * texts cut short, and at most MEMBER_ROWS_SHOWN rows, the rest counted in
 * `more` (and no further pages, which could not be shown). Undefined when
 * there is no list.
 */
export function memberList(value: unknown): NativeMemberList | undefined {
  const v = record(value);
  if (!v) return undefined;
  let room = MEMBER_ROWS_SHOWN;
  let hidden = 0;
  const sections: NativeMemberSection[] = [];
  for (const raw of Array.isArray(v.sections) ? v.sections.slice(0, MAX_MEMBER_SECTIONS) : []) {
    const section = record(raw);
    const name = shortText(section?.name);
    const rows = Array.isArray(section?.members) ? (section.members as unknown[]) : [];
    if (!name) continue;
    const members: NativeMember[] = [];
    for (const row of rows) {
      const m = member(row);
      if (!m) continue;
      if (room > 0) {
        members.push(m);
        room--;
      } else hidden++;
    }
    if (members.length > 0) sections.push({ name, members });
  }
  const list: NativeMemberList = { sections, hasMore: v.hasMore === true && hidden === 0, loading: v.loading === true };
  const more = count(v.more) + hidden;
  if (more > 0) list.more = more;
  const error = shortText(v.error, 300);
  if (error) list.error = error;
  return list;
}

export const MAX_PROFILE_ROLES = 20;
export const MAX_ABOUT_LENGTH = 1000;

/** A profile as the view trusts it: undefined without a usable id; malformed fields left out and texts cut short. */
export function memberProfile(value: unknown): NativeProfile | undefined {
  const v = record(value);
  if (!v || !isMemberId(v.id)) return undefined;
  const profile: NativeProfile = { id: v.id };
  const name = shortText(v.name);
  if (name) profile.name = name;
  if (typeof v.avatarUrl === "string" && v.avatarUrl !== "") profile.avatarUrl = v.avatarUrl;
  const presence = presenceOf(v.presence);
  if (presence) profile.presence = presence;
  const status = shortText(v.status);
  if (status) profile.status = status;
  const username = shortText(v.username);
  if (username) profile.username = username;
  const about = shortText(v.about, MAX_ABOUT_LENGTH);
  if (about) profile.about = about;
  const roles = (Array.isArray(v.roles) ? v.roles.slice(0, MAX_PROFILE_ROLES) : []).flatMap((raw) => {
    const role = record(raw);
    const roleName = shortText(role?.name);
    if (!roleName) return [];
    const color = colorOf(role!.color);
    return [color ? { name: roleName, color } : { name: roleName }];
  });
  if (roles.length > 0) profile.roles = roles;
  if (v.loading === true) profile.loading = true;
  return profile;
}

export const MAX_CUSTOM_EMOJI = 2000;
export const MAX_STICKER_PACKS = 200;
export const MAX_PACK_STICKERS = 300;
export const MAX_STICKERS = 5000;
export const MAX_GIF_RESULTS = 100;
export const MAX_GIF_QUERY = 100;
/** Emoji and sticker ids: plain enough to pass back (snowflakes, ULIDs, mxc paths, Telegram document ids). */
const MEDIA_ID = /^[A-Za-z0-9:._@!+=/-]{1,200}$/;
export const isMediaKey = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(value);
const isHttps = (value: unknown): value is string => typeof value === "string" && /^https:\/\/\S{1,2040}$/.test(value);

/** An address the view may show media from: https, or a data: URL of a picture or video. */
export function isShownUrl(value: unknown): value is string {
  return isHttps(value) || (typeof value === "string" && /^data:(image|video)\/[a-z0-9.+-]{1,40};base64,/.test(value));
}

/** A custom emoji as the pickers use it: its picture, what to insert and how to react with it. */
export interface PickerEmoji {
  id: string;
  name: string;
  animated: boolean;
  url: string;
  source?: string;
  text: string;
  key: string;
  react: boolean;
}

/**
 * Custom emoji as the view trusts them: each with a usable id, name and
 * picture (its own, or one under `base`), its text and key within what
 * messages and reactions take, at most MAX_CUSTOM_EMOJI.
 */
export function customEmojiList(value: unknown, base?: string): PickerEmoji[] {
  const list: PickerEmoji[] = [];
  for (const raw of Array.isArray(value) ? value : []) {
    if (list.length >= MAX_CUSTOM_EMOJI) break;
    const v = record(raw);
    const name = shortText(v?.name, 64);
    if (!v || typeof v.id !== "string" || !MEDIA_ID.test(v.id) || !name || /[\s:<>]/.test(name)) continue;
    const animated = v.animated === true;
    // A picture under the base only for a plain id, which cannot step out of it.
    const url = isShownUrl(v.url) ? v.url : isHttps(base) && /^[A-Za-z0-9_-]{1,64}$/.test(v.id) ? `${base}/${v.id}.${animated ? "gif" : "webp"}?size=48` : undefined;
    if (!url) continue;
    const text = typeof v.text === "string" && v.text.trim() !== "" && v.text.length <= 200 ? v.text : `<${animated ? "a" : ""}:${name}:${v.id}>`;
    // A key of the module's own that reactions cannot carry rules reactions out, rather than reacting with another key.
    const ownKey = typeof v.key === "string" && v.key !== "" && v.key.length <= 64;
    const key = ownKey ? (v.key as string) : `${name}:${v.id}`;
    const react = v.react !== false && (v.key === undefined || ownKey) && key.length <= 64;
    const emoji: PickerEmoji = { id: v.id, name, animated, url, text, key, react };
    const source = shortText(v.source);
    if (source) emoji.source = source;
    list.push(emoji);
  }
  return list;
}

/** Emoji pictures by id as the view trusts them: plain ids, https or data: pictures, at most MAX_CUSTOM_EMOJI. */
export function emojiUrls(value: unknown): Map<string, string> {
  const urls = new Map<string, string>();
  for (const [id, url] of Object.entries(record(value) ?? {})) {
    if (urls.size >= MAX_CUSTOM_EMOJI) break;
    if (MEDIA_ID.test(id) && isShownUrl(url)) urls.set(id, url);
  }
  return urls;
}

/** Sticker packs as the view trusts them: well-formed stickers only, within the caps; empty packs dropped. */
export function stickerPacks(value: unknown): NativeStickerPack[] {
  const packs: NativeStickerPack[] = [];
  let room = MAX_STICKERS;
  for (const raw of Array.isArray(value) ? value.slice(0, MAX_STICKER_PACKS) : []) {
    const v = record(raw);
    const name = shortText(v?.name);
    if (!v || typeof v.id !== "string" || !MEDIA_ID.test(v.id) || !name) continue;
    const stickers: NativeSticker[] = [];
    for (const item of Array.isArray(v.stickers) ? v.stickers.slice(0, MAX_PACK_STICKERS) : []) {
      if (room <= 0) break;
      const s = record(item);
      const stickerName = shortText(s?.name) ?? shortText(s?.emoji, 16);
      if (!s || typeof s.id !== "string" || !MEDIA_ID.test(s.id) || !stickerName || !(STICKER_FORMATS as readonly unknown[]).includes(s.format)) continue;
      const sticker: NativeSticker = { id: s.id, name: stickerName, format: s.format as NativeStickerFormat };
      if (isShownUrl(s.url)) sticker.url = s.url;
      else if (isMediaKey(s.mediaKey)) sticker.mediaKey = s.mediaKey;
      else continue;
      const emoji = shortText(s.emoji, 16);
      if (emoji) sticker.emoji = emoji;
      stickers.push(sticker);
      room--;
    }
    if (stickers.length > 0) packs.push({ id: v.id, name, stickers });
  }
  return packs;
}

/** GIF results as the view trusts them: https addresses only, at most MAX_GIF_RESULTS; undefined without any. */
export function gifResults(value: unknown): NativeGifResults | undefined {
  const v = record(value);
  if (!v) return undefined;
  const results: NativeGif[] = [];
  for (const raw of Array.isArray(v.results) ? v.results.slice(0, MAX_GIF_RESULTS) : []) {
    const g = record(raw);
    if (!g || typeof g.id !== "string" || !MEDIA_ID.test(g.id) || !isHttps(g.url) || !isHttps(g.preview)) continue;
    const gif: NativeGif = { id: g.id, url: g.url, preview: g.preview, video: g.video === true };
    if (count(g.width) && count(g.height)) {
      gif.width = Math.min(count(g.width), 4096);
      gif.height = Math.min(count(g.height), 4096);
    }
    const name = shortText(g.name);
    if (name) gif.name = name;
    results.push(gif);
  }
  const gifs: NativeGifResults = { query: typeof v.query === "string" ? v.query.slice(0, MAX_GIF_QUERY) : "", results, loading: v.loading === true };
  const error = shortText(v.error, 300);
  if (error) gifs.error = error;
  return gifs;
}

/** One input of a sign-in step. */
export interface NativePromptField {
  name: string;
  label: string;
  type: "text" | "tel" | "password" | "number";
  autocomplete?: string;
  placeholder?: string;
}

/**
 * A step of a sign-in flow the module defines itself, e.g. Telegram's phone
 * number, code and password steps. A new id starts a fresh form.
 */
export interface NativePrompt {
  id: string;
  title: string;
  description?: string;
  fields: NativePromptField[];
  submit: string;
  /** A secondary button, e.g. "Use another number". */
  cancel?: string;
  /** A web page to open in the browser, e.g. where to confirm a sign-in code. Only https links are shown. */
  link?: { url: string; label: string };
  /**
   * Text the view shows as a QR code, to scan with another device: e.g.
   * Telegram's sign-in link, which is a credential. The view draws the code
   * itself and keeps the text nowhere else. Read through promptQr().
   */
  qr?: string;
}

/** Longest text shown as a QR code. */
export const MAX_QR_TEXT = 200;

/** A prompt's QR code text as the view trusts it: printable ASCII, at most MAX_QR_TEXT characters; undefined otherwise. */
export function promptQr(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_QR_TEXT && /^[!-~]+$/.test(value) ? value : undefined;
}

export type NativeViewState =
  | { screen: "login"; platform: string; identity: "email" | "username"; busy: boolean; status?: string; error?: string }
  /** codes: "totp" accepts authenticator or backup codes; "backup" only backup codes. */
  | { screen: "mfa"; platform: string; codes: "totp" | "backup"; busy: boolean; error?: string }
  | { screen: "prompt"; platform: string; prompt: NativePrompt; busy: boolean; status?: string; error?: string }
  | { screen: "connecting"; platform: string; status: string }
  | {
      screen: "chat";
      platform: string;
      title: string;
      me: string;
      sidebar: NativeSidebarItem[];
      channel: NativeChannelView | null;
      voice: NativeVoiceSession | null;
      /** Base URL for custom emoji images: <base>/<id>.webp (or .gif when animated). */
      emojiBase?: string;
      /**
       * Pictures of custom emoji in the open conversation's messages, by the id
       * in their `<:name:id>`, for emoji the emojiBase cannot serve (data: URLs
       * the engine made, or addresses of their own). Read through emojiUrls().
       */
      emojiUrls?: Record<string, string>;
      /** Custom emoji usable in the open conversation, for the pickers; read by the view through customEmojiList(). */
      customEmoji?: NativeCustomEmoji[];
      /** Sticker packs usable in the open conversation; read through stickerPacks(). */
      stickers?: NativeStickerPack[];
      /** GIF search results while the picker's GIF tab searches (can.gifs); read through gifResults(). */
      gifs?: NativeGifResults;
      /** The profile last asked for (a `profile` action), read by the view through memberProfile(). */
      profile?: NativeProfile;
      /** A call ringing for the user: the view offers Accept (a `joinVoice` action) and Decline (`declineCall`). Read through incomingCall(). */
      incomingCall?: NativeIncomingCall;
      /**
       * The sidebar offers to join a conversation by its address: this is the
       * field's example (e.g. "#room:example.org"). It sends `joinAddress`.
       */
      joinAddress?: string;
      /** The user's folders, as tabs above the sidebar; picking one sends `folder`. Read through chatFolders(). */
      folders?: NativeFolder[];
      error?: string;
    };

/** A call ringing for the user. */
export interface NativeIncomingCall {
  /** The conversation the call is in, which Accept joins. */
  channelId: string;
  /** Who is calling, by name. */
  from: string;
  video?: boolean;
}

/** A ringing call as the view trusts it: a usable conversation id and a caller's name cut short; undefined without one. */
export function incomingCall(value: unknown): NativeIncomingCall | undefined {
  const v = record(value);
  const from = shortText(v?.from);
  if (!v || !id(v.channelId) || !from) return undefined;
  return { channelId: v.channelId as string, from, ...(v.video === true ? { video: true } : {}) };
}

/**
 * A folder of conversations the user keeps on the platform (Telegram's chat
 * folders, say): the sidebar shows one at a time, picked from tabs above it.
 */
export interface NativeFolder {
  /** Letters, digits, "-" and "_", at most 32. */
  id: string;
  name: string;
  /** The sidebar shows this folder now. */
  active: boolean;
  unread: boolean;
  mentions: number;
}

/** Most folder tabs the view shows. */
export const MAX_FOLDERS = 30;
const FOLDER_ID = /^[A-Za-z0-9_-]{1,32}$/;

/** Folders as the view trusts them: usable ids and names, at most MAX_FOLDERS, each id once. */
export function chatFolders(value: unknown): NativeFolder[] {
  const folders: NativeFolder[] = [];
  for (const raw of Array.isArray(value) ? value.slice(0, MAX_FOLDERS) : []) {
    const f = record(raw);
    const name = shortText(f?.name);
    if (!f || typeof f.id !== "string" || !FOLDER_ID.test(f.id) || !name || folders.some((o) => o.id === f.id)) continue;
    folders.push({ id: f.id, name, active: f.active === true, unread: f.unread === true, mentions: count(f.mentions) });
  }
  return folders;
}

/** A call feature that may fail to start on its own. */
export type VoiceNoticeFlag = "video" | "stream";

export type NativeAction =
  | { type: "ready" }
  | { type: "login"; identity: string; password: string }
  | { type: "mfa"; code: string }
  | { type: "cancelMfa" }
  /** Answers a prompt step; values by field name. */
  | { type: "prompt"; id: string; values: Record<string, string> }
  | { type: "cancelPrompt"; id: string }
  | { type: "select"; channelId: string }
  /** Sends a message; with `thread`, into the thread of that message (can.threads). */
  | { type: "send"; content: string; replyTo?: string; thread?: string }
  | { type: "edit"; messageId: string; content: string }
  | { type: "delete"; messageId: string }
  | { type: "react"; messageId: string; emoji: string; add: boolean }
  | { type: "loadOlder" }
  | { type: "typing" }
  | { type: "attach" }
  | { type: "createPost"; name: string; content: string }
  | { type: "joinVoice"; channelId: string }
  | { type: "leaveVoice" }
  | { type: "voiceState"; mute: boolean; deaf: boolean; video: boolean; stream: boolean }
  | { type: "voiceError"; message: string }
  /** A problem the call survives (a camera that won't open); `off` names the flag that could not be turned on. */
  | { type: "voiceNotice"; message: string; off?: VoiceNoticeFlag }
  | { type: "removeAttachment"; index: number }
  /** Fetch an attachment the engine holds back until asked (NativeAttachment.mediaKey). */
  | { type: "loadMedia"; key: string }
  /** The member panel opened or closed: the module lists the open conversation's members (NativeChannelView.members) only while it is open. */
  | { type: "members"; open: boolean }
  /** The next page of members; `offset` is how many are listed, so a page is never asked twice. */
  | { type: "loadMembers"; offset: number }
  /** Someone's profile card opened: the module answers with `profile` in the chat state. */
  | { type: "profile"; id: string }
  /**
   * Made by the shell only, never accepted from a view (isNativeAction
   * refuses it): send this file into the open conversation as an upload,
   * read through its handle like a picked file. The shell sends favourites
   * and stickers that cannot go natively this way.
   */
  | { type: "sendFile"; file: PickedFile; replyTo?: string }
  /** Sends one of the module's own stickers (NativeSticker.id) as a sticker, where can.stickers says it may. */
  | { type: "sendSticker"; stickerId: string; replyTo?: string }
  /** Searches the platform's GIFs (can.gifs); an empty query asks for its trending ones. */
  | { type: "searchGifs"; query: string }
  /**
   * The composer's picker opened or closed. A module may keep heavy picker
   * data (sticker pictures as data: URLs) out of the chat state while it is
   * closed, so they do not travel with every update.
   */
  | { type: "picker"; open: boolean }
  /** Mutes or unmutes a conversation's notifications on the platform, where its sidebar row says it can (canMute). */
  | { type: "mute"; channelId: string; mute: boolean }
  /** Moves a conversation into the platform's archive or out again, where its sidebar row says it can (canArchive). */
  | { type: "archive"; channelId: string; archive: boolean }
  /** Shows one of the chat state's folders in the sidebar. */
  | { type: "folder"; id: string }
  /** The pins panel opened or closed: the module lists the open conversation's pinned messages (NativeChannelView.pins) only while it is open. */
  | { type: "pins"; open: boolean }
  /** Pins or unpins a message in the open conversation, where it says it may (canPin). */
  | { type: "pin"; messageId: string; pin: boolean }
  /** Searches the open conversation's messages (can.search); an empty query ends the search. */
  | { type: "search"; query: string }
  /**
   * Forwards a message of the open conversation into another conversation
   * of the same module (can.forward): natively where the platform can, else
   * as a new message saying where it came from. Never across modules.
   */
  | { type: "forward"; messageId: string; channelId: string }
  /** Opens a message's thread in the side panel (can.threads), or closes it without a rootId. */
  | { type: "thread"; rootId?: string }
  /** Votes in a poll of the open conversation (NativePoll.canVote): the options chosen, replacing earlier ones; none takes the vote back. */
  | { type: "vote"; messageId: string; options: string[] }
  /** Accepts an invitation, or joins a conversation the sidebar lists as joinable. */
  | { type: "join"; channelId: string }
  /** Declines an invitation. */
  | { type: "decline"; channelId: string }
  /** Declines a call ringing for the user (the chat state's incomingCall). */
  | { type: "declineCall"; channelId: string }
  /** Joins a conversation by an address the user typed (the chat state's joinAddress); the module checks its form. */
  | { type: "joinAddress"; address: string }
  | { type: "logout" };

export const MAX_MESSAGE_LENGTH = 4000;
/** Fluxer's default max_attachments_per_message. */
export const MAX_ATTACHMENTS = 10;

const text = (value: unknown, min: number, max: number): boolean =>
  typeof value === "string" && value.length >= min && value.length <= max;
/** A snowflake (Fluxer, Telegram) or a ULID (Stoat). */
const id = (value: unknown): boolean => typeof value === "string" && /^(\d{1,20}|[0-9A-HJKMNP-TV-Z]{26})$/.test(value);
const promptId = (value: unknown): boolean => typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
export const MAX_PROMPT_FIELDS = 8;

function isPromptValues(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= MAX_PROMPT_FIELDS && entries.every(([name, v]) => /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name) && text(v, 0, 1024));
}
const content = (value: unknown): boolean => text(value, 1, MAX_MESSAGE_LENGTH) && (value as string).trim() !== "";

export function isNativeAction(value: unknown): value is NativeAction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "ready":
    case "cancelMfa":
    case "loadOlder":
    case "typing":
    case "attach":
    case "leaveVoice":
    case "logout":
      return true;
    case "login":
      return text(v.identity, 1, 320) && text(v.password, 1, 1024);
    case "mfa":
      return text(v.code, 1, 32);
    case "prompt":
      return promptId(v.id) && isPromptValues(v.values);
    case "cancelPrompt":
      return promptId(v.id);
    case "select":
      return id(v.channelId);
    case "send":
      // Empty text is allowed: a message may be attachments only.
      return text(v.content, 0, MAX_MESSAGE_LENGTH) && (v.replyTo === undefined || id(v.replyTo)) && (v.thread === undefined || id(v.thread));
    case "thread":
      return v.rootId === undefined || id(v.rootId);
    case "joinVoice":
      return id(v.channelId);
    case "mute":
      return id(v.channelId) && typeof v.mute === "boolean";
    case "archive":
      return id(v.channelId) && typeof v.archive === "boolean";
    case "folder":
      return typeof v.id === "string" && FOLDER_ID.test(v.id);
    case "pins":
      return typeof v.open === "boolean";
    case "vote":
      return id(v.messageId) && Array.isArray(v.options) && v.options.length <= MAX_POLL_OPTIONS && v.options.every(isPollOptionId) && new Set(v.options).size === v.options.length;
    case "forward":
      return id(v.messageId) && id(v.channelId);
    case "join":
    case "decline":
    case "declineCall":
      return id(v.channelId);
    case "joinAddress":
      // One word of printable characters: the module reads it as an address of its own kind.
      return typeof v.address === "string" && v.address.length <= MAX_JOIN_ADDRESS && /^[^\s\p{Cc}\p{Cf}]+$/u.test(v.address);
    case "search":
      return text(v.query, 0, MAX_SEARCH_QUERY);
    case "pin":
      return id(v.messageId) && typeof v.pin === "boolean";
    case "voiceState":
      return [v.mute, v.deaf, v.video, v.stream].every((flag) => typeof flag === "boolean");
    case "voiceError":
      return text(v.message, 1, 500);
    case "voiceNotice":
      return text(v.message, 1, 500) && (v.off === undefined || v.off === "video" || v.off === "stream");
    case "loadMedia":
      return isMediaKey(v.key);
    case "sendSticker":
      return typeof v.stickerId === "string" && MEDIA_ID.test(v.stickerId) && (v.replyTo === undefined || id(v.replyTo));
    case "searchGifs":
      return text(v.query, 0, MAX_GIF_QUERY);
    case "picker":
      return typeof v.open === "boolean";
    case "members":
      return typeof v.open === "boolean";
    case "loadMembers":
      return typeof v.offset === "number" && Number.isInteger(v.offset) && v.offset >= 0 && v.offset <= MAX_MEMBER_OFFSET;
    case "profile":
      return isMemberId(v.id);
    case "createPost":
      return text(v.name, 1, 100) && (v.name as string).trim() !== "" && content(v.content);
    case "removeAttachment":
      return typeof v.index === "number" && Number.isInteger(v.index) && v.index >= 0 && v.index < MAX_ATTACHMENTS;
    case "edit":
      return id(v.messageId) && content(v.content);
    case "delete":
      return id(v.messageId);
    case "react":
      return id(v.messageId) && text(v.emoji, 1, 64) && typeof v.add === "boolean";
    default:
      return false;
  }
}
