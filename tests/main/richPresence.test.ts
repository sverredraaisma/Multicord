import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRichPresence,
  discordAppLookup,
  encodeFrame,
  FrameReader,
  ipcPaths,
  MAX_CLIENTS,
  reclaimSocket,
  resolveActivity,
  RichPresenceServer,
  sanitizeActivity,
  type AppLookup,
} from "../../src/main/richPresence";
import type { ActivityUpdate } from "../../src/shared/adapter";

const socketPath = (): string =>
  process.platform === "win32" ? `\\\\.\\pipe\\multicord-test-${randomUUID()}` : path.join(os.tmpdir(), `mc-${randomUUID().slice(0, 8)}.sock`);

const lookup: AppLookup = {
  name: async (id) => (id === "42" ? "Space Game" : undefined),
  assets: async () => ({ logo: "1111" }),
};

const servers: RichPresenceServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function serve(paths = [socketPath()], extra: { reclaim?: (at: string) => Promise<boolean> } = {}) {
  const updates: ActivityUpdate[] = [];
  const server = new RichPresenceServer({
    createServer: (onConnection) => net.createServer(onConnection),
    paths,
    reclaim: extra.reclaim ?? (async () => false),
    onActivity: (update) => updates.push(update),
    lookup,
  });
  servers.push(server);
  return { server, updates, paths };
}

/** A client like a game's Discord RPC library. */
async function client(at: string) {
  const socket = net.connect(at);
  await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
  const reader = new FrameReader();
  const inbox: { op: number; payload: any }[] = [];
  const waiters: (() => void)[] = [];
  socket.on("data", (chunk: Buffer) => {
    inbox.push(...reader.push(chunk));
    for (const wake of waiters.splice(0)) wake();
  });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return {
    socket,
    closed,
    send: (op: number, payload: unknown) => socket.write(encodeFrame(op, payload)),
    async next(): Promise<{ op: number; payload: any }> {
      while (inbox.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      return inbox.shift()!;
    },
  };
}

const until = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("Rich Presence server", () => {
  it("greets apps, shows their activity and clears it when they leave", async () => {
    const { server, updates, paths } = serve();
    expect(await server.start()).toBe(true);
    expect(await server.start()).toBe(true); // already listening
    expect(server.listening).toBe(paths[0]);

    const app = await client(paths[0]!);
    app.send(0, { v: 1, client_id: "42" });
    const ready = await app.next();
    expect(ready).toMatchObject({ op: 1, payload: { cmd: "DISPATCH", evt: "READY" } });

    app.send(1, {
      cmd: "SET_ACTIVITY",
      args: { pid: 1234, activity: { details: "Level 3", assets: { large_image: "logo", large_text: "Logo", small_image: "missing" } } },
      nonce: "n1",
    });
    const reply = await app.next();
    expect(reply.payload).toMatchObject({ cmd: "SET_ACTIVITY", evt: null, nonce: "n1", data: { name: "Space Game", details: "Level 3" } });
    expect(updates[0]).toEqual({
      source: "rpc-1",
      pid: 1234,
      activity: { application_id: "42", name: "Space Game", type: 0, flags: 0, details: "Level 3", assets: { large_image: "1111", large_text: "Logo" } },
    });

    app.send(3, { ping: 1 });
    expect(await app.next()).toEqual({ op: 4, payload: { ping: 1 } });
    app.send(1, { cmd: "SUBSCRIBE", args: {}, evt: "ACTIVITY_JOIN", nonce: "n2" });
    expect((await app.next()).payload).toEqual({ cmd: "SUBSCRIBE", evt: "ERROR", data: { code: 1000, message: "Not supported" }, nonce: "n2" });

    app.send(1, { cmd: "SET_ACTIVITY", args: { pid: 1234, activity: null }, nonce: 5 });
    expect((await app.next()).payload).toEqual({ cmd: "SET_ACTIVITY", evt: null, data: null, nonce: null });
    expect(updates[1]).toEqual({ source: "rpc-1", pid: 1234, activity: null });

    app.send(1, { cmd: "SET_ACTIVITY", args: { activity: { state: "Again" } } });
    await app.next();
    app.send(2, {});
    await app.closed;
    await until(() => updates.length === 4);
    expect(updates[3]).toEqual({ source: "rpc-1", pid: 1234, activity: null });
  });

  it("drops apps that break the protocol", async () => {
    const { server, updates, paths } = serve();
    await server.start();
    for (const misbehave of [
      (c: Awaited<ReturnType<typeof client>>) => c.send(1, { cmd: "SET_ACTIVITY", args: {} }), // before the handshake
      (c: Awaited<ReturnType<typeof client>>) => c.send(0, { v: 2, client_id: "42" }),
      (c: Awaited<ReturnType<typeof client>>) => c.send(0, { v: 1, client_id: "not-a-snowflake" }),
      (c: Awaited<ReturnType<typeof client>>) => c.socket.write(Buffer.from([1, 0, 0, 0, 255, 255, 255, 127])), // huge frame
      (c: Awaited<ReturnType<typeof client>>) => c.socket.write(Buffer.concat([Buffer.from([1, 0, 0, 0, 1, 0, 0, 0]), Buffer.from("{")])), // bad JSON
    ]) {
      const app = await client(paths[0]!);
      misbehave(app);
      await app.closed;
    }
    // Shown activity is cleared when an app is dropped.
    const app = await client(paths[0]!);
    app.send(0, { v: 1, client_id: "7" });
    await app.next();
    app.send(1, { cmd: "SET_ACTIVITY", args: { activity: { details: "x" } } });
    await app.next();
    app.send(1, { nope: true });
    await app.closed;
    await until(() => updates.length === 2);
    expect(updates.map((u) => u.activity?.name ?? null)).toEqual(["a game", null]);
  });

  it("limits connections, stops cleanly, and tries the next path when one is taken", async () => {
    const taken = socketPath();
    const blocker = net.createServer().listen(taken);
    await new Promise((resolve) => blocker.once("listening", resolve));
    const free = socketPath();
    const reclaim = vi.fn(async () => false);
    const { server } = serve([taken, free], { reclaim });
    expect(await server.start()).toBe(true);
    expect(server.listening).toBe(free);
    expect(reclaim).toHaveBeenCalledWith(taken);

    const apps = [];
    for (let i = 0; i <= MAX_CLIENTS; i++) apps.push(await client(free));
    await apps.at(-1)!.closed; // one too many
    server.stop();
    await Promise.all(apps.map((a) => a.closed));
    expect(server.listening).toBeUndefined();

    const none = serve([taken]);
    expect(await none.server.start()).toBe(false);
    blocker.close();
  });

  it("listens on a path it reclaimed", async () => {
    const at = socketPath();
    const blocker = net.createServer().listen(at);
    await new Promise((resolve) => blocker.once("listening", resolve));
    const { server } = serve([at], {
      reclaim: async () => {
        await new Promise((resolve) => blocker.close(resolve));
        return true;
      },
    });
    expect(await server.start()).toBe(true);
  });
});

describe("frames and activities", () => {
  it("reads frames split across chunks", () => {
    const reader = new FrameReader();
    const bytes = Buffer.concat([encodeFrame(1, { a: 1 }), encodeFrame(3, "x")]);
    expect(reader.push(bytes.subarray(0, 5))).toEqual([]);
    expect(reader.push(bytes.subarray(5, 20))).toEqual([{ op: 1, payload: { a: 1 } }]);
    expect(reader.push(bytes.subarray(20))).toEqual([{ op: 3, payload: "x" }]);
    const negative = Buffer.alloc(8);
    negative.writeInt32LE(-1, 4);
    expect(() => new FrameReader().push(negative)).toThrow("Frame too large");
  });

  it("keeps only the fields Discord shows, trimmed", () => {
    expect(sanitizeActivity("1", null)).toBeNull();
    expect(sanitizeActivity("1", "x")).toBeNull();
    const long = "y".repeat(300);
    expect(
      sanitizeActivity("1", {
        type: 2,
        instance: true,
        details: long,
        state: "  ",
        timestamps: { start: 1700000000000.7, end: -5 },
        assets: { large_image: "bad key!", small_image: "ok_key", small_text: "Small" },
        party: { id: "p", size: [1, 4] },
        buttons: [
          { label: "Join", url: "https://game.example/join" },
          { label: "Bad", url: "javascript:alert(1)" },
          { label: "Third", url: "https://x.example" },
        ],
        secrets: { join: "s" },
        name: "Spoofed",
      }),
    ).toEqual({
      application_id: "1",
      type: 2,
      flags: 1,
      details: "y".repeat(128),
      timestamps: { start: 1700000000000 },
      assets: { small_image: "ok_key", small_text: "Small" },
      party: { size: [1, 4] },
      buttons: ["Join"],
      metadata: { button_urls: ["https://game.example/join"] },
    });
    expect(sanitizeActivity("1", { type: 1, timestamps: { end: 5 }, party: { size: [1] }, buttons: "no" })).toEqual({
      application_id: "1",
      type: 0,
      flags: 0,
      timestamps: { end: 5 },
    });
  });

  it("looks apps up once and copes with failures", async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith("/1/rpc")) return { name: "Game" };
      if (url.endsWith("/1/assets")) return [{ id: "55", name: "logo" }, { id: "x", name: "bad" }, null];
      if (url.endsWith("/2/assets")) return { not: "a list" };
      throw new Error("offline");
    });
    const apps = discordAppLookup(fetchJson);
    expect(await apps.name("1")).toBe("Game");
    expect(await apps.name("1")).toBe("Game");
    expect(await apps.assets("1")).toEqual({ logo: "55" });
    expect(await apps.assets("1")).toEqual({ logo: "55" });
    expect(await apps.name("2")).toBeUndefined();
    expect(await apps.assets("2")).toEqual({});
    expect(await apps.assets("3")).toEqual({});
    expect(fetchJson).toHaveBeenCalledTimes(5);
    expect(await resolveActivity({ application_id: "9", type: 0, flags: 0 }, lookup)).toEqual({ application_id: "9", type: 0, flags: 0, name: "a game" });
  });

  it("knows where apps look for Discord", () => {
    expect(ipcPaths("win32", {})[0]).toBe("\\\\?\\pipe\\discord-ipc-0");
    expect(ipcPaths("linux", { XDG_RUNTIME_DIR: "/run/user/1000" })[9]).toBe("/run/user/1000/discord-ipc-9");
    expect(ipcPaths("darwin", { TMPDIR: "/var/folders/x" })[0]).toBe("/var/folders/x/discord-ipc-0");
    expect(ipcPaths("linux", {})[0]).toBe("/tmp/discord-ipc-0");
  });

  it("reclaims only paths nobody answers on", async () => {
    const live = socketPath();
    const server = net.createServer().listen(live);
    await new Promise((resolve) => server.once("listening", resolve));
    expect(await reclaimSocket(live)).toBe(false);
    server.close();
    expect(await reclaimSocket(socketPath())).toBe(false); // nothing there at all
    expect(createRichPresence("win32", () => {})).toBeInstanceOf(RichPresenceServer);
  });

  it("runs on OS sockets and asks Discord for the app's name", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/rpc") ? new Response(JSON.stringify({ name: "Real Game" })) : new Response("", { status: 404 })));
    vi.stubGlobal("fetch", fetchMock);
    const taken = socketPath();
    const blocker = net.createServer().listen(taken);
    await new Promise((resolve) => blocker.once("listening", resolve));
    const free = socketPath();
    const updates: ActivityUpdate[] = [];
    for (const platform of ["win32", "linux"] as const) {
      const server = createRichPresence(platform, (u) => updates.push(u), [taken, free]);
      servers.push(server);
      expect(await server.start()).toBe(true);
      expect(server.listening).toBe(free);
      const app = await client(free);
      app.send(0, { v: 1, client_id: "77" });
      await app.next();
      app.send(1, { cmd: "SET_ACTIVITY", args: { activity: { details: "d", assets: { large_image: "logo" } } } });
      expect((await app.next()).payload.data.name).toBe("Real Game");
      server.stop();
      await app.closed;
    }
    expect(fetchMock).toHaveBeenCalledWith("https://discord.com/api/v9/oauth2/applications/77/rpc", expect.anything());
    blocker.close();
    vi.unstubAllGlobals();
  });
});

describe("Rich Presence limits", () => {
  it("forgets the least recently used apps", async () => {
    const { LOOKUP_CACHE } = await import("../../src/main/richPresence");
    const fetchJson = vi.fn(async () => ({ name: "Game" }));
    const apps = discordAppLookup(fetchJson);
    await apps.name("1");
    for (let i = 2; i <= LOOKUP_CACHE; i++) await apps.name(String(i));
    await apps.name("1"); // used again: stays
    await apps.name("overflow");
    expect(fetchJson).toHaveBeenCalledTimes(LOOKUP_CACHE + 1);
    await apps.name("1");
    expect(fetchJson).toHaveBeenCalledTimes(LOOKUP_CACHE + 1);
    await apps.name("2"); // the oldest was dropped
    expect(fetchJson).toHaveBeenCalledTimes(LOOKUP_CACHE + 2);
  });

  it("lets an app change its activity only so often", async () => {
    const { ACTIVITY_LIMIT } = await import("../../src/main/richPresence");
    const { server, updates, paths } = serve();
    await server.start();
    const app = await client(paths[0]!);
    app.send(0, { v: 1, client_id: "42" });
    await app.next();
    for (let i = 0; i < ACTIVITY_LIMIT; i++) {
      app.send(1, { cmd: "SET_ACTIVITY", args: { activity: { details: `n${i}` } }, nonce: `a${i}` });
      expect((await app.next()).payload.evt).toBeNull();
    }
    app.send(1, { cmd: "SET_ACTIVITY", args: { activity: { details: "spam" } }, nonce: "late" });
    expect((await app.next()).payload).toEqual({ cmd: "SET_ACTIVITY", evt: "ERROR", data: { code: 1000, message: "Rate limited: try again shortly" }, nonce: "late" });
    expect(updates).toHaveLength(ACTIVITY_LIMIT);
    // Once the window has passed, updates go through again.
    const later = Date.now() + 21_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    app.send(1, { cmd: "SET_ACTIVITY", args: { activity: { details: "later" } }, nonce: "ok" });
    expect((await app.next()).payload.evt).toBeNull();
    clock.mockRestore();
    app.socket.destroy();
  });
});
