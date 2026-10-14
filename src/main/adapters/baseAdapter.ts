import type {
  AccountRef,
  DirectConversation,
  IncomingCall,
  PlatformAdapter,
  PlatformId,
  PlatformNotification,
  RailServer,
} from "../../shared/adapter";
import { Emitter } from "./emitter";

/** Shared plumbing for adapters: event emitters, account and server bookkeeping. */
export abstract class BaseAdapter implements PlatformAdapter {
  readonly mode: PlatformAdapter["mode"] = "webview";
  abstract readonly capabilities: PlatformAdapter["capabilities"];

  protected servers: RailServer[] = [];
  protected readonly serversChanged = new Emitter<RailServer[]>();
  protected readonly directsChanged = new Emitter<DirectConversation[]>();
  protected readonly notifications = new Emitter<PlatformNotification>();
  protected readonly incomingCalls = new Emitter<IncomingCall>();

  constructor(
    readonly platform: PlatformId,
    protected account: AccountRef,
  ) {}

  // Web-view adapters leave login and the connection to the web client.
  async connect(account: AccountRef): Promise<void> {
    this.account = account;
  }

  async disconnect(): Promise<void> {}

  async listServers(): Promise<RailServer[]> {
    return this.servers;
  }

  async listDirectConversations(): Promise<DirectConversation[]> {
    return [];
  }

  onServersChanged(cb: (servers: RailServer[]) => void): () => void {
    return this.serversChanged.on(cb);
  }

  onDirectsChanged(cb: (dms: DirectConversation[]) => void): () => void {
    return this.directsChanged.on(cb);
  }

  onNotification(cb: (n: PlatformNotification) => void): () => void {
    return this.notifications.on(cb);
  }

  onIncomingCall(cb: (call: IncomingCall) => void): () => void {
    return this.incomingCalls.on(cb);
  }

  protected setServers(servers: RailServer[]): void {
    this.servers = servers;
    this.serversChanged.emit(servers);
  }

  abstract openServer(key: string): Promise<void>;
  abstract openConversation(key: string): Promise<void>;
}
