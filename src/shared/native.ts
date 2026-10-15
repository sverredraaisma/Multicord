// Contract between a native adapter (main process) and its chat view. The view
// only receives display data; tokens and API access stay in the main process.

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
}

export interface NativeVoiceMember {
  name: string;
  avatarUrl?: string;
  muted: boolean;
  video: boolean;
}

export interface NativeCustomEmoji {
  id: string;
  name: string;
  animated: boolean;
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
  reply?: { author: string; content: string } | null;
  reactions: NativeReaction[];
  attachments: NativeAttachment[];
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
}

export const CHANNEL_CAN_FLAGS = ["reply", "react", "attach", "typing"] as const satisfies readonly (keyof NativeChannelCan)[];

/** A conversation's flags as the view trusts them: each on only when it is exactly `true`. */
export function channelCan(value: unknown): NativeChannelCan {
  const flags = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(CHANNEL_CAN_FLAGS.map((flag) => [flag, flags[flag] === true])) as unknown as NativeChannelCan;
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
      /** The open server's custom emoji, for the picker. */
      customEmoji?: NativeCustomEmoji[];
      error?: string;
    };

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
  | { type: "send"; content: string; replyTo?: string }
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
      return text(v.content, 0, MAX_MESSAGE_LENGTH) && (v.replyTo === undefined || id(v.replyTo));
    case "joinVoice":
      return id(v.channelId);
    case "voiceState":
      return [v.mute, v.deaf, v.video, v.stream].every((flag) => typeof flag === "boolean");
    case "voiceError":
      return text(v.message, 1, 500);
    case "voiceNotice":
      return text(v.message, 1, 500) && (v.off === undefined || v.off === "video" || v.off === "stream");
    case "loadMedia":
      return typeof v.key === "string" && /^[A-Za-z0-9:._-]{1,200}$/.test(v.key);
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
