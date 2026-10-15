// The slice of Telegram the adapter uses, in plain data. gram.ts implements
// it with GramJS; tests use a fake. Ids are decimal strings, dates Unix
// seconds, as Telegram sends them. Chat ids are GramJS's marked ids: a
// user's id, -id for a basic group, -100id for a supergroup or channel.

import type { FileSource } from "../../engine/runtime";

export interface TgUser {
  id: string;
  name: string;
  bot: boolean;
  /** Telegram Premium: more reactions per message, and the premium ones. */
  premium?: boolean;
}

/** A message's photo, video, sound, sticker or file, as far as the view needs to know it. */
export interface TgFile {
  kind: "image" | "video" | "audio" | "sticker" | "file";
  name: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  /** Plays silently on a loop: GIFs, which Telegram sends as video. */
  loop?: boolean;
  /** Only a still thumbnail can be shown (animated vector stickers). */
  thumbnailOnly?: boolean;
}

/** A range of a message's text shown a certain way, counted in UTF-16 units as Telegram counts. */
export interface TgEntity {
  type: "bold" | "italic" | "underline" | "strike" | "spoiler" | "code" | "pre" | "textUrl" | "blockquote";
  offset: number;
  length: number;
  /** A text link's address. */
  url?: string;
  /** A code block's language. */
  language?: string;
}

/** Formatted text, as Telegram sends and takes it. */
export interface TgText {
  text: string;
  entities: TgEntity[];
}

export interface TgMessage {
  id: number;
  chatId: string;
  out: boolean;
  /** The sender's display name, where known (group and channel messages). */
  sender?: string;
  /** The sending user's id, where a user sent it (not a channel posting as itself); in private chats, only for incoming messages. */
  senderId?: string;
  /** It mentions the user or answers one of theirs. */
  mentioned?: boolean;
  text: string;
  /** How the text is formatted, where it is. */
  entities?: TgEntity[];
  /** A short label for media, e.g. "📷 Photo". */
  media?: string;
  /** The media itself, when it is something to show or play. */
  file?: TgFile;
  date: number;
  edited: boolean;
  replyToId?: number;
  /** Reactions with emoji, and how many gave each; others (custom emoji, paid) are left out. */
  reactions?: TgReaction[];
}

/** An emoji reaction on a message. */
export interface TgReaction {
  /** As Telegram writes it, without variation selectors (e.g. "❤"). */
  emoji: string;
  count: number;
  /** The user gave it. */
  chosen: boolean;
}

/** The reactions a chat takes: any of Telegram's, only some, or none. */
export type TgAllowedReactions = { kind: "all" } | { kind: "some"; emoji: string[] } | { kind: "none" };

/** A one-to-one chat (with a user, a bot or yourself), a group (basic or super) or a broadcast channel. */
export type TgChatKind = "user" | "group" | "channel";

export interface TgDialog {
  chatId: string;
  kind: TgChatKind;
  title: string;
  bot: boolean;
  unreadCount: number;
  /** Unread messages that mention the user or answer theirs. */
  unreadMentions: number;
  /** Until when (Unix seconds) the chat's notifications are muted, if they are. */
  mutedUntil?: number;
  /** Nothing can be sent here: a channel only its admins post in, or a group the user may not write in. */
  readOnly?: boolean;
  /** Its members may be listed, as far as the dialog tells: groups the user is in, channels they administer. */
  members?: boolean;
  /** The user may write here, but not send photos, videos or files. */
  noMedia?: boolean;
  /** The user left it, or was removed: they can only read what is left. */
  left?: boolean;
  lastMessage?: TgMessage;
  date: number;
}

/** How recently a user was online, as far as their privacy settings tell: "recently" is all many of them show. */
export type TgPresence = "online" | "recently" | "offline";

export interface TgMember {
  /** The user's id. */
  id: string;
  name: string;
  bot: boolean;
  /** The chat's creator, or one of its admins. */
  role?: "owner" | "admin";
  /** An admin's custom title. */
  rank?: string;
  presence: TgPresence;
}

export interface TgMemberPage {
  members: TgMember[];
  /** How many members the chat has, as Telegram counts them. */
  total: number;
  /** Where the next page starts; absent after the last. */
  next?: number;
  /** Telegram does not let the user see this chat's members. */
  hidden?: boolean;
}

export interface TgProfile {
  id: string;
  name: string;
  bot: boolean;
  presence: TgPresence;
  /** "@name". */
  username?: string;
  /** Their bio. */
  about?: string;
}

export type TgSignIn = { done: true } | { password: true; hint?: string } | { signUp: true };

export type TgUpdate =
  | { type: "message"; message: TgMessage }
  | { type: "edit"; message: TgMessage }
  | { type: "delete"; chatId?: string; ids: number[] }
  /** Someone is typing (or sending something) in a chat, or stopped. */
  | { type: "typing"; chatId: string; userId: string; active: boolean }
  /** A message's reactions now; `chosen` is only known when `own` is set (Telegram leaves it out of some updates). */
  | { type: "reactions"; chatId: string; id: number; reactions: TgReaction[]; own: boolean };

export interface TelegramApi {
  connect(): Promise<void>;
  authorized(): Promise<boolean>;
  sendCode(phone: string): Promise<{ hash: string; viaApp: boolean }>;
  signIn(phone: string, hash: string, code: string): Promise<TgSignIn>;
  checkPassword(password: string): Promise<void>;
  me(): Promise<TgUser>;
  dialogs(limit: number): Promise<TgDialog[]>;
  /** Messages before `beforeId` (or the newest), oldest first. */
  history(chatId: string, beforeId: number | undefined, limit: number): Promise<TgMessage[]>;
  send(chatId: string, text: TgText, replyTo?: number): Promise<TgMessage>;
  /** Uploads a picked file and sends it, with a caption. */
  sendFile(chatId: string, file: FileSource, caption: TgText, replyTo?: number): Promise<TgMessage>;
  edit(chatId: string, id: number, text: TgText): Promise<TgMessage>;
  remove(chatId: string, ids: number[]): Promise<void>;
  markRead(chatId: string, maxId: number): Promise<void>;
  /** A small profile picture as a data: URL. */
  avatar(chatId: string): Promise<string | undefined>;
  /**
   * A page of a group's or channel's members, from `offset` (a page's
   * `next`). Supergroups and channels give their admins first, then the
   * most recent members.
   */
  members(chatId: string, offset: number, limit: number): Promise<TgMemberPage>;
  /** What a user shows others: name, username, bio and how recently they were online. */
  profile(userId: string): Promise<TgProfile>;
  /** Sets the user's reactions on a message: these emoji, replacing those they gave; none removes them. */
  react(chatId: string, messageId: number, emoji: string[]): Promise<void>;
  /** Which reactions a group or channel takes. */
  allowedReactions(chatId: string): Promise<TgAllowedReactions>;
  /** The emoji Telegram offers as reactions to this user, where a chat takes all. */
  reactionList(): Promise<string[]>;
  /** Tells the chat the user is typing, or stopped. */
  typing(chatId: string, active: boolean): Promise<void>;
  /** A user's name, where Telegram has told it this session. */
  userName(userId: string): Promise<string | undefined>;
  /** A message's media (or its thumbnail), as bytes; undefined when there is none. */
  download(chatId: string, messageId: number, thumbnail: boolean): Promise<Uint8Array | undefined>;
  onUpdate(cb: (update: TgUpdate) => void): void;
  /** The session to store, so the next start skips signing in. */
  session(): string;
  logOut(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface TelegramCredentials {
  apiId: number;
  apiHash: string;
}

/** Emoji presentation selector (U+FE0F), which Telegram's reactions go without. */
const VARIATION = new RegExp(String.fromCharCode(0xfe0f), "g");

/** An emoji as Telegram writes reactions: without variation selectors. */
export const reactionEmoji = (emoji: string): string => emoji.replace(VARIATION, "");

/** Telegram's reactions that are text symbols unless marked as emoji: heart, snowman, writing hand, dove, male and female signs. */
const TEXT_DEFAULT = new Set([0x2764, 0x2603, 0x270d, 0x1f54a, 0x2642, 0x2640]);

/** A reaction as the view's emoji picker writes it (❤ as ❤️), so its own reactions match the picker's. */
export function viewEmoji(emoji: string): string {
  let out = "";
  for (const char of emoji) out += TEXT_DEFAULT.has(char.codePointAt(0)!) ? char + String.fromCharCode(0xfe0f) : char;
  return out;
}

/** Whether a chat id is a supergroup's or channel's, whose message ids are their own (GramJS's rule: -100 and no further zero). */
export function isChannelPeer(chatId: string): boolean {
  return /^-100[1-9]\d*$/.test(chatId);
}

/** Telegram's error names, e.g. PHONE_CODE_INVALID, from a GramJS RPCError. */
export function telegramError(error: unknown): string {
  if (typeof error === "object" && error !== null && "errorMessage" in error && typeof error.errorMessage === "string") return error.errorMessage;
  return error instanceof Error ? error.message : String(error);
}
