import { describe, expect, it, vi } from "vitest";
import { createNativeApi } from "../../src/preload/native";
import { isNativeAction, MAX_MESSAGE_LENGTH, NATIVE_IPC } from "../../src/shared/native";

describe("isNativeAction", () => {
  it("accepts well-formed actions", () => {
    for (const action of [
      { type: "ready" },
      { type: "cancelMfa" },
      { type: "loadOlder" },
      { type: "typing" },
      { type: "logout" },
      { type: "login", identity: "a@b.c", password: "pw" },
      { type: "mfa", code: "123456" },
      { type: "select", channelId: "123" },
      { type: "send", content: "hi" },
      { type: "send", content: "x".repeat(MAX_MESSAGE_LENGTH) },
    ]) {
      expect(isNativeAction(action)).toBe(true);
    }
  });

  it("rejects malformed actions", () => {
    for (const action of [
      null,
      "login",
      { type: "unknown" },
      { type: "login", identity: "", password: "pw" },
      { type: "login", identity: "a", password: "x".repeat(1025) },
      { type: "login", identity: "x".repeat(321), password: "pw" },
      { type: "mfa", code: "" },
      { type: "mfa", code: 123456 },
      { type: "select", channelId: "../x" },
      { type: "select" },
      { type: "send", content: "   " },
      { type: "send", content: "" },
      { type: "send", content: "x".repeat(MAX_MESSAGE_LENGTH + 1) },
    ]) {
      expect(isNativeAction(action)).toBe(false);
    }
  });
});

describe("createNativeApi", () => {
  it("relays state in and actions out", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => listeners.set(c, l) };
    const api = createNativeApi(ipc);
    const onState = vi.fn();
    api.onState(onState);
    listeners.get(NATIVE_IPC.state)!(null, { screen: "connecting", platform: "Fluxer", status: "x" });
    expect(onState).toHaveBeenCalledWith({ screen: "connecting", platform: "Fluxer", status: "x" });
    api.act({ type: "logout" });
    expect(ipc.send).toHaveBeenCalledWith(NATIVE_IPC.action, { type: "logout" });
  });
});

describe("message action validation", () => {
  it("validates replies, edits, deletes and reactions", () => {
    expect(isNativeAction({ type: "send", content: "hi", replyTo: "5" })).toBe(true);
    expect(isNativeAction({ type: "send", content: "hi", replyTo: "x" })).toBe(false);
    expect(isNativeAction({ type: "edit", messageId: "5", content: "new" })).toBe(true);
    expect(isNativeAction({ type: "edit", messageId: "5", content: " " })).toBe(false);
    expect(isNativeAction({ type: "edit", messageId: "x", content: "new" })).toBe(false);
    expect(isNativeAction({ type: "delete", messageId: "5" })).toBe(true);
    expect(isNativeAction({ type: "delete" })).toBe(false);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "👍", add: true })).toBe(true);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "party:55", add: false })).toBe(true);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "", add: true })).toBe(false);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "x".repeat(65), add: true })).toBe(false);
    expect(isNativeAction({ type: "react", messageId: "5", emoji: "👍" })).toBe(false);
  });
});
