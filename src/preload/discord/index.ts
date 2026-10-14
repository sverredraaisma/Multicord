import { IPC, isDiscordTarget, type DiscordState } from "../../shared/ipc";
import { injectStyle, navigate, readState } from "./dom";

export interface PreloadIpc {
  send(channel: string, payload: unknown): void;
  on(channel: string, listener: (event: unknown, payload: unknown) => void): void;
}

export const PUBLISH_DELAY_MS = 250;

/** Wires the Discord view: hides the guild bar, publishes state, accepts navigation. */
export function startDiscordPreload(ipc: PreloadIpc, doc: Document, win: Window): { publish(): void } {
  let last = "";
  let timer: ReturnType<typeof setTimeout> | undefined;

  const publish = (): void => {
    timer = undefined;
    const state: DiscordState = readState(doc);
    const serialized = JSON.stringify(state);
    if (serialized === last) return;
    last = serialized;
    ipc.send(IPC.discordState, state);
  };

  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(publish, PUBLISH_DELAY_MS);
  };

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
