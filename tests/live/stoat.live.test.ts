// Live test against a real Stoat (Revolt) instance. Skipped unless
// MULTICORD_LIVE_STOAT is set to the instance origin, e.g.
//   MULTICORD_LIVE_STOAT=https://localhost:14443 NODE_EXTRA_CA_CERTS=<caddy root.crt> npx vitest run tests/live
// The instance must allow sign-up without captcha or email verification.
// Multicord's own StoatAdapter (with Node's fetch and WebSocket) is account A;
// account B is driven with plain HTTP and WebSocket calls.
import { createHmac, randomBytes } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StoatAdapter } from "../../src/modules/stoat/adapter";
import { discoverInstance, instanceHosts, StoatRest } from "../../src/modules/stoat/rest";
import type { FileSource } from "../../src/engine/runtime";
import type { PlatformNotification, RailServer } from "../../src/shared/adapter";
import type { NativeViewState } from "../../src/shared/native";

const ORIGIN = process.env.MULTICORD_LIVE_STOAT;
const API = ORIGIN ? `${ORIGIN.replace(/\/+$/, "")}/api` : "";
const PASSWORD = "Multicord-live-Password-1";
const TIMEOUT = 20_000;

type Json = Record<string, any>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until check returns something truthy. */
async function until<T>(what: string, check: () => T | undefined | false | Promise<T | undefined | false>, timeout = TIMEOUT): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Plain API call; retries rate limits. */
async function api(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<any> {
  for (;;) {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { ...(token ? { "X-Session-Token": token } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 429) {
      await sleep(Number(response.headers.get("x-ratelimit-reset-after")) || 1000);
      continue;
    }
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  }
}

/** RFC 6238 code for a base32 secret. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A real PNG of the given size, so Autumn can read its dimensions. */
function png(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) >>> 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((width * 3 + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width * 3 + 1)] = 0;
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]),
  );
}

/** One frame of 32x24 H.264 in MP4, made with ffmpeg. */
const MP4 = Buffer.from(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAMXbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAMgAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAkF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAMgAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAYAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAADIAAAAAAABAAAAAAG5bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAACABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABZG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAASRzdGJsAAAAwHN0c2QAAAAAAAAAAQAAALBhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAGABIAAAASAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAANmF2Y0MBZAAK/+EAGWdkAAqs2Ul+XARAAAADAEAAAAMCg8SJZYABAAZo6+PLIsD9+PgAAAAAEHBhc3AAAAABAAAAAQAAABRidHJ0AAAAAAAAbigAAG4oAAAAGHN0dHMAAAAAAAAAAQAAAAEAAAgAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAABAAAAAQAAABRzdHN6AAAAAAAAAsEAAAABAAAAFHN0Y28AAAAAAAAAAQAAA0cAAABidWR0YQAAAFptZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAAC1pbHN0AAAAJal0b28AAAAdZGF0YQAAAAEAAAAATGF2ZjU4Ljc2LjEwMAAAAAhmcmVlAAACyW1kYXQAAAKfBgX//5vcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTQ4IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAxNiAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTEgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAAaZYiEAD///uZ1+BTTCBpJMvxDzj8xVtngGfE=",
  "base64",
);

const fileSource = (filename: string, contentType: string, bytes: Uint8Array): FileSource => ({
  filename,
  contentType,
  size: bytes.length,
  read: async (start, end) => bytes.slice(start, end),
});

/** Creates and onboards an account; returns a session for it. */
async function account(label: string): Promise<{ email: string; token: string; id: string; username: string; tag: string }> {
  const email = `${label}-${Date.now()}-${randomBytes(3).toString("hex")}@multicord.test`;
  await api("POST", "/auth/account/create", undefined, { email, password: PASSWORD });
  const session = await api("POST", "/auth/session/login", undefined, { email, password: PASSWORD, friendly_name: "live harness" });
  const username = `${label}${randomBytes(3).toString("hex")}`;
  await api("POST", "/onboard/complete", session.token, { username });
  const me = await api("GET", "/users/@me", session.token);
  return { email, token: session.token, id: me._id, username: me.username, tag: `${me.username}#${me.discriminator}` };
}

/** Account B's events connection: every event it receives, unpacked. */
class Listener {
  readonly events: Json[] = [];
  private socket: WebSocket | undefined;

  async connect(ws: string, token: string): Promise<void> {
    this.socket = new WebSocket(`${ws}?version=1&format=json`);
    this.socket.addEventListener("open", () => this.socket!.send(JSON.stringify({ type: "Authenticate", token })));
    this.socket.addEventListener("message", (event) => {
      const payload = JSON.parse(String(event.data));
      for (const e of payload.type === "Bulk" ? payload.v : [payload]) this.events.push(e);
    });
    await until("B's Ready", () => this.events.some((e) => e.type === "Ready"));
  }

  send(payload: Json): void {
    this.socket!.send(JSON.stringify(payload));
  }

  find(check: (e: Json) => boolean): Promise<Json> {
    return until("an event on B's connection", () => this.events.find(check));
  }

  close(): void {
    this.socket?.close();
  }
}

describe.skipIf(!ORIGIN)("Stoat module against a live instance", { timeout: 60_000 }, () => {
  let a: Awaited<ReturnType<typeof account>>;
  let b: Awaited<ReturnType<typeof account>>;
  let ws: string;
  let totpSecret: string;
  let recoveryCodes: string[];
  let view: NativeViewState | undefined;
  let rail: RailServer[] = [];
  const secrets = new Map<string, string>();
  const notices: PlatformNotification[] = [];
  const picked: FileSource[] = [];
  const locked: string[][] = [];
  const listener = new Listener();
  let adapter: StoatAdapter;
  let serverId: string;
  let channelId: string;
  let dmId: string;

  const chat = () => (view?.screen === "chat" ? view : undefined);
  const shown = () => chat()?.channel?.messages ?? [];
  const shownMessage = (id: string) => shown().find((m) => m.id === id);
  const sidebarItem = (id: string) => chat()?.sidebar.find((s) => s.id === id);

  beforeAll(async () => {
    a = await account("alice");
    b = await account("bob");
    // A gets an authenticator and recovery codes (each MFA change needs a fresh ticket).
    const ticket = async () => (await api("PUT", "/auth/mfa/ticket", a.token, { password: PASSWORD })).token as string;
    recoveryCodes = await api("PATCH", "/auth/mfa/recovery", a.token, undefined, { "X-MFA-Ticket": await ticket() });
    totpSecret = (await api("POST", "/auth/mfa/totp", a.token, undefined, { "X-MFA-Ticket": await ticket() })).secret;
    await api("PUT", "/auth/mfa/totp", a.token, { totp_code: totp(totpSecret) });
    // Friends, so they can DM each other.
    await api("POST", "/users/friend", a.token, { username: b.tag });
    await api("PUT", `/users/${a.id}/friend`, b.token);
  }, 60_000);

  afterAll(() => {
    listener.close();
    adapter?.signOut().catch(() => undefined);
  });

  it("discovers the instance's events and file server from /api/", async () => {
    const instance = await discoverInstance(ORIGIN!, fetch);
    expect(instance.api).toBe(API);
    expect(instance.ws).toMatch(/^wss:\/\//);
    expect(instance.autumn).toMatch(/^https:\/\/.+\/autumn$/);
    expect(instanceHosts(instance)).toEqual([new URL(ORIGIN!).hostname]);
    ws = instance.ws;
    await listener.connect(ws, b.token);
  });

  it("signs in with email, password and an authenticator code, then gets Ready", async () => {
    adapter = new StoatAdapter({
      def: { id: "stoat-live", name: "Stoat", url: ORIGIN! },
      fetch,
      createSocket: (url) => new WebSocket(url),
      secrets: {
        load: async (key) => secrets.get(key),
        save: async (key, value) => void secrets.set(key, value),
        delete: async (key) => void secrets.delete(key),
      },
      render: (state) => (view = state),
      files: { pick: async () => picked.splice(0) },
      lockHosts: async (hosts) => void locked.push(hosts),
      rest: { minIntervalMs: 20 },
    });
    adapter.onNotification((n) => notices.push(n));
    adapter.onServersChanged((servers) => (rail = servers));
    adapter.setVisible(true);
    await adapter.start();
    expect(view?.screen).toBe("login");
    expect(locked).toEqual([[new URL(ORIGIN!).hostname]]);

    await adapter.handleAction({ type: "login", identity: a.email, password: "wrong password" });
    expect(view).toMatchObject({ screen: "login", error: "Wrong email or password." });

    await adapter.handleAction({ type: "login", identity: a.email, password: PASSWORD });
    expect(view).toMatchObject({ screen: "mfa", codes: "totp" });
    await adapter.handleAction({ type: "mfa", code: "000000" === totp(totpSecret) ? "111111" : "000000" });
    expect(view).toMatchObject({ screen: "mfa" });
    expect(view?.screen === "mfa" && view.error).toBeTruthy();
    await adapter.handleAction({ type: "mfa", code: totp(totpSecret) });
    await until("Ready", chat);
    expect(chat()!.me).toBe(a.username);
    expect(adapter.accountStatus()).toEqual({ state: "signed-in", name: a.username });
    expect([...secrets.values()]).toHaveLength(1);
    expect(adapter.state.users.get(b.id)?.relationship).toBe("Friend");
  });

  it("signs in with a recovery code too", async () => {
    const instance = await discoverInstance(ORIGIN!, fetch);
    const rest = new StoatRest(instance, { fetch });
    const first = await rest.login(a.email, PASSWORD);
    expect(first).toMatchObject({ mfa: true, totp: true, recovery: true });
    const second = await rest.loginMfa((first as { ticket: string }).ticket, { recovery_code: recoveryCodes[0]! });
    expect(second).toMatchObject({ token: expect.any(String), userId: a.id });
    rest.token = (second as { token: string }).token;
    await rest.logout();
    await expect(api("GET", "/users/@me", rest.token)).rejects.toThrow(/401/);
  });

  it("shows a server, its channel and a DM created by others live", async () => {
    // A creates a server elsewhere (another client): ServerCreate arrives live.
    const created = await api("POST", "/servers/create", a.token, { name: "Live test server" });
    serverId = created.server._id;
    const channel = await api("POST", `/servers/${serverId}/channels`, a.token, { type: "Text", name: "second" });
    channelId = channel._id;
    await until("the server in the rail", () => rail.find((s) => s.key === serverId));
    await adapter.openServer(serverId);
    await until("the new channel in the sidebar", () => sidebarItem(channelId));
    expect(chat()!.title).toBe("Live test server");
    // B joins through an invite.
    const invite = await api("POST", `/channels/${channelId}/invites`, a.token);
    await api("POST", `/invites/${invite._id}`, b.token);
    // B opens a DM with A.
    const dm = await api("GET", `/users/${a.id}/dm`, b.token);
    dmId = dm._id;
    const hello = await api("POST", `/channels/${dmId}/messages`, b.token, { content: "Hello from B" });
    const direct = await until("the DM in the directs list", async () => (await adapter.listDirectConversations()).find((d) => d.key === dmId && d.preview));
    expect(direct).toMatchObject({ title: b.username, preview: "Hello from B", unread: true, mentions: 1 });
    // DMs notify by default.
    const notice = await until("the DM notification", () => notices.find((n) => n.target === dmId));
    expect(notice).toEqual({ title: b.username, body: "Hello from B", target: dmId, railKey: `dm:${dmId}`, inView: false });
    expect(hello._id).toBeTruthy();
  });

  it("opens the DM, loads history and acknowledges it", async () => {
    await adapter.openConversation(dmId);
    await until("DM history", () => shown().some((m) => m.content === "Hello from B"));
    expect(chat()!.channel!.name).toBe(b.username);
    // The open conversation is acked on the server.
    await until("the DM acked", async () => {
      const unreads = (await api("GET", "/sync/unreads", a.token)) as Json[];
      const dm = unreads.find((u) => u._id.channel === dmId);
      return dm?.last_id === adapter.state.channels.get(dmId)?.lastMessageId;
    });
    expect((await adapter.listDirectConversations()).find((d) => d.key === dmId)).toMatchObject({ unread: false, mentions: 0 });
  });

  it("sends, receives live, replies, edits and deletes", async () => {
    await adapter.openConversation(channelId);
    await until("channel history loaded", () => chat()?.channel?.id === channelId && !chat()!.channel!.loading);
    await adapter.handleAction({ type: "send", content: "First from A" });
    const mine = await until("A's message shown", () => shown().find((m) => m.content === "First from A"));
    expect(mine).toMatchObject({ mine: true, canEdit: true, canDelete: true, author: a.username });
    await listener.find((e) => e.type === "Message" && e._id === mine.id && e.content === "First from A");

    // B writes; A sees it live (and, being in view, acks it).
    const fromB = await api("POST", `/channels/${channelId}/messages`, b.token, { content: "Reply-worthy from B" });
    await until("B's message live", () => shownMessage(fromB._id));
    expect(shownMessage(fromB._id)).toMatchObject({ mine: false, author: b.username });

    // Reply.
    await adapter.handleAction({ type: "send", content: "Answering B", replyTo: fromB._id });
    const reply = await until("the reply", () => shown().find((m) => m.content === "Answering B"));
    expect(reply.reply).toEqual({ author: b.username, content: "Reply-worthy from B" });
    const stored = await api("GET", `/channels/${channelId}/messages/${reply.id}`, b.token);
    expect(stored.replies).toEqual([fromB._id]);

    // Edit: A's own edit, and B's edit arriving live.
    await adapter.handleAction({ type: "edit", messageId: mine.id, content: "First from A (edited)" });
    // The view is re-rendered shortly after a state change.
    await until("A's edit shown", () => shownMessage(mine.id)?.edited && shownMessage(mine.id)!.content === "First from A (edited)");
    await listener.find((e) => e.type === "MessageUpdate" && e.id === mine.id && e.data?.content === "First from A (edited)");
    await api("PATCH", `/channels/${channelId}/messages/${fromB._id}`, b.token, { content: "Edited by B" });
    await until("B's edit live", () => shownMessage(fromB._id)?.edited && shownMessage(fromB._id)!.content === "Edited by B");

    // Delete: A's own, and B's deletion live.
    await adapter.handleAction({ type: "delete", messageId: mine.id });
    await until("A's deletion shown", () => !shownMessage(mine.id));
    await listener.find((e) => e.type === "MessageDelete" && e.id === mine.id);
    await api("DELETE", `/channels/${channelId}/messages/${fromB._id}`, b.token);
    await until("B's deletion live", () => !shownMessage(fromB._id));
    expect(chat()!.error).toBeUndefined();
  });

  it("reacts and sees reactions live", async () => {
    const target = await api("POST", `/channels/${channelId}/messages`, b.token, { content: "React to me" });
    await until("message to react to", () => shownMessage(target._id));
    await adapter.handleAction({ type: "react", messageId: target._id, emoji: "👍", add: true });
    await until("A's reaction shown", () => shownMessage(target._id)!.reactions.length > 0);
    expect(shownMessage(target._id)!.reactions).toEqual([{ key: "👍", label: "👍", imageUrl: undefined, count: 1, me: true }]);
    await listener.find((e) => e.type === "MessageReact" && e.id === target._id && e.user_id === a.id && e.emoji_id === "👍");
    await api("PUT", `/channels/${channelId}/messages/${target._id}/reactions/${encodeURIComponent("👍")}`, b.token);
    await until("B's reaction live", () => shownMessage(target._id)!.reactions[0]?.count === 2);
    await adapter.handleAction({ type: "react", messageId: target._id, emoji: "👍", add: false });
    await until("A's reaction removed", () => shownMessage(target._id)!.reactions[0]?.me === false);
    expect(shownMessage(target._id)!.reactions[0]).toMatchObject({ count: 1, me: false });
    const stored = await api("GET", `/channels/${channelId}/messages/${target._id}`, b.token);
    expect(stored.reactions).toEqual({ "👍": [b.id] });
    expect(chat()!.error).toBeUndefined();
  });

  it("shows typing both ways", async () => {
    await adapter.handleAction({ type: "typing" });
    await listener.find((e) => e.type === "ChannelStartTyping" && e.id === channelId && e.user === a.id);
    listener.send({ type: "BeginTyping", channel: channelId });
    await until("B typing shown", () => chat()?.channel?.typing.includes(b.username));
    listener.send({ type: "EndTyping", channel: channelId });
    await until("B typing cleared", () => chat()?.channel?.typing.length === 0);
    // Sending ends our typing.
    await adapter.handleAction({ type: "send", content: "done typing" });
    await listener.find((e) => e.type === "ChannelStopTyping" && e.id === channelId && e.user === a.id);
  });

  it("tracks unread state and mentions in channels that are not open, and notifies on mentions only", async () => {
    await adapter.openConversation(dmId);
    const before = notices.length;
    await api("POST", `/channels/${channelId}/messages`, b.token, { content: "no mention here" });
    await until("server channel unread", () => sidebarItem(dmId) && adapter.state.isUnread(adapter.state.channels.get(channelId)!));
    await until("server unread in the rail", () => rail.find((s) => s.key === serverId && s.unread && s.mentions === 0));
    await api("POST", `/channels/${channelId}/messages`, b.token, { content: `hey <@${a.id}>` });
    const notice = await until("mention notification", () => notices.slice(before).find((n) => n.target === channelId));
    expect(notice).toEqual({ title: `${b.username} in #second (Live test server)`, body: `hey @${a.username}`, target: channelId, railKey: serverId, inView: false });
    expect(notices.slice(before).filter((n) => n.target === channelId)).toHaveLength(1);
    await until("mention count in rail", () => rail.find((s) => s.key === serverId && s.mentions === 1));

    // Opening the channel acks it on the server and clears the badges.
    await adapter.openConversation(channelId);
    await until("channel acked on the server", async () => {
      const unreads = (await api("GET", "/sync/unreads", a.token)) as Json[];
      const entry = unreads.find((u) => u._id.channel === channelId);
      return entry?.last_id === adapter.state.channels.get(channelId)?.lastMessageId && !(entry?.mentions?.length > 0);
    });
    await until("rail cleared", () => rail.find((s) => s.key === serverId && !s.unread && s.mentions === 0));

    // A muted server notifies nothing, even for mentions.
    await api("POST", `/sync/settings/set?timestamp=${Date.now()}`, a.token, { notifications: JSON.stringify({ server: { [serverId]: "none" }, channel: {} }) });
    await until("settings update applied", () => adapter.state.notifySettings.servers.get(serverId) === "none");
    const muted = notices.length;
    const quiet = await api("POST", `/channels/${channelId}/messages`, b.token, { content: `muted <@${a.id}>` });
    await until("muted message arrives", () => shownMessage(quiet._id));
    expect(notices.length).toBe(muted);
  });

  it("uploads attachments to Autumn and shows their media metadata", async () => {
    const image = png(4, 3);
    const text = new TextEncoder().encode("plain text attachment\n");
    picked.push(fileSource("pixel.png", "image/png", image), fileSource("clip.mp4", "video/mp4", new Uint8Array(MP4)), fileSource("notes.txt", "text/plain", text));
    await adapter.handleAction({ type: "attach" });
    expect(chat()!.channel!.pending).toEqual([
      { name: "pixel.png", size: image.length },
      { name: "clip.mp4", size: MP4.length },
      { name: "notes.txt", size: text.length },
    ]);
    await adapter.handleAction({ type: "send", content: "" });
    expect(chat()!.error).toBeUndefined();
    const sent = await until("message with attachments", () => shown().find((m) => m.attachments.length === 3));
    const [img, vid, txt] = sent.attachments;
    // Autumn strips metadata from images, so the stored PNG is not byte-identical.
    expect(img).toMatchObject({ name: "pixel.png", kind: "image", width: 4, height: 3, mime: "image/png" });
    expect(vid).toMatchObject({ name: "clip.mp4", kind: "video", width: 32, height: 24, mime: "video/mp4" });
    // Autumn labels text files "plain/text" itself.
    expect(txt).toMatchObject({ name: "notes.txt", kind: "file" });
    // Autumn reports the stored size, which includes its encryption overhead; Multicord shows what it reports.
    for (const attachment of sent.attachments) expect(attachment.size).toBeGreaterThan(0);
    for (const attachment of sent.attachments) expect(attachment.url).toMatch(new RegExp(`^${ORIGIN}/autumn/attachments/[A-Za-z0-9_-]+$`));
    const download = await fetch(img!.url!);
    expect(download.ok).toBe(true);
    // Autumn serves still images as a (WebP) preview at this URL, as Stoat's own client shows them.
    expect(download.headers.get("content-type")).toMatch(/^image\//);
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const textDownload = await fetch(txt!.url!);
    expect(await textDownload.text()).toBe("plain text attachment\n");
    // B sees the same files.
    const event = await listener.find((e) => e.type === "Message" && e._id === sent.id);
    expect(event.attachments.map((f: Json) => f.filename)).toEqual(["pixel.png", "clip.mp4", "notes.txt"]);
    // The DM preview of an attachment-only message names the files.
    await adapter.openConversation(dmId);
    picked.push(fileSource("dm.txt", "text/plain", text));
    await adapter.handleAction({ type: "attach" });
    await adapter.handleAction({ type: "send", content: "" });
    await until("attachment preview", async () => (await adapter.listDirectConversations()).find((d) => d.key === dmId && d.preview === "📎 dm.txt"));
  });

  it("resumes a saved session from Ready alone and pages back through history", async () => {
    // Fill the channel past one page (rate limits make this take a while).
    for (let i = 0; i < 55; i++) await api("POST", `/channels/${channelId}/messages`, b.token, { content: `page ${i}` });
    let resumedView: NativeViewState | undefined;
    const resumed = new StoatAdapter({
      def: { id: "stoat-live", name: "Stoat", url: ORIGIN! },
      fetch,
      createSocket: (url) => new WebSocket(url),
      secrets: { load: async (key) => secrets.get(key), save: async () => undefined, delete: async () => undefined },
      render: (state) => (resumedView = state),
    });
    resumed.setVisible(false);
    await resumed.start();
    await until("Ready on the resumed session", () => resumedView?.screen === "chat");
    expect(resumed.state.servers.get(serverId)?.name).toBe("Live test server");
    expect(resumed.state.channels.get(channelId)?.name).toBe("second");
    expect(resumed.state.channels.get(dmId)?.recipients.sort()).toEqual([a.id, b.id].sort());
    const direct = (await resumed.listDirectConversations()).find((d) => d.key === dmId);
    expect(direct).toMatchObject({ title: b.username, unread: false, mentions: 0 });
    await until("rail from Ready", () => resumed.railServers().find((s) => s.key === serverId));

    await resumed.openConversation(channelId);
    const messages = () => (resumedView?.screen === "chat" ? (resumedView.channel?.messages ?? []) : []);
    await until("first page", () => messages().length === 50);
    expect(messages().at(-1)!.content).toBe("page 54");
    expect(resumedView?.screen === "chat" && resumedView.channel!.hasOlder).toBe(true);
    await resumed.handleAction({ type: "loadOlder" });
    await until("older page", () => messages().length > 50);
    const ids = messages().map((m) => m.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    expect(messages().map((m) => m.content)).toContain("page 0");

    // Signing out in the other session ends this one too.
    resumedSession = resumed;
    resumedViewOf = () => resumedView;
  }, 180_000);

  let resumedSession: StoatAdapter | undefined;
  let resumedViewOf: () => NativeViewState | undefined = () => undefined;

  it("signs out, ending the session on the server", async () => {
    const token = secrets.values().next().value!;
    await adapter.handleAction({ type: "logout" });
    expect(view?.screen).toBe("login");
    expect(secrets.size).toBe(0);
    expect(adapter.accountStatus()).toEqual({ state: "signed-out" });
    expect(rail).toEqual([]);
    await expect(api("GET", "/users/@me", token)).rejects.toThrow(/401/);
    // The other adapter on the same session is told and goes back to sign-in.
    if (resumedSession) {
      await until("the resumed session ended", () => resumedViewOf()?.screen === "login");
      expect(resumedViewOf()).toMatchObject({ error: "Your session has ended. Please sign in again." });
    }
  });
});
