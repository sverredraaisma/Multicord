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
      { type: "send", content: "" },
      { type: "attach" },
      { type: "removeAttachment", index: 0 },
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
      { type: "send", content: 5 },
      { type: "removeAttachment", index: 10 },
      { type: "removeAttachment", index: 1.5 },
      { type: "removeAttachment" },
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

describe("forum post validation", () => {
  it("requires a title and a first message", () => {
    expect(isNativeAction({ type: "createPost", name: "Idea", content: "body" })).toBe(true);
    expect(isNativeAction({ type: "createPost", name: " ", content: "body" })).toBe(false);
    expect(isNativeAction({ type: "createPost", name: "x".repeat(101), content: "body" })).toBe(false);
    expect(isNativeAction({ type: "createPost", name: "Idea", content: "" })).toBe(false);
  });
});

describe("voice action validation", () => {
  it("validates joins, toggles and errors", () => {
    expect(isNativeAction({ type: "joinVoice", channelId: "5" })).toBe(true);
    expect(isNativeAction({ type: "joinVoice", channelId: "x" })).toBe(false);
    expect(isNativeAction({ type: "leaveVoice" })).toBe(true);
    expect(isNativeAction({ type: "voiceState", mute: true, deaf: false, video: false, stream: false })).toBe(true);
    expect(isNativeAction({ type: "voiceState", mute: true, deaf: false, video: false })).toBe(false);
    expect(isNativeAction({ type: "voiceError", message: "ICE failed" })).toBe(true);
    expect(isNativeAction({ type: "voiceError", message: "" })).toBe(false);
  });
});

describe("prompt actions", () => {
  it("accepts answers to a prompt step and rejects malformed ones", () => {
    expect(isNativeAction({ type: "prompt", id: "phone", values: { phone: "+31 6 1234" } })).toBe(true);
    expect(isNativeAction({ type: "prompt", id: "api-id", values: {} })).toBe(true);
    expect(isNativeAction({ type: "cancelPrompt", id: "code" })).toBe(true);
    for (const bad of [
      { type: "prompt", id: "Phone", values: {} },
      { type: "prompt", id: "phone", values: null },
      { type: "prompt", id: "phone", values: [] },
      { type: "prompt", id: "phone", values: { "bad name": "x" } },
      { type: "prompt", id: "phone", values: { phone: 5 } },
      { type: "prompt", id: "phone", values: { phone: "x".repeat(1025) } },
      { type: "prompt", id: "phone", values: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`f${i}`, "x"])) },
      { type: "cancelPrompt", id: "" },
    ]) {
      expect(isNativeAction(bad)).toBe(false);
    }
  });
});

describe("Stoat ids in actions", () => {
  it("accepts ULIDs as well as snowflakes, and nothing looser", () => {
    const ulid = "01HZ0000000000000000000111";
    expect(isNativeAction({ type: "select", channelId: ulid })).toBe(true);
    expect(isNativeAction({ type: "send", content: "x", replyTo: ulid })).toBe(true);
    expect(isNativeAction({ type: "react", messageId: ulid, emoji: ulid, add: true })).toBe(true);
    expect(isNativeAction({ type: "select", channelId: ulid.toLowerCase() })).toBe(false);
    expect(isNativeAction({ type: "select", channelId: `${ulid}0` })).toBe(false);
    expect(isNativeAction({ type: "select", channelId: "01HZ000000000000000000011I" })).toBe(false);
  });
});

describe("media requests", () => {
  it("accepts plain media keys only", () => {
    expect(isNativeAction({ type: "loadMedia", key: "tg:123:456" })).toBe(true);
    for (const key of ["", "a b", "<x>", "k".repeat(201), 5]) expect(isNativeAction({ type: "loadMedia", key })).toBe(false);
  });
});
