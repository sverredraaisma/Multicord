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

export interface NativeMessage {
  id: string;
  author: string;
  avatarUrl?: string;
  content: string;
  timestamp: string;
  edited: boolean;
  mine: boolean;
  attachments: NativeAttachment[];
}

export interface NativeChannelView {
  id: string;
  name: string;
  messages: NativeMessage[];
  loading: boolean;
  hasOlder: boolean;
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
  | { type: "send"; content: string }
  | { type: "loadOlder" }
  | { type: "logout" };

export const MAX_MESSAGE_LENGTH = 4000;

const text = (value: unknown, min: number, max: number): boolean =>
  typeof value === "string" && value.length >= min && value.length <= max;

export function isNativeAction(value: unknown): value is NativeAction {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case "ready":
    case "cancelMfa":
    case "loadOlder":
    case "logout":
      return true;
    case "login":
      return text(v.identity, 1, 320) && text(v.password, 1, 1024);
    case "mfa":
      return text(v.code, 1, 32);
    case "select":
      return typeof v.channelId === "string" && /^\d{1,20}$/.test(v.channelId);
    case "send":
      return text(v.content, 1, MAX_MESSAGE_LENGTH) && (v.content as string).trim() !== "";
    default:
      return false;
  }
}
