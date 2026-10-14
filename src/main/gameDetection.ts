import type { ActivityUpdate } from "../shared/adapter";

/** A game Discord knows how to detect. */
export interface DetectableGame {
  id: string;
  name: string;
}

/** The connection id detected games are shown under; Rich Presence apps start at rpc-1. */
export const DETECTED_SOURCE = "rpc-0";
/** Linux's `ps -o comm=` cuts process names to this many characters. */
const LINUX_COMM = 15;
const SNOWFLAKE = /^\d{1,20}$/;

const basename = (name: string): string => name.trim().split(/[\\/]/).pop()!.toLowerCase();

/**
 * Indexes Discord's detectable-games list by executable name for this OS.
 * Process lists give names, not paths, so a name more than one game uses
 * (launcher.exe, game.exe) would guess; such names are left out.
 */
export function indexDetectable(raw: unknown, platform: NodeJS.Platform): Map<string, DetectableGame> {
  const index = new Map<string, DetectableGame>();
  const ambiguous = new Set<string>();
  if (!Array.isArray(raw)) return index;
  for (const app of raw) {
    if (typeof app?.id !== "string" || !SNOWFLAKE.test(app.id) || typeof app.name !== "string" || !Array.isArray(app.executables)) continue;
    const game = { id: app.id, name: app.name.slice(0, 128) };
    for (const exe of app.executables) {
      if (exe?.os !== platform || exe.is_launcher === true || typeof exe.name !== "string") continue;
      let key = basename(exe.name);
      if (platform === "linux") key = key.slice(0, LINUX_COMM);
      if (!key || ambiguous.has(key)) continue;
      const known = index.get(key);
      if (known && known.id !== game.id) {
        index.delete(key);
        ambiguous.add(key);
      } else {
        index.set(key, game);
      }
    }
  }
  return index;
}

export interface GameDetectorDeps {
  platform: NodeJS.Platform;
  /** Running process names. */
  list(): Promise<string[]>;
  /** Discord's detectable-games list (applications/detectable). */
  fetchDetectable(): Promise<unknown>;
  onActivity(update: ActivityUpdate): void;
  /** Whether a Rich Presence app is already showing this game, which then speaks for itself. */
  covered?(applicationId: string): boolean;
  now?(): number;
  intervalMs?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** After a failed download, wait this long before trying again. */
const RETRY_MS = 10 * 60 * 1000;

/**
 * Game detection for Rich Presence, as Discord's desktop app does it: looks
 * at the running processes now and then, and shows the first known game as
 * "Playing …" from when it was first seen until it closes.
 */
export class GameDetector {
  private games: Map<string, DetectableGame> | undefined;
  private loadedAt = 0;
  private failedAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private current: { game: DetectableGame; since: number } | undefined;

  constructor(private readonly deps: GameDetectorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(2_000);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.show(undefined);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.scan().finally(() => this.schedule(this.deps.intervalMs ?? 15_000)), delay);
    this.timer.unref?.();
  }

  private async load(): Promise<Map<string, DetectableGame> | undefined> {
    const now = this.now();
    const stale = !this.games || now - this.loadedAt >= DAY_MS;
    if (stale && now - this.failedAt >= RETRY_MS) {
      try {
        this.games = indexDetectable(await this.deps.fetchDetectable(), this.deps.platform);
        this.loadedAt = now;
      } catch {
        this.failedAt = now;
      }
    }
    return this.games;
  }

  /** One look at the running processes; exposed for tests. */
  async scan(): Promise<void> {
    const games = await this.load();
    if (!games || !this.running) return;
    const running = new Set((await this.deps.list()).map((name) => (this.deps.platform === "linux" ? basename(name).slice(0, LINUX_COMM) : basename(name))));
    if (!this.running) return;
    const found: DetectableGame[] = [];
    for (const name of running) {
      const game = games.get(name);
      if (game && !this.deps.covered?.(game.id)) found.push(game);
    }
    // The game already shown stays while it runs; otherwise the first one found.
    const keep = this.current && found.some((g) => g.id === this.current!.game.id);
    this.show(keep ? this.current!.game : found[0]);
  }

  private show(game: DetectableGame | undefined): void {
    if (game?.id === this.current?.game.id) return;
    if (!game) {
      this.current = undefined;
      return this.deps.onActivity({ source: DETECTED_SOURCE, activity: null });
    }
    this.current = { game, since: this.now() };
    this.deps.onActivity({
      source: DETECTED_SOURCE,
      activity: { application_id: game.id, name: game.name, type: 0, flags: 0, timestamps: { start: this.current.since } },
    });
  }
}

/** The detector as the app runs it: the OS process list and Discord's public list of games. */
export function createGameDetector(
  platform: NodeJS.Platform,
  list: () => Promise<string[]>,
  onActivity: (update: ActivityUpdate) => void,
  covered: (applicationId: string) => boolean,
): GameDetector {
  return new GameDetector({
    platform,
    list,
    onActivity,
    covered,
    fetchDetectable: async () => {
      const response = await fetch("https://discord.com/api/v9/applications/detectable", { signal: AbortSignal.timeout(60_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    },
  });
}
