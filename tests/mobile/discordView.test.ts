// @vitest-environment happy-dom
// @vitest-environment-options {"url": "https://discord.com/channels/@me"}
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMediaUse, MEDIA_EVENT, startDiscordPage, startDiscordRelay, watchMedia, type DiscordListener } from "../../src/mobile/discordView";
import { PUBLISH_DELAY_MS } from "../../src/preload/discord/index";
import { STYLE_ID } from "../../src/preload/discord/dom";
import { NOTIFY_CLICK_EVENT, NOTIFY_EVENT, SCREEN_AUDIO_END_EVENT } from "../../src/shared/ipc";

function fakeHost() {
  let listener: ((event: { data: unknown }) => void) | undefined;
  const host: DiscordListener & { sent: unknown[]; deliver(data: unknown): void } = {
    sent: [],
    postMessage: vi.fn((text: string) => void host.sent.push(JSON.parse(text))),
    addEventListener: (_type, cb) => {
      listener = cb;
    },
    deliver: (data) => listener?.({ data }),
  };
  return host;
}

/** A window that is its own top, at `href`. */
function fakeWindow(href: string): Window {
  const win = { location: { href } } as unknown as Window & { top: Window };
  win.top = win;
  return win;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.head.innerHTML = "";
  document.body.innerHTML = `<nav class="guilds_a"><div data-list-item-id="guildsnav___1" aria-label="One"></div></nav>`;
  document.title = "Discord";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("startDiscordRelay", () => {
  it("starts only with a listener, in Discord's own top frame", () => {
    expect(startDiscordRelay(undefined, document, window)).toBe(false);
    expect(startDiscordRelay({} as DiscordListener, document, window)).toBe(false);
    expect(startDiscordRelay(fakeHost(), document, fakeWindow("https://evil.example/channels/@me"))).toBe(false);
    const frame = { location: { href: "https://discord.com/widget" }, top: window } as unknown as Window;
    expect(startDiscordRelay(fakeHost(), document, frame)).toBe(false);
    expect(document.getElementById(STYLE_ID)).toBeNull();
  });

  it("publishes the view's state to native code", () => {
    const host = fakeHost();
    expect(startDiscordRelay(host, document, window)).toBe(true);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);
    expect(host.sent).toEqual([{ k: "state", body: expect.objectContaining({ guilds: [expect.objectContaining({ id: "1", name: "One" })], badge: { unread: false, mentions: 0 } }) }]);
  });

  it("relays Discord's notifications, checked, and runs a click native code sends back", () => {
    const host = fakeHost();
    startDiscordRelay(host, document, window);
    document.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail: JSON.stringify({ id: "3", title: "Ana", body: "hi" }) }));
    document.dispatchEvent(new CustomEvent(NOTIFY_EVENT, { detail: JSON.stringify({ id: "x", title: "Ana", body: "hi" }) }));
    expect(host.sent).toEqual([{ k: "notification", body: { id: "3", title: "Ana", body: "hi" } }]);

    const clicks: unknown[] = [];
    document.addEventListener(NOTIFY_CLICK_EVENT, (event) => clicks.push((event as CustomEvent).detail));
    host.deliver(JSON.stringify({ k: "notificationClick", id: "3" }));
    host.deliver(JSON.stringify({ k: "notificationClick", id: "../x" }));
    expect(clicks).toEqual(["3"]);
  });

  it("navigates as native code says, through the hidden guild bar", () => {
    const host = fakeHost();
    startDiscordRelay(host, document, window);
    const item = document.querySelector<HTMLElement>('[data-list-item-id="guildsnav___1"]')!;
    const click = vi.spyOn(item, "click");
    host.deliver(JSON.stringify({ k: "navigate", target: "1" }));
    host.deliver(JSON.stringify({ k: "navigate", target: "../evil" }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("ignores anything else native code or the page sends", () => {
    const host = fakeHost();
    startDiscordRelay(host, document, window);
    const pushState = vi.spyOn(window.history, "pushState");
    for (const data of [5, "not json", "null", JSON.stringify({ k: "other", target: "1" }), JSON.stringify({ k: "navigate" })]) host.deliver(data);
    expect(pushState).not.toHaveBeenCalled();
    for (const detail of [5, "not json", JSON.stringify({ audio: true }), JSON.stringify({ audio: 1, video: false })]) {
      document.dispatchEvent(new CustomEvent(MEDIA_EVENT, { detail }));
    }
    // The desktop's screen share with system sound does not exist here: nothing goes out for it.
    document.dispatchEvent(new CustomEvent(SCREEN_AUDIO_END_EVENT));
    expect(host.sent).toEqual([]);
  });

  it("passes on whether the page holds a live microphone or camera", () => {
    const host = fakeHost();
    startDiscordRelay(host, document, window);
    document.dispatchEvent(new CustomEvent(MEDIA_EVENT, { detail: JSON.stringify({ audio: true, video: false }) }));
    expect(host.sent).toEqual([{ k: "media", body: { audio: true, video: false } }]);
  });
});

describe("isMediaUse", () => {
  it("takes two booleans and nothing else", () => {
    expect(isMediaUse({ audio: false, video: true })).toBe(true);
    for (const bad of [null, "x", {}, { audio: true }, { audio: true, video: "no" }, { audio: true, video: false, more: 1 }]) expect(isMediaUse(bad)).toBe(false);
  });
});

class FakeTrack extends EventTarget {
  readyState = "live";
  stopped = 0;
  constructor(readonly kind: "audio" | "video") {
    super();
  }
  stop(): void {
    this.stopped++;
    this.readyState = "ended";
  }
}

function fakeMediaWindow(tracks: () => FakeTrack[]) {
  const reports: unknown[] = [];
  const doc = new EventTarget() as Document;
  doc.addEventListener("watch", (event) => reports.push(JSON.parse((event as CustomEvent).detail)));
  const media = { getUserMedia: vi.fn(async () => ({ getTracks: tracks })) };
  const win = { navigator: { mediaDevices: media }, document: doc } as unknown as Window;
  return { win, media, reports };
}

describe("watchMedia", () => {
  it("reports live tracks from getUserMedia until they stop or end", async () => {
    const mic = new FakeTrack("audio");
    const camera = new FakeTrack("video");
    let next: FakeTrack[] = [mic];
    const { win, reports } = fakeMediaWindow(() => next);
    watchMedia(win, "watch");
    const media = win.navigator.mediaDevices;
    await media.getUserMedia({ audio: true });
    expect(reports).toEqual([{ audio: true, video: false }]);
    next = [mic, camera];
    await media.getUserMedia({ audio: true, video: true });
    expect(reports.at(-1)).toEqual({ audio: true, video: true });
    (camera as unknown as MediaStreamTrack).stop();
    expect(camera.stopped).toBe(1);
    expect(reports.at(-1)).toEqual({ audio: true, video: false });
    mic.dispatchEvent(new Event("ended"));
    expect(reports.at(-1)).toEqual({ audio: false, video: false });
    (mic as unknown as MediaStreamTrack).stop();
    expect(reports).toHaveLength(4);
  });

  it("skips tracks already ended and reports only changes", async () => {
    const ended = new FakeTrack("video");
    ended.readyState = "ended";
    const { win, reports } = fakeMediaWindow(() => [ended]);
    watchMedia(win, "watch");
    await win.navigator.mediaDevices.getUserMedia({ video: true });
    await win.navigator.mediaDevices.getUserMedia({ video: true });
    expect(reports).toEqual([{ audio: false, video: false }]);
  });

  it("patches once, and not at all without getUserMedia", () => {
    const { win, media } = fakeMediaWindow(() => []);
    watchMedia(win, "watch");
    const patched = media.getUserMedia;
    watchMedia(win, "watch");
    expect(media.getUserMedia).toBe(patched);
    expect(() => watchMedia({ navigator: {} } as unknown as Window, "watch")).not.toThrow();
  });
});

describe("startDiscordPage", () => {
  it("runs the main-world scripts in Discord's own top frame only", () => {
    expect(startDiscordPage(fakeWindow("https://evil.example/"))).toBe(false);
    expect(startDiscordPage(window)).toBe(true);
  });
});
