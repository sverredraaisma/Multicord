import { describe, expect, it } from "vitest";
import { isEngineCommand, isEngineEvent, isEngineRequest, isEngineSocketEvent, MAX_KEY, MAX_SOCKET_FRAME } from "../../src/shared/engine";

// What engines send (requests, events) is tested with the shared cases in tests/fixtures/engine-validator-cases.json
// (validatorCases.test.ts), which mobile/android runs too; this file has what only the desktop shell checks.

describe("engine messages that are not JSON", () => {
  it("refuses undefined", () => {
    expect(isEngineEvent(undefined)).toBe(false);
    expect(isEngineRequest(undefined)).toBe(false);
  });
});

describe("isEngineCommand", () => {
  it("accepts every command", () => {
    for (const c of [{ type: "openHome" }, { type: "signOut" }, { type: "visible", visible: false }]) expect(isEngineCommand(c)).toBe(true);
    for (const type of ["openServer", "openConversation", "toggleGroup"]) expect(isEngineCommand({ type, key: "k" })).toBe(true);
  });

  it("rejects bad commands", () => {
    for (const type of ["openServer", "openConversation", "toggleGroup"]) {
      expect(isEngineCommand({ type })).toBe(false);
      expect(isEngineCommand({ type, key: "" })).toBe(false);
      expect(isEngineCommand({ type, key: "k".repeat(MAX_KEY + 1) })).toBe(false);
    }
    expect(isEngineCommand({ type: "visible", visible: "true" })).toBe(false);
    expect(isEngineCommand({ type: "settings", values: { typing: false, theme: "dark" } })).toBe(true);
    expect(isEngineCommand({ type: "settings", values: { typing: 1 } })).toBe(false);
    expect(isEngineCommand({ type: "settingAction", key: "forgetCallServices" })).toBe(true);
    expect(isEngineCommand({ type: "settingAction", key: "../x" })).toBe(false);
    expect(isEngineCommand({ type: "unknown" })).toBe(false);
    for (const v of [null, "openHome", []]) expect(isEngineCommand(v)).toBe(false);
  });
});

describe("bridged socket events", () => {
  it("validates what the shell tells the engine about its sockets", () => {
    expect(isEngineSocketEvent({ type: "open", id: "1" })).toBe(true);
    expect(isEngineSocketEvent({ type: "open", id: "1", protocol: "binary" })).toBe(true);
    expect(isEngineSocketEvent({ type: "open", id: "1", protocol: "" })).toBe(false);
    expect(isEngineSocketEvent({ type: "open", id: "1", protocol: "a b" })).toBe(false);
    expect(isEngineSocketEvent({ type: "message", id: "1", data: "hi" })).toBe(true);
    expect(isEngineSocketEvent({ type: "message", id: "1", data: new Uint8Array(2) })).toBe(true);
    expect(isEngineSocketEvent({ type: "message", id: "1", data: new Uint8Array(MAX_SOCKET_FRAME + 1) })).toBe(false);
    expect(isEngineSocketEvent({ type: "message", id: "1", data: {} })).toBe(false);
    expect(isEngineSocketEvent({ type: "close", id: "1", code: 1006, reason: "" })).toBe(true);
    expect(isEngineSocketEvent({ type: "close", id: "1", code: 999, reason: "" })).toBe(false);
    expect(isEngineSocketEvent({ type: "close", id: "1", code: 1000 })).toBe(false);
    expect(isEngineSocketEvent({ type: "close", id: "1", code: "1000", reason: "" })).toBe(false);
    expect(isEngineSocketEvent({ type: "open", id: "" })).toBe(false);
    expect(isEngineSocketEvent({ type: "other", id: "1" })).toBe(false);
    expect(isEngineSocketEvent(null)).toBe(false);
  });
});
