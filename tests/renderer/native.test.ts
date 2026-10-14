// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatTime, NativeView, startNative } from "../../src/renderer/native";
import type { NativeApi } from "../../src/preload/native";
import type { NativeMessage, NativeViewState } from "../../src/shared/native";

type Chat = Extract<NativeViewState, { screen: "chat" }>;

const login: NativeViewState = { screen: "login", platform: "Fluxer", identity: "email", busy: false };

function msg(id: string, extra: Partial<NativeMessage> = {}): NativeMessage {
  return { id, author: "Ana", content: `text ${id}`, timestamp: "2026-10-14T12:00:00Z", edited: false, mine: false, attachments: [], ...extra };
}

function chat(extra: Partial<Chat> = {}): Chat {
  return {
    screen: "chat",
    platform: "Fluxer",
    title: "Alpha",
    me: "me",
    sidebar: [
      { id: "1", name: "Text", kind: "category", unread: false, mentions: 0, active: false },
      { id: "2", name: "general", kind: "text", unread: true, mentions: 3, active: true },
      { id: "3", name: "Ana", kind: "dm", iconUrl: "https://media/a.png", unread: false, mentions: 120, active: false },
      { id: "4", name: "Bo", kind: "dm", unread: false, mentions: 0, active: false },
    ],
    channel: { id: "2", name: "general", messages: [msg("10")], loading: false, hasOlder: false },
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
    view.update({ screen: "mfa", platform: "Fluxer", busy: false });
    const code = root.querySelector<HTMLInputElement>('input[name="code"]')!;
    code.value = " 123456 ";
    root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(act).toHaveBeenCalledWith({ type: "mfa", code: "123456" });
    view.update({ screen: "mfa", platform: "Fluxer", busy: true, error: "Invalid code" });
    expect(root.querySelector<HTMLButtonElement>("button.primary")!.disabled).toBe(true);
    expect(root.querySelector(".error")!.textContent).toBe("Invalid code");
    root.querySelector<HTMLButtonElement>("button.link")!.click();
    expect(act).toHaveBeenCalledWith({ type: "cancelMfa" });
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
          messages: [
            msg("10", {
              content: "<img src=x onerror=alert(1)>",
              edited: true,
              avatarUrl: "https://media/a.png",
              attachments: [
                { name: "cat.png", url: "https://media/cat.png", image: true },
                { name: "notes.txt", url: "https://media/notes.txt", image: false },
                { name: "old.png", image: false },
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
    view.update(chat({ channel: { id: "2", name: "general", messages: [msg("10")], loading: false, hasOlder: true } }));
    const older = root.querySelector<HTMLButtonElement>("button.older")!;
    expect(older.textContent).toBe("Load older messages");
    older.click();
    expect(act).toHaveBeenCalledWith({ type: "loadOlder" });
    view.update(chat({ channel: { id: "2", name: "general", messages: [msg("10")], loading: true, hasOlder: true } }));
    expect(root.querySelector<HTMLButtonElement>("button.older")!.disabled).toBe(true);
    view.update(chat({ channel: { id: "2", name: "general", messages: [], loading: true, hasOlder: false } }));
    expect(root.querySelector(".older-row")!.textContent).toBe("Loading…");
  });

  it("keeps the reader's place when older messages arrive and follows new ones at the bottom", () => {
    view.update(chat());
    const list = root.querySelector<HTMLElement>(".messages")!;
    // Each rendered message is 500px tall.
    Object.defineProperty(list, "scrollHeight", { get: () => list.children.length * 500, configurable: true });
    Object.defineProperty(list, "clientHeight", { value: 400, configurable: true });
    const update = (...ids: string[]) =>
      view.update(chat({ channel: { id: "2", name: "general", messages: ids.map((id) => msg(id)), loading: false, hasOlder: false } }));

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
    const api: NativeApi = { onState: (cb) => (push = cb), act: vi.fn() };
    startNative(document, api);
    expect(api.act).toHaveBeenCalledWith({ type: "ready" });
    push(login);
    expect(document.querySelector("form.auth")).not.toBeNull();
  });
});
