// The slice of Telegram the adapter uses, in plain data. gram.ts implements
// it with GramJS; tests use a fake. Ids are decimal strings, dates Unix
// seconds, as Telegram sends them.

export interface TgUser {
  id: string;
  name: string;
  bot: boolean;
}

export interface TgMessage {
  id: number;
  chatId: string;
  out: boolean;
  /** The sender's display name, where known. */
  sender?: string;
  text: string;
  /** A short label for media, e.g. "📷 Photo". */
  media?: string;
  date: number;
  edited: boolean;
  replyToId?: number;
}

/** A one-to-one chat with a user or bot; groups and channels are not listed. */
export interface TgDialog {
  chatId: string;
  title: string;
  bot: boolean;
  unreadCount: number;
  lastMessage?: TgMessage;
  date: number;
}

export type TgSignIn = { done: true } | { password: true; hint?: string } | { signUp: true };

export type TgUpdate =
  | { type: "message"; message: TgMessage }
  | { type: "edit"; message: TgMessage }
  | { type: "delete"; chatId?: string; ids: number[] };

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
  send(chatId: string, text: string, replyTo?: number): Promise<TgMessage>;
  edit(chatId: string, id: number, text: string): Promise<TgMessage>;
  remove(chatId: string, ids: number[]): Promise<void>;
  markRead(chatId: string, maxId: number): Promise<void>;
  /** A small profile picture as a data: URL. */
  avatar(chatId: string): Promise<string | undefined>;
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

/** Telegram's error names, e.g. PHONE_CODE_INVALID, from a GramJS RPCError. */
export function telegramError(error: unknown): string {
  if (typeof error === "object" && error !== null && "errorMessage" in error && typeof error.errorMessage === "string") return error.errorMessage;
  return error instanceof Error ? error.message : String(error);
}
