import type { DirectConversation, HealthCheck, HomeBadge, PlatformAdapter, RailServer } from "../shared/adapter";
import { BaseAdapter } from "../shared/baseAdapter";
import { Emitter } from "../shared/emitter";
import type { EngineCommand, EngineEvent, EngineServer } from "../shared/engine";
import type { AccountStatus, ServiceSettingStatus, ServiceSettingValues } from "../shared/settings";

/**
 * The shell's stand-in for a module running in an engine: it keeps
 * the last validated rail data, account and badge the engine reported, and
 * turns shell calls into engine commands.
 */
export class EngineAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  private status: AccountStatus = { state: "unknown" };
  private badge: HomeBadge = { unread: false, mentions: 0 };
  private directs: DirectConversation[] = [];
  private engine: EngineHealth = { state: "starting", responsive: true, restarts: 0 };
  private readonly accountChanged = new Emitter<AccountStatus>();
  private settings: ServiceSettingStatus = {};
  /** The module's own checks of its service, as the engine last reported them. */
  private serviceChecks: HealthCheck[] = [];
  private readonly settingsChanged = new Emitter<void>();
  readonly openHome?: () => Promise<void>;

  constructor(
    id: string,
    instance: string,
    readonly capabilities: PlatformAdapter["capabilities"],
    private readonly send: (command: EngineCommand) => void,
    home: boolean,
  ) {
    super(id, { platform: id, instance, accountId: "default" });
    if (home) this.openHome = async () => this.send({ type: "openHome" });
  }

  /** Applies an event the host has already validated. */
  handle(event: EngineEvent): void {
    switch (event.type) {
      case "servers":
        return this.setServers(event.servers.map((s) => this.toRail(s)));
      case "directs":
        this.directs = event.directs.map((d) => ({ ...d, account: this.account }));
        return this.directsChanged.emit(this.directs);
      case "notification":
        return this.notifications.emit(event.notification);
      case "call":
        return this.incomingCalls.emit(event.call);
      case "account":
        this.status = event.account;
        return this.accountChanged.emit(event.account);
      case "homeBadge":
        this.badge = event.badge;
        // The rail reads the home badge when servers change.
        return this.serversChanged.emit(this.servers);
      case "settingsStatus":
        this.settings = event.status;
        return this.settingsChanged.emit();
      case "health":
        // Only the fields Settings shows.
        this.serviceChecks = event.checks.map(({ name, ok, detail }) => (detail === undefined ? { name, ok } : { name, ok, detail }));
        return;
    }
  }

  applySettings(values: ServiceSettingValues): void {
    this.send({ type: "settings", values });
  }

  async runSettingAction(key: string): Promise<void> {
    this.send({ type: "settingAction", key });
  }

  settingsStatus(): ServiceSettingStatus {
    return this.settings;
  }

  onSettingsStatusChanged(cb: () => void): () => void {
    return this.settingsChanged.on(cb);
  }

  /** The host's view of the engine process, for Settings > Diagnostics. */
  setEngineHealth(health: EngineHealth): void {
    this.engine = health;
  }

  health(): HealthCheck[] {
    const { state, responsive, restarts, lastExit } = this.engine;
    const exits = restarts > 0 ? ` It has restarted ${restarts} time${restarts === 1 ? "" : "s"}${lastExit ? ` (last: ${lastExit})` : ""}.` : "";
    const running: HealthCheck = { name: "Engine running", ok: state === "running" };
    if (state === "stopped") running.detail = `Stopped after crashing repeatedly; restart Multicord to try again. Nothing from this service arrives.${exits}`;
    else if (state === "starting") running.detail = `Starting; messages and notifications arrive once it runs.${exits}`;
    else if (exits) running.detail = exits.trim();
    if (state !== "running") return [running];
    const busy = { name: "Engine responsive", ok: false, detail: "The engine is busy; messages and notifications are delayed." };
    // The module's checks of its service come after; they are only as fresh as a running engine keeps them.
    return [running, responsive ? { name: busy.name, ok: true } : busy, ...this.serviceChecks];
  }

  private toRail(server: EngineServer): RailServer {
    const { children, ...rest } = server;
    const rail: RailServer = { ...rest, account: this.account };
    if (children) rail.children = children.map((c) => this.toRail(c));
    return rail;
  }

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs;
  }

  homeBadge(): HomeBadge {
    return this.badge;
  }

  accountStatus(): AccountStatus {
    return this.status;
  }

  onAccountChanged(cb: (account: AccountStatus) => void): () => void {
    return this.accountChanged.on(cb);
  }

  async signOut(): Promise<void> {
    this.send({ type: "signOut" });
  }

  async openServer(key: string): Promise<void> {
    this.send({ type: "openServer", key });
  }

  async openConversation(key: string): Promise<void> {
    this.send({ type: "openConversation", key });
  }

  async toggleGroup(key: string): Promise<void> {
    this.send({ type: "toggleGroup", key });
  }

  setVisible(visible: boolean): void {
    this.send({ type: "visible", visible });
  }
}

/** How an engine process is doing. */
export interface EngineHealth {
  state: "starting" | "running" | "stopped";
  responsive: boolean;
  restarts: number;
  /** Why the engine last stopped, as the host reported it. */
  lastExit?: string;
}

/** Crashes in a row before an engine is left stopped. */
export const MAX_CRASHES = 5;
/** An engine that ran this long before crashing starts a fresh count. */
export const STABLE_MS = 60_000;
/** Restart delay after the nth crash in a row: 2 s, doubling, at most 30 s. */
export function restartDelay(crashes: number): number {
  return Math.min(2000 * 2 ** (crashes - 1), 30_000);
}

/** The session partition an instance's engine runs in. */
export function engineStoragePartition(instanceId: string, persistent: boolean): string {
  // "_" cannot occur in service ids, so these never meet a service's own persist:<id> or another engine's.
  return persistent ? `persist:engine_${instanceId}` : `engine_${instanceId}`;
}

/**
 * Crashes in a row once the engine's process is gone: a fresh count when it
 * had been running for a while, else one more than before.
 */
export function crashesInARow(previous: number, health: EngineHealth, ranForMs: number): number {
  return ranForMs >= STABLE_MS && health.state === "running" ? 1 : previous + 1;
}

/** Engine ids: what the build bundles as dist/engines/<id>.js and the host serves on an origin of its own. */
export function isEngineId(id: string): boolean {
  return /^[a-z0-9-]{1,32}$/.test(id);
}
