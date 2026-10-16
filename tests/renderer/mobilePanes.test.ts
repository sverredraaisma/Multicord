// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("livekit-client", () => import("../mocks/livekit"));

import { attachMobilePanes } from "../../src/renderer/mobilePanes";
import { startNative } from "../../src/renderer/native";
import type { NativeApi } from "../../src/preload/native";
import type { AudioRoutes, NativeViewState } from "../../src/shared/native";

const chat = (channel: string | null): NativeViewState =>
  ({
    screen: "chat",
    platform: "Matrix",
    title: "Home",
    me: "Ana",
    sidebar: [{ id: "1", name: "general", kind: "text", unread: false, mentions: 0 }],
    channel: channel === null ? null : { id: channel, name: "general", messages: [], loading: false, hasOlder: false, typing: [], pending: [], can: { reply: true, react: true, attach: true, typing: true, members: false } },
    voice: null,
  }) as unknown as NativeViewState;

function panes() {
  let state: (s: NativeViewState) => void = () => {};
  let back: () => boolean = () => false;
  const view = attachMobilePanes(document, { onState: (cb) => (state = cb), onBack: (cb) => (back = cb) });
  return { view, state: (s: NativeViewState) => state(s), back: () => back() };
}

beforeEach(() => {
  document.documentElement.className = "";
  delete document.documentElement.dataset.pane;
  document.body.replaceChildren();
});

describe("the chat view's panes on a phone", () => {
  it("starts on the list, under the mobile class", () => {
    const { view } = panes();
    expect(document.documentElement.classList.contains("mobile")).toBe(true);
    expect(view.pane()).toBe("list");
    expect(document.documentElement.dataset.pane).toBe("list");
    expect(document.querySelector<HTMLButtonElement>(".mobile-back")!.hidden).toBe(true);
  });

  it("shows a conversation once one opens, and goes back to the list", () => {
    const { view, state, back } = panes();
    state(chat("1"));
    expect(view.pane()).toBe("conversation");
    expect(document.querySelector<HTMLButtonElement>(".mobile-back")!.hidden).toBe(false);
    // Updates of the same conversation leave the pane alone.
    expect(back()).toBe(true);
    state(chat("1"));
    expect(view.pane()).toBe("list");
    expect(back()).toBe(false);
    state(chat(null));
    expect(view.pane()).toBe("list");
    state({ screen: "connecting", platform: "Matrix", status: "" });
    expect(view.pane()).toBe("list");
  });

  it("shows the conversation picked from the list, even the one already open", () => {
    const { view } = panes();
    const list = document.createElement("ul");
    list.className = "channels";
    const channel = document.createElement("button");
    channel.className = "channel";
    list.append(channel);
    document.body.append(list);
    channel.click();
    expect(view.pane()).toBe("conversation");
    document.querySelector<HTMLButtonElement>(".mobile-back")!.click();
    expect(view.pane()).toBe("list");
    document.body.click();
    expect(view.pane()).toBe("list");
  });

  it("is only set up by a bridge that has back presses", () => {
    document.body.innerHTML = '<div id="app"></div>';
    const api = { onState: vi.fn(), act: vi.fn(), screenAudioEnded: vi.fn(), onVoiceSettings: vi.fn(), onMediaAutoLoad: vi.fn(), onCompact: vi.fn(), onVoiceCommand: vi.fn(), onFavourites: vi.fn(), favourites: vi.fn() } satisfies NativeApi;
    startNative(document, api);
    expect(document.documentElement.classList.contains("mobile")).toBe(false);
    document.body.innerHTML = '<div id="app"></div>';
    const onBack = vi.fn();
    startNative(document, { ...api, onBack });
    expect(document.documentElement.classList.contains("mobile")).toBe(true);
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("calls on a phone", () => {
  const inCall = (): NativeViewState => ({ ...chat("1"), voice: { channelId: "v", channelName: "Lounge", guildName: "", url: "wss://v", token: "t", mute: false, deaf: false, video: false, stream: false } }) as NativeViewState;
  const labels = () => [...document.querySelectorAll(".voice-controls button")].map((b) => b.textContent);

  function phone(withRoutes: boolean) {
    document.body.innerHTML = '<div id="app"></div>';
    const states: ((s: NativeViewState) => void)[] = [];
    let routes: (r: unknown) => void = () => {};
    const api = {
      onState: (cb: (s: NativeViewState) => void) => void states.push(cb),
      act: vi.fn(),
      screenAudioEnded: vi.fn(),
      onVoiceSettings: vi.fn(),
      onMediaAutoLoad: vi.fn(),
      onCompact: vi.fn(),
      onVoiceCommand: vi.fn(),
      onFavourites: vi.fn(),
      favourites: vi.fn(),
      onBack: vi.fn(),
      ...(withRoutes ? { onAudioRoutes: (cb: (r: AudioRoutes) => void) => void (routes = cb as (r: unknown) => void), setAudioRoute: vi.fn() } : {}),
    } satisfies NativeApi;
    startNative(document, api);
    return { api, state: (s: NativeViewState) => states.forEach((cb) => cb(s)), routes: (r: unknown) => routes(r) };
  }

  it("has no screen sharing, and no route button until the phone reports routes", () => {
    const { state } = phone(false);
    state(inCall());
    expect(labels()).toEqual(["Mute", "Deafen", "Camera", "Leave"]);
  });

  it("switches to the next available audio route, and ignores malformed reports", () => {
    const { api, state, routes } = phone(true);
    state(inCall());
    routes({ current: "earpiece", available: ["earpiece"] });
    expect(labels()).toEqual(["Mute", "Deafen", "Camera", "Leave"]);
    routes({ current: "earpiece", available: ["earpiece", "speaker", "bluetooth"] });
    expect(labels()).toEqual(["Mute", "Deafen", "Camera", "Earpiece", "Leave"]);
    const route = document.querySelector<HTMLButtonElement>(".audio-route")!;
    expect(route.title).toBe("Playing through the earpiece; switch to the speaker");
    route.click();
    expect(api.setAudioRoute).toHaveBeenCalledWith("speaker");
    routes({ current: "bluetooth", available: ["earpiece", "speaker", "bluetooth"] });
    document.querySelector<HTMLButtonElement>(".audio-route")!.click();
    expect(api.setAudioRoute).toHaveBeenLastCalledWith("earpiece");
    routes({ current: "wired", available: ["earpiece"] });
    routes({ current: "loud", available: ["loud", "speaker"] });
    expect(document.querySelector(".audio-route")!.textContent).toBe("Bluetooth");
  });
});
