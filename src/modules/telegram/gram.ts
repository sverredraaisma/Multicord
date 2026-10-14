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
import { telegramError, type TelegramApi, type TelegramCredentials, type TgDialog, type TgMessage, type TgSignIn, type TgUpdate, type TgUser } from "./api";

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

/** The other user of a one-to-one chat, or undefined for groups and channels. */
export function userChatId(peer: Api.TypePeer | undefined): string | undefined {
  return peer instanceof Api.PeerUser ? peer.userId.toString() : undefined;
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
  const media = mediaLabel(message.media);
  if (media) out.media = media;
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
      return dialogs
        .filter((d) => d.isUser && d.id !== undefined)
        .map((d): TgDialog => {
          const chatId = d.id!.toString();
          const user = d.entity instanceof Api.User ? d.entity : undefined;
          const dialog: TgDialog = { chatId, title: d.title || userName(user), bot: user?.bot === true, unreadCount: d.unreadCount, date: d.date };
          if (d.message) dialog.lastMessage = toMessage(d.message, chatId);
          return dialog;
        });
    },
    history: async (chatId, beforeId, limit) => {
      const page = await client.getMessages(peer(chatId), { limit, offsetId: beforeId ?? 0 });
      return page.filter((m) => m instanceof Api.Message).map((m) => toMessage(m, chatId)).reverse();
    },
    send: async (chatId, text, replyTo) => toMessage(await client.sendMessage(peer(chatId), { message: text, replyTo, parseMode: false }), chatId),
    edit: async (chatId, id, text) => toMessage(await client.editMessage(peer(chatId), { message: id, text, parseMode: false }), chatId),
    remove: async (chatId, ids) => void (await client.deleteMessages(peer(chatId), ids, { revoke: true })),
    markRead: async (chatId, maxId) => void (await client.markAsRead(peer(chatId), maxId)),
    avatar: async (chatId) => {
      const photo = await client.downloadProfilePhoto(peer(chatId), { isBig: false });
      if (!photo || typeof photo === "string" || photo.length === 0 || photo.length > MAX_AVATAR_BYTES) return undefined;
      return `data:image/jpeg;base64,${photo.toString("base64")}`;
    },
    onUpdate: (cb: (update: TgUpdate) => void) => {
      client.addEventHandler((event: NewMessageEvent) => {
        const chatId = userChatId(event.message.peerId);
        if (chatId) cb({ type: "message", message: toMessage(event.message, chatId) });
      }, new NewMessage({}));
      client.addEventHandler((event: EditedMessageEvent) => {
        const chatId = userChatId(event.message.peerId);
        if (chatId) cb({ type: "edit", message: toMessage(event.message, chatId) });
      }, new EditedMessage({}));
      client.addEventHandler((event: DeletedMessageEvent) => {
        // Channel deletions name their channel; ours (private chats) name none.
        if (!event.peer) cb({ type: "delete", ids: event.deletedIds });
      }, new DeletedMessage({}));
    },
    session: () => (client.session as StringSession).save(),
    logOut: async () => void (await client.invoke(new Api.auth.LogOut())),
    disconnect: async () => void (await client.destroy()),
  };
}
