import { BRIDGE_EVENT, IPC, isBridgePayload, isDiscordTarget, type BridgePayload, type DiscordState } from "../../shared/ipc";
import { injectStyle, navigate, readState } from "./dom";
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

  return { publish };
}
