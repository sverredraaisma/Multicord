// Adapter contract from the integration study. Every platform plugs into the
// shell through PlatformAdapter, either as an embedded web view or natively.

export type PlatformId = "discord" | "matrix" | "fluxer" | "stoat" | (string & {});

export interface AccountRef {
  platform: PlatformId;
  instance: string;
  accountId: string;
}

export interface RailServer {
  key: string; // stable across sessions
  account: AccountRef;
  name: string;
  iconUrl?: string;
  unread: boolean;
  mentions: number;
  /**
   * A group of servers: a Discord folder, later a Matrix space. Groups carry
   * their children and the platform's own expanded state.
   */
  kind?: "server" | "group";
  children?: RailServer[];
  expanded?: boolean;
  color?: string;
  previewIconUrls?: string[];
}

export interface DirectConversation {
  key: string;
  account: AccountRef;
  title: string;
  avatarUrl?: string;
  lastActivity: number; // epoch ms, for the unified Messages tab
  preview?: string; // optional; some modes cannot provide it
  unread: boolean;
  mentions: number;
}

export interface IncomingCall {
  conversationKey: string;
  from: string;
  video: boolean;
}

export interface PlatformNotification {
  title: string;
  body: string;
  target: string;
}

/** Badge for a platform's "home" (DM) entry in the rail. */
export interface HomeBadge {
  unread: boolean;
  mentions: number;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly mode: "webview" | "native";
  readonly capabilities: {
    directMessages: boolean;
    messagePreviews: boolean;
    voice: boolean;
    screenShare: boolean;
  };

  connect(account: AccountRef): Promise<void>;
  disconnect(): Promise<void>;

  listServers(): Promise<RailServer[]>;
  listDirectConversations(): Promise<DirectConversation[]>;

  // Push updates; the shell re-renders the rail and Messages tab.
  onServersChanged(cb: (servers: RailServer[]) => void): () => void;
  onDirectsChanged(cb: (dms: DirectConversation[]) => void): () => void;
  onNotification(cb: (n: PlatformNotification) => void): () => void;
  onIncomingCall(cb: (call: IncomingCall) => void): () => void;

  // Navigation: web-view adapters route inside their SPA; native ones open our view.
  openServer(key: string): Promise<void>;
  openConversation(key: string): Promise<void>;

  // Expands or collapses a group returned by listServers().
  toggleGroup?(key: string): Promise<void>;

  // Whether the platform's view is in front, e.g. to mark the open channel read.
  setVisible?(visible: boolean): void;

  // Shell addition to the draft: the DM home entry (Discord's /channels/@me).
  homeBadge?(): HomeBadge;
  openHome?(): Promise<void>;
}
