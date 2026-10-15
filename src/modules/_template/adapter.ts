// A minimal native module, to copy when adding a platform (see docs/modules.md).
// It talks to an imaginary chat service with four endpoints:
//   POST /api/login {username, password} -> {token}
//   GET  /api/me                          -> {name}
//   GET  /api/messages                    -> [{id, author, content, timestamp}]
//   POST /api/messages {content}          -> the new message
// It is type-checked and tested but never registered, so it never ships.

import type { DirectConversation, HomeBadge, PlatformAdapter } from "../../shared/adapter";
import type { NativeAction, NativeMessage, NativeViewState } from "../../shared/native";
import type { AccountStatus } from "../../shared/settings";
import type { AsyncSecretStore } from "../../engine/runtime";
import { BaseAdapter } from "../../shared/baseAdapter";

/** Which instance this is: the engine's own info (EngineInfo). */
export interface TemplateInstanceDef {
  id: string;
  name: string;
  url: string;
}

/** Everything the adapter reaches the outside through; the engine passes the bridged versions. */
export interface TemplateAdapterDeps {
  def: TemplateInstanceDef;
  /** fetch over the shell's HTTP bridge: https only, public hosts only, no cookies. */
  fetch: typeof fetch;
  /** This instance's own secrets; no other module or instance can read them. */
  secrets: AsyncSecretStore;
  /** Sends display state to the module's own view. */
  render(state: NativeViewState): void;
  /** Narrows what the engine may reach to these hosts. */
  lockHosts?(hosts: string[]): Promise<void>;
}

export interface TemplateMessage {
  id: string;
  author: string;
  content: string;
  timestamp: string;
}

/** The one conversation. Ids the view sends back must be digits (or ULIDs): see isNativeAction. */
export const CONVERSATION = "1";
const CONVERSATION_NAME = "General";
const TOKEN_KEY = "token";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the module offers the shell; its manifest must declare the same (tested). */
export const CAPABILITIES: PlatformAdapter["capabilities"] = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

export class TemplateAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  /** Must match the manifest's capabilities (the shell reads those). */
  readonly capabilities = CAPABILITIES;

  private token: string | undefined;
  private me: string | undefined;
  private messages: TemplateMessage[] = [];
  private busy = false;
  private error: string | undefined;
  /** What the connecting screen says: progress, or why a saved session cannot be resumed. */
  private status = "Connecting…";

  constructor(private readonly deps: TemplateAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
  }

  /** Locks the engine to its instance, then resumes a saved session or shows the sign-in screen. */
  async start(): Promise<void> {
    try {
      await this.deps.lockHosts?.([new URL(this.deps.def.url).hostname]);
    } catch (error) {
      // Refused, e.g. for a private address: the shell's general rules still apply.
      console.warn(`[template] host lock refused: ${messageOf(error)}`);
    }
    this.token = await this.deps.secrets.load(TOKEN_KEY);
    if (this.token) return this.openSession();
    this.render();
  }

  /** User actions from the view; the shell has already checked their shape. */
  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
      case "select":
        return this.render();
      case "login":
        return this.login(action.identity, action.password);
      case "send":
        return this.send(action.content);
      case "logout":
        return this.signOut();
      default:
        return; // Not supported by this module.
    }
  }

  accountStatus(): AccountStatus {
    if (!this.token) return { state: "signed-out" };
    return this.me ? { state: "signed-in", name: this.me } : { state: "signed-in" };
  }

  homeBadge(): HomeBadge {
    return { unread: false, mentions: 0 };
  }

  override async listDirectConversations(): Promise<DirectConversation[]> {
    if (!this.me) return [];
    const last = this.messages.at(-1);
    const conversation: DirectConversation = {
      key: CONVERSATION,
      account: this.account,
      title: CONVERSATION_NAME,
      lastActivity: last ? Date.parse(last.timestamp) || 0 : 0,
      unread: false,
      mentions: 0,
    };
    if (last) conversation.preview = last.content;
    return [conversation];
  }

  async openHome(): Promise<void> {
    this.render();
  }

  async openServer(key: string): Promise<void> {
    throw new Error(`Unknown server: ${key}`); // This module has no servers, only its home.
  }

  async openConversation(key: string): Promise<void> {
    if (key !== CONVERSATION) throw new Error(`Unknown conversation: ${key}`);
    this.render();
  }

  /** Forgets the session here. A real module also ends it on the server, so the token cannot be reused. */
  async signOut(): Promise<void> {
    await this.deps.secrets.delete(TOKEN_KEY);
    this.token = undefined;
    this.me = undefined;
    this.messages = [];
    this.directsChanged.emit([]);
    this.render();
  }

  private async login(username: string, password: string): Promise<void> {
    this.busy = true;
    this.error = undefined;
    this.render();
    try {
      const { token } = await this.api<{ token: string }>("POST", "/api/login", { username, password });
      this.token = token;
      await this.deps.secrets.save(TOKEN_KEY, token);
    } catch (error) {
      this.error = error instanceof HttpError && error.status === 401 ? "Wrong username or password." : messageOf(error);
    }
    this.busy = false;
    if (this.token) return this.openSession();
    this.render();
  }

  private async openSession(): Promise<void> {
    this.status = "Connecting…";
    this.render();
    try {
      const [me, messages] = await Promise.all([this.api<{ name: string }>("GET", "/api/me"), this.api<TemplateMessage[]>("GET", "/api/messages")]);
      this.me = me.name;
      this.messages = messages;
      this.directsChanged.emit(await this.listDirectConversations());
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        await this.signOut();
        this.error = "Your session ended; sign in again.";
      } else this.status = `Can't reach ${this.deps.def.name}: ${messageOf(error)}`;
    }
    this.render();
  }

  private async send(content: string): Promise<void> {
    if (!this.me || content.trim() === "") return;
    try {
      this.messages.push(await this.api<TemplateMessage>("POST", "/api/messages", { content }));
      this.error = undefined;
      this.directsChanged.emit(await this.listDirectConversations());
    } catch (error) {
      this.error = `Not sent: ${messageOf(error)}`;
    }
    this.render();
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.deps.fetch(new URL(path, this.deps.def.url).href, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new HttpError(response.status);
    return (await response.json()) as T;
  }

  private toNative(message: TemplateMessage): NativeMessage {
    return {
      id: message.id,
      author: message.author,
      content: message.content,
      timestamp: message.timestamp,
      edited: false,
      mine: message.author === this.me,
      canEdit: false,
      canDelete: false,
      reactions: [],
      attachments: [],
    };
  }

  /** The view shows whatever state comes last; send it after every change. */
  private render(): void {
    const platform = this.deps.def.name;
    let state: NativeViewState;
    if (!this.token) state = { screen: "login", platform, identity: "username", busy: this.busy, error: this.error };
    else if (!this.me) state = { screen: "connecting", platform, status: this.status };
    else
      state = {
        screen: "chat",
        platform,
        title: platform,
        me: this.me,
        sidebar: [{ id: CONVERSATION, name: CONVERSATION_NAME, kind: "dm", unread: false, mentions: 0, active: true }],
        channel: {
          id: CONVERSATION,
          name: CONVERSATION_NAME,
          messages: this.messages.map((m) => this.toNative(m)),
          loading: false,
          hasOlder: false,
          typing: [],
          pending: [],
          uploading: false,
        },
        voice: null,
        error: this.error,
      };
    this.deps.render(state);
  }
}
