// Protocol between the main process and an engine's socket relay: a hidden
// page of the shell's own that opens the engine's bridged WebSockets in
// Chromium's network stack (src/main/webSockets.ts). The engine never talks
// to it; the main process checks every socket before the relay opens it.

import { isFrame, MAX_CLOSE_REASON } from "./engine";

export const RELAY_IPC = {
  /** Main -> relay: RelayCommand. */
  command: "relay:command",
  /** Relay -> main: RelayEvent. */
  event: "relay:event",
} as const;

/** What the main process asks of the relay. Ids are the main process's own. */
export type RelayCommand =
  | { type: "open"; id: string; url: string }
  | { type: "send"; id: string; data: string | Uint8Array }
  | { type: "close"; id: string; code?: number; reason?: string };

/** What the relay reports back. */
export type RelayEvent =
  /** The relay page has loaded and listens for commands. */
  | { type: "ready" }
  | { type: "open"; id: string }
  | { type: "message"; id: string; data: string | Uint8Array }
  /** The socket is closed for good, or could not connect (1006). */
  | { type: "close"; id: string; code: number; reason: string }
  /**
   * What the socket still has waiting to be sent: after a send of `sent`
   * (sized as for MAX_SOCKET_QUEUE), and while it drains.
   */
  | { type: "buffered"; id: string; amount: number; sent?: number };

const RELAY_ID = /^[0-9]{1,16}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isAmount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function isRelayEvent(value: unknown): value is RelayEvent {
  if (!isRecord(value)) return false;
  if (value.type === "ready") return true;
  if (typeof value.id !== "string" || !RELAY_ID.test(value.id)) return false;
  switch (value.type) {
    case "open":
      return true;
    case "message":
      return isFrame(value.data);
    case "close":
      return Number.isInteger(value.code) && (value.code as number) >= 1000 && (value.code as number) <= 4999 && typeof value.reason === "string" && value.reason.length <= MAX_CLOSE_REASON;
    case "buffered":
      return isAmount(value.amount) && (value.sent === undefined || isAmount(value.sent));
    default:
      return false;
  }
}
