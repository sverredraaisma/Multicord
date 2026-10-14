import type { AsyncSecretStore } from "../../engine/runtime";
import type { DirectConversation, HomeBadge, PlatformAdapter } from "../../shared/adapter";
import { BaseAdapter } from "../../shared/baseAdapter";
import { MAX_DIRECTS } from "../../shared/engine";
import { escapeMarkdown } from "../../shared/markdown";
import type { NativeAction, NativeMessage, NativePrompt, NativeSidebarItem, NativeViewState } from "../../shared/native";
import type { AccountStatus } from "../../shared/settings";
import { MatrixError, matrixErrcode, type MatrixApi, type MxContent, type MxEvent, type MxMember, type MxPage, type MxRoomState, type MxSession, type MxSync } from "./api";
import { cleanName, userId } from "./events";

export const PAGE_SIZE = 50;
/** Profile pictures fetched per refresh; the rest show initials. */
export const AVATAR_LIMIT = 40;
/** How long the server may hold a /sync open; the HTTP bridge sets no timeout of its own. */
export const SYNC_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;
const SESSION_KEY = "session";
const EDITABLE = new Set(["m.text", "m.notice", "m.emote"]);
export const ENCRYPTED_TEXT = "🔒 Encrypted message — open this chat in Element to read it";
export const ENCRYPTED_NOTICE =
  "🔒 This room is end-to-end encrypted, which Multicord does not support. Messages here can only be read and sent in Element or another Matrix app with encryption; Multicord never sends unencrypted messages into it.";
const CONNECTION_LOST = "Connection lost. Reconnecting…";

export interface MatrixInstanceDef {
  id: string;
  name: string;
  /** The homeserver, or a server name whose .well-known points at it. */
  url: string;
}

export interface MatrixAdapterDeps {
  def: MatrixInstanceDef;
  secrets: AsyncSecretStore;
  render(state: NativeViewState): void;
  api: MatrixApi;
  /** Waits before retrying a failed sync; tests pass their own. */
  delay?: (ms: number) => Promise<void>;
}

type Step = "connecting" | "login" | "token" | "retry" | "chat";

type Shown = Extract<MxEvent, { kind: "message" | "encrypted" }>;
type Message = Extract<MxEvent, { kind: "message" }>;

interface Room {
  id: string;
  /** The view's id for the room: actions carry digits only. */
  local: string;
  name: string;
  alias: string;
  avatar: string;
  encrypted: boolean;
  members: Map<string, MxMember>;
  heroes: string[];
  /** Messages and encrypted events, oldest first; edits are kept apart. */
  events: Shown[];
  /** The latest edit of each message, by "<sender>|<event id>": only the sender's own edits count. */
  edits: Map<string, Message>;
  prevBatch?: string;
  notifications: number;
  highlights: number;
  lastActivity: number;
  /** The last event we sent a read receipt for. */
  lastRead?: string;
}

/** What the user sees for Matrix error codes. */
const FRIENDLY: Record<string, string> = {
  M_FORBIDDEN: "That username or password is not right.",
  M_USER_DEACTIVATED: "This account has been deactivated.",
  M_LIMIT_EXCEEDED: "Too many attempts. Wait a while and try again.",
  M_UNKNOWN_TOKEN: "That access token is not valid (anymore).",
  M_MISSING_TOKEN: "That access token is not valid (anymore).",
};

function friendly(error: unknown): string {
  const code = matrixErrcode(error);
  if (code && FRIENDLY[code]) return FRIENDLY[code];
  return error instanceof Error ? error.message : String(error);
}

/** The server no longer accepts the token (M_UNKNOWN_TOKEN and friends come with 401). */
const ended = (error: unknown): boolean => error instanceof MatrixError && error.status === 401;

/** A message's text with its media label after it, so media-only messages still say something. */
export function messageText(content: MxContent): string {
  const text = content.msgtype === "m.emote" ? `* ${content.text}` : content.text;
  return [text, content.media].filter(Boolean).join("\n");
}

/** A stored session, if it is one we wrote. */
export function parseSession(text: string | undefined): MxSession | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as Partial<MxSession>;
    const { baseUrl, accessToken, deviceId, ownDevice } = value;
    if (
      typeof baseUrl === "string" &&
      baseUrl.startsWith("https://") &&
      typeof accessToken === "string" &&
      accessToken !== "" &&
      userId(value.userId) &&
      typeof deviceId === "string" &&
      typeof ownDevice === "boolean"
    ) {
      return { baseUrl, accessToken, userId: value.userId!, deviceId, ownDevice };
    }
  } catch {
    // Not stored by us; sign in again.
  }
  return undefined;
}

const defaultDelay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Native Matrix adapter: signs in with a password or an access token, lists
 * direct chats (m.direct) as direct messages in the rail and the unified
 * Messages page, and every other joined room in its view's sidebar. Runs in
 * its sandboxed engine over plain Client-Server API calls. End-to-end
 * encryption is not supported: encrypted messages show as such, and nothing
 * is ever sent into an encrypted room.
 */
export class MatrixAdapter extends BaseAdapter implements PlatformAdapter {
  override readonly mode = "native" as const;
  readonly capabilities = { directMessages: true, messagePreviews: true, voice: false, screenShare: false };

  private step: Step = "connecting";
  private status: string | undefined;
  private busy = false;
  private error: string | undefined;
  private baseUrl: string | undefined;
  private passwordLogin = false;
  /** What "Try again" on the retry screen does. */
  private retry: (() => Promise<void>) | undefined;
  private session: MxSession | undefined;
  private hasSession = false;
  private readonly rooms = new Map<string, Room>();
  /** DM room id -> the other user, from m.direct. */
  private dmUsers = new Map<string, string>();
  /** Matrix ids <-> the view's numeric ids, for rooms and events alike. */
  private readonly locals = new Map<string, string>();
  private readonly byLocal = new Map<string, string>();
  private nextLocal = 1;
  /** Thumbnails by mxc URI; failed ones are not asked for again. */
  private readonly avatars = new Map<string, string>();
  private readonly avatarsTried = new Set<string>();
  private loadingAvatars = false;
  private readonly loading = new Set<string>();
  private selected: string | undefined;
  private visible = false;
  /** Counts sign-ins and sign-outs, so a sync loop or task started for one session stops for the next. */
  private generation = 0;
  private readonly delay: (ms: number) => Promise<void>;

  constructor(private readonly deps: MatrixAdapterDeps) {
    super(deps.def.id, { platform: deps.def.id, instance: new URL(deps.def.url).host, accountId: "default" });
    this.delay = deps.delay ?? defaultDelay;
  }

  /** Resumes a saved session, else starts signing in. */
  async start(): Promise<void> {
    const saved = parseSession(await this.deps.secrets.load(SESSION_KEY));
    if (!saved) return this.showSignIn();
    this.hasSession = true;
    await this.resume(saved);
  }

  private host(): string {
    return new URL(this.deps.def.url).host;
  }

  private async resume(saved: MxSession): Promise<void> {
    this.connecting(`Connecting to ${this.host()}…`);
    try {
      await this.deps.api.whoami(saved.baseUrl, saved.accessToken);
    } catch (error) {
      if (ended(error)) {
        await this.forgetSession();
        return this.showSignIn("Your Matrix session has ended. Sign in again.");
      }
      return this.showRetry(`Could not reach ${this.host()}: ${friendly(error)}`, () => this.resume(saved));
    }
    this.signedIn(saved);
  }

  /** Finds the homeserver and its sign-in options, then asks for a password or token. */
  private async showSignIn(error?: string): Promise<void> {
    this.connecting(`Looking up ${this.host()}…`);
    try {
      this.baseUrl = await this.deps.api.discover(this.deps.def.url);
      this.passwordLogin = (await this.deps.api.loginFlows(this.baseUrl)).password;
    } catch (failure) {
      return this.showRetry(`Could not reach a Matrix homeserver at ${this.host()}: ${friendly(failure)}`, () => this.showSignIn(error));
    }
    this.step = this.passwordLogin ? "login" : "token";
    this.status = undefined;
    this.error = error;
    this.render();
  }

  private showRetry(error: string, retry: () => Promise<void>): void {
    this.step = "retry";
    this.status = undefined;
    this.error = error;
    this.retry = retry;
    this.render();
  }

  private connecting(status: string): void {
    this.step = "connecting";
    this.status = status;
    this.render();
  }

  private signedIn(session: MxSession): void {
    this.session = session;
    this.hasSession = true;
    this.error = undefined;
    this.connecting("Loading your chats…");
    void this.syncLoop(++this.generation, session);
  }

  private async forgetSession(): Promise<void> {
    this.hasSession = false;
    this.session = undefined;
    await this.deps.secrets.delete(SESSION_KEY);
  }

  // --- Shell interface ---------------------------------------------------------

  override async listDirectConversations(): Promise<DirectConversation[]> {
    return this.directs();
  }

  /** Rooms other than DMs: DM bubbles carry their own badges. */
  homeBadge(): HomeBadge {
    let unread = false;
    let mentions = 0;
    for (const room of this.rooms.values()) {
      if (this.dmUsers.has(room.id)) continue;
      unread ||= room.notifications > 0;
      mentions += room.highlights;
    }
    return { unread, mentions };
  }

  async openHome(): Promise<void> {
    this.render();
  }

  async openServer(key: string): Promise<void> {
    throw new Error(`Matrix has no server ${key}`);
  }

  async openConversation(key: string): Promise<void> {
    const room = this.rooms.get(key);
    if (room) await this.select(room.local);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    const room = this.selectedRoom();
    if (visible && room) this.markRead(room);
  }

  accountStatus(): AccountStatus {
    if (this.session) return { state: "signed-in", name: this.session.userId };
    return this.hasSession ? { state: "signed-in" } : { state: "signed-out" };
  }

  async signOut(): Promise<void> {
    const session = this.session;
    this.generation++;
    // A token copied from another app is that app's device: ending it would sign that app out too.
    if (session?.ownDevice) await this.deps.api.logout(session).catch(() => undefined);
    await this.forgetSession();
    this.rooms.clear();
    this.dmUsers.clear();
    this.locals.clear();
    this.byLocal.clear();
    // Another account may sign in next; its chats must not show these pictures.
    this.avatars.clear();
    this.avatarsTried.clear();
    this.selected = undefined;
    this.directsChanged.emit([]);
    await this.showSignIn();
  }

  /** The server no longer accepts the token, e.g. after signing out elsewhere. */
  private async sessionEnded(): Promise<void> {
    this.generation++;
    await this.forgetSession();
    this.rooms.clear();
    this.dmUsers.clear();
    this.selected = undefined;
    this.directsChanged.emit([]);
    await this.showSignIn("Your Matrix session has ended. Sign in again.");
  }

  async handleAction(action: NativeAction): Promise<void> {
    switch (action.type) {
      case "ready":
        return this.render();
      case "prompt":
        return this.answer(action.id, action.values);
      case "cancelPrompt":
        // The secondary button switches between password and access token.
        if (action.id === "login" || (action.id === "token" && this.passwordLogin)) {
          this.step = action.id === "login" ? "token" : "login";
          this.error = undefined;
          this.render();
        }
        return;
      case "select":
        return this.select(action.channelId);
      case "send":
        return this.send(action.content, action.replyTo);
      case "edit":
        return this.edit(action.messageId, action.content);
      case "delete":
        return this.remove(action.messageId);
      case "loadOlder":
        return this.loadOlder();
      case "logout":
        return this.signOut();
      default:
        // Reactions, uploads, typing, forums and voice are not offered for Matrix.
        return;
    }
  }

  // --- Signing in ---------------------------------------------------------------

  private async answer(step: string, values: Record<string, string>): Promise<void> {
    if (step !== this.step || this.busy) return;
    if (step === "retry") return this.retry!();
    this.busy = true;
    this.error = undefined;
    this.render();
    let session: MxSession | undefined;
    try {
      const baseUrl = this.baseUrl!;
      if (step === "login") {
        const user = (values.user ?? "").trim();
        if (user === "" || user.length > 255) throw new Error("Enter your username, e.g. @alice:matrix.org or alice.");
        session = await this.deps.api.login(baseUrl, user, values.password ?? "");
      } else {
        const token = (values.token ?? "").trim();
        if (!/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Error("That does not look like an access token.");
        const who = await this.deps.api.whoami(baseUrl, token);
        session = { baseUrl, accessToken: token, userId: who.userId, deviceId: who.deviceId ?? "", ownDevice: false };
      }
      await this.deps.secrets.save(SESSION_KEY, JSON.stringify(session));
    } catch (error) {
      this.error = friendly(error);
      session = undefined;
    }
    this.busy = false;
    if (session) return this.signedIn(session);
    this.render();
  }

  private prompt(): NativePrompt {
    const host = this.host();
    switch (this.step) {
      case "retry":
        return { id: "retry", title: "Matrix is not reachable", fields: [], submit: "Try again" };
      case "token": {
        const prompt: NativePrompt = {
          id: "token",
          title: `Sign in to ${host} with an access token`,
          description:
            `${this.passwordLogin ? "" : `${host} does not offer password sign-in to other apps; homeservers that sign in through their own account page (such as matrix.org) work this way. `}` +
            "Copy an access token from Element: Settings > Help & About > Access token. Multicord then shares Element's session: signing out here only forgets the token, and signing out in Element ends it here too. The token is stored encrypted on this device.",
          fields: [{ name: "token", label: "Access token", type: "password", autocomplete: "off" }],
          submit: "Sign in",
        };
        if (this.passwordLogin) prompt.cancel = "Use a password instead";
        return prompt;
      }
      default:
        return {
          id: "login",
          title: `Sign in to ${host}`,
          description: "Your password goes only to your homeserver, and your session is stored encrypted on this device. Encrypted rooms cannot be read in Multicord.",
          fields: [
            { name: "user", label: "Username", type: "text", autocomplete: "username", placeholder: "@alice:matrix.org" },
            { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
          ],
          submit: "Sign in",
          cancel: "Use an access token instead",
        };
    }
  }

  // --- Syncing --------------------------------------------------------------------

  private async syncLoop(generation: number, session: MxSession): Promise<void> {
    let since: string | undefined;
    let wait = RETRY_MIN_MS;
    while (generation === this.generation) {
      try {
        // The first sync returns at once; later ones wait for news.
        const sync = await this.deps.api.sync(session, since, since === undefined ? 0 : SYNC_TIMEOUT_MS);
        if (generation !== this.generation) return;
        this.applySync(sync, since === undefined);
        since = sync.nextBatch;
        wait = RETRY_MIN_MS;
      } catch (error) {
        if (generation !== this.generation) return;
        if (ended(error)) return this.sessionEnded();
        if (this.step === "chat") this.error = CONNECTION_LOST;
        else this.status = `Could not reach ${this.host()}: ${friendly(error)}. Retrying…`;
        this.render();
        await this.delay(wait);
        wait = Math.min(wait * 2, RETRY_MAX_MS);
      }
    }
  }

  private local(id: string): string {
    let local = this.locals.get(id);
    if (!local) {
      local = String(this.nextLocal++);
      this.locals.set(id, local);
      this.byLocal.set(local, id);
    }
    return local;
  }

  private room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, local: this.local(id), name: "", alias: "", avatar: "", encrypted: false, members: new Map(), heroes: [], events: [], edits: new Map(), notifications: 0, highlights: 0, lastActivity: 0 };
      this.rooms.set(id, room);
    }
    return room;
  }

  private applyState(room: Room, state: MxRoomState): void {
    if (state.name !== undefined) room.name = state.name;
    if (state.alias !== undefined) room.alias = state.alias;
    if (state.avatar !== undefined) room.avatar = state.avatar;
    if (state.encrypted) room.encrypted = true;
    for (const [user, member] of Object.entries(state.members)) room.members.set(user, member);
  }

  private applySync(sync: MxSync, initial: boolean): void {
    if (sync.directs) {
      this.dmUsers = new Map(Object.entries(sync.directs).flatMap(([user, ids]) => ids.map((id): [string, string] => [id, user])));
    }
    for (const id of sync.left) {
      this.rooms.delete(id);
      if (this.selected === id) this.selected = undefined;
    }
    for (const update of sync.joined) {
      const fresh = !this.rooms.has(update.roomId);
      const room = this.room(update.roomId);
      this.applyState(room, update.state);
      if (update.heroes) room.heroes = update.heroes;
      if (update.unread) {
        room.notifications = update.unread.notifications;
        room.highlights = update.unread.highlights;
      }
      if (fresh || (update.limited && !initial)) {
        // A gap: what we had no longer joins up with the new events.
        if (!fresh) room.events = [];
        room.prevBatch = update.prevBatch;
      }
      for (const event of update.timeline) this.addEvent(room, event, !initial);
    }
    this.step = "chat";
    this.status = undefined;
    if (this.error === CONNECTION_LOST) this.error = undefined;
    const open = this.selectedRoom();
    if (open && this.visible) this.markRead(open);
    this.publish();
    void this.loadAvatars();
  }

  private removeEvent(room: Room, id: string): void {
    room.events = room.events.filter((e) => e.id !== id);
    for (const [key, edit] of room.edits) if (edit.id === id || key.endsWith(`|${id}`)) room.edits.delete(key);
  }

  /** Adds a timeline event; `live` ones (from a sync after the first) may notify. */
  private addEvent(room: Room, event: MxEvent, live: boolean): void {
    switch (event.kind) {
      case "redacted":
        return this.removeEvent(room, event.id);
      case "redaction":
        return this.removeEvent(room, event.redacts);
    }
    if (event.kind === "message" && event.replaces) {
      const key = `${event.sender}|${event.replaces}`;
      const known = room.edits.get(key);
      if (!known || known.ts <= event.ts) room.edits.set(key, event);
      return;
    }
    if (room.events.some((e) => e.id === event.id)) return;
    room.events.push(event);
    room.lastActivity = Math.max(room.lastActivity, event.ts);
    if (live && event.sender !== this.session!.userId) this.notify(room, event);
  }

  private mentionsMe(room: Room, event: Shown): boolean {
    if (event.kind !== "message") return false;
    const me = this.session!.userId;
    if (event.mentions) return event.mentions.includes(me);
    // Older clients do not say whom they mention: look for our name in the text.
    const text = event.content.text.toLowerCase();
    const name = room.members.get(me)?.name?.toLowerCase();
    return text.includes(me.toLowerCase()) || (name !== undefined && text.includes(name));
  }

  private notify(room: Room, event: Shown): void {
    const dm = this.dmUsers.has(room.id);
    if (!dm && !this.mentionsMe(room, event)) return;
    const title = this.title(room);
    this.notifications.emit({
      title: dm ? title : `${this.memberName(room, event.sender)} in ${title}`.slice(0, 200),
      body: this.eventText(room, event).slice(0, 200),
      target: room.id,
      railKey: dm ? `dm:${room.id}` : "home",
      inView: this.visible && this.selected === room.id,
    });
  }

  private async loadAvatars(): Promise<void> {
    if (this.loadingAvatars) return;
    this.loadingAvatars = true;
    const generation = this.generation;
    const session = this.session!;
    let found = false;
    try {
      for (const room of this.dmRooms().slice(0, AVATAR_LIMIT)) {
        const mxc = this.avatarOf(room);
        if (!mxc || this.avatarsTried.has(mxc)) continue;
        this.avatarsTried.add(mxc);
        const url = await this.deps.api.thumbnail(session, mxc).catch(() => undefined);
        // Signed out meanwhile: these chats belong to the previous account.
        if (generation !== this.generation) return;
        if (url) {
          this.avatars.set(mxc, url);
          found = true;
        }
      }
    } finally {
      this.loadingAvatars = false;
    }
    if (found) this.publish();
  }

  /** A DM's picture: the room's own, else the other person's. */
  private avatarOf(room: Room): string | undefined {
    return room.avatar || room.members.get(this.dmUsers.get(room.id)!)?.avatar;
  }

  // --- Rooms and messages -------------------------------------------------------

  private selectedRoom(): Room | undefined {
    return this.selected ? this.rooms.get(this.selected) : undefined;
  }

  private async select(local: string): Promise<void> {
    const room = this.rooms.get(this.byLocal.get(local) ?? "");
    if (!room) return;
    this.selected = room.id;
    this.render();
    if (room.events.length === 0 && room.prevBatch) await this.fetchHistory(room);
    if (this.visible) this.markRead(room);
  }

  private async fetchHistory(room: Room): Promise<void> {
    const session = this.session!;
    if (!room.prevBatch || this.loading.has(room.id)) return;
    const generation = this.generation;
    this.loading.add(room.id);
    this.render();
    let page: MxPage | undefined;
    try {
      page = await this.deps.api.messages(session, room.id, room.prevBatch, PAGE_SIZE);
    } catch (error) {
      this.error = `Could not load messages: ${friendly(error)}`;
    }
    this.loading.delete(room.id);
    if (generation !== this.generation) return;
    if (page) {
      this.applyState(room, page.state);
      const known = new Set(room.events.map((e) => e.id));
      const older: Shown[] = [];
      for (const event of page.events) {
        if (event.kind === "message" && event.replaces) this.addEvent(room, event, false);
        else if (event.kind === "redaction") this.removeEvent(room, event.redacts);
        else if ((event.kind === "message" || event.kind === "encrypted") && !known.has(event.id)) older.push(event);
      }
      // Redactions in this page may also remove events from it.
      const redacted = new Set(page.events.flatMap((e) => (e.kind === "redaction" ? [e.redacts] : [])));
      room.events = [...older.filter((e) => !redacted.has(e.id)), ...room.events];
      room.prevBatch = page.end;
      for (const event of older) room.lastActivity = Math.max(room.lastActivity, event.ts);
    }
    this.publish();
  }

  private async loadOlder(): Promise<void> {
    const room = this.selectedRoom();
    if (room) await this.fetchHistory(room);
  }

  /** Clears a room's unread state, and tells the server once per newest event. */
  private markRead(room: Room): void {
    const last = room.events.at(-1);
    if (room.notifications === 0 && room.highlights === 0) return;
    room.notifications = 0;
    room.highlights = 0;
    this.publish();
    if (!last || room.lastRead === last.id) return;
    room.lastRead = last.id;
    void this.deps.api.markRead(this.session!, room.id, last.id).catch(() => undefined);
  }

  private async attempt(what: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.error = `${what}: ${friendly(error)}`;
      this.render();
    }
  }

  /**
   * Refuses to write into an encrypted room. The cached state could be
   * stale, so unless it already says so, the server is asked first; if it
   * cannot answer, nothing is sent.
   */
  private async ensureUnencrypted(session: MxSession, room: Room): Promise<void> {
    if (!room.encrypted && (await this.deps.api.encrypted(session, room.id))) room.encrypted = true;
    if (room.encrypted) {
      this.render();
      throw new Error("this room is end-to-end encrypted, which Multicord does not support");
    }
  }

  private findEvent(room: Room, local: string): Shown | undefined {
    const id = this.byLocal.get(local);
    return id ? room.events.find((e) => e.id === id) : undefined;
  }

  private async send(text: string, replyTo?: string): Promise<void> {
    const room = this.selectedRoom();
    if (!room || text.trim() === "") return;
    const session = this.session!;
    await this.attempt("Message not sent", async () => {
      await this.ensureUnencrypted(session, room);
      const content: Record<string, unknown> = { msgtype: "m.text", body: text, "m.mentions": {} };
      const replied = replyTo ? this.findEvent(room, replyTo) : undefined;
      if (replied) content["m.relates_to"] = { "m.in_reply_to": { event_id: replied.id } };
      const id = await this.deps.api.send(session, room.id, content);
      const sent: Message = { kind: "message", id, sender: session.userId, ts: Date.now(), content: { msgtype: "m.text", text }, mentions: [] };
      if (replied) sent.replyTo = replied.id;
      this.addEvent(room, sent, false);
      this.publish();
    });
  }

  private async edit(local: string, text: string): Promise<void> {
    const room = this.selectedRoom();
    const session = this.session!;
    const target = room && this.findEvent(room, local);
    if (!room || target?.kind !== "message" || target.sender !== session.userId || !EDITABLE.has(target.content.msgtype)) return;
    await this.attempt("Message not edited", async () => {
      await this.ensureUnencrypted(session, room);
      const { msgtype } = target.content;
      const id = await this.deps.api.send(session, room.id, {
        msgtype,
        body: `* ${text}`,
        "m.new_content": { msgtype, body: text, "m.mentions": {} },
        "m.relates_to": { rel_type: "m.replace", event_id: target.id },
        "m.mentions": {},
      });
      this.addEvent(room, { kind: "message", id, sender: session.userId, ts: Date.now(), content: { msgtype, text }, mentions: [], replaces: target.id }, false);
      this.publish();
    });
  }

  private async remove(local: string): Promise<void> {
    const room = this.selectedRoom();
    const session = this.session!;
    const target = room && this.findEvent(room, local);
    // Redactions carry no content, so they are fine in encrypted rooms too.
    if (!room || !target || target.sender !== session.userId) return;
    await this.attempt("Message not deleted", async () => {
      await this.deps.api.redact(session, room.id, target.id);
      this.removeEvent(room, target.id);
      this.publish();
    });
  }

  // --- Output -------------------------------------------------------------------

  private memberName(room: Room, user: string): string {
    // User ids are checked to start with "@", so a cleaned one is never empty.
    return room.members.get(user)?.name ?? cleanName(user)!;
  }

  /** The room's name, else (for DMs) the other person, else its alias or members, as Matrix names rooms. */
  private title(room: Room): string {
    const other = this.dmUsers.get(room.id);
    const me = this.session!.userId;
    const heroes = room.heroes.filter((u) => u !== me).map((u) => this.memberName(room, u));
    const title = room.name || (other ? this.memberName(room, other) : "") || room.alias || heroes.join(", ") || "Empty room";
    return cleanName(title) ?? "Empty room";
  }

  private shownContent(room: Room, event: Message): { content: MxContent; edited: boolean } {
    const edit = room.edits.get(`${event.sender}|${event.id}`);
    return edit ? { content: edit.content, edited: true } : { content: event.content, edited: false };
  }

  private eventText(room: Room, event: Shown): string {
    return event.kind === "encrypted" ? ENCRYPTED_TEXT : messageText(this.shownContent(room, event).content);
  }

  private dmRooms(): Room[] {
    return [...this.rooms.values()].filter((r) => this.dmUsers.has(r.id)).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  private otherRooms(): Room[] {
    return [...this.rooms.values()].filter((r) => !this.dmUsers.has(r.id)).sort((a, b) => b.lastActivity - a.lastActivity);
  }

  directs(): DirectConversation[] {
    return this.dmRooms()
      .slice(0, MAX_DIRECTS)
      .map((room) => {
        const direct: DirectConversation = {
          key: room.id,
          account: this.account,
          title: this.title(room),
          lastActivity: room.lastActivity,
          unread: room.notifications > 0,
          mentions: room.notifications,
        };
        const avatar = this.avatars.get(this.avatarOf(room) ?? "");
        if (avatar) direct.avatarUrl = avatar;
        const last = room.events.at(-1);
        if (last) direct.preview = (last.kind === "encrypted" ? "🔒 Encrypted message" : this.eventText(room, last)).replace(/\s+/g, " ").slice(0, 200);
        return direct;
      });
  }

  private publish(): void {
    this.directsChanged.emit(this.directs());
    this.render();
  }

  private toNative(room: Room, event: Shown): NativeMessage {
    const mine = event.sender === this.session!.userId;
    const native: NativeMessage = {
      id: this.local(event.id),
      author: this.memberName(room, event.sender),
      content: escapeMarkdown(this.eventText(room, event)),
      timestamp: new Date(event.ts).toISOString(),
      edited: false,
      mine,
      canEdit: false,
      canDelete: mine,
      reactions: [],
      attachments: [],
    };
    if (event.kind !== "message") return native;
    const { content, edited } = this.shownContent(room, event);
    native.edited = edited;
    native.canEdit = mine && !room.encrypted && EDITABLE.has(event.content.msgtype);
    if (native.canEdit) native.source = content.text;
    const replied = event.replyTo ? room.events.find((e) => e.id === event.replyTo) : undefined;
    // Reply previews are plain text in the view.
    if (replied) native.reply = { author: this.memberName(room, replied.sender), content: this.eventText(room, replied).slice(0, 100) };
    return native;
  }

  private sidebarItem(room: Room, dm: boolean): NativeSidebarItem {
    const item: NativeSidebarItem = {
      id: room.local,
      name: this.title(room),
      kind: dm ? "dm" : "text",
      unread: room.notifications > 0,
      mentions: dm ? room.notifications : room.highlights,
      active: room.id === this.selected,
    };
    const avatar = dm ? this.avatars.get(this.avatarOf(room) ?? "") : undefined;
    if (avatar) item.iconUrl = avatar;
    return item;
  }

  private viewState(): NativeViewState {
    const platform = this.deps.def.name;
    if (this.step === "connecting") return { screen: "connecting", platform, status: this.status! };
    if (this.step !== "chat") return { screen: "prompt", platform, prompt: this.prompt(), busy: this.busy, status: this.status, error: this.error };
    const dms = this.dmRooms();
    const rooms = this.otherRooms();
    const sidebar: NativeSidebarItem[] = [];
    const category = (id: string, name: string): NativeSidebarItem => ({ id, name, kind: "category", unread: false, mentions: 0, active: false });
    if (dms.length) sidebar.push(category("dms", "Direct messages"), ...dms.map((r) => this.sidebarItem(r, true)));
    if (rooms.length) sidebar.push(category("rooms", "Rooms"), ...rooms.map((r) => this.sidebarItem(r, false)));
    const room = this.selectedRoom();
    const userId = this.session!.userId;
    return {
      screen: "chat",
      platform,
      title: userId.slice(userId.indexOf(":") + 1),
      me: userId,
      sidebar,
      channel: room
        ? {
            id: room.local,
            name: this.title(room),
            messages: room.events.map((e) => this.toNative(room, e)),
            loading: this.loading.has(room.id),
            hasOlder: room.prevBatch !== undefined,
            typing: [],
            pending: [],
            uploading: false,
            ...(room.encrypted ? { locked: ENCRYPTED_NOTICE } : {}),
          }
        : null,
      voice: null,
      error: this.error,
    };
  }

  private render(): void {
    this.deps.render(this.viewState());
  }
}
