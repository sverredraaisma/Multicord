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
import {
  GENERAL_TOPIC,
  isChannelPeer,
  reactionEmoji,
  telegramError,
  type TelegramApi,
  type TelegramCredentials,
  type TgAllowedReactions,
  type TgDialog,
  type TgEntity,
  type TgFile,
  type TgMember,
  type TgMemberPage,
  type TgMessage,
  type TgPresence,
  type TgProfile,
  type TgReaction,
  type TgSignIn,
  type TgText,
  type TgTopic,
  type TgUpdate,
  type TgUser,
} from "./api";
import { MAX_ENTITIES } from "./format";

/** Largest profile picture passed on (as a data: URL); bigger ones show initials. */
const MAX_AVATAR_BYTES = 140_000;

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
    if (mime === "application/x-tgsticker") return { kind: "sticker", name, mime: "image/webp", thumbnailOnly: true, ...dims };
    return { kind: "sticker", name, mime, size, ...dims };
  }
  const audio = find(Api.DocumentAttributeAudio);
  if (audio) return { kind: "audio", name: audio.voice ? "Voice message" : [audio.performer, audio.title].filter(Boolean).join(" – ") || filename || "Audio", mime, size };
  if (find(Api.DocumentAttributeAnimated)) return { kind: "video", name: "GIF", mime, size, loop: true, ...dims };
  if (video) return { kind: "video", name: filename ?? (video.roundMessage ? "Video message" : "Video"), mime, size, ...dims };
  if (mime?.startsWith("image/")) return { kind: "image", name: filename ?? "Image", mime, size, ...dims };
  return { kind: "file", name: filename ?? "File", mime, size };
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

/** Whether the user may write in a group but not send media there: its rules or their own restrictions, which admins are free of. */
export function mediaBanned(entity: unknown): boolean {
  if (!(entity instanceof Api.Chat || entity instanceof Api.Channel) || entity.creator === true || entity.adminRights !== undefined) return false;
  const rights = [entity.defaultBannedRights, entity instanceof Api.Channel ? entity.bannedRights : undefined];
  return rights.some((r) => r?.sendMedia === true);
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
    const type = ENTITY_TYPES.find(([cls]) => entity instanceof cls)?.[1];
    if (!type) continue;
    const { offset, length, url, language } = entity as { offset?: unknown; length?: unknown; url?: unknown; language?: unknown };
    if (!Number.isInteger(offset) || !Number.isInteger(length)) continue;
    const [start, size] = [offset as number, length as number];
    if (start < 0 || size <= 0 || start + size > text.length) continue;
    const found: TgEntity = { type, offset: start, length: size };
    if (type === "textUrl" && typeof url === "string") found.url = url.slice(0, 2048);
    if (type === "pre" && typeof language === "string" && language !== "") found.language = language.slice(0, 64);
    out.push(found);
  }
  return out;
}

/** Formatting for Telegram, from what the view's markdown said. */
export function apiEntities(entities: readonly TgEntity[]): Api.TypeMessageEntity[] {
  return entities.map(({ type, offset, length, url, language }) => {
    switch (type) {
      case "textUrl":
        return new Api.MessageEntityTextUrl({ offset, length, url: url ?? "" });
      case "pre":
        return new Api.MessageEntityPre({ offset, length, language: language ?? "" });
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

export function toMessage(message: Api.Message, chatId: string): TgMessage {
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
    const sender = entityName(message.sender) ?? (message.postAuthor || undefined);
    if (sender) out.sender = sender;
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
  const header = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;
  // In a forum topic every message points at the topic's first; only one that also names a top id answers another.
  const topic = header?.forumTopic === true ? (header.replyToTopId ?? header.replyToMsgId) : undefined;
  if (topic && topic !== GENERAL_TOPIC) out.topicId = topic;
  const reply = header?.forumTopic === true && header.replyToTopId === undefined ? undefined : header?.replyToMsgId;
  if (reply) out.replyToId = reply;
  return out;
}

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
        const password = await client.invoke(new Api.account.GetPassword());
        return password.hint ? { password: true, hint: password.hint } : { password: true };
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
    dialogs: async (limit) => {
      const dialogs = await client.getDialogs({ limit });
      return dialogs.flatMap((d): TgDialog[] => {
        const chat = describeChat(d.entity);
        const chatId = d.id?.toString() ?? "";
        // Ids beyond 18 digits are not Telegram's; the view could not tell them apart.
        if (!chat || !/^-?\d{1,18}$/.test(chatId)) return [];
        const dialog: TgDialog = { chatId, kind: chat.kind, title: chat.title, bot: chat.bot, unreadCount: tally(d.unreadCount), unreadMentions: tally(d.unreadMentionsCount), date: d.date };
        if (chat.readOnly) dialog.readOnly = true;
        if (chat.members) dialog.members = true;
        if (chat.left) dialog.left = true;
        if (mediaBanned(d.entity)) dialog.noMedia = true;
        const forum = forumOf(d.entity);
        if (forum.forum) dialog.forum = true;
        if (forum.noTopics) dialog.noTopics = true;
        const settings = d.dialog.notifySettings;
        // A Unix time; "muted for ever" is the largest 32-bit one.
        const mutedUntil = settings instanceof Api.PeerNotifySettings ? settings.muteUntil : undefined;
        if (Number.isInteger(mutedUntil) && mutedUntil! > 0) dialog.mutedUntil = mutedUntil;
        if (d.message) dialog.lastMessage = toMessage(d.message, chatId);
        return [dialog];
      });
    },
    history: async (chatId, beforeId, limit, topicId) => {
      // A topic's messages are the replies to its first one.
      const page = await client.getMessages(peer(chatId), { limit, offsetId: beforeId ?? 0, ...(topicId === undefined ? {} : { replyTo: topicId }) });
      return page.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, chatId)).reverse();
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
      // The largest thumbnail, for media that can only be shown as one.
      const thumb = thumbnail ? Math.max(0, (document?.thumbs?.length ?? 1) - 1) : undefined;
      const data = await client.downloadMedia(message, thumb === undefined ? {} : { thumb });
      return data instanceof Uint8Array && data.length > 0 ? new Uint8Array(data) : undefined;
    },
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
        if (!(update instanceof Api.UpdateMessageReactions)) return;
        const chatId = chatIdOf(update.peer);
        if (!chatId || !Number.isInteger(update.msgId) || update.msgId <= 0) return;
        cb({ type: "reactions", chatId, id: update.msgId, ...reactionsOf(update.reactions) });
      }, new Raw({ types: [Api.UpdateMessageReactions, Api.UpdateUserTyping, Api.UpdateChatUserTyping, Api.UpdateChannelUserTyping] }));
    },
    session: () => (client.session as StringSession).save(),
    logOut: async () => void (await client.invoke(new Api.auth.LogOut())),
    disconnect: async () => void (await client.destroy()),
  };
}
