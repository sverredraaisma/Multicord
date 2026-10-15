import { unlink } from "node:fs/promises";
import net, { type Server, type Socket } from "node:net";
import path from "node:path";
import type { Activity, ActivityUpdate } from "../shared/adapter";

/**
 * Rich Presence: a local server speaking Discord's IPC protocol (as arRPC
 * does), so games and apps that show "Playing …" in the desktop client can
 * do the same here. Activities are checked and trimmed before anything
 * passes them on; the server answers only what those apps need.
 */

const OP = { handshake: 0, frame: 1, close: 2, ping: 3, pong: 4 } as const;
/** Larger frames are not from a Rich Presence client; the connection is dropped. */
export const MAX_FRAME = 64 * 1024;
export const MAX_CLIENTS = 16;
/** Activity updates one app may send per window, as Discord's own client allows. */
export const ACTIVITY_LIMIT = 5;
export const ACTIVITY_WINDOW_MS = 20_000;
const SNOWFLAKE = /^\d{1,20}$/;

/** What Discord's READY says about the session; apps only check that it arrives. */
const READY = {
  v: 1,
  config: { cdn_host: "cdn.discordapp.com", api_endpoint: "//discord.com/api", environment: "production" },
  user: { id: "0", username: "Multicord", discriminator: "0", global_name: "Multicord", avatar: null, bot: false, flags: 0, premium_type: 0 },
};

export function encodeFrame(op: number, payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(8);
  header.writeInt32LE(op, 0);
  header.writeInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

/** Splits a byte stream into frames; throws on a frame no client would send. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): { op: number; payload: unknown }[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: { op: number; payload: unknown }[] = [];
    while (this.buffer.length >= 8) {
      const op = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > MAX_FRAME) throw new Error("Frame too large");
      if (this.buffer.length < 8 + length) break;
      const body = this.buffer.subarray(8, 8 + length).toString("utf8");
      this.buffer = this.buffer.subarray(8 + length);
      frames.push({ op, payload: JSON.parse(body) });
    }
    return frames;
  }
}

const text = (value: unknown, max = 128): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.slice(0, max) : undefined;
/** A timestamp in milliseconds; seconds (as many games send) are converted, as arRPC does. */
const time = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value < 1e12 ? value * 1000 : value);
};
/** The name of an image the app uploaded to Discord; image links would need Discord's own proxying. */
const imageKey = (value: unknown): string | undefined => {
  const key = text(value, 128);
  return key && /^[\w.-]+$/.test(key) ? key : undefined;
};

/** Activity types an app may set: playing, listening, watching, competing. */
const TYPES = new Set([0, 2, 3, 5]);

/**
 * Turns an app's SET_ACTIVITY into the fields Discord shows, dropping
 * everything else. Null clears the activity.
 */
export function sanitizeActivity(applicationId: string, raw: unknown): Activity | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, any>;
  const activity: Activity = { application_id: applicationId, type: TYPES.has(r.type) ? r.type : 0, flags: r.instance === true ? 1 : 0 };
  const details = text(r.details);
  const state = text(r.state);
  if (details) activity.details = details;
  if (state) activity.state = state;
  const start = time(r.timestamps?.start);
  const end = time(r.timestamps?.end);
  if (start || end) activity.timestamps = { ...(start && { start }), ...(end && { end }) };
  const assets: NonNullable<Activity["assets"]> = {};
  for (const key of ["large_image", "small_image"] as const) {
    const image = imageKey(r.assets?.[key]);
    if (image) assets[key] = image;
  }
  for (const key of ["large_text", "small_text"] as const) {
    const label = text(r.assets?.[key]);
    if (label) assets[key] = label;
  }
  if (Object.keys(assets).length > 0) activity.assets = assets;
  const size = r.party?.size;
  if (Array.isArray(size) && size.length === 2 && size.every((n) => Number.isInteger(n) && n >= 0 && n < 1_000_000)) {
    activity.party = { size: [size[0], size[1]] };
  }
  const buttons = Array.isArray(r.buttons) ? r.buttons.slice(0, 2) : [];
  const valid = buttons.filter((b: any) => text(b?.label, 32) && typeof b?.url === "string" && /^https?:\/\//.test(b.url) && b.url.length <= 512);
  if (valid.length > 0) {
    // Discord shows button labels; the links travel in the metadata.
    activity.buttons = valid.map((b: any) => text(b.label, 32)!);
    activity.metadata = { button_urls: valid.map((b: any) => b.url as string) };
  }
  return activity;
}

/** The app's name and image ids, from Discord's public application endpoints. */
export interface AppLookup {
  name(applicationId: string): Promise<string | undefined>;
  assets(applicationId: string): Promise<Record<string, string>>;
}

/** Apps whose name and images are remembered; the least recently used are forgotten first. */
export const LOOKUP_CACHE = 64;

/** Remembers up to `limit` lookups, dropping the least recently used. */
function cached<T>(limit: number, load: (id: string) => Promise<T>): (id: string) => Promise<T> {
  const entries = new Map<string, Promise<T>>();
  return (id) => {
    let entry = entries.get(id);
    if (entry) entries.delete(id);
    else entry = load(id);
    entries.set(id, entry);
    if (entries.size > limit) entries.delete(entries.keys().next().value!);
    return entry;
  };
}

export function discordAppLookup(fetchJson: (url: string) => Promise<unknown>): AppLookup {
  const base = "https://discord.com/api/v9/oauth2/applications";
  return {
    name: cached(LOOKUP_CACHE, (id) =>
      fetchJson(`${base}/${id}/rpc`).then(
        (app) => text((app as { name?: unknown } | undefined)?.name, 128),
        () => undefined,
      ),
    ),
    assets: cached(LOOKUP_CACHE, (id) =>
      fetchJson(`${base}/${id}/assets`).then(
        (list) => {
          const byName: Record<string, string> = {};
          if (Array.isArray(list)) for (const a of list) if (typeof a?.name === "string" && SNOWFLAKE.test(a?.id)) byName[a.name] = a.id;
          return byName;
        },
        () => ({}),
      ),
    ),
  };
}

/** Fills in the app's name and turns uploaded image names into the ids Discord shows. */
export async function resolveActivity(activity: Activity, lookup: AppLookup): Promise<Activity> {
  const [name, assets] = await Promise.all([lookup.name(activity.application_id), activity.assets ? lookup.assets(activity.application_id) : ({} as Record<string, string>)]);
  const resolved: Activity = { ...activity, name: name ?? "a game" };
  if (activity.assets) {
    const out = { ...activity.assets };
    for (const key of ["large_image", "small_image"] as const) {
      const image = out[key];
      if (!image) continue;
      if (assets[image]) out[key] = assets[image];
      else delete out[key];
    }
    resolved.assets = out;
  }
  return resolved;
}

/**
 * Where apps look for Discord: discord-ipc-0 to -9, in the OS's place for them.
 * Inside a Flatpak that place is private to the sandbox, so the sockets go in
 * the app's own runtime directory, which the host shares (as Discord's Flatpak
 * does); apps outside reach them through a link (README, "Linux packages").
 */
export function ipcPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  const runtime = env.XDG_RUNTIME_DIR && env.FLATPAK_ID ? `${env.XDG_RUNTIME_DIR}/app/${env.FLATPAK_ID}` : env.XDG_RUNTIME_DIR;
  const dir = platform === "win32" ? "\\\\?\\pipe" : (runtime ?? env.TMPDIR ?? env.TMP ?? env.TEMP ?? "/tmp");
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  return Array.from({ length: 10 }, (_, i) => join(dir, `discord-ipc-${i}`));
}

export interface RichPresenceDeps {
  createServer(onConnection: (socket: Socket) => void): Server;
  paths: string[];
  /** A path left by a process that is gone: removes it so it can be reused. Resolves false if it is in use. */
  reclaim(path: string): Promise<boolean>;
  /** The activity for one connection changed. */
  onActivity(update: ActivityUpdate): void;
  lookup: AppLookup;
}

/** The Discord IPC server; start() listens on the first free discord-ipc path. */
export class RichPresenceServer {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private next = 0;
  /** The path listened on, if any. */
  listening: string | undefined;

  constructor(private readonly deps: RichPresenceDeps) {}

  async start(): Promise<boolean> {
    if (this.server) return true;
    for (const candidate of this.deps.paths) {
      const server = this.deps.createServer((socket) => this.accept(socket));
      if ((await this.listen(server, candidate)) || ((await this.deps.reclaim(candidate)) && (await this.listen(server, candidate)))) {
        this.server = server;
        this.listening = candidate;
        return true;
      }
    }
    return false;
  }

  private listen(server: Server, at: string): Promise<boolean> {
    return new Promise((resolve) => {
      const failed = (): void => resolve(false);
      server.once("error", failed);
      server.listen(at, () => {
        server.off("error", failed);
        resolve(true);
      });
    });
  }

  stop(): void {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    this.server = undefined;
    this.listening = undefined;
  }

  private accept(socket: Socket): void {
    if (this.sockets.size >= MAX_CLIENTS) return void socket.destroy();
    this.sockets.add(socket);
    const id = `rpc-${++this.next}`;
    const reader = new FrameReader();
    let clientId: string | undefined;
    let pid: number | undefined;
    let shown = false;
    let pending = Promise.resolve();
    const recent: number[] = [];
    const send = (op: number, payload: unknown): void => void socket.write(encodeFrame(op, payload));
    const clear = (): void => {
      if (shown) this.deps.onActivity({ source: id, pid, activity: null });
      shown = false;
    };

    const handle = async (op: number, payload: any): Promise<void> => {
      if (op === OP.ping) return send(OP.pong, payload);
      if (op === OP.close) return void socket.end();
      if (op === OP.handshake) {
        const requested = String(payload?.client_id ?? "");
        if (payload?.v !== 1 || !SNOWFLAKE.test(requested)) throw new Error("Bad handshake");
        clientId = requested;
        return send(OP.frame, { cmd: "DISPATCH", evt: "READY", data: READY, nonce: null });
      }
      if (op !== OP.frame || !clientId || typeof payload?.cmd !== "string") throw new Error("Unexpected frame");
      const nonce = typeof payload.nonce === "string" ? payload.nonce.slice(0, 64) : null;
      if (payload.cmd === "SET_ACTIVITY") {
        const now = Date.now();
        while (recent.length > 0 && now - recent[0]! >= ACTIVITY_WINDOW_MS) recent.shift();
        if (recent.length >= ACTIVITY_LIMIT) {
          return send(OP.frame, { cmd: "SET_ACTIVITY", evt: "ERROR", data: { code: 1000, message: "Rate limited: try again shortly" }, nonce });
        }
        recent.push(now);
      }
      if (payload.cmd !== "SET_ACTIVITY") {
        // Subscriptions and the rest need the real client; say so politely.
        return send(OP.frame, { cmd: payload.cmd.slice(0, 64), evt: "ERROR", data: { code: 1000, message: "Not supported" }, nonce });
      }
      if (Number.isInteger(payload.args?.pid) && payload.args.pid > 0) pid = payload.args.pid;
      const activity = sanitizeActivity(clientId, payload.args?.activity);
      if (!activity) {
        clear();
        return send(OP.frame, { cmd: "SET_ACTIVITY", evt: null, data: null, nonce });
      }
      const resolved = await resolveActivity(activity, this.deps.lookup);
      if (!this.sockets.has(socket)) return;
      shown = true;
      this.deps.onActivity({ source: id, pid, activity: resolved });
      send(OP.frame, { cmd: "SET_ACTIVITY", evt: null, data: resolved, nonce });
    };

    const drop = (): void => {
      clear();
      this.sockets.delete(socket);
      socket.destroy();
    };
    socket.on("data", (chunk: Buffer) => {
      let frames: { op: number; payload: unknown }[];
      try {
        frames = reader.push(chunk);
      } catch {
        return drop();
      }
      for (const frame of frames) pending = pending.then(() => handle(frame.op, frame.payload)).catch(drop);
    });
    socket.on("close", drop);
    socket.on("error", drop);
  }
}

/** On Unix a socket file outlives a crashed owner: one nobody answers on is removed. */
export function reclaimSocket(at: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(at);
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNREFUSED") return resolve(false);
      unlink(at).then(
        () => resolve(true),
        () => resolve(false),
      );
    });
  });
}

/** The server as the app runs it: OS sockets, and Discord's public endpoints for app names. */
export function createRichPresence(
  platform: NodeJS.Platform,
  onActivity: (update: ActivityUpdate) => void,
  paths = ipcPaths(platform, process.env),
): RichPresenceServer {
  return new RichPresenceServer({
    createServer: (onConnection) => net.createServer(onConnection),
    paths,
    // Windows pipes go away with their owner.
    reclaim: (at) => (platform === "win32" ? Promise.resolve(false) : reclaimSocket(at)),
    onActivity,
    lookup: discordAppLookup(async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return response.ok ? response.json() : undefined;
    }),
  });
}
