// Contract between a native adapter (main process) and its chat view. The view
// only receives display data; tokens and API access stay in the main process.

export const NATIVE_IPC = {
  state: "native:state",
  action: "native:action",
} as const;

export interface NativeSidebarItem {
  id: string;
  name: string;
  kind: "category" | "text" | "dm";
  iconUrl?: string;
  unread: boolean;
  mentions: number;
  active: boolean;
}

export interface NativeAttachment {
  name: string;
  url?: string;
  image: boolean;
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
}

export type NativeViewState =
  | { screen: "login"; platform: string; identity: "email" | "username"; busy: boolean; status?: string; error?: string }
  | { screen: "mfa"; platform: string; busy: boolean; error?: string }
  | { screen: "connecting"; platform: string; status: string }
  | {
      screen: "chat";
      platform: string;
      title: string;
      me: string;
      sidebar: NativeSidebarItem[];
      channel: NativeChannelView | null;
      error?: string;
    };

export type NativeAction =
  | { type: "ready" }
  | { type: "login"; identity: string; password: string }
  | { type: "mfa"; code: string }
  | { type: "cancelMfa" }
  | { type: "select"; channelId: string }
  | { type: "send"; content: string; replyTo?: string }
  | { type: "edit"; messageId: string; content: string }
  | { type: "delete"; messageId: string }
  | { type: "react"; messageId: string; emoji: string; add: boolean }
  | { type: "loadOlder" }
  | { type: "typing" }
  | { type: "attach" }
  | { type: "removeAttachment"; index: number }
  | { type: "logout" };

export const MAX_MESSAGE_LENGTH = 4000;
/** Fluxer's default max_attachments_per_message. */
export const MAX_ATTACHMENTS = 10;

const text = (value: unknown, min: number, max: number): boolean =>
  typeof value === "string" && value.length >= min && value.length <= max;
const id = (value: unknown): boolean => typeof value === "string" && /^\d{1,20}$/.test(value);
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
    case "logout":
      return true;
    case "login":
      return text(v.identity, 1, 320) && text(v.password, 1, 1024);
    case "mfa":
      return text(v.code, 1, 32);
    case "select":
      return id(v.channelId);
    case "send":
      // Empty text is allowed: a message may be attachments only.
      return text(v.content, 0, MAX_MESSAGE_LENGTH) && (v.replyTo === undefined || id(v.replyTo));
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
