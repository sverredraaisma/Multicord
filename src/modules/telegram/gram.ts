// TelegramApi over GramJS. GramJS speaks MTProto over WebSockets to
// Telegram's web endpoints (*.web.telegram.org), which is all the engine's
// network policy allows.

import { Api, TelegramClient } from "telegram";
import type { FileSource } from "../../engine/runtime";
import { DeletedMessage, type DeletedMessageEvent } from "telegram/events/DeletedMessage";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage";
import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage";
import { Raw } from "telegram/events/Raw";
import { LogLevel } from "telegram/extensions/Logger";
import { generateRandomBytes, readBigIntFromBuffer, returnBigInt } from "telegram/Helpers";
import { computeCheck } from "telegram/Password";
import { StringSession } from "telegram/sessions/StringSession";
import type { Dialog } from "telegram/tl/custom/dialog";
import {
  ALL_CHATS,
  DOCUMENT_ID,
  FAVED_STICKERS,
  GENERAL_TOPIC,
  isChannelPeer,
  RECENT_STICKERS,
  reactionEmoji,
  telegramError,
  type TelegramApi,
  type TelegramCredentials,
  type TgAllowedReactions,
  type TgDialog,
  type TgDialogPage,
  type TgEntity,
  type TgFile,
  type TgFolder,
  type TgMember,
  type TgMemberPage,
  type TgMessage,
  type TgNewPoll,
  type TgNotifyDefaults,
  type TgPresence,
  type TgPoll,
  type TgPollResults,
  type TgPreview,
  type TgQrLogin,
  type TgProfile,
  type TgReaction,
  type TgSignIn,
  type TgSticker,
  type TgStickerFormat,
  type TgStickerSet,
  type TgText,
  type TgTopic,
  type TgUpdate,
  type TgUser,
} from "./api";
import { MAX_ENTITIES } from "./format";

/** Largest profile picture passed on (as a data: URL); bigger ones show initials. */
const MAX_AVATAR_BYTES = 140_000;

/** A user's public username, where it looks like one (4 to 32 letters, digits and underscores). */
function usernameOf(user: Api.User): string | undefined {
  return typeof user.username === "string" && /^[A-Za-z0-9_]{4,32}$/.test(user.username) ? user.username : undefined;
}

function userName(user: { firstName?: string; lastName?: string; username?: string } | undefined): string {
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ");
  return name || (user?.username ? `@${user.username}` : "Telegram user");
}

/** A short label for message media; link previews need none, the link is in the text. */
export function mediaLabel(media: Api.TypeMessageMedia | undefined): string | undefined {
  if (!media || media instanceof Api.MessageMediaEmpty || media instanceof Api.MessageMediaWebPage) return undefined;
  if (media instanceof Api.MessageMediaPhoto) return "📷 Photo";
  if (media instanceof Api.MessageMediaDocument) {
    const document = media.document instanceof Api.Document ? media.document : undefined;
    const attributes = document?.attributes ?? [];
    const sticker = attributes.find((a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker);
    if (sticker) return `${sticker.alt || "🙂"} Sticker`;
    const audio = attributes.find((a): a is Api.DocumentAttributeAudio => a instanceof Api.DocumentAttributeAudio);
    if (audio) return audio.voice ? "🎤 Voice message" : "🎵 Audio";
    if (attributes.some((a) => a instanceof Api.DocumentAttributeVideo)) return "🎥 Video";
    const file = attributes.find((a): a is Api.DocumentAttributeFilename => a instanceof Api.DocumentAttributeFilename);
    return `📎 ${file?.fileName ?? "File"}`;
  }
  if (media instanceof Api.MessageMediaGeo || media instanceof Api.MessageMediaGeoLive || media instanceof Api.MessageMediaVenue) return "📍 Location";
  if (media instanceof Api.MessageMediaContact) return "👤 Contact";
  if (media instanceof Api.MessageMediaPoll) return "📊 Poll";
  return "Attachment";
}

const count = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : typeof (value as { toJSNumber?: unknown })?.toJSNumber === "function" ? (value as { toJSNumber(): number }).toJSNumber() : undefined;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The photo, video, sound, sticker or file in a message, described for the view. */
export function mediaFile(media: Api.TypeMessageMedia | undefined): TgFile | undefined {
  if (media instanceof Api.MessageMediaPhoto) {
    const photo = media.photo instanceof Api.Photo ? media.photo : undefined;
    // The largest size is what downloads.
    let best: { w: number; h: number; size?: number } | undefined;
    for (const size of photo?.sizes ?? []) {
      if (size instanceof Api.PhotoSize) best = { w: size.w, h: size.h, size: size.size };
      else if (size instanceof Api.PhotoSizeProgressive) best = { w: size.w, h: size.h, size: size.sizes.at(-1) };
    }
    return { kind: "image", name: "Photo", mime: "image/jpeg", width: best?.w, height: best?.h, size: best?.size };
  }
  if (!(media instanceof Api.MessageMediaDocument) || !(media.document instanceof Api.Document)) return undefined;
  const document = media.document;
  const attributes = document.attributes;
  const find = <T>(type: new (...args: never[]) => T): T | undefined => attributes.find((a): a is never => a instanceof type) as T | undefined;
  const mime = document.mimeType || undefined;
  const size = count(document.size);
  const video = find(Api.DocumentAttributeVideo);
  const image = find(Api.DocumentAttributeImageSize);
  const dims = { width: video?.w ?? image?.w, height: video?.h ?? image?.h };
  const filename = find(Api.DocumentAttributeFilename)?.fileName;
  const sticker = find(Api.DocumentAttributeSticker);
  if (sticker) {
    const name = `${sticker.alt || "🙂"} Sticker`;
    // Animated vector stickers (.tgs) cannot be drawn here: their still thumbnail is.
    if (mime === "application/x-tgsticker") return { kind: "sticker", name, mime, thumbnailOnly: true, ...dims };
    return { kind: "sticker", name, mime, size, ...dims };
  }
  const audio = find(Api.DocumentAttributeAudio);
  if (audio) return { kind: "audio", name: audio.voice ? "Voice message" : [audio.performer, audio.title].filter(Boolean).join(" – ") || filename || "Audio", mime, size };
  if (find(Api.DocumentAttributeAnimated)) return { kind: "video", name: "GIF", mime, size, loop: true, ...dims };
  if (video) return { kind: "video", name: filename ?? (video.roundMessage ? "Video message" : "Video"), mime, size, ...dims };
  if (mime?.startsWith("image/")) return { kind: "image", name: filename ?? "Image", mime, size, ...dims };
  return { kind: "file", name: filename ?? "File", mime, size };
}

/**
 * The link preview Telegram made for a message's link: site, title,
 * description and photo (not a page's video or file, which would download
 * in the photo's place). Undefined for a preview still pending or empty.
 */
export function webPreview(media: Api.TypeMessageMedia | undefined): TgPreview | undefined {
  if (!(media instanceof Api.MessageMediaWebPage) || !(media.webpage instanceof Api.WebPage)) return undefined;
  const page = media.webpage;
  const text = (value: string | undefined, max: number) => (value && value.trim() !== "" ? value.slice(0, max) : undefined);
  const preview: TgPreview = {};
  if (/^https:\/\/\S{1,2040}$/.test(page.url)) preview.url = page.url;
  const site = text(page.siteName, 100);
  if (site) preview.site = site;
  const title = text(page.title, 256);
  if (title) preview.title = title;
  const description = text(page.description, 1000);
  if (description) preview.description = description;
  if (page.photo instanceof Api.Photo && !page.document) preview.photo = mediaFile(new Api.MessageMediaPhoto({ photo: page.photo }));
  return title || description || preview.photo ? preview : undefined;
}

/** Chat ids as GramJS marks them (Utils.getPeerId): a user's id, -id for a basic group, -100id for a supergroup or channel. */
export function chatIdOf(peer: Api.TypePeer | undefined): string | undefined {
  if (peer instanceof Api.PeerUser) return peer.userId.toString();
  if (peer instanceof Api.PeerChat) return `-${peer.chatId.toString()}`;
  if (peer instanceof Api.PeerChannel) return `-100${peer.channelId.toString()}`;
  return undefined;
}

/** The title of Telegram's chat with yourself. */
export const SAVED_MESSAGES = "Saved Messages";

/** Whose name a message shows: a user's, or a group's or channel's posting as itself. */
function entityName(entity: unknown): string | undefined {
  if (entity instanceof Api.User) return userName(entity);
  if (entity instanceof Api.Chat || entity instanceof Api.Channel) return entity.title || undefined;
  return undefined;
}

const banned = (rights: Api.TypeChatBannedRights | undefined): boolean => rights?.sendMessages === true || rights?.sendPlain === true;

/**
 * What a dialog's entity is to the view: a one-to-one chat, a group (basic,
 * super or broadcast group) or a broadcast channel, and whether the user may
 * write there and list its members. Undefined for chats the user can no
 * longer open (forbidden) and basic groups that moved into a supergroup
 * (listed as that).
 */
export function describeChat(entity: unknown): { kind: TgDialog["kind"]; title: string; bot: boolean; readOnly: boolean; members: boolean; left: boolean } | undefined {
  if (entity instanceof Api.User) return { kind: "user", title: entity.self ? SAVED_MESSAGES : userName(entity), bot: entity.bot === true, readOnly: false, members: false, left: false };
  if (entity instanceof Api.Chat) {
    if (entity.deactivated || entity.migratedTo) return undefined;
    const admin = entity.creator === true || entity.adminRights !== undefined;
    const left = entity.left === true;
    return { kind: "group", title: entity.title || "Group", bot: false, readOnly: left || (!admin && banned(entity.defaultBannedRights)), members: !left, left };
  }
  if (entity instanceof Api.Channel) {
    const title = entity.title || "Channel";
    const admin = entity.creator === true || entity.adminRights !== undefined;
    // Only admins with the right post in a broadcast channel, and in a broadcast group (gigagroup); only admins see a channel's subscribers.
    const left = entity.left === true;
    if (!entity.megagroup) return { kind: "channel", title, bot: false, readOnly: !(entity.creator === true || entity.adminRights?.postMessages === true), members: admin, left };
    const silenced = entity.gigagroup === true || banned(entity.bannedRights) || banned(entity.defaultBannedRights);
    return { kind: "group", title, bot: false, readOnly: left || (!admin && silenced), members: !left, left };
  }
  return undefined;
}

/** Whether a group's rules or the user's own restrictions there, which admins are free of, bar what `barred` says. */
function restricted(entity: unknown, barred: (rights: Api.TypeChatBannedRights) => boolean): boolean {
  if (!(entity instanceof Api.Chat || entity instanceof Api.Channel) || entity.creator === true || entity.adminRights !== undefined) return false;
  const rights = [entity.defaultBannedRights, entity instanceof Api.Channel ? entity.bannedRights : undefined];
  return rights.some((r) => r !== undefined && barred(r));
}

/** Whether the user may write in a group but not send media there. */
export const mediaBanned = (entity: unknown): boolean => restricted(entity, (r) => r.sendMedia === true);

/** Whether the user may write in a group but not send stickers there: barred from them, or from all media. */
export const stickersBanned = (entity: unknown): boolean => restricted(entity, (r) => r.sendMedia === true || r.sendStickers === true);

/** Whether the user may write in a group but not start polls there: barred from them, or from all media. */
export const pollsBanned = (entity: unknown): boolean => restricted(entity, (r) => r.sendMedia === true || r.sendPolls === true);

/**
 * A poll as Telegram takes it: question and answers as plain text, each
 * answer's option bytes (its place, for a new poll), and how it is set.
 * Closing sends the poll as it is, with closed set.
 */
export function inputPoll(id: Api.long, question: string, answers: { option: Uint8Array; text: string }[], flags: { multiple: boolean; publicVoters: boolean; quiz?: boolean; closed?: boolean }): Api.InputMediaPoll {
  const text = (value: string) => new Api.TextWithEntities({ text: value, entities: [] });
  const poll = new Api.Poll({
    id,
    question: text(question),
    answers: answers.map((a) => new Api.PollAnswer({ text: text(a.text), option: Buffer.from(a.option) })),
    multipleChoice: flags.multiple,
    publicVoters: flags.publicVoters,
    quiz: flags.quiz === true,
    closed: flags.closed === true,
  });
  return new Api.InputMediaPoll({ poll });
}

/** Whether a dialog's entity is a forum group, and whether only its admins start topics there. */
export function forumOf(entity: unknown): { forum: boolean; noTopics: boolean } {
  if (!(entity instanceof Api.Channel) || entity.megagroup !== true || entity.forum !== true) return { forum: false, noTopics: false };
  const admin = entity.creator === true || entity.adminRights !== undefined;
  return { forum: true, noTopics: !admin && entity.defaultBannedRights?.manageTopics === true };
}

/** A forum's topics as listed: deleted ones and malformed ids left out, titles cut short, last activity from their newest message. */
export function topicsOf(topics: readonly unknown[], messages: readonly unknown[]): TgTopic[] {
  const dates = new Map<number, number>();
  for (const m of messages) if (m instanceof Api.Message || m instanceof Api.MessageService) dates.set(m.id, m.date);
  return topics.flatMap((t): TgTopic[] => {
    if (!(t instanceof Api.ForumTopic) || !Number.isInteger(t.id) || t.id <= 0) return [];
    const topic: TgTopic = { id: t.id, title: (t.title || "Topic").slice(0, 128), unreadCount: tally(t.unreadCount), unreadMentions: tally(t.unreadMentionsCount), date: dates.get(t.topMessage) ?? t.date };
    if (t.pinned) topic.pinned = true;
    const muteUntil = muteOf(t.notifySettings);
    if (muteUntil !== undefined) topic.mutedUntil = muteUntil;
    if (Number.isInteger(t.readInboxMaxId) && t.readInboxMaxId > 0) topic.readUpTo = t.readInboxMaxId;
    return [topic];
  });
}

/** Where a message goes in a forum: into a topic (General takes plain messages), as a reply within it where it answers one. */
export function topicReply(replyTo: number | undefined, topicId: number | undefined): { replyTo?: number; topMsgId?: number } {
  if (topicId === undefined || topicId === GENERAL_TOPIC) return replyTo === undefined ? {} : { replyTo };
  return replyTo === undefined ? { replyTo: topicId } : { replyTo, topMsgId: topicId };
}

/** How recently a user was online, as their status says. */
export function presenceOf(status: Api.TypeUserStatus | undefined): TgPresence {
  if (status instanceof Api.UserStatusOnline) return "online";
  return status instanceof Api.UserStatusRecently ? "recently" : "offline";
}

/** The users among a chat's participants, with their role there; deleted accounts are left out. */
export function membersOf(participants: readonly unknown[], users: readonly unknown[]): TgMember[] {
  const byId = new Map<string, Api.User>();
  for (const user of users) if (user instanceof Api.User) byId.set(user.id.toString(), user);
  return participants.flatMap((participant): TgMember[] => {
    const id = (participant as { userId?: { toString(): string } } | undefined)?.userId?.toString();
    const user = id ? byId.get(id) : undefined;
    if (!id || !user || user.deleted) return [];
    const member: TgMember = { id, name: userName(user), bot: user.bot === true, presence: presenceOf(user.status) };
    if (participant instanceof Api.ChatParticipantCreator || participant instanceof Api.ChannelParticipantCreator) member.role = "owner";
    else if (participant instanceof Api.ChatParticipantAdmin || participant instanceof Api.ChannelParticipantAdmin) member.role = "admin";
    const username = usernameOf(user);
    if (username) member.username = username;
    const rank = (participant as { rank?: unknown }).rank;
    if (typeof rank === "string" && rank !== "") member.rank = rank;
    return [member];
  });
}

/** A member count from Telegram, kept sane. */
const total = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 100_000_000) : 0);

/** A count from Telegram, kept sane: a whole number from 0 to a million. */
const tally = (value: unknown): number => (typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 1_000_000) : 0);

/** Telegram's entity classes for the formatting the view shows; mentions, hashtags and the like are plain text there. */
const ENTITY_TYPES: [new (...args: never[]) => Api.TypeMessageEntity, TgEntity["type"]][] = [
  [Api.MessageEntityBold, "bold"],
  [Api.MessageEntityItalic, "italic"],
  [Api.MessageEntityUnderline, "underline"],
  [Api.MessageEntityStrike, "strike"],
  [Api.MessageEntitySpoiler, "spoiler"],
  [Api.MessageEntityCode, "code"],
  [Api.MessageEntityPre, "pre"],
  [Api.MessageEntityTextUrl, "textUrl"],
  [Api.MessageEntityBlockquote, "blockquote"],
];

/** A message's formatting, as far as it fits its text (offsets and lengths are UTF-16 units). */
export function entitiesOf(entities: readonly unknown[] | undefined, text: string): TgEntity[] {
  const out: TgEntity[] = [];
  for (const entity of (entities ?? []).slice(0, MAX_ENTITIES)) {
    const type = entity instanceof Api.MessageEntityCustomEmoji ? "customEmoji" : ENTITY_TYPES.find(([cls]) => entity instanceof cls)?.[1];
    if (!type) continue;
    const { offset, length, url, language, documentId } = entity as { offset?: unknown; length?: unknown; url?: unknown; language?: unknown; documentId?: unknown };
    if (!Number.isInteger(offset) || !Number.isInteger(length)) continue;
    const [start, size] = [offset as number, length as number];
    if (start < 0 || size <= 0 || start + size > text.length) continue;
    const found: TgEntity = { type, offset: start, length: size };
    if (type === "textUrl" && typeof url === "string") found.url = url.slice(0, 2048);
    if (type === "pre" && typeof language === "string" && language !== "") found.language = language.slice(0, 64);
    if (type === "customEmoji") {
      const id = String(documentId ?? "");
      if (!DOCUMENT_ID.test(id)) continue;
      found.documentId = id;
    }
    out.push(found);
  }
  return out;
}

/** Formatting for Telegram, from what the view's markdown said. */
export function apiEntities(entities: readonly TgEntity[]): Api.TypeMessageEntity[] {
  return entities.map(({ type, offset, length, url, language, documentId }) => {
    switch (type) {
      case "textUrl":
        return new Api.MessageEntityTextUrl({ offset, length, url: url ?? "" });
      case "pre":
        return new Api.MessageEntityPre({ offset, length, language: language ?? "" });
      case "customEmoji":
        return new Api.MessageEntityCustomEmoji({ offset, length, documentId: returnBigInt(documentId!) });
      default:
        return new (ENTITY_TYPES.find(([, name]) => name === type)![0] as new (args: { offset: number; length: number }) => Api.TypeMessageEntity)({ offset, length });
    }
  });
}

/** Most reactions read per message. */
const MAX_REACTIONS = 50;

/** A short, plain emoji from Telegram; undefined for anything else. */
const emojiOf = (reaction: unknown): string | undefined => {
  const emoticon = reaction instanceof Api.ReactionEmoji ? reaction.emoticon : undefined;
  const emoji = typeof emoticon === "string" && emoticon.length <= 32 && !/[\s<>]/.test(emoticon) ? reactionEmoji(emoticon) : "";
  return emoji !== "" ? emoji : undefined;
};

/**
 * A message's emoji reactions with their counts, and whether the user gave
 * each (`own`: Telegram says so; in "min" updates it does not). Custom
 * emoji and paid reactions are left out: showing them would mean fetching
 * their stickers.
 */
export function reactionsOf(reactions: unknown): { reactions: TgReaction[]; own: boolean } {
  if (!(reactions instanceof Api.MessageReactions)) return { reactions: [], own: true };
  const out: TgReaction[] = [];
  for (const result of (Array.isArray(reactions.results) ? reactions.results : []).slice(0, MAX_REACTIONS)) {
    const emoji = result instanceof Api.ReactionCount ? emojiOf(result.reaction) : undefined;
    const count = tally((result as { count?: unknown }).count);
    if (emoji && count > 0 && !out.some((r) => r.emoji === emoji)) out.push({ emoji, count, chosen: result.chosenOrder !== undefined });
  }
  return { reactions: out, own: reactions.min !== true };
}

/** What a chat's full info says about reactions; a chat that says nothing takes all. */
export function allowedOf(reactions: unknown): TgAllowedReactions {
  if (reactions instanceof Api.ChatReactionsNone) return { kind: "none" };
  if (reactions instanceof Api.ChatReactionsSome) return { kind: "some", emoji: reactions.reactions.flatMap((r) => emojiOf(r) ?? []) };
  return { kind: "all" };
}

/** What others see as "typing": typing itself, or recording or sending media. */
const TYPING_ACTIONS = [
  Api.SendMessageTypingAction,
  Api.SendMessageRecordVideoAction,
  Api.SendMessageUploadVideoAction,
  Api.SendMessageRecordAudioAction,
  Api.SendMessageUploadAudioAction,
  Api.SendMessageUploadPhotoAction,
  Api.SendMessageUploadDocumentAction,
  Api.SendMessageRecordRoundAction,
  Api.SendMessageUploadRoundAction,
  Api.SendMessageChooseStickerAction,
];

/**
 * A typing update as a chat, a user and whether they are at it (a cancel
 * stops it). Undefined for other updates, for chats posting as themselves,
 * and for other actions (emoji interactions, voice chat speaking).
 */
/** A text Telegram sends either plain or with entities (TextWithEntities), as plain text. */
function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  const text = typeof value === "object" && value !== null ? (value as { text?: unknown }).text : undefined;
  return typeof text === "string" ? text : "";
}

const base64Of = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** A poll's results, as far as Telegram shows them. */
export function pollResultsOf(results: unknown): TgPollResults | undefined {
  if (!(results instanceof Api.PollResults)) return undefined;
  const voters = (results.results ?? []).flatMap((r) => {
    if (!(r instanceof Api.PollAnswerVoters)) return [];
    const entry: TgPollResults["voters"][number] = { option: base64Of(r.option), votes: Math.max(0, r.voters) };
    if (r.chosen === true) entry.chosen = true;
    if (r.correct === true) entry.correct = true;
    return [entry];
  });
  const out: TgPollResults = { voters, min: results.min === true };
  if (typeof results.totalVoters === "number") out.total = results.totalVoters;
  return out;
}

/** The poll in a message, with its results where Telegram sent them. */
export function pollOf(media: Api.TypeMessageMedia | undefined): TgPoll | undefined {
  if (!(media instanceof Api.MessageMediaPoll) || !(media.poll instanceof Api.Poll)) return undefined;
  const poll = media.poll;
  const answers = poll.answers.flatMap((a) => (a instanceof Api.PollAnswer ? [{ option: base64Of(a.option), text: plainText(a.text) }] : []));
  const out: TgPoll = { id: poll.id.toString(), question: plainText(poll.question), answers, multiple: poll.multipleChoice === true, closed: poll.closed === true, quiz: poll.quiz === true };
  if (poll.publicVoters === true) out.publicVoters = true;
  const results = pollResultsOf(media.results);
  if (results) out.results = results;
  return out;
}

/** Messages pinned or unpinned somewhere, as Telegram announces it (per chat; a channel's or supergroup's by its id). */
export function pinsOf(update: unknown): Extract<TgUpdate, { type: "pins" }> | undefined {
  const chatId =
    update instanceof Api.UpdatePinnedMessages ? chatIdOf(update.peer) : update instanceof Api.UpdatePinnedChannelMessages ? chatIdOf(new Api.PeerChannel({ channelId: update.channelId })) : undefined;
  if (!chatId) return undefined;
  const { messages, pinned } = update as Api.UpdatePinnedMessages;
  return { type: "pins", chatId, ids: messages.filter((id) => Number.isInteger(id) && id > 0), pinned: pinned === true };
}

/** A chat a folder names, as a chat id; the user's own chat by the id given for it. */
function inputPeerId(peer: unknown, self: string | undefined): string | undefined {
  if (peer instanceof Api.InputPeerUser) return peer.userId.toString();
  if (peer instanceof Api.InputPeerChat) return `-${peer.chatId.toString()}`;
  if (peer instanceof Api.InputPeerChannel) return `-100${peer.channelId.toString()}`;
  return peer instanceof Api.InputPeerSelf ? self : undefined;
}

/** Most folders read, and chats read per list of a folder (Telegram allows 30 and 200, with Premium). */
const MAX_FOLDERS = 31;
export const MAX_FOLDER_PEERS = 200;
const FOLDER_FLAGS = ["contacts", "nonContacts", "groups", "broadcasts", "bots", "excludeMuted", "excludeRead", "excludeArchived"] as const;

/** The chats a folder's lists name. */
function folderPeers(filter: unknown): unknown[] {
  if (!(filter instanceof Api.DialogFilter || filter instanceof Api.DialogFilterChatlist)) return [];
  return [...filter.pinnedPeers, ...filter.includePeers, ...(filter instanceof Api.DialogFilter ? filter.excludePeers : [])];
}

/** The user's folders as Telegram lists them, with "All chats" where they placed it; shared folders (chat lists) take only the chats they name. */
export function foldersOf(filters: readonly unknown[], self: string | undefined): TgFolder[] {
  return filters.slice(0, MAX_FOLDERS).flatMap((f): TgFolder[] => {
    if (f instanceof Api.DialogFilterDefault) return [{ id: ALL_CHATS, title: "All chats", include: [], exclude: [] }];
    if (!(f instanceof Api.DialogFilter || f instanceof Api.DialogFilterChatlist) || !Number.isInteger(f.id) || f.id <= 0) return [];
    const ids = (peers: readonly unknown[]) => peers.slice(0, MAX_FOLDER_PEERS).flatMap((p) => inputPeerId(p, self) ?? []);
    const folder: TgFolder = { id: f.id, title: plainText(f.title).trim().slice(0, 64) || "Folder", include: [...new Set([...ids(f.pinnedPeers), ...ids(f.includePeers)])], exclude: [] };
    if (f instanceof Api.DialogFilter) {
      folder.exclude = ids(f.excludePeers);
      for (const flag of FOLDER_FLAGS) if (f[flag] === true) folder[flag] = true;
    }
    return [folder];
  });
}

/** Telegram's folder for archived chats; the main list is folder 0. */
const ARCHIVE_FOLDER = 1;

/** Chats moved into the archive or out of it, as Telegram announces it. */
export function archiveOf(update: unknown): Extract<TgUpdate, { type: "archive" }> | undefined {
  if (!(update instanceof Api.UpdateFolderPeers)) return undefined;
  const peers = update.folderPeers.flatMap((p) => {
    const chatId = p instanceof Api.FolderPeer ? chatIdOf(p.peer) : undefined;
    return chatId ? [{ chatId, archived: p.folderId === ARCHIVE_FOLDER }] : [];
  });
  return peers.length > 0 ? { type: "archive", peers } : undefined;
}

/**
 * A mute as notify settings carry it: until when (a Unix time; "muted for
 * ever" is the largest 32-bit one), 0 for unmuted, or undefined where the
 * settings leave it unset, so the default applies.
 */
export function muteOf(settings: unknown): number | undefined {
  const until = settings instanceof Api.PeerNotifySettings ? settings.muteUntil : undefined;
  return Number.isInteger(until) ? Math.max(0, until!) : undefined;
}

/** The kinds of chat whose defaults Telegram keeps, as GetNotifySettings and UpdateNotifySettings name them. */
const NOTIFY_KINDS = [
  ["user", Api.InputNotifyUsers, Api.NotifyUsers],
  ["group", Api.InputNotifyChats, Api.NotifyChats],
  ["channel", Api.InputNotifyBroadcasts, Api.NotifyBroadcasts],
] as const;

/** A change to a chat's own notification settings, or to the defaults for a kind of chat; forum topics' are left out. */
export function notifyOf(update: unknown): Extract<TgUpdate, { type: "notifyChat" | "notifyDefault" }> | undefined {
  if (!(update instanceof Api.UpdateNotifySettings)) return undefined;
  const mutedUntil = muteOf(update.notifySettings);
  if (update.peer instanceof Api.NotifyPeer) {
    const chatId = chatIdOf(update.peer.peer);
    return chatId ? { type: "notifyChat", chatId, ...(mutedUntil === undefined ? {} : { mutedUntil }) } : undefined;
  }
  const kind = NOTIFY_KINDS.find(([, , type]) => update.peer instanceof type)?.[0];
  return kind ? { type: "notifyDefault", kind, mutedUntil: mutedUntil ?? 0 } : undefined;
}

export function typingOf(update: unknown): Extract<TgUpdate, { type: "typing" }> | undefined {
  let chatId: string;
  let userId: string | undefined;
  // In groups, someone typing as a channel (fromId a PeerChannel) has no user id, and is left out.
  const user = (from: unknown) => (from instanceof Api.PeerUser ? String(from.userId) : undefined);
  if (update instanceof Api.UpdateUserTyping) chatId = userId = String(update.userId);
  else if (update instanceof Api.UpdateChatUserTyping) [chatId, userId] = [`-${update.chatId}`, user(update.fromId)];
  else if (update instanceof Api.UpdateChannelUserTyping) [chatId, userId] = [`-100${update.channelId}`, user(update.fromId)];
  else return undefined;
  if (!/^-?\d{1,18}$/.test(chatId) || !userId || !/^\d{1,18}$/.test(userId)) return undefined;
  const { action } = update;
  const active = action instanceof Api.SendMessageCancelAction ? false : TYPING_ACTIONS.some((cls) => action instanceof cls) ? true : undefined;
  if (active === undefined) return undefined;
  // In a forum, which topic; none is General.
  const topic = update instanceof Api.UpdateChannelUserTyping ? update.topMsgId : undefined;
  return Number.isInteger(topic) && topic! > GENERAL_TOPIC ? { type: "typing", chatId, userId, active, topicId: topic } : { type: "typing", chatId, userId, active };
}

/** Text and its formatting, as GramJS sends them. */
const outgoing = (text: TgText) => ({ formattingEntities: apiEntities(text.entities) });

/** Telegram takes uploads in parts of 512 KB; files over 10 MB as "big" files. */
export const UPLOAD_PART = 512 * 1024;
const BIG_FILE = 10 * 1024 * 1024;
/** Parts read through the bridge at once. */
const PARTS_PER_READ = 16;
/** Largest picture sent as a photo, Telegram's limit; larger ones go as files. */
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

/** Uploads a picked file in parts, reading it a few parts at a time, and names the result for sending. */
async function uploadFile(client: TelegramClient, file: FileSource, name: string): Promise<Api.TypeInputFile> {
  const parts = Math.max(1, Math.ceil(file.size / UPLOAD_PART));
  const big = file.size > BIG_FILE;
  const id = readBigIntFromBuffer(generateRandomBytes(8), true, true);
  for (let first = 0; first < parts; first += PARTS_PER_READ) {
    const start = first * UPLOAD_PART;
    const end = Math.min(file.size, start + PARTS_PER_READ * UPLOAD_PART);
    const chunk = await file.read(start, end);
    if (chunk.length !== end - start) throw new Error(`${name} changed while it was sent`);
    for (let part = first; part < Math.min(parts, first + PARTS_PER_READ); part++) {
      const bytes = Buffer.from(chunk.subarray((part - first) * UPLOAD_PART, (part - first + 1) * UPLOAD_PART));
      await client.invoke(big ? new Api.upload.SaveBigFilePart({ fileId: id, filePart: part, fileTotalParts: parts, bytes }) : new Api.upload.SaveFilePart({ fileId: id, filePart: part, bytes }));
    }
  }
  return big ? new Api.InputFileBig({ id, parts, name }) : new Api.InputFile({ id, parts, name, md5Checksum: "" });
}

/**
 * How a picked file goes out: JPEG and PNG pictures (up to Telegram's
 * 10 MB) as photos, videos as videos (Telegram reads their size and length
 * itself), everything else as a document with its name.
 */
export function uploadMedia(uploaded: Api.TypeInputFile, file: FileSource, name: string): Api.TypeInputMedia {
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.contentType) ? file.contentType.toLowerCase() : "application/octet-stream";
  if ((mime === "image/jpeg" || mime === "image/png") && file.size <= MAX_PHOTO_BYTES) return new Api.InputMediaUploadedPhoto({ file: uploaded });
  const attributes: Api.TypeDocumentAttribute[] = [new Api.DocumentAttributeFilename({ fileName: name })];
  if (mime.startsWith("video/")) attributes.push(new Api.DocumentAttributeVideo({ duration: 0, w: 1, h: 1, supportsStreaming: mime === "video/mp4" }));
  return new Api.InputMediaUploadedDocument({ file: uploaded, mimeType: mime, attributes });
}

/** A file name Telegram shows: its last path part, without control characters, at most 255 characters. */
export function fileName(name: string): string {
  const clean = Array.from(name.split(/[\\/]/).at(-1)!, (c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? "" : c)).join("").trim().slice(0, 255);
  return clean || "file";
}

/**
 * Which of a document's thumbnails is its largest, as GramJS counts them
 * (it leaves out vector outlines); undefined when it has none to download.
 */
export function thumbIndex(thumbs: readonly unknown[] | undefined): number | undefined {
  const usable = (thumbs ?? []).filter((t) => !(t instanceof Api.PhotoPathSize)).length;
  return usable > 0 ? usable - 1 : undefined;
}

/** Sticker files by MIME type: the formats the picker offers. */
const STICKER_FORMATS = new Map<string, TgStickerFormat>([
  ["image/webp", "webp"],
  ["application/x-tgsticker", "lottie"],
  ["video/webm", "webm"],
]);

/** A sticker document as the picker offers it; undefined for anything else, or a format it does not know. */
export function stickerOf(document: unknown): TgSticker | undefined {
  if (!(document instanceof Api.Document)) return undefined;
  const attribute = document.attributes.find((a): a is Api.DocumentAttributeSticker => a instanceof Api.DocumentAttributeSticker);
  const format = STICKER_FORMATS.get(document.mimeType);
  const id = String(document.id);
  if (!attribute || !format || !/^-?\d{1,20}$/.test(id)) return undefined;
  const sticker: TgSticker = { id, emoji: attribute.alt && attribute.alt.length <= 32 ? attribute.alt : "", format };
  const size = count(document.size);
  if (size) sticker.size = size;
  // Premium stickers come with a full-screen effect: a video thumbnail of type "f".
  if ((document.videoThumbs ?? []).some((v) => v instanceof Api.VideoSize && v.type === "f")) sticker.premium = true;
  return sticker;
}

/** The installed sticker sets the picker offers: regular ones, not archived, masks or custom emoji. */
export function stickerSetsOf(sets: readonly unknown[]): { set: TgStickerSet; input: Api.InputStickerSetID }[] {
  return sets.flatMap((s) => {
    if (!(s instanceof Api.StickerSet) || s.archived || s.masks || s.emojis) return [];
    const id = String(s.id);
    if (!/^-?\d{1,20}$/.test(id)) return [];
    return [{ set: { id, title: (s.title || "Stickers").slice(0, 100) }, input: new Api.InputStickerSetID({ id: s.id, accessHash: s.accessHash }) }];
  });
}

/** A message for the adapter; `senderEntity` is who sent it where GramJS has not attached it (raw requests). */
export function toMessage(message: Api.Message, chatId: string, senderEntity: unknown = message.sender): TgMessage {
  const out: TgMessage = {
    id: message.id,
    chatId,
    out: message.out === true,
    text: message.message ?? "",
    date: message.date,
    edited: message.editDate !== undefined && message.editHide !== true,
  };
  const entities = entitiesOf(message.entities, out.text);
  if (entities.length > 0) out.entities = entities;
  // In groups and channels each message says who wrote it; in a private chat the chat does.
  if (!(message.peerId instanceof Api.PeerUser)) {
    const sender = entityName(senderEntity) ?? (message.postAuthor || undefined);
    if (sender) out.sender = sender;
    const username = senderEntity instanceof Api.User ? usernameOf(senderEntity) : undefined;
    if (username) out.senderUsername = username;
  }
  // Who sent it, for their profile: the user named as sender, or in a private chat the other side.
  const from = message.fromId instanceof Api.PeerUser ? message.fromId.userId : message.peerId instanceof Api.PeerUser && message.out !== true ? message.peerId.userId : undefined;
  if (from !== undefined) out.senderId = from.toString();
  if (message.mentioned === true) out.mentioned = true;
  const media = mediaLabel(message.media);
  if (media) out.media = media;
  const { reactions } = reactionsOf(message.reactions);
  if (reactions.length > 0) out.reactions = reactions;
  const file = mediaFile(message.media);
  if (file) out.file = file;
  if (message.pinned === true) out.pinned = true;
  const poll = pollOf(message.media);
  if (poll) out.poll = poll;
  const preview = webPreview(message.media);
  if (preview) out.preview = preview;
  const header = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;
  // In a forum topic every message points at the topic's first; only one that also names a top id answers another.
  const topic = header?.forumTopic === true ? (header.replyToTopId ?? header.replyToMsgId) : undefined;
  if (topic && topic !== GENERAL_TOPIC) out.topicId = topic;
  const reply = header?.forumTopic === true && header.replyToTopId === undefined ? undefined : header?.replyToMsgId;
  if (reply) out.replyToId = reply;
  return out;
}

/** GramJS's dialogs as the adapter lists them: chats the user can open, with their counts, mute and last message. */
export function dialogsOf(found: readonly Dialog[]): TgDialog[] {
  return found.flatMap((d): TgDialog[] => {
    const chat = describeChat(d.entity);
    const chatId = d.id?.toString() ?? "";
    // Ids beyond 18 digits are not Telegram's; the view could not tell them apart.
    if (!chat || !/^-?\d{1,18}$/.test(chatId)) return [];
    const dialog: TgDialog = { chatId, kind: chat.kind, title: chat.title, bot: chat.bot, unreadCount: tally(d.unreadCount), unreadMentions: tally(d.unreadMentionsCount), date: d.date };
    if (chat.readOnly) dialog.readOnly = true;
    if (chat.members) dialog.members = true;
    if (chat.left) dialog.left = true;
    if (d.archived === true) dialog.archived = true;
    if (d.entity instanceof Api.User && (d.entity.contact === true || d.entity.self === true)) dialog.contact = true;
    if (mediaBanned(d.entity)) dialog.noMedia = true;
    if (stickersBanned(d.entity)) dialog.noStickers = true;
    if (pollsBanned(d.entity)) dialog.noPolls = true;
    const forum = forumOf(d.entity);
    if (forum.forum) dialog.forum = true;
    if (forum.noTopics) dialog.noTopics = true;
    // The chat's own mute, where it has one; else it follows the default for its kind.
    const mutedUntil = muteOf(d.dialog.notifySettings);
    if (mutedUntil !== undefined) dialog.mutedUntil = mutedUntil;
    const readUpTo = d.dialog.readInboxMaxId;
    if (Number.isInteger(readUpTo) && readUpTo > 0) dialog.readUpTo = readUpTo;
    if (d.message) dialog.lastMessage = toMessage(d.message, chatId);
    return [dialog];
  });
}

/**
 * The messages of a raw messages.search answer, with their senders' names
 * from the users and chats it lists (GramJS attaches them only to messages
 * it fetched itself).
 */
export function foundMessages(found: unknown, chatId: string): TgMessage[] {
  const { messages, users, chats } = found as { messages?: unknown; users?: unknown; chats?: unknown };
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const entities = new Map<string, unknown>();
  for (const user of list(users)) if (user instanceof Api.User) entities.set(user.id.toString(), user);
  for (const chat of list(chats)) if (chat instanceof Api.Chat || chat instanceof Api.Channel) entities.set(chatIdOf(chat instanceof Api.Chat ? new Api.PeerChat({ chatId: chat.id }) : new Api.PeerChannel({ channelId: chat.id }))!, chat);
  return list(messages).flatMap((m) => (m instanceof Api.Message ? [toMessage(m, chatId, entities.get(chatIdOf(m.fromId ?? m.peerId) ?? ""))] : []));
}

/** Downloaded bytes, or undefined for none (or a path, which is not asked for). */
const bytesOf = (data: unknown): Uint8Array | undefined => (data instanceof Uint8Array && data.length > 0 ? new Uint8Array(data) : undefined);

export interface GramOptions {
  os: string;
  appVersion: string;
}

export function createGramApi(credentials: TelegramCredentials, session: string, options: GramOptions): TelegramApi {
  const client = new TelegramClient(new StringSession(session), credentials.apiId, credentials.apiHash, {
    connectionRetries: 5,
    useWSS: true,
    deviceModel: "Multicord",
    systemVersion: options.os,
    appVersion: options.appVersion,
    langCode: "en",
    systemLangCode: "en",
  });
  client.setLogLevel(LogLevel.ERROR);
  const peer = (chatId: string) => returnBigInt(chatId);
  const api = { apiId: credentials.apiId, apiHash: credentials.apiHash };

  /** The installed sticker sets as last listed, with Telegram's hash of them; and how to ask for each. */
  let installed: { hash: Api.long; sets: TgStickerSet[] } | undefined;
  const stickerSetInputs = new Map<string, Api.InputStickerSetID>();
  /** Stickers listed this session, by id: their document (to send or download it) and where it was listed, to refresh it from. */
  const stickerDocuments = new Map<string, { document: Api.Document; source: string }>();

  /** A set's sticker documents, or the user's recent or favourite ones. */
  const fetchStickers = async (source: string): Promise<readonly unknown[]> => {
    if (source === RECENT_STICKERS) {
      const found = await client.invoke(new Api.messages.GetRecentStickers({ hash: returnBigInt(0) }));
      return found instanceof Api.messages.RecentStickers ? found.stickers : [];
    }
    if (source === FAVED_STICKERS) {
      const found = await client.invoke(new Api.messages.GetFavedStickers({ hash: returnBigInt(0) }));
      return found instanceof Api.messages.FavedStickers ? found.stickers : [];
    }
    const input = stickerSetInputs.get(source);
    if (!input) throw new Error("Telegram did not list this sticker set");
    const found = await client.invoke(new Api.messages.GetStickerSet({ stickerset: input, hash: 0 }));
    return found instanceof Api.messages.StickerSet ? found.documents : [];
  };

  const listStickers = async (source: string): Promise<TgSticker[]> => {
    const stickers: TgSticker[] = [];
    for (const document of await fetchStickers(source)) {
      const sticker = stickerOf(document);
      if (!sticker) continue;
      stickerDocuments.set(sticker.id, { document: document as Api.Document, source });
      stickers.push(sticker);
    }
    return stickers;
  };

  /** Uses a listed sticker's document; where Telegram says its file reference expired, once more after listing it afresh. */
  const withSticker = async <T>(id: string, use: (document: Api.Document) => Promise<T>): Promise<T> => {
    const known = stickerDocuments.get(id);
    if (!known) throw new Error("Telegram did not list this sticker");
    try {
      return await use(known.document);
    } catch (error) {
      if (!telegramError(error).startsWith("FILE_REFERENCE_")) throw error;
      await listStickers(known.source);
      const fresh = stickerDocuments.get(id)!;
      // No longer listed there: nothing to refresh it with.
      if (fresh === known) throw error;
      return use(fresh.document);
    }
  };

  /**
   * A forum topic's messages that match a search or a filter, newest first.
   * GramJS's own search drops the topic (it lists the topic's replies
   * instead), so Telegram's messages.search is asked directly.
   */
  const searchTopic = async (chatId: string, q: string, filter: Api.TypeMessagesFilter, limit: number, topMsgId: number): Promise<TgMessage[]> => {
    const found = await client.invoke(new Api.messages.Search({ peer: peer(chatId), q, filter, topMsgId, minDate: 0, maxDate: 0, offsetId: 0, addOffset: 0, limit, maxId: 0, minId: 0, hash: returnBigInt(0) }));
    return foundMessages(found, chatId);
  };

  /** The password step after a sign-in Telegram accepted, with the account's hint where it has one. */
  const passwordStep = async (): Promise<{ password: true; hint?: string }> => {
    const password = await client.invoke(new Api.account.GetPassword());
    return password.hint ? { password: true, hint: password.hint } : { password: true };
  };

  return {
    connect: async () => void (await client.connect()),
    authorized: () => client.checkAuthorization(),
    sendCode: async (phone) => {
      const sent = await client.sendCode(api, phone);
      return { hash: sent.phoneCodeHash, viaApp: sent.isCodeViaApp };
    },
    signIn: async (phone, hash, code): Promise<TgSignIn> => {
      try {
        const result = await client.invoke(new Api.auth.SignIn({ phoneNumber: phone, phoneCodeHash: hash, phoneCode: code }));
        return result instanceof Api.auth.AuthorizationSignUpRequired ? { signUp: true } : { done: true };
      } catch (error) {
        if (telegramError(error) !== "SESSION_PASSWORD_NEEDED") throw error;
        return passwordStep();
      }
    },
    qrLogin: async (): Promise<TgQrLogin> => {
      try {
        let result = await client.invoke(new Api.auth.ExportLoginToken({ apiId: api.apiId, apiHash: api.apiHash, exceptIds: [] }));
        // Accepted by an account on another data centre: sign in there, with the token it gives.
        if (result instanceof Api.auth.LoginTokenMigrateTo) {
          await client._switchDC(result.dcId);
          result = await client.invoke(new Api.auth.ImportLoginToken({ token: result.token }));
        }
        if (result instanceof Api.auth.LoginToken) return { token: new Uint8Array(result.token), expires: result.expires };
        if (result instanceof Api.auth.LoginTokenSuccess) return { done: true };
        throw new Error("Telegram did not answer the QR sign-in as expected");
      } catch (error) {
        if (telegramError(error) !== "SESSION_PASSWORD_NEEDED") throw error;
        return passwordStep();
      }
    },
    checkPassword: async (password) => {
      const request = await client.invoke(new Api.account.GetPassword());
      await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(request, password) }));
    },
    me: async (): Promise<TgUser> => {
      const me = await client.getMe();
      return me.premium ? { id: me.id.toString(), name: userName(me), bot: me.bot === true, premium: true } : { id: me.id.toString(), name: userName(me), bot: me.bot === true };
    },
    dialogs: async (limit, after) => {
      // Later pages leave out the pinned chats, which the first page has; they start after the cursor's chat and message.
      const offset = after ? { offsetDate: after.date, offsetId: after.id, offsetPeer: await client.getInputEntity(peer(after.chatId)), ignorePinned: true } : {};
      const found = await client.getDialogs({ limit, ...offset });
      const page: TgDialogPage = { dialogs: dialogsOf(found) };
      // A full page may have more after it: they start after its last chat with a message, as GramJS pages them.
      const last = found.length >= limit ? found.findLast((d) => d.message instanceof Api.Message) : undefined;
      const lastId = last?.id?.toString();
      if (last && lastId && /^-?\d{1,18}$/.test(lastId)) page.next = { chatId: lastId, id: last.message!.id, date: last.message!.date };
      return page;
    },
    history: async (chatId, beforeId, limit, topicId) => {
      // A topic's messages are the replies to its first one.
      const page = await client.getMessages(peer(chatId), { limit, offsetId: beforeId ?? 0, ...(topicId === undefined ? {} : { replyTo: topicId }) });
      return page.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, chatId)).reverse();
    },
    pinned: async (chatId, limit, topicId) => {
      if (topicId !== undefined) return searchTopic(chatId, "", new Api.InputMessagesFilterPinned(), limit, topicId);
      const found = await client.getMessages(peer(chatId), { limit, filter: new Api.InputMessagesFilterPinned() });
      return found.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, chatId));
    },
    forward: async (fromChatId, id, toChatId, topicId) => {
      const topic = topicId === undefined || topicId === GENERAL_TOPIC ? {} : { topMsgId: topicId };
      await client.invoke(new Api.messages.ForwardMessages({ fromPeer: peer(fromChatId), id: [id], randomId: [readBigIntFromBuffer(generateRandomBytes(8), true, true)], toPeer: peer(toChatId), ...topic }));
    },
    vote: async (chatId, messageId, options) => {
      await client.invoke(new Api.messages.SendVote({ peer: peer(chatId), msgId: messageId, options: options.map((option) => Buffer.from(option, "base64")) }));
    },
    search: async (chatId, query, limit, topicId) => {
      if (topicId !== undefined) return searchTopic(chatId, query, new Api.InputMessagesFilterEmpty(), limit, topicId);
      const found = await client.getMessages(peer(chatId), { limit, search: query });
      return found.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, chatId));
    },
    sendPoll: async (chatId, poll: TgNewPoll, topicId) => {
      // Each answer's option is its place, as Telegram's apps number them.
      const answers = poll.answers.map((text, i) => ({ option: Uint8Array.of(i), text }));
      const media = inputPoll(readBigIntFromBuffer(generateRandomBytes(8), true, true), poll.question, answers, poll);
      return toMessage(await client.sendFile(peer(chatId), { file: media, caption: "", ...topicReply(undefined, topicId) }), chatId);
    },
    closePoll: async (chatId, messageId, poll) => {
      const answers = poll.answers.map((a) => ({ option: Buffer.from(a.option, "base64"), text: a.text }));
      const media = inputPoll(returnBigInt(poll.id), poll.question, answers, { multiple: poll.multiple, publicVoters: poll.publicVoters === true, quiz: poll.quiz, closed: true });
      await client.invoke(new Api.messages.EditMessage({ peer: peer(chatId), id: messageId, media }));
    },
    pin: async (chatId, id, pin) => {
      await client.invoke(new Api.messages.UpdatePinnedMessage({ peer: peer(chatId), id, unpin: !pin, silent: true }));
    },
    send: async (chatId, text, replyTo, topicId) =>
      toMessage(await client.sendMessage(peer(chatId), { message: text.text, ...topicReply(replyTo, topicId), ...outgoing(text) }), chatId),
    sendFile: async (chatId, file, caption, replyTo, topicId) => {
      const name = fileName(file.filename);
      const media = uploadMedia(await uploadFile(client, file, name), file, name);
      return toMessage(await client.sendFile(peer(chatId), { file: media, caption: caption.text, ...topicReply(replyTo, topicId), ...outgoing(caption) }), chatId);
    },
    edit: async (chatId, id, text) => toMessage(await client.editMessage(peer(chatId), { message: id, text: text.text, ...outgoing(text) }), chatId),
    remove: async (chatId, ids) => void (await client.deleteMessages(peer(chatId), ids, { revoke: true })),
    markRead: async (chatId, maxId, topicId) => {
      if (topicId !== undefined) {
        // A topic is read as the discussion under its first message, mentions in it with it.
        const input = await client.getInputEntity(peer(chatId));
        await client.invoke(new Api.messages.ReadDiscussion({ peer: input, msgId: topicId, readMaxId: maxId }));
        await client.invoke(new Api.messages.ReadMentions({ peer: input, topMsgId: topicId }));
        return;
      }
      await client.markAsRead(peer(chatId), maxId);
      // Reading a group also reads the mentions in it, as Telegram's apps do once they are seen.
      if (chatId.startsWith("-")) await client.invoke(new Api.messages.ReadMentions({ peer: await client.getInputEntity(peer(chatId)) }));
    },
    folders: async () => {
      const found = await client.invoke(new Api.messages.GetDialogFilters());
      const filters = found instanceof Api.messages.DialogFilters ? found.filters : [];
      // A folder may name the user's own chat (Saved Messages) as themselves.
      const self = filters.some((f) => folderPeers(f).some((p) => p instanceof Api.InputPeerSelf)) ? (await client.getMe()).id.toString() : undefined;
      return foldersOf(filters, self);
    },
    archive: async (chatId, archived) => {
      const folderPeer = new Api.InputFolderPeer({ peer: await client.getInputEntity(peer(chatId)), folderId: archived ? ARCHIVE_FOLDER : 0 });
      await client.invoke(new Api.folders.EditPeerFolders({ folderPeers: [folderPeer] }));
    },
    notifyDefaults: async (): Promise<TgNotifyDefaults> => {
      const mutes = await Promise.all(NOTIFY_KINDS.map(async ([, Input]) => muteOf(await client.invoke(new Api.account.GetNotifySettings({ peer: new Input() }))) ?? 0));
      return { user: mutes[0]!, group: mutes[1]!, channel: mutes[2]! };
    },
    mute: async (chatId, until, topicId) => {
      const input = await client.getInputEntity(peer(chatId));
      const notifyPeer = topicId === undefined ? new Api.InputNotifyPeer({ peer: input }) : new Api.InputNotifyForumTopic({ peer: input, topMsgId: topicId });
      await client.invoke(new Api.account.UpdateNotifySettings({ peer: notifyPeer, settings: new Api.InputPeerNotifySettings({ muteUntil: until }) }));
    },
    members: async (chatId, offset, limit): Promise<TgMemberPage> => {
      if (!isChannelPeer(chatId)) {
        // A basic group's members come whole with its full info; it has a few hundred at most.
        const full = await client.invoke(new Api.messages.GetFullChat({ chatId: returnBigInt(chatId.slice(1)) }));
        const participants = full.fullChat instanceof Api.ChatFull && full.fullChat.participants instanceof Api.ChatParticipants ? full.fullChat.participants.participants : undefined;
        if (!participants) return { members: [], total: 0, hidden: true };
        const all = membersOf(participants, full.users);
        const end = offset + limit;
        return { members: all.slice(offset, end), total: all.length, ...(end < all.length ? { next: end } : {}) };
      }
      const channel = peer(chatId);
      const page = (filter: Api.TypeChannelParticipantsFilter, from: number) =>
        client.invoke(new Api.channels.GetParticipants({ channel, filter, offset: from, limit, hash: returnBigInt(0) }));
      let count: number | undefined;
      let admins: TgMember[] = [];
      if (offset === 0) {
        // Groups may hide their members from all but admins, and channels always do.
        const full = await client.invoke(new Api.channels.GetFullChannel({ channel }));
        if (!(full.fullChat instanceof Api.ChannelFull) || full.fullChat.canViewParticipants !== true) return { members: [], total: 0, hidden: true };
        count = full.fullChat.participantsCount;
        // Admins first: they need not be among the recent members.
        const found = await page(new Api.ChannelParticipantsAdmins(), 0);
        if (found instanceof Api.channels.ChannelParticipants) admins = membersOf(found.participants, found.users);
      }
      const found = await page(new Api.ChannelParticipantsRecent(), offset);
      if (!(found instanceof Api.channels.ChannelParticipants)) return { members: admins, total: total(count) };
      const listed = new Set(admins.map((m) => m.id));
      const members = [...admins, ...membersOf(found.participants, found.users).filter((m) => !listed.has(m.id))];
      const result: TgMemberPage = { members, total: total(count ?? found.count) };
      if (found.participants.length >= limit) result.next = offset + found.participants.length;
      return result;
    },
    profile: async (userId): Promise<TgProfile> => {
      const full = await client.invoke(new Api.users.GetFullUser({ id: peer(userId) }));
      const user = full.users.find((u): u is Api.User => u instanceof Api.User && u.id.toString() === userId);
      const profile: TgProfile = { id: userId, name: userName(user), bot: user?.bot === true, presence: presenceOf(user?.status) };
      if (user?.username) profile.username = `@${user.username}`;
      if (full.fullUser.about) profile.about = full.fullUser.about;
      return profile;
    },
    avatar: async (chatId) => {
      const photo = await client.downloadProfilePhoto(peer(chatId), { isBig: false });
      if (!photo || typeof photo === "string" || photo.length === 0 || photo.length > MAX_AVATAR_BYTES) return undefined;
      return `data:image/jpeg;base64,${photo.toString("base64")}`;
    },
    react: async (chatId, messageId, emoji) => {
      await client.invoke(new Api.messages.SendReaction({ peer: peer(chatId), msgId: messageId, reaction: emoji.map((emoticon) => new Api.ReactionEmoji({ emoticon })) }));
    },
    allowedReactions: async (chatId) => {
      if (!chatId.startsWith("-")) return { kind: "all" };
      const full = isChannelPeer(chatId)
        ? await client.invoke(new Api.channels.GetFullChannel({ channel: peer(chatId) }))
        : await client.invoke(new Api.messages.GetFullChat({ chatId: returnBigInt(chatId.slice(1)) }));
      return allowedOf((full.fullChat as { availableReactions?: unknown }).availableReactions);
    },
    reactionList: async () => {
      const [list, me] = await Promise.all([client.invoke(new Api.messages.GetAvailableReactions({ hash: 0 })), client.getMe()]);
      if (!(list instanceof Api.messages.AvailableReactions)) return [];
      return list.reactions.filter((r) => r.inactive !== true && (r.premium !== true || me.premium === true)).flatMap((r) => emojiOf(new Api.ReactionEmoji({ emoticon: r.reaction })) ?? []);
    },
    typing: async (chatId, active, topicId) => {
      const action = active ? new Api.SendMessageTypingAction() : new Api.SendMessageCancelAction();
      const topic = topicId !== undefined && topicId !== GENERAL_TOPIC ? { topMsgId: topicId } : {};
      await client.invoke(new Api.messages.SetTyping({ peer: peer(chatId), action, ...topic }));
    },
    topics: async (chatId, limit) => {
      const found = await client.invoke(new Api.channels.GetForumTopics({ channel: peer(chatId), offsetDate: 0, offsetId: 0, offsetTopic: 0, limit }));
      return topicsOf(found.topics, found.messages).slice(0, limit);
    },
    createTopic: async (chatId, title) => {
      const updates = await client.invoke(new Api.channels.CreateForumTopic({ channel: peer(chatId), title, randomId: readBigIntFromBuffer(generateRandomBytes(8), true, true) }));
      const list = updates instanceof Api.Updates || updates instanceof Api.UpdatesCombined ? updates.updates : [];
      for (const update of list) {
        const message = update instanceof Api.UpdateNewChannelMessage || update instanceof Api.UpdateNewMessage ? update.message : undefined;
        if (message instanceof Api.MessageService && message.action instanceof Api.MessageActionTopicCreate) return message.id;
      }
      throw new Error("Telegram did not say which topic it started");
    },
    userName: async (userId) => {
      const user = await client.getEntity(new Api.PeerUser({ userId: returnBigInt(userId) }));
      return user instanceof Api.User ? userName(user) : undefined;
    },
    download: async (chatId, messageId, thumbnail) => {
      const [message] = await client.getMessages(peer(chatId), { ids: [messageId] });
      if (!(message instanceof Api.Message) || !message.media) return undefined;
      const document = message.media instanceof Api.MessageMediaDocument && message.media.document instanceof Api.Document ? message.media.document : undefined;
      // The largest thumbnail, for media that can only be shown as one; never the file in its place.
      const thumb = thumbnail ? (document ? thumbIndex(document.thumbs) : 0) : undefined;
      if (thumbnail && thumb === undefined) return undefined;
      return bytesOf(await client.downloadMedia(message, thumb === undefined ? {} : { thumb }));
    },
    stickerSets: async () => {
      const found = await client.invoke(new Api.messages.GetAllStickers({ hash: installed?.hash ?? returnBigInt(0) }));
      // Unchanged since last asked: the sets known.
      if (found instanceof Api.messages.AllStickers) {
        const sets = stickerSetsOf(found.sets);
        for (const { set, input } of sets) stickerSetInputs.set(set.id, input);
        installed = { hash: found.hash, sets: sets.map((s) => s.set) };
      }
      return installed?.sets ?? [];
    },
    stickers: (setId) => listStickers(setId),
    stickerFile: (id, thumbnail) =>
      withSticker(id, async (document) => {
        const thumb = thumbnail ? thumbIndex(document.thumbs) : undefined;
        if (thumbnail && thumb === undefined) return undefined;
        return bytesOf(await client.downloadMedia(new Api.MessageMediaDocument({ document }), thumb === undefined ? {} : { thumb }));
      }),
    sendSticker: (chatId, id, replyTo, topicId) =>
      withSticker(id, async (document) => {
        const media = new Api.InputMediaDocument({ id: new Api.InputDocument({ id: document.id, accessHash: document.accessHash, fileReference: document.fileReference }) });
        return toMessage(await client.sendFile(peer(chatId), { file: media, caption: "", ...topicReply(replyTo, topicId) }), chatId);
      }),
    onUpdate: (cb: (update: TgUpdate) => void) => {
      client.addEventHandler((event: NewMessageEvent) => {
        const chatId = chatIdOf(event.message.peerId);
        if (chatId) cb({ type: "message", message: toMessage(event.message, chatId) });
      }, new NewMessage({}));
      client.addEventHandler((event: EditedMessageEvent) => {
        const chatId = chatIdOf(event.message.peerId);
        if (chatId) cb({ type: "edit", message: toMessage(event.message, chatId) });
      }, new EditedMessage({}));
      client.addEventHandler((event: DeletedMessageEvent) => {
        // Supergroup and channel deletions name their chat; private chats' and basic groups' name none.
        const chatId = event.peer ? chatIdOf(event.peer as Api.TypePeer) : undefined;
        if (event.peer && !chatId) return;
        cb(chatId ? { type: "delete", chatId, ids: event.deletedIds } : { type: "delete", ids: event.deletedIds });
      }, new DeletedMessage({}));
      client.addEventHandler((update: Api.TypeUpdate) => {
        const typing = typingOf(update);
        if (typing) return cb(typing);
        if (update instanceof Api.UpdateMessagePoll) {
          const results = pollResultsOf(update.results);
          if (results) cb({ type: "poll", pollId: update.pollId.toString(), results, ...(update.poll instanceof Api.Poll && update.poll.closed === true ? { closed: true } : {}) });
          return;
        }
        const pins = pinsOf(update);
        if (pins) return cb(pins);
        if (update instanceof Api.UpdateDialogFilter || update instanceof Api.UpdateDialogFilters || update instanceof Api.UpdateDialogFilterOrder) return cb({ type: "folders" });
        if (update instanceof Api.UpdateLoginToken) return cb({ type: "loginToken" });
        const archive = archiveOf(update);
        if (archive) return cb(archive);
        const notify = notifyOf(update);
        if (notify) return cb(notify);
        if (!(update instanceof Api.UpdateMessageReactions)) return;
        const chatId = chatIdOf(update.peer);
        if (!chatId || !Number.isInteger(update.msgId) || update.msgId <= 0) return;
        cb({ type: "reactions", chatId, id: update.msgId, ...reactionsOf(update.reactions) });
      }, new Raw({ types: [Api.UpdateMessageReactions, Api.UpdateUserTyping, Api.UpdateChatUserTyping, Api.UpdateChannelUserTyping, Api.UpdatePinnedMessages, Api.UpdatePinnedChannelMessages, Api.UpdateMessagePoll, Api.UpdateFolderPeers, Api.UpdateNotifySettings, Api.UpdateDialogFilter, Api.UpdateDialogFilters, Api.UpdateDialogFilterOrder, Api.UpdateLoginToken] }));
    },
    session: () => (client.session as StringSession).save(),
    logOut: async () => void (await client.invoke(new Api.auth.LogOut())),
    disconnect: async () => void (await client.destroy()),
  };
}
