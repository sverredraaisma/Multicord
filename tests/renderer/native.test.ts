// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => import("../mocks/livekit"));

import { AUTO_LOAD_TIMEOUT_MS, formatSize, formatTime, insertAtCursor, MAX_UNREAD_PAGES, NativeView, newMessagesText, QUICK_REACTIONS, startNative, typingText } from "../../src/renderer/native";
import type { NativeApi } from "../../src/preload/native";
import type { FavouritesState } from "../../src/shared/favourites";
import type { NativeMessage, NativeViewState } from "../../src/shared/native";
import { DEFAULT_SETTINGS, type VoiceSettings } from "../../src/shared/settings";
import { Room, resetLiveKit } from "../mocks/livekit";

type Chat = Extract<NativeViewState, { screen: "chat" }>;

const ALL = { reply: true, react: true, attach: true, typing: true, members: false };

const login: NativeViewState = { screen: "login", platform: "Fluxer", identity: "email", busy: false };

function msg(id: string, extra: Partial<NativeMessage> = {}): NativeMessage {
  return {
    id,
    author: "Ana",
    content: `text ${id}`,
    timestamp: "2026-10-14T12:00:00Z",
    edited: false,
    mine: false,
    canEdit: false,
    canDelete: false,
    reactions: [],
    attachments: [],
    ...extra,
  };
}

function chat(extra: Partial<Chat> = {}): Chat {
  return {
    screen: "chat",
    voice: null,
    platform: "Fluxer",
    title: "Alpha",
    me: "me",
    sidebar: [
      { id: "1", name: "Text", kind: "category", unread: false, mentions: 0, active: false },
      { id: "2", name: "general", kind: "text", unread: true, mentions: 3, active: true },
      { id: "3", name: "Ana", kind: "dm", iconUrl: "https://media/a.png", unread: false, mentions: 120, active: false },
      { id: "4", name: "Bo", kind: "dm", unread: false, mentions: 0, active: false },
    ],
    channel: { id: "2", name: "general", messages: [msg("10")], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL },
    ...extra,
  };
}

let root: HTMLElement;
let act: ReturnType<typeof vi.fn<NativeApi["act"]>>;
let view: NativeView;

beforeEach(() => {
  document.body.innerHTML = `<div id="app"></div>`;
  root = document.getElementById("app")!;
  act = vi.fn<NativeApi["act"]>();
  view = new NativeView(root, { act });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("login and MFA screens", () => {
  it("submits credentials and keeps typed input across updates", () => {
    view.update(login);
    const identity = root.querySelector<HTMLInputElement>('input[name="identity"]')!;
    const password = root.querySelector<HTMLInputElement>('input[name="password"]')!;
    expect(root.querySelector("h1")!.textContent).toBe("Sign in to Fluxer");
    expect(identity.type).toBe("email");
    expect(root.textContent).toContain("Email");
    expect(root.textContent).toContain("third-party client");

    identity.value = " a@b.c ";
    password.value = "pw";
    view.update({ ...login, busy: true, status: "Checking you are human…" });
    expect(root.querySelector<HTMLInputElement>('input[name="identity"]')).toBe(identity);
    expect(root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
    expect(root.querySelector(".status")!.textContent).toBe("Checking you are human…");

    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(act).toHaveBeenCalledWith({ type: "login", identity: "a@b.c", password: "pw" });

    view.update({ ...login, identity: "username", error: "Wrong password" });
    expect(identity.type).toBe("text");
    expect(root.textContent).toContain("Username");
    expect(root.querySelector(".error")!.textContent).toBe("Wrong password");
    expect(root.querySelector(".status")!.textContent).toBe("");
  });

  it("submits and cancels two-factor codes", () => {
    view.update({ screen: "mfa", platform: "Fluxer", codes: "totp", busy: false });
    expect(root.querySelector("label")!.textContent).toBe("Authentication or backup code");
    const code = root.querySelector<HTMLInputElement>('input[name="code"]')!;
    code.value = " 123456 ";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(act).toHaveBeenCalledWith({ type: "mfa", code: "123456" });
    view.update({ screen: "mfa", platform: "Fluxer", codes: "totp", busy: true, error: "Invalid code" });
    expect(root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
    expect(root.querySelector(".error")!.textContent).toBe("Invalid code");
    root.querySelector<HTMLButtonElement>("button.link")!.click();
    expect(act).toHaveBeenCalledWith({ type: "cancelMfa" });
  });

  it("asks for a backup code when that is the only code option", () => {
    view.update({ screen: "mfa", platform: "Fluxer", codes: "backup", busy: false });
    expect(root.querySelector("label")!.textContent).toBe("Backup code");
  });

  it("shows connection progress", () => {
    view.update({ screen: "connecting", platform: "Fluxer", status: "Connecting…" });
    expect(root.querySelector(".spinner")).not.toBeNull();
    view.update({ screen: "connecting", platform: "Fluxer", status: "Reconnecting…" });
    expect(root.querySelector(".status")!.textContent).toBe("Reconnecting…");
  });
});

describe("chat screen", () => {
  it("renders the sidebar with categories, channels, DMs and badges", () => {
    view.update(chat());
    expect(root.querySelector(".sidebar-title")!.textContent).toBe("Alpha");
    expect(root.querySelector(".me")!.textContent).toBe("me");
    expect(root.querySelector(".category")!.textContent).toBe("Text");
    const channels = root.querySelectorAll<HTMLButtonElement>("button.channel");
    expect([...channels].map((c) => c.querySelector(".name")!.textContent)).toEqual(["# general", "Ana", "Bo"]);
    expect(channels[0]!.classList.contains("active")).toBe(true);
    expect(channels[0]!.classList.contains("unread")).toBe(true);
    expect(channels[0]!.querySelector(".badge")!.textContent).toBe("3");
    expect(channels[1]!.querySelector("img.avatar")!.getAttribute("src")).toBe("https://media/a.png");
    expect(channels[1]!.querySelector(".badge")!.textContent).toBe("99+");
    expect(channels[2]!.querySelector(".avatar")!.textContent).toBe("B");

    channels[2]!.click();
    expect(act).toHaveBeenCalledWith({ type: "select", channelId: "4" });
    root.querySelector<HTMLButtonElement>(".account .link")!.click();
    expect(act).toHaveBeenCalledWith({ type: "logout" });
  });

  it("renders messages as text only, with attachments and edits", () => {
    view.update(
      chat({
        channel: {
          id: "2",
          name: "general",
          loading: false,
          hasOlder: false,
          typing: [],
          pending: [],
          uploading: false,
          can: ALL,
          messages: [
            msg("10", {
              content: "<img src=x onerror=alert(1)>",
              edited: true,
              avatarUrl: "https://media/a.png",
              attachments: [
                { name: "cat.png", url: "https://media/cat.png", kind: "image" },
                { name: "notes.txt", url: "https://media/notes.txt", kind: "file" },
                { name: "old.png", kind: "file" },
              ],
            }),
            msg("11", { mine: true, content: "" }),
          ],
        },
      }),
    );
    const first = root.querySelector(".message")!;
    expect(first.querySelector(".content")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(first.querySelector(".content img")).toBeNull();
    expect(first.querySelector(".edited")).not.toBeNull();
    expect(first.querySelector("img.attachment-image")!.getAttribute("alt")).toBe("cat.png");
    const link = first.querySelector<HTMLAnchorElement>("a.attachment")!;
    expect(link.getAttribute("href")).toBe("https://media/notes.txt");
    expect(link.target).toBe("_blank");
    expect(first.querySelector(".attachment.expired")!.textContent).toBe("old.png (link expired)");
    const second = root.querySelectorAll(".message")[1]!;
    expect(second.classList.contains("mine")).toBe(true);
    expect(second.querySelector(".content")).toBeNull();
  });

  it("sends with Enter, keeps Shift+Enter for new lines and ignores blank input", () => {
    view.update(chat());
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    expect(composer.placeholder).toBe("Message general");
    composer.value = "   ";
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    composer.value = "line";
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(act).not.toHaveBeenCalled();
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(act).toHaveBeenCalledWith({ type: "send", content: "line" });
    expect(composer.value).toBe("");

    composer.value = "draft";
    view.update(chat({ sidebar: [] }));
    expect(root.querySelector(".composer")).toBe(composer);
    expect(composer.value).toBe("draft");
  });

  it("disables the composer without a channel and shows errors", () => {
    view.update(chat({ channel: null, error: "Connection lost. Reconnecting…" }));
    expect(root.querySelector(".conversation-title")!.textContent).toBe("Select a conversation");
    expect(root.querySelector<HTMLTextAreaElement>(".composer")!.disabled).toBe(true);
    const banner = root.querySelector<HTMLElement>(".banner")!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toBe("Connection lost. Reconnecting…");
    view.update(chat());
    expect(banner.hidden).toBe(true);
  });

  it("offers older history and shows loading states", () => {
    view.update(chat({ channel: { id: "2", name: "general", messages: [msg("10")], loading: false, hasOlder: true, typing: [], pending: [], uploading: false, can: ALL } }));
    const older = root.querySelector<HTMLButtonElement>("button.older")!;
    expect(older.textContent).toBe("Load older messages");
    older.click();
    expect(act).toHaveBeenCalledWith({ type: "loadOlder" });
    view.update(chat({ channel: { id: "2", name: "general", messages: [msg("10")], loading: true, hasOlder: true, typing: [], pending: [], uploading: false, can: ALL } }));
    expect(root.querySelector<HTMLButtonElement>("button.older")!.disabled).toBe(true);
    view.update(chat({ channel: { id: "2", name: "general", messages: [], loading: true, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } }));
    expect(root.querySelector(".older-row")!.textContent).toBe("Loading…");
  });

  it("keeps the reader's place when older messages arrive and follows new ones at the bottom", () => {
    view.update(chat());
    const list = root.querySelector<HTMLElement>(".messages")!;
    // Each rendered message is 500px tall.
    Object.defineProperty(list, "scrollHeight", { get: () => list.children.length * 500, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    const update = (...ids: string[]) =>
      view.update(chat({ channel: { id: "2", name: "general", messages: ids.map((id) => msg(id)), loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } }));

    // Reading at the top: older messages are prepended, the view stays on the same message.
    list.scrollTop = 0;
    update("5", "10");
    expect(list.scrollTop).toBe(500);

    // At the bottom: new messages keep it pinned.
    list.scrollTop = 600;
    update("5", "10", "11");
    expect(list.scrollTop).toBe(1500);

    // Reading in the middle with only an unrelated update: nothing moves.
    list.scrollTop = 200;
    update("5", "10", "11");
    expect(list.scrollTop).toBe(200);
  });

  it("rebuilds when the screen changes", () => {
    view.update(chat());
    view.update(login);
    expect(root.querySelector(".chat")).toBeNull();
    expect(root.querySelector("form.auth")).not.toBeNull();
  });
});

describe("helpers", () => {
  it("formats timestamps and tolerates bad ones", () => {
    expect(formatTime("2026-10-14T12:00:00Z", "en-GB")).toMatch(/14\/10\/2026/);
    expect(formatTime("nonsense")).toBe("");
  });

  it("wires the view to the bridge and asks for state", () => {
    let push: (state: NativeViewState) => void = () => {};
    let pushVoice: (settings: VoiceSettings) => void = () => {};
    let pushCompact: (compact: boolean) => void = () => {};
    let voiceCommand: (command: "toggleMute" | "toggleDeafen") => void = () => {};
    let pushFavourites: (state: FavouritesState) => void = () => {};
    let pushLimit: (limit: number) => void = () => {};
    const api: NativeApi = {
      onState: (cb) => (push = cb),
      act: vi.fn(),
      onVoiceSettings: (cb) => (pushVoice = cb),
      onMediaAutoLoad: (cb) => (pushLimit = cb),
      onCompact: (cb) => (pushCompact = cb),
      onVoiceCommand: (cb) => (voiceCommand = cb),
      screenAudioEnded: vi.fn(),
      onFavourites: (cb) => (pushFavourites = cb),
      favourites: vi.fn(),
    };
    vi.stubGlobal("IntersectionObserver", undefined);
    startNative(document, api);
    expect(api.act).toHaveBeenCalledWith({ type: "ready" });
    push(login);
    expect(document.querySelector("form.auth")).not.toBeNull();
    pushVoice({ ...DEFAULT_SETTINGS.voice, noiseSuppression: false }); // before a chat view exists: kept for later
    push(chat());
    expect(document.querySelector(".voice-stage")).not.toBeNull();
    pushFavourites({ categories: [], items: [], module: { name: "Fluxer", label: "FX", color: "#4f8cf7" }, saving: [] });
    document.querySelector<HTMLButtonElement>(".emoji-button")!.click();
    expect(document.querySelector(".media-picker")).not.toBeNull();
    document.querySelector<HTMLButtonElement>(".emoji-button")!.click();
    pushCompact(true);
    expect(document.body.classList.contains("compact")).toBe(true);
    pushCompact(false);
    expect(document.body.classList.contains("compact")).toBe(false);
    document.dispatchEvent(new CustomEvent("multicord:screen-audio-end"));
    expect(api.screenAudioEnded).toHaveBeenCalled();
    // The shell's limit lets held-back media load by itself.
    pushLimit(Number.POSITIVE_INFINITY);
    push(chat({ channel: { ...chat().channel!, messages: [msg("10", { attachments: [{ name: "p.jpg", kind: "image", mediaKey: "m:1" }] })] } }));
    expect(api.act).toHaveBeenCalledWith({ type: "loadMedia", key: "m:1" });

    // Voice shortcuts and push to talk reach the call in progress.
    const live = { channelId: "7", channelName: "Lounge", guildName: "G", url: "wss://x", token: "t", mute: false, deaf: false, video: false, stream: false };
    push(chat({ voice: live }));
    voiceCommand("toggleMute");
    expect(api.act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: false, video: false, stream: false });
    voiceCommand("toggleDeafen");
    expect(api.act).toHaveBeenLastCalledWith({ type: "voiceState", mute: false, deaf: true, video: false, stream: false });
    pushVoice({ ...DEFAULT_SETTINGS.voice, pushToTalk: "Backquote" });
    push(chat({ voice: { ...live, mute: true } }));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote" }));
    expect(api.act).toHaveBeenLastCalledWith({ type: "voiceState", mute: false, deaf: false, video: false, stream: false });
    push(chat({ voice: { ...live, mute: false } }));
    const calls = (api.act as ReturnType<typeof vi.fn>).mock.calls.length;
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Backquote", repeat: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyA" }));
    expect((api.act as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls);
    document.dispatchEvent(new KeyboardEvent("keyup", { code: "Backquote" }));
    expect(api.act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: false, video: false, stream: false });
    push(chat({ voice: { ...live, mute: false } }));
    window.dispatchEvent(new Event("blur"));
    expect(api.act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: false, video: false, stream: false });
  });
});

describe("message actions", () => {
  const ownMessage = msg("10", { mine: true, canEdit: true, canDelete: true, source: "raw <@2>", content: "raw @Ana" });
  const withMessages = (...messages: NativeMessage[]) =>
    chat({ channel: { id: "2", name: "general", messages, loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } });
  const button = (label: string, scope: ParentNode = root) =>
    [...scope.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === label);

  it("offers edit and delete only where allowed", () => {
    view.update(withMessages(ownMessage, msg("11")));
    const [own, other] = root.querySelectorAll(".message");
    expect([...own!.querySelectorAll(".message-actions button")].map((b) => b.textContent)).toEqual(["Reply", "React", "Edit", "Delete"]);
    expect([...other!.querySelectorAll(".message-actions button")].map((b) => b.textContent)).toEqual(["Reply", "React"]);
  });

  it("replies through a bar above the composer", () => {
    view.update(withMessages(msg("11")));
    button("Reply")!.click();
    const bar = root.querySelector<HTMLElement>(".reply-bar")!;
    expect(bar.hidden).toBe(false);
    expect(bar.textContent).toContain("Replying to Ana");

    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    composer.value = "sure";
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(act).toHaveBeenLastCalledWith({ type: "send", content: "sure", replyTo: "11" });
    expect(bar.hidden).toBe(true);

    button("Reply")!.click();
    bar.querySelector<HTMLButtonElement>("button")!.click();
    expect(bar.hidden).toBe(true);
    button("Reply")!.click();
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(bar.hidden).toBe(true);
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); // nothing to cancel
  });

  it("edits in place from the raw source, surviving updates", () => {
    view.update(withMessages(ownMessage));
    button("Edit")!.click();
    let box = root.querySelector<HTMLTextAreaElement>(".edit-box")!;
    expect(box.value).toBe("raw <@2>");
    expect(root.querySelector(".message .content")).toBeNull();

    box.value = "changed";
    view.update(withMessages(ownMessage));
    box = root.querySelector<HTMLTextAreaElement>(".edit-box")!;
    expect(box.value).toBe("changed");

    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true }));
    expect(act).not.toHaveBeenCalled();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(act).toHaveBeenCalledWith({ type: "edit", messageId: "10", content: "changed" });
    expect(root.querySelector(".edit-box")).toBeNull();
  });

  it("cancels edits with Escape and ignores empty edits", () => {
    view.update(withMessages(ownMessage, msg("12", { mine: true, canEdit: true, canDelete: true, content: "plain" })));
    button("Edit")!.click();
    root.querySelector<HTMLTextAreaElement>(".edit-box")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(root.querySelector(".edit-box")).toBeNull();

    const second = root.querySelectorAll(".message")[1]!;
    button("Edit", second)!.click();
    const box = root.querySelector<HTMLTextAreaElement>(".edit-box")!;
    expect(box.value).toBe("plain"); // no source: falls back to the content
    box.value = "  ";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(act).not.toHaveBeenCalled();
  });

  it("deletes after confirmation", () => {
    view.update(withMessages(ownMessage));
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, "confirm", { value: confirm, configurable: true, writable: true });
    button("Delete")!.click();
    expect(act).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    button("Delete")!.click();
    expect(act).toHaveBeenCalledWith({ type: "delete", messageId: "10" });
    delete (window as { confirm?: unknown }).confirm;
    act.mockClear();
    button("Delete")!.click(); // no confirm dialog available: proceeds
    expect(act).toHaveBeenCalledOnce();
  });

  it("toggles reactions and offers quick reactions", () => {
    view.update(
      withMessages(
        msg("11", {
          reactions: [
            { key: "👍", label: "👍", count: 2, me: true },
            { key: "party:55", label: ":party:", imageUrl: "https://media/e/55.webp", count: 1, me: false },
          ],
        }),
      ),
    );
    const reactions = root.querySelectorAll<HTMLButtonElement>(".reactions .reaction");
    expect(reactions[0]!.classList.contains("me")).toBe(true);
    expect(reactions[0]!.textContent).toBe("👍2");
    expect(reactions[1]!.querySelector("img")!.getAttribute("src")).toBe("https://media/e/55.webp");
    reactions[0]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "react", messageId: "11", emoji: "👍", add: false });
    reactions[1]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "react", messageId: "11", emoji: "party:55", add: true });

    button("React")!.click();
    const quick = root.querySelectorAll<HTMLButtonElement>(".quick-reactions .reaction:not(.more)");
    expect([...quick].map((b) => b.textContent)).toEqual(QUICK_REACTIONS);
    quick[0]!.click(); // 👍 is already ours: removes it
    expect(act).toHaveBeenLastCalledWith({ type: "react", messageId: "11", emoji: "👍", add: false });
    button("React")!.click();
    button("React")!.click(); // toggles the palette closed
    expect(root.querySelector(".quick-reactions")).toBeNull();
    button("React")!.click();
    root.querySelectorAll<HTMLButtonElement>(".quick-reactions .reaction:not(.more)")[5]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "react", messageId: "11", emoji: "🎉", add: true });
  });

  it("offers only what the conversation allows", () => {
    const reacted = msg("11", { reactions: [{ key: "👍", label: "👍", count: 2, me: false }] });
    const none = { reply: false, react: false, attach: false, typing: false, members: false };
    const state = (can: unknown) =>
      chat({ channel: { id: "2", name: "general", messages: [reacted], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: can as typeof ALL } });
    view.update(state(ALL));
    button("React")!.click();
    expect(root.querySelector(".quick-reactions")).not.toBeNull();
    view.update(state(none));
    // The open palette closes; others' reactions still show but cannot be toggled.
    expect(root.querySelectorAll(".message-actions button")).toHaveLength(0);
    expect(root.querySelector(".quick-reactions")).toBeNull();
    const chip = root.querySelector<HTMLButtonElement>(".reactions .reaction")!;
    expect(chip.disabled).toBe(true);
    chip.click();
    expect(act).not.toHaveBeenCalledWith(expect.objectContaining({ type: "react" }));
    const attach = root.querySelector<HTMLButtonElement>("button.attach")!;
    expect(attach.hidden).toBe(true);
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    composer.value = "h";
    composer.dispatchEvent(new Event("input"));
    expect(act).not.toHaveBeenCalledWith({ type: "typing" });
    // A malformed flag counts as off.
    view.update(state({ ...ALL, reply: "yes", attach: 1 }));
    expect([...root.querySelectorAll(".message-actions button")].map((b) => b.textContent)).toEqual(["React"]);
    expect(attach.hidden).toBe(true);
    view.update(state(ALL));
    expect(attach.hidden).toBe(false);
    view.update(chat({ channel: null }));
    expect(attach.hidden).toBe(false);
  });

  it("shows reply previews and deleted originals", () => {
    view.update(withMessages(msg("11", { reply: { author: "Bo", content: "earlier" } }), msg("12", { reply: null })));
    const quotes = root.querySelectorAll(".reply");
    expect(quotes[0]!.textContent).toBe("↪ Bo: earlier");
    expect(quotes[1]!.textContent).toBe("↪ Original message was deleted");
    expect(quotes[1]!.classList.contains("missing")).toBe(true);
  });

  it("drops a pending reply or edit when the channel changes", () => {
    view.update(withMessages(ownMessage));
    button("Reply")!.click();
    button("Edit")!.click();
    view.update(chat({ channel: { id: "3", name: "other", messages: [ownMessage], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } }));
    expect(root.querySelector<HTMLElement>(".reply-bar")!.hidden).toBe(true);
    expect(root.querySelector(".edit-box")).toBeNull();
  });
});

describe("typing", () => {
  it("phrases who is typing", () => {
    expect(typingText([])).toBe("");
    expect(typingText(["Ana"])).toBe("Ana is typing…");
    expect(typingText(["Ana", "Bo"])).toBe("Ana and Bo are typing…");
    expect(typingText(["Ana", "Bo", "Cy"])).toBe("Ana, Bo and Cy are typing…");
    expect(typingText(["a", "b", "c", "d"])).toBe("Several people are typing…");
  });

  it("shows typing and reports our own typing", () => {
    view.update(chat({ channel: { id: "2", name: "general", messages: [], loading: false, hasOlder: false, typing: ["Ana"], pending: [], uploading: false, can: ALL } }));
    expect(root.querySelector(".typing")!.textContent).toBe("Ana is typing…");
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    composer.value = "  ";
    composer.dispatchEvent(new Event("input"));
    expect(act).not.toHaveBeenCalled();
    composer.value = "h";
    composer.dispatchEvent(new Event("input"));
    expect(act).toHaveBeenCalledWith({ type: "typing" });
    view.update(chat({ channel: null }));
    expect(root.querySelector(".typing")!.textContent).toBe("");
  });
});

describe("unread messages", () => {
  const withUnread = (unread: unknown, extra: Partial<NonNullable<Chat["channel"]>> = {}) =>
    chat({ channel: { id: "2", name: "general", messages: [msg("10"), msg("11"), msg("12")], loading: false, hasOlder: true, typing: [], pending: [], uploading: false, can: ALL, unread: unread as never, ...extra } });
  const scroller = () => root.querySelector<HTMLElement>(".messages")!;
  const bar = () => root.querySelector<HTMLElement>(".unread-bar")!;
  /** Gives the messages list a layout: its heights and where it is scrolled. */
  const layout = (scrollHeight: number, clientHeight: number, scrollTop: number) => {
    const list = scroller();
    Object.defineProperty(list, "scrollHeight", { value: scrollHeight, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: clientHeight, configurable: true });
    Object.defineProperty(list, "scrollTop", { value: scrollTop, writable: true, configurable: true });
  };

  it("phrases how many messages are new", () => {
    expect(newMessagesText(undefined)).toBe("New messages");
    expect(newMessagesText(1)).toBe("1 new message");
    expect(newMessagesText(12)).toBe("12 new messages");
  });

  it("marks where the news starts and brings it into sight on opening", () => {
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("unread-divider") ? 300 : 0;
    });
    view.update(chat({ channel: null }));
    layout(2000, 500, 0);
    view.update(withUnread({ firstId: "11", count: 2 }));
    const divider = scroller().querySelector(".unread-divider")!;
    expect(divider.getAttribute("role")).toBe("separator");
    expect(divider.textContent).toBe("2 new messages");
    expect(divider.nextElementSibling!.getAttribute("data-id")).toBe("11");
    expect(scroller().scrollTop).toBe(292);
    expect(bar().hidden).toBe(true);
    // Scrolled back above it, the bar does not come back; scrolled on past it, it offers the way back.
    layout(2000, 500, 900);
    scroller().dispatchEvent(new Event("scroll"));
    expect(bar().hidden).toBe(false);
    expect(bar().querySelector(".unread-text")!.textContent).toBe("2 new messages");
    bar().querySelector<HTMLButtonElement>(".jump-unread")!.click();
    expect(scroller().scrollTop).toBe(292);
    expect(bar().hidden).toBe(true);
    // Read on to the latest messages: the bar stays away.
    layout(2000, 500, 1500);
    scroller().dispatchEvent(new Event("scroll"));
    layout(2000, 500, 900);
    scroller().dispatchEvent(new Event("scroll"));
    expect(bar().hidden).toBe(true);
    // A marker the view cannot place, or none: no divider.
    view.update(withUnread({ firstId: "99" }));
    expect(scroller().querySelector(".unread-divider")).toBeNull();
    view.update(withUnread("junk"));
    expect(scroller().querySelector(".unread-divider")).toBeNull();
    vi.restoreAllMocks();
  });

  it("loads older messages to find where the news starts, a page at a time and within a limit", () => {
    view.update(chat({ channel: null }));
    layout(2000, 500, 1500);
    view.update(withUnread({ count: 40 }));
    expect(bar().hidden).toBe(false);
    expect(bar().textContent).toContain("40 new messages");
    bar().querySelector<HTMLButtonElement>(".jump-unread")!.click();
    expect(act.mock.calls.filter(([a]) => a.type === "loadOlder")).toHaveLength(1);
    // Not again until the page has arrived.
    view.update(withUnread({ count: 40 }, { loading: true }));
    view.update(withUnread({ count: 40 }));
    expect(act.mock.calls.filter(([a]) => a.type === "loadOlder")).toHaveLength(1);
    view.update(withUnread({ count: 40 }, { messages: [msg("5"), msg("10"), msg("11"), msg("12")] }));
    expect(act.mock.calls.filter(([a]) => a.type === "loadOlder")).toHaveLength(2);
    // Found: brought into sight, and the search ends.
    view.update(withUnread({ firstId: "5", count: 40 }, { messages: [msg("4"), msg("5"), msg("10"), msg("11"), msg("12")] }));
    expect(scroller().querySelector(".unread-divider")).not.toBeNull();
    expect(bar().hidden).toBe(true);
    view.update(withUnread({ firstId: "5", count: 40 }, { messages: [msg("3"), msg("4"), msg("5"), msg("10"), msg("11"), msg("12")] }));
    expect(act.mock.calls.filter(([a]) => a.type === "loadOlder")).toHaveLength(2);
  });

  it("stops looking when there is nothing older or after enough pages, and can be dismissed", () => {
    view.update(chat({ channel: null }));
    layout(2000, 500, 1500);
    view.update(withUnread({}, { hasOlder: false }));
    expect(bar().textContent).toContain("New messages");
    bar().querySelector<HTMLButtonElement>(".jump-unread")!.click();
    expect(act).not.toHaveBeenCalledWith({ type: "loadOlder" });
    view.update(withUnread({}));
    bar().querySelector<HTMLButtonElement>(".jump-unread")!.click();
    for (let page = 1; page <= MAX_UNREAD_PAGES + 2; page++) view.update(withUnread({}, { messages: [msg(String(100 - page)), msg("10")] }));
    expect(act.mock.calls.filter(([a]) => a.type === "loadOlder")).toHaveLength(MAX_UNREAD_PAGES);
    bar().querySelector<HTMLButtonElement>(".dismiss-unread")!.click();
    expect(bar().hidden).toBe(true);
    // Another conversation without news: no bar.
    view.update(chat());
    expect(bar().hidden).toBe(true);
  });

  it("offers a way back to the latest messages while scrolled up", () => {
    view.update(chat());
    const present = root.querySelector<HTMLButtonElement>(".jump-present")!;
    layout(3000, 500, 1000);
    scroller().dispatchEvent(new Event("scroll"));
    expect(present.hidden).toBe(false);
    present.click();
    expect(scroller().scrollTop).toBe(3000);
    expect(present.hidden).toBe(true);
  });
});

describe("muting conversations", () => {
  it("sends a mute action from a row's bell", () => {
    const base = chat();
    view.update(chat({ sidebar: [...base.sidebar.slice(0, 2), { ...base.sidebar[2]!, muted: true, canMute: true }] }));
    root.querySelector<HTMLButtonElement>('.mute-toggle[aria-label="Unmute Ana"]')!.click();
    expect(act).toHaveBeenCalledWith({ type: "mute", channelId: "3", mute: false });
  });
});

describe("mentions", () => {
  const people = [msg("10", { author: "Ana", authorId: "a", authorMention: "<@a>" }), msg("11", { author: "Bo", authorId: "b" }), msg("12", { author: "Me", authorId: "m", mine: true })];
  const withPeople = (extra: Partial<NonNullable<Chat["channel"]>> = {}) =>
    chat({ channel: { id: "2", name: "general", messages: people, loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL, ...extra } });
  const type = (field: HTMLTextAreaElement, value: string, cursor = value.length) => {
    field.value = value;
    field.selectionStart = field.selectionEnd = cursor;
    field.dispatchEvent(new Event("input"));
  };
  const key = (field: HTMLTextAreaElement, name: string, extra: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", { key: name, cancelable: true, ...extra });
    field.dispatchEvent(event);
    return event;
  };
  const list = () => root.querySelector<HTMLElement>(".mention-list")!;
  const names = () => [...list().querySelectorAll(".mention-name")].map((n) => n.textContent);
  const active = () => list().querySelector('[aria-selected="true"] .mention-name')?.textContent;

  it("suggests recent authors for @name and inserts the module's mention for the one picked", () => {
    view.update(withPeople());
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    expect(composer.getAttribute("aria-autocomplete")).toBe("list");
    type(composer, "hi @");
    expect(list().hidden).toBe(false);
    expect(names()).toEqual(["Bo", "Ana"]);
    expect(composer.getAttribute("aria-expanded")).toBe("true");
    expect(composer.getAttribute("aria-activedescendant")).toBe("mention-option-0");
    expect(key(composer, "ArrowUp").defaultPrevented).toBe(true);
    expect(active()).toBe("Ana");
    key(composer, "ArrowDown");
    expect(active()).toBe("Bo");
    key(composer, "ArrowDown");
    expect(active()).toBe("Ana");
    // Other keys type as usual.
    expect(key(composer, "a").defaultPrevented).toBe(false);
    expect(key(composer, "Enter").defaultPrevented).toBe(true);
    expect(composer.value).toBe("hi <@a> ");
    expect(composer.selectionStart).toBe(8);
    expect(list().hidden).toBe(true);
    expect(composer.getAttribute("aria-expanded")).toBe("false");
    expect(composer.hasAttribute("aria-activedescendant")).toBe(false);
    expect(act).not.toHaveBeenCalledWith(expect.objectContaining({ type: "send" }));

    // Without a mention of the module's own, the name goes in; Tab picks too, text after the cursor stays.
    type(composer, "@b and more", 2);
    expect(names()).toEqual(["Bo"]);
    key(composer, "Tab");
    expect(composer.value).toBe("Bo  and more");
  });

  it("closes on Escape, blur, a send or a switch, keeps the reply, and lets Shift+Enter add a line", () => {
    view.update(withPeople());
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    root.querySelector<HTMLButtonElement>(".message-actions button")!.click();
    type(composer, "@a");
    expect(key(composer, "Escape").defaultPrevented).toBe(true);
    expect(list().hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".reply-bar")!.hidden).toBe(false);
    type(composer, "@a");
    expect(key(composer, "Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(list().hidden).toBe(false);
    key(composer, "Tab", { shiftKey: true });
    composer.dispatchEvent(new Event("blur"));
    expect(list().hidden).toBe(true);
    type(composer, "@a");
    view.update(chat());
    expect(list().hidden).toBe(true);
    // Nobody fits, or there is no @name: no list.
    type(composer, "@zz");
    expect(list().hidden).toBe(true);
    type(composer, "plain");
    expect(list().hidden).toBe(true);
  });

  it("follows the cursor, refreshes with new state keeping the highlighted one, and adds listed members", () => {
    view.update(withPeople());
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    type(composer, "@ x", 1);
    key(composer, "ArrowDown");
    expect(active()).toBe("Ana");
    view.update(withPeople({ messages: [...people, msg("13", { author: "Cy", authorId: "c" })] }));
    expect(names()).toEqual(["Cy", "Bo", "Ana"]);
    expect(active()).toBe("Ana");
    composer.selectionStart = composer.selectionEnd = 3;
    composer.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowRight" }));
    expect(list().hidden).toBe(true);
    composer.selectionStart = composer.selectionEnd = 1;
    composer.dispatchEvent(new KeyboardEvent("keyup", { key: "a" }));
    expect(list().hidden).toBe(true);
    composer.dispatchEvent(new MouseEvent("click"));
    expect(list().hidden).toBe(false);
    // Members count where the module lists them.
    const members = { sections: [{ name: "Members", members: [{ id: "d", name: "Di", mention: "@di" }] }], hasMore: false, loading: false };
    view.update(withPeople({ members, can: { ...ALL, members: true } }));
    expect(names()).toEqual(["Bo", "Ana", "Di"]);
    expect(active()).toBe("Bo");
    view.update(withPeople({ members }));
    expect(names()).toEqual(["Bo", "Ana"]);
    // Pressing an option picks it.
    list().querySelector(".mention-option")!.dispatchEvent(new MouseEvent("mousedown", { cancelable: true }));
    expect(composer.value).toBe("Bo  x");
  });

  it("offers nothing where the composer is off, and inserts nothing past the length limit", () => {
    view.update(withPeople({ locked: "Read only" }));
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    type(composer, "@");
    expect(list().hidden).toBe(true);
    view.update(withPeople());
    const long = `${"x".repeat(3998)} @b`;
    type(composer, long);
    key(composer, "Enter");
    expect(composer.value).toBe(long);
    expect(list().hidden).toBe(true);
  });
});

describe("attachments", () => {
  const withFiles = (pending: { name: string; size: number }[], uploading = false) =>
    chat({ channel: { id: "2", name: "general", messages: [], loading: false, hasOlder: false, typing: [], pending, uploading, can: ALL } });

  it("formats sizes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("attaches, lists and removes pending files, and sends attachments without text", () => {
    view.update(withFiles([]));
    root.querySelector<HTMLButtonElement>("button.attach")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "attach" });

    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(act).toHaveBeenCalledTimes(1); // nothing to send yet

    view.update(withFiles([{ name: "cat.png", size: 2048 }, { name: "notes.txt", size: 10 }]));
    const chips = root.querySelectorAll(".pending-file");
    expect([...chips].map((c) => c.textContent)).toEqual(["cat.png2.0 KB×", "notes.txt10 B×"]);
    chips[1]!.querySelector<HTMLButtonElement>("button")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "removeAttachment", index: 1 });

    composer.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(act).toHaveBeenLastCalledWith({ type: "send", content: "" });
  });

  it("locks the composer while uploading", () => {
    view.update(withFiles([{ name: "cat.png", size: 2048 }], true));
    expect(root.querySelector<HTMLTextAreaElement>(".composer")!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>("button.attach")!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(".pending-file button")!.disabled).toBe(true);
    expect(root.querySelector(".uploading")!.textContent).toBe("Uploading…");
    view.update(withFiles([], true));
    expect(root.querySelector(".uploading")!.textContent).toBe("Sending…");
  });
});

describe("threads and forums", () => {
  const forum = (posts: NonNullable<Chat["channel"]>["posts"]) =>
    chat({
      sidebar: [
        { id: "5", name: "general", kind: "text", unread: false, mentions: 0, active: false },
        { id: "6", name: "side chat", kind: "thread", unread: false, mentions: 0, active: false },
        { id: "7", name: "ideas", kind: "forum", unread: true, mentions: 0, active: true },
      ],
      channel: { id: "7", name: "ideas", messages: [], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL, posts },
    });

  it("marks threads and forums in the sidebar", () => {
    view.update(forum([]));
    expect([...root.querySelectorAll(".channel .name")].map((n) => n.textContent)).toEqual(["# general", "↳ side chat", "☰ ideas"]);
    expect(root.querySelector(".channel.thread")).not.toBeNull();
  });

  it("lists posts, opens them and disables the composer", () => {
    view.update(
      forum([
        { id: "40", name: "Dark mode", messageCount: 4, unread: true, mentions: 2 },
        { id: "41", name: "Emoji", messageCount: 1, unread: false, mentions: 0 },
        { id: "42", name: "Fresh", unread: false, mentions: 0 },
      ]),
    );
    const posts = root.querySelectorAll<HTMLButtonElement>("button.post");
    expect([...posts].map((p) => p.textContent)).toEqual(["Dark mode4 replies2", "Emoji1 reply", "Fresh"]);
    expect(posts[0]!.classList.contains("unread")).toBe(true);
    posts[1]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "select", channelId: "41" });
    expect(root.querySelector<HTMLTextAreaElement>(".composer")!.disabled).toBe(true);
  });

  it("creates posts from a form that keeps its text across updates", () => {
    view.update(forum([]));
    expect(root.querySelector(".messages .empty")!.textContent).toBe("No open posts yet.");
    const title = root.querySelector<HTMLInputElement>('.post-form input[name="title"]')!;
    const body = root.querySelector<HTMLTextAreaElement>('.post-form textarea[name="body"]')!;
    title.value = " Idea ";
    view.update(forum([]));
    expect(root.querySelector<HTMLInputElement>('.post-form input[name="title"]')).toBe(title);

    const form = root.querySelector("form.post-form")!;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(act).not.toHaveBeenCalled(); // no body yet
    body.value = "first";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(act).toHaveBeenCalledWith({ type: "createPost", name: "Idea", content: "first" });
    expect(title.value).toBe("");
  });
});

describe("voice", () => {
  const voice = (extra: Partial<NonNullable<Chat["voice"]>> = {}): NonNullable<Chat["voice"]> => ({
    channelId: "9",
    channelName: "Lounge",
    guildName: "Alpha",
    mute: false,
    deaf: false,
    video: false,
    stream: false,
    ...extra,
  });

  it("tells the engine whether a call problem ended the call", async () => {
    resetLiveKit();
    view.update(chat({ voice: voice({ url: "wss://v", token: "t" }) }));
    await vi.waitFor(() => expect(Room.instances).toHaveLength(1));
    const room = Room.instances[0]!;
    await vi.waitFor(() => expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalled());
    room.localParticipant.setCameraEnabled.mockRejectedValueOnce(new Error("busy"));
    view.update(chat({ voice: voice({ url: "wss://v", token: "t", video: true }) }));
    await vi.waitFor(() => expect(act).toHaveBeenCalledWith({ type: "voiceNotice", message: "The camera could not start: busy", off: "video" }));
    room.emit("disconnected");
    expect(act).toHaveBeenLastCalledWith({ type: "voiceError", message: "Disconnected from voice" });
  });

  it("joins voice channels from the sidebar and lists who is there", () => {
    view.update(
      chat({
        sidebar: [
          {
            id: "9",
            name: "Lounge",
            kind: "voice",
            unread: false,
            mentions: 0,
            active: true,
            members: [
              { name: "Ana", avatarUrl: "https://media/a.png", muted: true, video: false },
              { name: "Bo", muted: false, video: true },
            ],
          },
          { id: "10", name: "Empty", kind: "voice", unread: false, mentions: 0, active: false, members: [] },
        ],
      }),
    );
    const channel = root.querySelector<HTMLButtonElement>(".channel.voice")!;
    expect(channel.querySelector(".name")!.textContent).toBe("🔊 Lounge");
    channel.click();
    expect(act).toHaveBeenCalledWith({ type: "joinVoice", channelId: "9" });
    const members = root.querySelectorAll(".voice-members li");
    expect([...members].map((m) => m.querySelector(".name")!.textContent)).toEqual(["Ana", "Bo"]);
    expect(members[0]!.classList.contains("muted")).toBe(true);
    expect(members[1]!.querySelector(".live")).not.toBeNull();
    expect(root.querySelectorAll(".voice-members")).toHaveLength(1);
  });

  it("shows the call panel while connecting and once connected", () => {
    view.update(chat({ voice: voice() }));
    const panel = root.querySelector<HTMLElement>(".voice-panel")!;
    expect(panel.hidden).toBe(false);
    expect(panel.querySelector(".voice-status")!.textContent).toBe("Connecting…");
    expect(panel.querySelector(".voice-where")!.textContent).toBe("Lounge / Alpha");
    expect(panel.querySelector<HTMLButtonElement>(".voice-controls button")!.disabled).toBe(true);

    view.update(chat({ voice: voice({ guildName: "", url: "wss://v", token: "t", mute: true }) }));
    expect(panel.querySelector(".voice-status")!.textContent).toBe("Voice connected");
    expect(panel.querySelector(".voice-where")!.textContent).toBe("Lounge");
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>(".voice-controls button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Unmute", "Deafen", "Camera", "Share screen", "Leave"]);
    expect(buttons[0]!.getAttribute("aria-pressed")).toBe("true");

    buttons[0]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "voiceState", mute: false, deaf: false, video: false, stream: false });
    buttons[1]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: true, video: false, stream: false });
    buttons[2]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: false, video: true, stream: false });
    buttons[3]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: false, video: false, stream: true });
    buttons[4]!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "leaveVoice" });

    view.update(chat({ voice: voice({ token: "t", url: "wss://v", deaf: true, video: true, stream: true }) }));
    expect([...panel.querySelectorAll(".voice-controls button")].map((b) => b.textContent)).toEqual([
      "Mute",
      "Undeafen",
      "Camera off",
      "Stop sharing",
      "Leave",
    ]);

    view.update(chat({ voice: null }));
    expect(panel.hidden).toBe(true);
    view.update(login); // leaving the chat screen ends the call
  });
});

describe("emoji and markdown", () => {
  const withEmoji = (messages: NativeMessage[] = [msg("11")]) =>
    chat({
      emojiBase: "https://media.fx/emojis",
      customEmoji: [{ id: "55", name: "party", animated: false }],
      channel: { id: "2", name: "general", messages, loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL },
    });

  it("inserts picked emoji at the cursor and closes the picker", () => {
    view.update(withEmoji());
    const composer = root.querySelector<HTMLTextAreaElement>(".composer")!;
    composer.value = "hi there";
    composer.selectionStart = composer.selectionEnd = 2;
    const toggle = root.querySelector<HTMLButtonElement>(".emoji-button")!;
    toggle.click();
    const holder = root.querySelector<HTMLElement>(".composer-picker")!;
    expect(holder.hidden).toBe(false);
    holder.querySelector<HTMLButtonElement>(".emoji-option.custom")!.click();
    expect(composer.value).toBe("hi<:party:55> there");
    expect(holder.hidden).toBe(true);
    expect(holder.children).toHaveLength(0);

    toggle.click();
    toggle.click(); // closes again
    expect(holder.hidden).toBe(true);
  });

  it("inserts at the end without a selection", () => {
    const field = document.createElement("textarea");
    field.value = "abc";
    Object.defineProperty(field, "selectionStart", { value: null, writable: true });
    Object.defineProperty(field, "selectionEnd", { value: null, writable: true });
    insertAtCursor(field, "!");
    expect(field.value).toBe("abc!");
  });

  it("reacts with any emoji through the full picker", () => {
    view.update(withEmoji([msg("11", { reactions: [{ key: "party:55", label: ":party:", count: 1, me: true }] })]));
    [...root.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "React")!.click();
    root.querySelector<HTMLButtonElement>(".quick-reactions .more")!.click();
    const picker = root.querySelector(".message .emoji-picker")!;
    expect(picker).not.toBeNull();
    picker.querySelector<HTMLButtonElement>(".emoji-option.custom")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "react", messageId: "11", emoji: "party:55", add: false });
    expect(root.querySelector(".message .emoji-picker")).toBeNull();

    [...root.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "React")!.click();
    root.querySelector<HTMLButtonElement>(".quick-reactions .more")!.click();
    const search = root.querySelector<HTMLInputElement>(".message .emoji-search")!;
    search.value = "pizza";
    search.dispatchEvent(new Event("input"));
    root.querySelector<HTMLButtonElement>(".message .emoji-grid .emoji-option")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "react", messageId: "11", emoji: "🍕", add: true });
  });

  it("renders message markdown with the platform's custom emoji", () => {
    view.update(withEmoji([msg("11", { content: "**bold** <:party:55> ||spoiler||" })]));
    const content = root.querySelector(".message .content")!;
    expect(content.querySelector("strong")!.textContent).toBe("bold");
    expect(content.querySelector("img.emoji")!.getAttribute("src")).toBe("https://media.fx/emojis/55.webp?size=48");
    expect(content.querySelector(".spoiler")).not.toBeNull();
  });

  it("shows emoji with pictures of their own, and names those without one", () => {
    const ulid = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    view.update({
      ...withEmoji([msg("11", { content: `<:cat:${ulid}> <:mx:x.org/abc> <:gone:01BX5ZZKBKACTAV9WEVGEMMVRZ> <:big:77>` })]),
      emojiUrls: { [ulid]: "https://cdn/cat.webp", "x.org/abc": "data:image/png;base64,AA", bad: "javascript:x" },
    });
    const images = [...root.querySelectorAll<HTMLImageElement>(".message .content img.emoji")].map((i) => i.getAttribute("src"));
    expect(images).toEqual(["https://cdn/cat.webp", "data:image/png;base64,AA", "https://media.fx/emojis/77.webp?size=48"]);
    expect(root.querySelector(".message .content")!.textContent).toContain(":gone:");
    // Without an emoji base, a snowflake emoji has no picture either.
    view.update(chat({ channel: { id: "2", name: "general", messages: [msg("12", { content: "<:big:77>" })], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } }));
    expect(root.querySelector(".message .content")!.textContent).toBe(":big:");
  });

  it("disables the emoji button where the composer is disabled", () => {
    view.update(chat({ channel: null }));
    expect(root.querySelector<HTMLButtonElement>(".emoji-button")!.disabled).toBe(true);
  });

  it("locks the composer with a notice where nothing may be sent", () => {
    const notice = () => root.querySelector<HTMLElement>(".locked-notice")!;
    const composer = () => root.querySelector<HTMLTextAreaElement>(".composer")!;
    view.update(chat());
    expect(notice().hidden).toBe(true);
    view.update(chat({ channel: { id: "2", name: "general", messages: [], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL, locked: "Encrypted room" } }));
    expect(notice().hidden).toBe(false);
    expect(notice().textContent).toBe("Encrypted room");
    expect(composer().disabled).toBe(true);
    expect(composer().placeholder).toBe("");
    expect(root.querySelector<HTMLButtonElement>("button.attach")!.disabled).toBe(true);
    expect(root.querySelector<HTMLButtonElement>(".emoji-button")!.disabled).toBe(true);
    view.update(chat());
    expect(notice().hidden).toBe(true);
    expect(composer().disabled).toBe(false);
    expect(composer().placeholder).toBe("Message general");
  });
});

describe("prompt steps", () => {
  const step = (id: string, extra: Partial<Extract<NativeViewState, { screen: "prompt" }>> = {}): NativeViewState => ({
    screen: "prompt",
    platform: "Telegram",
    busy: false,
    prompt: {
      id,
      title: id === "phone" ? "Your phone number" : "Enter the code",
      description: "Telegram sends a code.",
      fields: id === "phone" ? [{ name: "phone", label: "Phone", type: "tel", autocomplete: "tel", placeholder: "+31…" }] : [{ name: "code", label: "Code", type: "number" }, { name: "password", label: "Password", type: "password" }],
      submit: "Next",
      cancel: id === "phone" ? undefined : "Use another number",
    },
    ...extra,
  });

  it("renders each step, keeps typing across updates and sends the answers", () => {
    const api = { act: vi.fn() };
    const view = new NativeView(root, api);
    view.update(step("phone"));
    const phone = root.querySelector<HTMLInputElement>('input[name="phone"]')!;
    expect(phone.type).toBe("tel");
    expect(phone.placeholder).toBe("+31…");
    expect(root.querySelector(".prompt-description")!.textContent).toBe("Telegram sends a code.");
    expect(root.querySelector("button.link")).toBeNull();
    phone.value = " +31 6 1234 ";
    view.update(step("phone", { busy: true, status: "Sending code…" }));
    expect(root.querySelector<HTMLInputElement>('input[name="phone"]')).toBe(phone); // same form
    expect(root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
    expect(root.querySelector(".status")!.textContent).toBe("Sending code…");
    view.update(step("phone", { error: "Invalid number" }));
    expect(root.querySelector(".error")!.textContent).toBe("Invalid number");
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(api.act).toHaveBeenCalledWith({ type: "prompt", id: "phone", values: { phone: "+31 6 1234" } });

    view.update(step("code"));
    const code = root.querySelector<HTMLInputElement>('input[name="code"]')!;
    expect(code.inputMode).toBe("numeric");
    code.value = " 12345 ";
    root.querySelector<HTMLInputElement>('input[name="password"]')!.value = " secret ";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(api.act).toHaveBeenLastCalledWith({ type: "prompt", id: "code", values: { code: "12345", password: " secret " } });
    root.querySelector<HTMLButtonElement>("button.link")!.click();
    expect(api.act).toHaveBeenLastCalledWith({ type: "cancelPrompt", id: "code" });
  });

  it("links to https pages only, opening them outside the app", () => {
    const view = new NativeView(root, { act: vi.fn() });
    const linked = (url: string, id: string) => step(id, { prompt: { ...(step(id) as Extract<NativeViewState, { screen: "prompt" }>).prompt, link: { url, label: "Open the page" } } });
    view.update(linked("https://account.x.org/link", "phone"));
    const link = root.querySelector<HTMLAnchorElement>("a.prompt-link")!;
    expect(link.textContent).toBe("Open the page");
    expect(link.getAttribute("href")).toBe("https://account.x.org/link");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    view.update(linked("javascript:alert(1)", "code"));
    expect(root.querySelector("a.prompt-link")).toBeNull();
    // A link needs no description.
    const bare = linked("https://account.x.org/link", "device") as Extract<NativeViewState, { screen: "prompt" }>;
    view.update({ ...bare, prompt: { ...bare.prompt, description: undefined } });
    expect(root.querySelector(".prompt-description")).toBeNull();
    expect(root.querySelector("a.prompt-link")).not.toBeNull();
  });
});

describe("voice shortcuts without a call", () => {
  it("does nothing without a connected call or a push-to-talk key", () => {
    view.update(chat({ voice: { channelId: "7", channelName: "L", guildName: "", mute: false, deaf: false, video: false, stream: false } }));
    view.voiceCommand("toggleMute");
    view.pushToTalk("Backquote", true);
    view.releaseTalk();
    view.setVoiceSettings({ ...DEFAULT_SETTINGS.voice, pushToTalk: "Backquote" });
    view.pushToTalk("Backquote", true); // connecting: no token yet
    view.update(login);
    view.voiceCommand("toggleDeafen");
    view.voiceCommand("talkStart");
    expect(act).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voiceState" }));
  });

  it("talks on the background key, and keeps talking when the window loses focus", () => {
    const live = { channelId: "7", channelName: "L", guildName: "", url: "wss://x", token: "t", mute: true, deaf: false, video: false, stream: false };
    view.update(chat({ voice: live }));
    view.voiceCommand("talkStart"); // no push-to-talk key: ignored
    expect(act).not.toHaveBeenCalledWith(expect.objectContaining({ type: "voiceState" }));
    view.setVoiceSettings({ ...DEFAULT_SETTINGS.voice, pushToTalk: "F13", pushToTalkGlobal: true });
    view.voiceCommand("talkStart");
    expect(act).toHaveBeenLastCalledWith({ type: "voiceState", mute: false, deaf: false, video: false, stream: false });
    view.update(chat({ voice: { ...live, mute: false } }));
    act.mockClear();
    view.releaseTalk(); // the hook will see the release
    expect(act).not.toHaveBeenCalled();
    view.voiceCommand("talkStop");
    expect(act).toHaveBeenLastCalledWith({ type: "voiceState", mute: true, deaf: false, video: false, stream: false });
  });
});

describe("media requests from the view", () => {
  const MB = 1024 * 1024;
  const withFiles = (attachments: NativeMessage["attachments"]) => chat({ channel: { ...chat().channel!, messages: [msg("10", { attachments })] } });
  const asked = () => act.mock.calls.flatMap(([a]) => (a.type === "loadMedia" ? [a.key] : []));

  /** An IntersectionObserver the test drives: what it watches, and a way to bring items into sight. */
  class FakeObserver {
    static last: FakeObserver | undefined;
    watched: Element[] = [];
    disconnected = 0;
    constructor(readonly callback: (entries: { isIntersecting: boolean; target: Element }[]) => void) {
      FakeObserver.last = this;
    }
    observe(target: Element) {
      this.watched.push(target);
    }
    disconnect() {
      this.watched = [];
      this.disconnected++;
    }
    show(key: string, isIntersecting = true) {
      this.callback(this.watched.filter((t) => (t as HTMLElement).dataset.autoLoad === key).map((target) => ({ isIntersecting, target })));
    }
  }

  it("loads link preview pictures by itself like attachments", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    view.setMediaAutoLoad(5 * MB);
    view.update(
      chat({
        channel: {
          ...chat().channel!,
          messages: [msg("10", { embeds: [{ title: "a", image: { mediaKey: "e:1", size: 10 } }, { title: "b" }, { title: "c", image: { url: "https://x/y.png" } }] })],
        },
      }),
    );
    expect(asked()).toEqual(["e:1"]);
  });

  it("asks the engine for held-back media once", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const state = withFiles([{ name: "s", kind: "sticker", mediaKey: "m:1" }]);
    view.update(state);
    view.update(state);
    expect(asked()).toEqual(["m:1"]);
  });

  it("loads media up to the service's limit by itself, three at a time, and the rest on a click", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    // Before the shell says, nothing loads by itself, and a limit before any chat changes nothing shown.
    view.setMediaAutoLoad(5 * MB);
    const files: NativeMessage["attachments"] = [
      { name: "a.jpg", kind: "image", mediaKey: "m:1", size: MB },
      { name: "b.jpg", kind: "image", mediaKey: "m:2" },
      { name: "c.mp4", kind: "video", mediaKey: "m:3", size: 10 * MB },
      { name: "d", kind: "sticker", mediaKey: "m:4" },
      { name: "e.ogg", kind: "audio", mediaKey: "m:5", size: 2 * MB },
      { name: "f.jpg", kind: "image", mediaKey: "m:6", size: 3 * MB },
      { name: "g.zip", kind: "file", mediaKey: "m:7", size: 1 },
    ];
    view.update(withFiles(files));
    expect(asked()).toEqual(["m:1", "m:4", "m:5"]);
    const unknown = [...root.querySelectorAll<HTMLButtonElement>("button.load")].find((b) => b.textContent!.includes("b.jpg"))!;
    expect(unknown.title).toBe("Load this image. Its size is unknown, so it does not load by itself.");

    // The engine answers one (shown) and fails another (no key any more): two places free.
    const answered = files.map((f) => (f.mediaKey === "m:1" ? { ...f, url: "data:image/jpeg;base64,AA", mediaKey: undefined } : f.mediaKey === "m:4" ? { ...f, mediaKey: undefined, unavailable: "failed" } : f));
    view.update(withFiles(answered));
    expect(asked()).toEqual(["m:1", "m:4", "m:5", "m:6"]);
    view.update(withFiles(answered));
    expect(asked()).toHaveLength(4);

    // A click asks at once; a larger limit lets more load by itself, but a failed or answered key is never asked again.
    unknown.click();
    view.setMediaAutoLoad(Number.POSITIVE_INFINITY);
    expect(asked()).toEqual(["m:1", "m:4", "m:5", "m:6", "m:2", "m:3"]);
    view.update(withFiles(files));
    expect(asked()).toHaveLength(6);
  });

  it("frees the place of a load the engine never answers", () => {
    vi.useFakeTimers();
    vi.stubGlobal("IntersectionObserver", undefined);
    view.setMediaAutoLoad(Number.POSITIVE_INFINITY);
    view.update(withFiles(["1", "2", "3", "4"].map((n) => ({ name: n, kind: "image" as const, mediaKey: `m:${n}` }))));
    expect(asked()).toEqual(["m:1", "m:2", "m:3"]);
    vi.advanceTimersByTime(AUTO_LOAD_TIMEOUT_MS);
    expect(asked()).toEqual(["m:1", "m:2", "m:3", "m:4"]);
    // Gone from the conversation: no longer waited for.
    view.update(withFiles(["5", "6", "7", "8", "9"].map((n) => ({ name: n, kind: "image" as const, mediaKey: `m:${n}` }))));
    expect(asked().slice(4)).toEqual(["m:5", "m:6", "m:7"]);
    view.update(chat({ channel: null }));
    vi.advanceTimersByTime(AUTO_LOAD_TIMEOUT_MS);
    expect(asked()).toHaveLength(7);
  });

  it("asks for media that loads by itself only once it comes into sight", () => {
    vi.stubGlobal("IntersectionObserver", FakeObserver);
    view.setMediaAutoLoad(5 * MB);
    const state = withFiles([
      { name: "a.jpg", kind: "image", mediaKey: "m:1", size: MB },
      { name: "b.jpg", kind: "image", mediaKey: "m:2", size: MB },
    ]);
    view.update(state);
    const observer = FakeObserver.last!;
    expect(observer.watched).toHaveLength(2);
    expect(asked()).toEqual([]);
    observer.show("m:2", false);
    expect(asked()).toEqual([]);
    observer.show("m:2");
    observer.show("m:2");
    expect(asked()).toEqual(["m:2"]);
    // Re-rendered items are watched afresh by the same observer; a new screen gets a new one.
    view.update(state);
    expect([FakeObserver.last, observer.watched.length]).toEqual([observer, 2]);
    view.update(login);
    view.update(state);
    expect(FakeObserver.last).not.toBe(observer);
    expect(observer.disconnected).toBeGreaterThan(1);
  });

  it("stops waiting for a place for media the picker asked for meanwhile", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    view.setMediaAutoLoad(Number.POSITIVE_INFINITY);
    const stickers = [{ id: "p", name: "Pack", stickers: [{ id: "s4", name: "Four", format: "webp" as const, mediaKey: "m:4" }] }];
    const files = ["1", "2", "3", "4"].map((n) => ({ name: n, kind: "image" as const, mediaKey: `m:${n}` }));
    const state = (attachments: NativeMessage["attachments"]): Chat => ({ ...chat({ channel: { ...chat().channel!, can: { ...ALL, stickers: true }, messages: [msg("10", { attachments })] } }), stickers });
    view.update(state(files));
    expect(asked()).toEqual(["m:1", "m:2", "m:3"]);
    root.querySelector<HTMLButtonElement>(".emoji-button")!.click();
    root.querySelector<HTMLButtonElement>('.picker-tab[data-tab="stickers"]')!.click();
    expect(asked()).toEqual(["m:1", "m:2", "m:3", "m:4"]);
    // A place frees: nothing is left waiting for it.
    view.update(state(files.slice(1)));
    expect(asked()).toHaveLength(4);
  });
});

describe("member panel", () => {
  const WITH_MEMBERS = { ...ALL, members: true };
  const list = { sections: [{ name: "Members", members: [{ id: "5", name: "Ana", presence: "online" }] }], hasMore: true, loading: false };
  const state = (can: unknown, members?: unknown) =>
    chat({ channel: { ...chat().channel!, can: can as typeof ALL, ...(members === undefined ? {} : { members: members as never }) } });
  const toggle = () => root.querySelector<HTMLButtonElement>(".members-toggle")!;
  const panel = () => root.querySelector<HTMLElement>("#member-panel")!;

  it("is offered only where the conversation lists its members", () => {
    view.update(state(ALL));
    expect(toggle().hidden).toBe(true);
    view.update(state(WITH_MEMBERS));
    expect(toggle().hidden).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe("member-panel");
    expect(panel().hidden).toBe(true);
    view.update(chat({ channel: null }));
    expect(toggle().hidden).toBe(true);
    // A list without the flag stays hidden.
    view.update(state(ALL, list));
    expect(panel().hidden).toBe(true);
    expect(root.querySelector(".conversation-name")!.textContent).toBe("general");
  });

  it("opens and closes through the module, which then sends the list", () => {
    view.update(state(WITH_MEMBERS));
    toggle().click();
    expect(act).toHaveBeenLastCalledWith({ type: "members", open: true });
    view.update(state(WITH_MEMBERS, list));
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect(panel().getAttribute("aria-label")).toBe("Members");
    expect(panel().querySelector(".member-name")!.textContent).toBe("Ana");
    expect(panel().querySelector(".presence.online")).not.toBeNull();
    toggle().click();
    expect(act).toHaveBeenLastCalledWith({ type: "members", open: false });
    view.update(state(WITH_MEMBERS));
    expect(panel().hidden).toBe(true);
    expect(panel().children).toHaveLength(0);
  });

  it("loads more from the number listed, keeping focus on the button across updates", () => {
    view.update(state(WITH_MEMBERS, list));
    const more = panel().querySelector<HTMLButtonElement>(".member-more")!;
    more.focus();
    view.update(state(WITH_MEMBERS, list));
    const again = panel().querySelector<HTMLButtonElement>(".member-more")!;
    expect(again).not.toBe(more);
    expect(document.activeElement).toBe(again);
    again.click();
    expect(act).toHaveBeenLastCalledWith({ type: "loadMembers", offset: 1 });
    // Focus outside the panel stays where it is.
    root.querySelector<HTMLTextAreaElement>(".composer")!.focus();
    view.update(state(WITH_MEMBERS, { ...list, loading: true }));
    expect(document.activeElement).toBe(root.querySelector(".composer"));
    expect(panel().textContent).toContain("Loading members…");
  });

  it("drops focus quietly when its control is gone", () => {
    view.update(state(WITH_MEMBERS, list));
    panel().querySelector<HTMLButtonElement>(".member-more")!.focus();
    view.update(state(WITH_MEMBERS, { ...list, hasMore: false }));
    expect(panel().querySelector(".member-more")).toBeNull();
  });
});

describe("pinned messages panel", () => {
  const WITH_PINS = { ...ALL, pins: true };
  const pinned = (id: string, timestamp = "2026-10-14T12:00:00Z") => ({ id, author: "Ana", content: `pin ${id}`, timestamp });
  const state = (can: unknown, pins?: unknown, extra: Partial<NonNullable<Chat["channel"]>> = {}) =>
    chat({ channel: { ...chat().channel!, can: can as typeof ALL, ...(pins === undefined ? {} : { pins: pins as never }), ...extra } });
  const toggle = () => root.querySelector<HTMLButtonElement>(".pins-toggle")!;
  const panel = () => root.querySelector<HTMLElement>("#message-panel")!;
  const loads = () => act.mock.calls.filter(([a]) => a.type === "loadOlder").length;

  it("is offered only where the conversation lists its pins, and opens and closes through the module", () => {
    view.update(state(ALL, { messages: [pinned("10")], loading: false }));
    expect(toggle().hidden).toBe(true);
    expect(panel().hidden).toBe(true);
    view.update(state(WITH_PINS));
    expect(toggle().hidden).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    toggle().click();
    expect(act).toHaveBeenLastCalledWith({ type: "pins", open: true });
    view.update(state(WITH_PINS, { messages: [], loading: false }));
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(panel().hidden).toBe(false);
    expect(panel().getAttribute("aria-label")).toBe("Pinned messages");
    expect(panel().textContent).toContain("No pinned messages.");
    panel().querySelector<HTMLButtonElement>(".profile-close")!.focus();
    view.update(state(WITH_PINS, { messages: [], loading: true }));
    expect(document.activeElement).toBe(panel().querySelector(".profile-close"));
    toggle().click();
    expect(act).toHaveBeenLastCalledWith({ type: "pins", open: false });
    panel().querySelector<HTMLButtonElement>(".profile-close")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "pins", open: false });
    view.update(chat({ channel: null }));
    expect(toggle().hidden).toBe(true);
    expect(panel().children).toHaveLength(0);
  });

  it("pins and unpins from the message menu", () => {
    view.update(state(WITH_PINS, undefined, { messages: [msg("10", { canPin: true, pinned: true })] }));
    [...root.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "Unpin")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "pin", messageId: "10", pin: false });
  });

  it("jumps to a loaded pinned message and marks it, keeping focus in the panel", () => {
    const list = { messages: [pinned("10")], loading: false };
    view.update(state(WITH_PINS, list));
    const button = panel().querySelector<HTMLButtonElement>(".listed-message")!;
    button.focus();
    button.click();
    expect(root.querySelector('li.message[data-id="10"]')!.classList.contains("jump-target")).toBe(true);
    expect(document.activeElement).toBe(panel().querySelector(".listed-message"));
    expect(loads()).toBe(0);
    // Another conversation drops the mark.
    view.update(chat({ channel: { ...state(WITH_PINS).channel!, id: "3", messages: [msg("10")] } }));
    expect(root.querySelector(".jump-target")).toBeNull();
  });

  it("loads older pages to reach a pinned message, and says when it cannot be reached", () => {
    const list = { messages: [pinned("5", "2026-10-14T11:00:00Z")], loading: false };
    view.update(state(WITH_PINS, list, { hasOlder: true }));
    panel().querySelector<HTMLButtonElement>(".listed-message")!.click();
    expect(loads()).toBe(1);
    view.update(state(WITH_PINS, list, { hasOlder: true, messages: [msg("8"), msg("10")] }));
    expect(loads()).toBe(2);
    view.update(state(WITH_PINS, list, { hasOlder: true, messages: [msg("5"), msg("8"), msg("10")] }));
    expect(root.querySelector('li.message[data-id="5"]')!.classList.contains("jump-target")).toBe(true);
    expect(loads()).toBe(2);
    // Older messages loaded without it: it is gone, and the panel says so.
    const gone = { messages: [pinned("4", "2026-10-14T12:30:00Z")], loading: false };
    view.update(state(WITH_PINS, gone, { hasOlder: true }));
    panel().querySelector<HTMLButtonElement>(".listed-message")!.click();
    expect(loads()).toBe(2);
    expect(panel().querySelector(".member-error")!.textContent).toBe("That message could not be loaded here.");
    // Nothing older at all.
    view.update(state(WITH_PINS, list, { hasOlder: false }));
    panel().querySelector<HTMLButtonElement>(".listed-message")!.click();
    expect(panel().textContent).toContain("could not be loaded");
  });

  it("gives up after a number of pages", async () => {
    const { MAX_JUMP_PAGES } = await import("../../src/renderer/native");
    const list = { messages: [pinned("1", "2000-01-01T00:00:00Z")], loading: false };
    view.update(state(WITH_PINS, list, { hasOlder: true }));
    panel().querySelector<HTMLButtonElement>(".listed-message")!.click();
    for (let page = 0; page < MAX_JUMP_PAGES + 2; page++) view.update(state(WITH_PINS, list, { hasOlder: true, messages: [msg(String(100 - page))] }));
    expect(loads()).toBe(MAX_JUMP_PAGES);
    expect(panel().textContent).toContain("could not be loaded");
  });
});

describe("profile cards", () => {
  const card = () => root.querySelector<HTMLElement>(".profile-card")!;
  const withAuthor = (extra: Partial<Chat> = {}) => chat({ channel: { ...chat().channel!, messages: [msg("10", { authorId: "7", avatarUrl: "https://x/a.png" })] }, ...extra });

  it("opens from a message's author with what the view knows, then adds the module's answer", () => {
    view.update(withAuthor());
    expect(card().hidden).toBe(true);
    root.querySelector<HTMLButtonElement>("button.author")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "profile", id: "7" });
    expect(card().hidden).toBe(false);
    expect(card().getAttribute("role")).toBe("dialog");
    expect(card().querySelector(".profile-name")!.textContent).toBe("Ana");
    expect(card().querySelector("img.avatar")!.getAttribute("src")).toBe("https://x/a.png");
    expect(document.activeElement).toBe(card().querySelector(".profile-close"));
    // An answer about someone else is not shown; one about them is, over what the view had.
    view.update(withAuthor({ profile: { id: "8", name: "Bo", about: "Not Ana" } }));
    expect(card().textContent).not.toContain("Not Ana");
    view.update(withAuthor({ profile: { id: "7", about: "Hi there", username: "@ana", loading: true } }));
    expect(card().querySelector(".profile-name")!.textContent).toBe("Ana");
    expect(card().querySelector(".profile-about")!.textContent).toBe("Hi there");
    expect(document.activeElement).toBe(card().querySelector(".profile-close"));
    view.update(withAuthor({ profile: { id: "7", name: "Ana Bo", about: "Hi there" } }));
    expect(card().querySelector(".profile-name")!.textContent).toBe("Ana Bo");
    expect(card().textContent).not.toContain("Loading…");
  });

  it("closes with its button, with Escape, and when the conversation changes", () => {
    view.update(withAuthor());
    root.querySelector<HTMLButtonElement>(".avatar-button")!.click();
    card().querySelector<HTMLButtonElement>(".profile-close")!.click();
    expect(card().hidden).toBe(true);
    expect(card().children).toHaveLength(0);
    root.querySelector<HTMLButtonElement>("button.author")!.click();
    card().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(card().hidden).toBe(false);
    card().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(card().hidden).toBe(true);
    root.querySelector<HTMLButtonElement>("button.author")!.click();
    view.update(chat({ channel: { ...chat().channel!, id: "3" } }));
    expect(card().hidden).toBe(true);
  });

  it("opens from a member row with the row's presence and status", () => {
    const list = { sections: [{ name: "Members", members: [{ id: "9", name: "Cy", presence: "idle", status: "Bot" }] }], hasMore: false, loading: false };
    view.update(chat({ channel: { ...chat().channel!, can: { ...ALL, members: true }, members: list as never } }));
    root.querySelector<HTMLButtonElement>("button.member")!.click();
    expect(act).toHaveBeenLastCalledWith({ type: "profile", id: "9" });
    expect(card().querySelector(".profile-status")!.textContent).toBe("Idle · Bot");
    // A member row keeps focus across updates by its id.
    const row = root.querySelector<HTMLButtonElement>("button.member")!;
    row.focus();
    view.update(chat({ channel: { ...chat().channel!, can: { ...ALL, members: true }, members: list as never } }));
    expect(document.activeElement).toBe(root.querySelector("button.member"));
    expect(document.activeElement).not.toBe(row);
  });
});

describe("media picker and favourites", () => {
  const FAV = "a".repeat(64);
  const module = { name: "Fluxer", label: "FX", color: "#4f8cf7" };
  const state = (over: Partial<FavouritesState> = {}): FavouritesState => ({
    categories: [],
    items: [
      {
        id: FAV,
        kind: "gif",
        name: "Dance",
        mime: "image/gif",
        animated: true,
        size: 5,
        categories: [],
        source: { platform: "Stoat", label: "ST", color: "#ff4655" },
        addedAt: 1,
        origin: "https://cdn/dance.gif",
        cached: true,
      },
    ],
    module,
    saving: [],
    ...over,
  });
  let favourites: ReturnType<typeof vi.fn<NativeApi["favourites"]>>;
  const media = [
    { name: "dance.gif", kind: "image" as const, url: "https://cdn/dance.gif", mime: "image/gif" },
    { name: "cat.png", kind: "image" as const, url: "https://cdn/cat.png" },
    { name: "GIF", kind: "video" as const, url: "https://cdn/loop.mp4", loop: true },
  ];
  const stickers = [
    {
      id: "p1",
      name: "Cats",
      stickers: [
        { id: "s1", name: "Wave", format: "webp" as const, url: "https://cdn/s1.webp" },
        { id: "s2", name: "Later", format: "png" as const, mediaKey: "st:2" },
      ],
    },
  ];
  const withMedia = (can: Record<string, boolean> = {}, extra: Partial<Chat> = {}) =>
    chat({
      stickers,
      emojiBase: "https://media.fx/emojis",
      customEmoji: [
        { id: "55", name: "party", animated: false, source: "Alpha" },
        { id: "56", name: "noreact", animated: false, react: false },
      ],
      gifs: { query: "", results: [{ id: "g1", url: "https://gifs/g1", preview: "https://gifs/g1.gif", video: false }], loading: false },
      channel: {
        id: "2",
        name: "general",
        messages: [msg("10", { attachments: media }), msg("11", { attachments: [media[0]!] })],
        loading: false,
        hasOlder: false,
        typing: [],
        pending: [],
        uploading: false,
        can: { ...ALL, ...can },
      },
      ...extra,
    });
  const open = () => root.querySelector<HTMLButtonElement>(".emoji-button")!.click();
  const tab = (name: string) => root.querySelector<HTMLButtonElement>(`.picker-tab[data-tab="${name}"]`)!.click();
  const pick = (key: string) => root.querySelector<HTMLButtonElement>(`[data-key="${key}"]`)!.click();
  const reply = () => [...root.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "Reply")!.click();

  beforeEach(() => {
    favourites = vi.fn<NativeApi["favourites"]>();
    view = new NativeView(root, { act, favourites });
  });

  it("stars media in messages, and unstars what is kept", () => {
    view.update(withMedia());
    view.setFavourites(state());
    const stars = [...root.querySelectorAll<HTMLButtonElement>(".message .favourite-star")];
    expect(stars.map((s) => s.textContent)).toEqual(["★", "☆", "☆", "★"]);
    stars[1]!.click();
    expect(favourites).toHaveBeenLastCalledWith({ type: "add", url: "https://cdn/cat.png", kind: "image", name: "cat.png", place: "general" });
    stars[0]!.click();
    expect(favourites).toHaveBeenLastCalledWith({ type: "remove", id: FAV });
    // A nameless file in a nameless conversation still gets saved.
    view.update(chat({ channel: { id: "2", name: " ", messages: [msg("12", { attachments: [{ name: " ", kind: "image", url: "https://cdn/x.png" }] })], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } }));
    root.querySelector<HTMLButtonElement>(".favourite-star")!.click();
    expect(favourites).toHaveBeenLastCalledWith({ type: "add", url: "https://cdn/x.png", kind: "image", name: "Media" });
  });

  it("shows no stars and sends no files without the shell's favourites", () => {
    view = new NativeView(root, { act });
    view.update(withMedia());
    expect(root.querySelector(".favourite-star")).toBeNull();
    open();
    tab("favourites");
    expect(root.querySelector(".picker-note")!.textContent).toBe("This conversation takes no files, so favourites cannot be sent here.");
  });

  it("sends the module's stickers as stickers where it may, with the reply", () => {
    view.update(withMedia({ stickers: true }));
    view.setFavourites(state());
    reply();
    open();
    tab("stickers");
    expect(root.querySelector(".picker-heading")!.textContent).toBe("FXCats");
    expect(act).toHaveBeenCalledWith({ type: "loadMedia", key: "st:2" });
    pick("sticker:p1:s1");
    expect(act).toHaveBeenCalledWith({ type: "sendSticker", stickerId: "s1", replyTo: "10" });
    expect(root.querySelector(".media-picker")).toBeNull();
    expect(root.querySelector<HTMLElement>(".reply-bar")!.hidden).toBe(true);
    open();
    tab("stickers");
    pick("sticker:p1:s1");
    expect(act).toHaveBeenCalledWith({ type: "sendSticker", stickerId: "s1" });
  });

  it("sends stickers as files where they cannot go as stickers", () => {
    view.update(withMedia({ stickers: false }));
    open();
    tab("stickers");
    pick("sticker:p1:s1");
    expect(favourites).toHaveBeenLastCalledWith({ type: "sendMedia", url: "https://cdn/s1.webp", name: "Wave" });
    reply();
    open();
    tab("stickers");
    pick("sticker:p1:s1");
    expect(favourites).toHaveBeenLastCalledWith({ type: "sendMedia", url: "https://cdn/s1.webp", name: "Wave", replyTo: "10" });
  });

  it("searches and sends the platform's GIFs, and sends GIFs seen here as files", () => {
    view.update(withMedia({ gifs: true }));
    view.setFavourites(state());
    open();
    tab("gifs");
    expect(act).toHaveBeenCalledWith({ type: "searchGifs", query: "" });
    pick("gif:g1");
    expect(act).toHaveBeenCalledWith({ type: "send", content: "https://gifs/g1" });
    reply();
    open();
    tab("gifs");
    pick("gif:g1");
    expect(act).toHaveBeenCalledWith({ type: "send", content: "https://gifs/g1", replyTo: "10" });
    open();
    tab("gifs");
    // Seen here: newest first, once each.
    const recent = [...root.querySelectorAll<HTMLElement>('[data-key^="recent:"]')].map((b) => b.dataset.key);
    expect(recent).toEqual(["recent:https://cdn/dance.gif", "recent:https://cdn/loop.mp4"]);
    pick("recent:https://cdn/loop.mp4");
    expect(favourites).toHaveBeenLastCalledWith({ type: "sendMedia", url: "https://cdn/loop.mp4", name: "GIF" });
    reply();
    open();
    tab("gifs");
    pick("recent:https://cdn/loop.mp4");
    expect(favourites).toHaveBeenLastCalledWith({ type: "sendMedia", url: "https://cdn/loop.mp4", name: "GIF", replyTo: "10" });
  });

  it("sends favourites, and changes them from the picker", () => {
    view.update(withMedia());
    view.setFavourites(state());
    open();
    tab("favourites");
    root.querySelector<HTMLButtonElement>(".picker-manage")!.click();
    const input = root.querySelector<HTMLInputElement>('[data-key="new-category"]')!;
    input.value = "Cats";
    root.querySelector<HTMLFormElement>(".picker-new-category")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(favourites).toHaveBeenLastCalledWith({ type: "createCategory", name: "Cats" });
    pick(`fav:${FAV}`);
    expect(favourites).toHaveBeenLastCalledWith({ type: "send", id: FAV });
    reply();
    open();
    tab("favourites");
    pick(`fav:${FAV}`);
    expect(favourites).toHaveBeenLastCalledWith({ type: "send", id: FAV, replyTo: "10" });
  });

  it("inserts custom emoji with where they come from, and reacts only with those that may", () => {
    view.update(withMedia());
    view.setFavourites(state());
    open();
    expect(root.querySelector(".media-picker .picker-heading")!.textContent).toBe("FXAlpha");
    expect(root.querySelectorAll(".media-picker .emoji-option.custom")).toHaveLength(2);
    [...root.querySelectorAll<HTMLButtonElement>(".message-actions button")].find((b) => b.textContent === "React")!.click();
    root.querySelector<HTMLButtonElement>(".quick-reactions .more")!.click();
    expect(root.querySelectorAll(".message .emoji-picker .emoji-option.custom")).toHaveLength(1);
  });

  it("keeps the picker current, and closes it on Escape, on switching or when sending is off", () => {
    view.update(withMedia({ stickers: true }));
    open();
    tab("stickers");
    expect(root.querySelector<HTMLButtonElement>('[data-key="sticker:p1:s2"]')!.disabled).toBe(true);
    const loaded = [{ ...stickers[0]!, stickers: [stickers[0]!.stickers[0]!, { id: "s2", name: "Later", format: "png" as const, url: "https://cdn/s2.png" }] }];
    view.update(withMedia({ stickers: true }, { stickers: loaded }));
    expect(root.querySelector<HTMLButtonElement>('[data-key="sticker:p1:s2"]')!.disabled).toBe(false);
    // Asked for once, however often it renders.
    expect(act.mock.calls.filter(([a]) => a.type === "loadMedia")).toHaveLength(1);
    expect(root.querySelector(".emoji-button")!.getAttribute("aria-expanded")).toBe("true");
    expect(act).toHaveBeenCalledWith({ type: "picker", open: true });
    expect(act).not.toHaveBeenCalledWith({ type: "picker", open: false });
    root.querySelector(".media-picker")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(root.querySelector(".media-picker")).toBeNull();
    expect(root.querySelector(".emoji-button")!.getAttribute("aria-expanded")).toBe("false");
    expect(act).toHaveBeenLastCalledWith({ type: "picker", open: false });
    expect(document.activeElement).toBe(root.querySelector(".emoji-button"));
    open();
    view.update(chat({ channel: { id: "3", name: "Ana", messages: [], loading: false, hasOlder: false, typing: [], pending: [], uploading: false, can: ALL } }));
    expect(root.querySelector(".media-picker")).toBeNull();
    open();
    view.update(chat({ channel: { id: "3", name: "Ana", messages: [], loading: false, hasOlder: false, typing: [], pending: [], uploading: true, can: ALL } }));
    expect(root.querySelector(".media-picker")).toBeNull();
    // Signing out leaves no picker behind.
    view.update(login);
    view.update(withMedia());
    expect(root.querySelector(".media-picker")).toBeNull();
  });

  it("inserts a picked emoji and closes", () => {
    view.update(withMedia());
    open();
    root.querySelector<HTMLButtonElement>(".media-picker .emoji-option.custom")!.click();
    expect(root.querySelector<HTMLTextAreaElement>(".composer")!.value).toBe("<:party:55>");
    expect(root.querySelector(".media-picker")).toBeNull();
  });
});
