import { describe, expect, it, vi } from "vitest";
import { createNativeApi } from "../../src/preload/native";
import { isNativeAction, MAX_MESSAGE_LENGTH, NATIVE_IPC } from "../../src/shared/native";

describe("isNativeAction", () => {
  it("accepts well-formed actions", () => {
    for (const action of [
      { type: "ready" },
      { type: "cancelMfa" },
      { type: "loadOlder" },
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
