// The phone's Discord view: what runs in Discord's own page (https://discord.com) in its WebView. Native
// code injects two document-start scripts, both restricted to Discord's origin and both doing nothing in
// frames other than the top one:
//
// - discord-page.js, in the page's main world: the desktop's main-world scripts as they are (the store
//   bridge and the Notification relay; not screenAudioPatch: no screen share on a phone, nor the Rich
//   Presence bridge: no Rich Presence on a phone), plus a watch on the page's own camera and microphone
//   tracks so the background service can keep a call's sound (startDiscordPage).
// - discord-relay.js, with the native message listener, in an isolated world where the WebView has one (the
//   page's world otherwise): the desktop preload's isolated half (startDiscordPreload: reads the hidden guild
//   bar, checks the store bridge's output, publishes state, navigates), speaking to native code through the
//   listener instead of Electron's IPC (startDiscordRelay).
//
// The rules are the desktop's: nothing here calls Discord's APIs or dispatches anything into its client; it
// reads what the desktop reads and clicks what the desktop clicks. Native code checks every message again
// with its port of the desktop's validators (DiscordValidators.kt) before the shell page sees it.
import { BRIDGE_MAX_ATTEMPTS, BRIDGE_RETRY_MS, MAX_RELAYED, startDiscordPreload, type PreloadIpc } from "../preload/discord/index";
import { discordNotificationRelay } from "../preload/discord/notificationRelay";
import { discordStoreBridge } from "../preload/discord/storeBridge";
import { BRIDGE_EVENT, IPC, isDiscordPage, NOTIFY_CLICK_EVENT, NOTIFY_EVENT } from "../shared/ipc";

/** The native message listener's name, in the relay's world only (DiscordView.kt has the same). */
export const DISCORD_LISTENER = "multicordDiscord";
/** DOM event: the main world tells the relay whether the page holds a live microphone or camera track. */
export const MEDIA_EVENT = "multicord:media";

/** Whether the page holds a live microphone or camera track it got from getUserMedia. */
export interface MediaUse {
  audio: boolean;
  video: boolean;
}

/** What the relay sends native code, as JSON text. */
export type DiscordViewMessage =
  | { k: "state"; body: unknown }
  | { k: "notification"; body: unknown }
  | { k: "media"; body: MediaUse };

/** What native code sends the relay, as JSON text: navigation (isDiscordTarget) and a click on a relayed notification. */
export type DiscordNativeMessage = { k: "navigate"; target: unknown } | { k: "notificationClick"; id: unknown };

/** The listener object native code puts in the relay's world (WebViewCompat.addWebMessageListener). */
export interface DiscordListener {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export function isMediaUse(value: unknown): value is MediaUse {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.keys(value).length === 2 &&
    typeof (value as MediaUse).audio === "boolean" &&
    typeof (value as MediaUse).video === "boolean"
  );
}

/** Only Discord's own page, in the top frame: the scripts are injected into every frame of Discord's origin. */
function isDiscordTop(win: Window): boolean {
  return win === win.top && isDiscordPage(win.location.href);
}

/**
 * The isolated half: the desktop preload with the listener as its IPC. What it publishes goes to native code
 * as is (it was checked here, and native code checks it again); native code's navigation and notification
 * clicks come back on the channels the preload listens on.
 */
export function startDiscordRelay(host: DiscordListener | undefined, doc: Document, win: Window): boolean {
  if (!host || typeof host.postMessage !== "function" || !isDiscordTop(win)) return false;
  const post = (message: DiscordViewMessage): void => host.postMessage(JSON.stringify(message));
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const ipc: PreloadIpc = {
    send(channel, payload) {
      if (channel === IPC.discordState) post({ k: "state", body: payload });
      else if (channel === IPC.discordNotification) post({ k: "notification", body: payload });
      // Nothing else goes out: no screen share or Rich Presence on a phone.
    },
    on(channel, listener) {
      listeners.set(channel, listener);
    },
  };
  host.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    let message: Partial<DiscordNativeMessage> & { k?: unknown };
    try {
      message = JSON.parse(event.data) as typeof message;
    } catch {
      return;
    }
    // The preload checks each value again (isDiscordTarget, the notification id's form).
    if (message?.k === "navigate") listeners.get(IPC.discordNavigate)?.(null, (message as { target?: unknown }).target);
    else if (message?.k === "notificationClick") listeners.get(IPC.discordNotificationClick)?.(null, (message as { id?: unknown }).id);
  });
  doc.addEventListener(MEDIA_EVENT, (event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    let parsed: unknown;
    try {
      parsed = typeof detail === "string" ? JSON.parse(detail) : undefined;
    } catch {
      return;
    }
    if (isMediaUse(parsed)) post({ k: "media", body: { audio: parsed.audio, video: parsed.video } });
  });
  // The main-world scripts are native code's own document-start script (discord-page.js), not run from here.
  startDiscordPreload(ipc, doc, win);
  return true;
}

/**
 * Tells the relay whether the page holds a live microphone or camera track, whenever that changes: tracks
 * getUserMedia hands the page count until they end or are stopped. A browser API only, as screenAudioPatch
 * patches one on the desktop; nothing of Discord's own is read. Runs in the page's main world.
 */
export function watchMedia(win: Window, eventName: string): void {
  const media = win.navigator.mediaDevices as (MediaDevices & { __multicordWatch?: true }) | undefined;
  if (!media || typeof media.getUserMedia !== "function" || media.__multicordWatch) return;
  media.__multicordWatch = true;
  const live = new Set<MediaStreamTrack>();
  let last = "";
  const report = (): void => {
    const use: MediaUse = { audio: false, video: false };
    for (const track of live) use[track.kind === "video" ? "video" : "audio"] = true;
    const text = JSON.stringify(use);
    if (text === last) return;
    last = text;
    win.document.dispatchEvent(new CustomEvent(eventName, { detail: text }));
  };
  const watch = (track: MediaStreamTrack): void => {
    if (track.readyState === "ended" || live.has(track)) return;
    live.add(track);
    const done = (): void => {
      if (live.delete(track)) report();
    };
    track.addEventListener("ended", done);
    const stop = track.stop;
    track.stop = function (this: MediaStreamTrack) {
      stop.call(this);
      done();
    };
  };
  const original = media.getUserMedia;
  media.getUserMedia = async function (this: MediaDevices, ...args: Parameters<MediaDevices["getUserMedia"]>) {
    const stream = await original.apply(this, args);
    for (const track of stream.getTracks()) watch(track);
    report();
    return stream;
  };
}

/** The main-world half, from native code's document-start script: the desktop's main-world scripts, and the media watch. */
export function startDiscordPage(win: Window): boolean {
  if (!isDiscordTop(win)) return false;
  discordStoreBridge(BRIDGE_EVENT, BRIDGE_RETRY_MS, BRIDGE_MAX_ATTEMPTS);
  discordNotificationRelay(NOTIFY_EVENT, NOTIFY_CLICK_EVENT, MAX_RELAYED);
  watchMedia(win, MEDIA_EVENT);
  return true;
}
