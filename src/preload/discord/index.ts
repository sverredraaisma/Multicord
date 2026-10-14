import {
  BRIDGE_EVENT,
  IPC,
  isBridgePayload,
  isDiscordTarget,
  isRelayedNotification,
  NOTIFY_CLICK_EVENT,
  NOTIFY_EVENT,
  type BridgePayload,
  type DiscordState,
} from "../../shared/ipc";
import { COMPACT_CLASS, injectStyle, navigate, readState } from "./dom";
import { discordNotificationRelay } from "./notificationRelay";
import { discordStoreBridge } from "./storeBridge";

export interface PreloadIpc {
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

/** Runs a self-contained function in the page's main world. */
export type MainWorldRunner = (func: (...args: never[]) => void, args: unknown[]) => void;

export const PUBLISH_DELAY_MS = 250;
export const BRIDGE_RETRY_MS = 1000;
export const BRIDGE_MAX_ATTEMPTS = 120;
/** Relayed notifications kept for their click handlers. */
export const MAX_RELAYED = 200;

/**
 * Wires the Discord view: hides the guild bar, starts the main-world store
 * bridge for DMs and guild names, publishes state and accepts navigation.
 */
export function startDiscordPreload(
  ipc: PreloadIpc,
  doc: Document,
  win: Window,
  runInMainWorld?: MainWorldRunner,
): { publish(): void } {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let bridge: BridgePayload | undefined;

  const publish = (): void => {
    timer = undefined;
    const state: DiscordState = readState(doc, bridge);
    const serialized = JSON.stringify(state);
    if (serialized === last) return;
    last = serialized;
    ipc.send(IPC.discordState, state);
  };

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(publish, PUBLISH_DELAY_MS);
  };

  // The bridge's data is untrusted until validated here and again in main.
  doc.addEventListener(BRIDGE_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(detail);
    } catch {
      return;
    }
    if (!isBridgePayload(parsed)) return;
    bridge = parsed;
    schedule();
  });
  runInMainWorld?.(discordStoreBridge, [BRIDGE_EVENT, BRIDGE_RETRY_MS, BRIDGE_MAX_ATTEMPTS]);

  // Discord's notifications go to the shell; a click on ours runs Discord's own handler.
  doc.addEventListener(NOTIFY_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    let parsed: unknown;
    try {
      parsed = typeof detail === "string" ? JSON.parse(detail) : undefined;
    } catch {
      return;
    }
    if (isRelayedNotification(parsed)) ipc.send(IPC.discordNotification, parsed);
  });
  ipc.on(IPC.discordNotificationClick, (_event, id) => {
    if (typeof id === "string" && /^\d{1,10}$/.test(id)) doc.dispatchEvent(new CustomEvent(NOTIFY_CLICK_EVENT, { detail: id }));
  });
  runInMainWorld?.(discordNotificationRelay, [NOTIFY_EVENT, NOTIFY_CLICK_EVENT, MAX_RELAYED]);

  const attach = (): void => {
    injectStyle(doc);
    new MutationObserver(schedule).observe(doc.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: ["aria-label", "src", "class"],
    });
    schedule();
  };

  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", attach, { once: true });
  else attach();

  ipc.on(IPC.discordNavigate, (_event, target) => {
    if (isDiscordTarget(target)) navigate(doc, win, target);
  });
  // Beside the unified Messages list, Discord's own DM sidebar would repeat it.
  ipc.on(IPC.viewCompact, (_event, compact) => doc.documentElement.classList.toggle(COMPACT_CLASS, compact === true));

  return { publish };
}
