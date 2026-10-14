// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACT_CLASS, STYLE_ID } from "../../src/preload/discord/dom";
import {
  BRIDGE_MAX_ATTEMPTS,
  BRIDGE_RETRY_MS,
  PUBLISH_DELAY_MS,
  startDiscordPreload,
  type PreloadIpc,
} from "../../src/preload/discord/index";
import { discordStoreBridge } from "../../src/preload/discord/storeBridge";
import { BRIDGE_EVENT, IPC } from "../../src/shared/ipc";

function fakeIpc() {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const ipc: PreloadIpc & { emit(channel: string, payload: unknown): void } = {
    send: vi.fn(),
    on: (channel, listener) => listeners.set(channel, listener),
    emit: (channel, payload) => listeners.get(channel)?.(null, payload),
  };
  return ipc;
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

describe("startDiscordPreload", () => {
  it("hides the guild bar and publishes state after a debounce", () => {
    const ipc = fakeIpc();
    startDiscordPreload(ipc, document, window);
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
    expect(ipc.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);
    expect(ipc.send).toHaveBeenCalledWith(IPC.discordState, {
      guilds: [{ id: "1", name: "One", iconUrl: undefined, unread: false, mentions: 0 }],
      badge: { unread: false, mentions: 0 },
      health: { guildBar: true },
    });
  });

  it("republishes on DOM changes but skips unchanged state", async () => {
    const ipc = fakeIpc();
    const { publish } = startDiscordPreload(ipc, document, window);
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);
    publish();
    expect(ipc.send).toHaveBeenCalledTimes(1);

    document.querySelector("[data-list-item-id]")!.setAttribute("aria-label", "unread, One");
    await Promise.resolve(); // let the MutationObserver fire
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);
    expect(ipc.send).toHaveBeenCalledTimes(2);
  });

  it("waits for DOMContentLoaded while the document is loading", () => {
    const ipc = fakeIpc();
    const readyState = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    startDiscordPreload(ipc, document, window);
    expect(document.getElementById(STYLE_ID)).toBeNull();
    readyState.mockRestore();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    expect(document.getElementById(STYLE_ID)).not.toBeNull();
  });

  it("navigates on valid targets only", () => {
    const ipc = fakeIpc();
    const click = vi.fn();
    document.querySelector("[data-list-item-id]")!.addEventListener("click", click);
    startDiscordPreload(ipc, document, window);
    ipc.emit(IPC.discordNavigate, '"]<script>');
    expect(click).not.toHaveBeenCalled();
    ipc.emit(IPC.discordNavigate, "1");
    expect(click).toHaveBeenCalledOnce();
  });

  it("hides Discord's own sidebar beside the Messages list", () => {
    const ipc = fakeIpc();
    startDiscordPreload(ipc, document, window);
    ipc.emit(IPC.viewCompact, true);
    expect(document.documentElement.classList.contains(COMPACT_CLASS)).toBe(true);
    expect(document.getElementById(STYLE_ID)!.textContent).toContain(`html.${COMPACT_CLASS} [class^="sidebar_"]`);
    ipc.emit(IPC.viewCompact, false);
    expect(document.documentElement.classList.contains(COMPACT_CLASS)).toBe(false);
  });
});

describe("store bridge", () => {
  const dm = { id: "9", title: "Ana", unread: true, mentions: 1, lastActivity: 5 };
  const fire = (detail: unknown) => document.dispatchEvent(new CustomEvent(BRIDGE_EVENT, { detail }));

  it("starts the store bridge in the main world", () => {
    const run = vi.fn();
    startDiscordPreload(fakeIpc(), document, window, run);
    expect(run).toHaveBeenCalledWith(discordStoreBridge, [BRIDGE_EVENT, BRIDGE_RETRY_MS, BRIDGE_MAX_ATTEMPTS]);
  });

  it("publishes validated DMs and names guilds from the store", () => {
    const ipc = fakeIpc();
    startDiscordPreload(ipc, document, window);
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);

    fire({ not: "a string" });
    fire("{broken json");
    fire(JSON.stringify({ dms: [{ id: "nope" }], guilds: [] }));
    fire(JSON.stringify([dm]));
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);
    expect(ipc.send).toHaveBeenCalledTimes(1);

    fire(JSON.stringify({ dms: [dm], guilds: [{ id: "1", name: "Store Name" }] }));
    vi.advanceTimersByTime(PUBLISH_DELAY_MS);
    expect(ipc.send).toHaveBeenLastCalledWith(IPC.discordState, {
      guilds: [{ id: "1", name: "Store Name", iconUrl: undefined, unread: false, mentions: 0 }],
      badge: { unread: false, mentions: 0 },
      health: { guildBar: true },
      dms: [dm],
    });
  });
});
