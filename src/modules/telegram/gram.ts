// TelegramApi over GramJS. GramJS speaks MTProto over WebSockets to
// Telegram's web endpoints (*.web.telegram.org), which is all the engine's
// network policy allows.

import { Api, TelegramClient } from "telegram";
import { DeletedMessage, type DeletedMessageEvent } from "telegram/events/DeletedMessage";
import { EditedMessage, type EditedMessageEvent } from "telegram/events/EditedMessage";
import { NewMessage, type NewMessageEvent } from "telegram/events/NewMessage";
import { LogLevel } from "telegram/extensions/Logger";
import { returnBigInt } from "telegram/Helpers";
import { computeCheck } from "telegram/Password";
import { StringSession } from "telegram/sessions/StringSession";
import {
  isChannelPeer,
  telegramError,
  type TelegramApi,
  type TelegramCredentials,
  type TgDialog,
  type TgFile,
  type TgMember,
  type TgMemberPage,
  type TgMessage,
  type TgPresence,
  type TgProfile,
  type TgSignIn,
  type TgUpdate,
  type TgUser,
} from "./api";

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
export function describeChat(entity: unknown): { kind: TgDialog["kind"]; title: string; bot: boolean; readOnly: boolean; members: boolean } | undefined {
  if (entity instanceof Api.User) return { kind: "user", title: entity.self ? SAVED_MESSAGES : userName(entity), bot: entity.bot === true, readOnly: false, members: false };
  if (entity instanceof Api.Chat) {
    if (entity.deactivated || entity.migratedTo) return undefined;
    const admin = entity.creator === true || entity.adminRights !== undefined;
    const left = entity.left === true;
    return { kind: "group", title: entity.title || "Group", bot: false, readOnly: left || (!admin && banned(entity.defaultBannedRights)), members: !left };
  }
  if (entity instanceof Api.Channel) {
    const title = entity.title || "Channel";
    const admin = entity.creator === true || entity.adminRights !== undefined;
    // Only admins with the right post in a broadcast channel, and in a broadcast group (gigagroup); only admins see a channel's subscribers.
    if (!entity.megagroup) return { kind: "channel", title, bot: false, readOnly: !(entity.creator === true || entity.adminRights?.postMessages === true), members: admin };
    const silenced = entity.gigagroup === true || banned(entity.bannedRights) || banned(entity.defaultBannedRights);
    const left = entity.left === true;
    return { kind: "group", title, bot: false, readOnly: left || (!admin && silenced), members: !left };
  }
  return undefined;
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

export function toMessage(message: Api.Message, chatId: string): TgMessage {
  const out: TgMessage = {
    id: message.id,
    chatId,
    out: message.out === true,
    text: message.message ?? "",
    date: message.date,
    edited: message.editDate !== undefined && message.editHide !== true,
  };
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
  const file = mediaFile(message.media);
  if (file) out.file = file;
  const reply = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo.replyToMsgId : undefined;
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
      return { id: me.id.toString(), name: userName(me), bot: me.bot === true };
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
        const settings = d.dialog.notifySettings;
        // A Unix time; "muted for ever" is the largest 32-bit one.
        const mutedUntil = settings instanceof Api.PeerNotifySettings ? settings.muteUntil : undefined;
        if (Number.isInteger(mutedUntil) && mutedUntil! > 0) dialog.mutedUntil = mutedUntil;
        if (d.message) dialog.lastMessage = toMessage(d.message, chatId);
        return [dialog];
      });
    },
    history: async (chatId, beforeId, limit) => {
      const page = await client.getMessages(peer(chatId), { limit, offsetId: beforeId ?? 0 });
      return page.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, chatId)).reverse();
    },
    send: async (chatId, text, replyTo) => toMessage(await client.sendMessage(peer(chatId), { message: text, replyTo, parseMode: false }), chatId),
    edit: async (chatId, id, text) => toMessage(await client.editMessage(peer(chatId), { message: id, text, parseMode: false }), chatId),
    remove: async (chatId, ids) => void (await client.deleteMessages(peer(chatId), ids, { revoke: true })),
    markRead: async (chatId, maxId) => {
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
    },
    session: () => (client.session as StringSession).save(),
    logOut: async () => void (await client.invoke(new Api.auth.LogOut())),
    disconnect: async () => void (await client.destroy()),
  };
}
