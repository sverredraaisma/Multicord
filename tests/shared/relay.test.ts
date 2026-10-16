import { describe, expect, it } from "vitest";
import { MAX_CLOSE_REASON, MAX_SOCKET_FRAME } from "../../src/shared/engine";
import { isRelayEvent } from "../../src/shared/relay";

describe("isRelayEvent", () => {
  it("accepts what the relay reports", () => {
    for (const event of [
      { type: "ready" },
      { type: "open", id: "1" },
      { type: "open", id: "1", protocol: "binary" },
      { type: "message", id: "12", data: "text" },
      { type: "message", id: "12", data: new Uint8Array(3) },
      { type: "close", id: "1", code: 1006, reason: "" },
      { type: "close", id: "1", code: 4999, reason: "x".repeat(MAX_CLOSE_REASON) },
      { type: "buffered", id: "1", amount: 0 },
      { type: "buffered", id: "1", amount: 10, sent: 4 },
    ])
      expect(isRelayEvent(event), JSON.stringify(event)).toBe(true);
  });

  it("refuses anything else", () => {
    for (const event of [
      null,
      "ready",
      [],
      { type: "open" },
      { type: "open", id: "abc" },
      { type: "open", id: 1 },
      { type: "open", id: "1".repeat(17) },
      { type: "open", id: "1", protocol: "" },
      { type: "open", id: "1", protocol: "a b" },
      { type: "open", id: "1", protocol: 1 },
      { type: "message", id: "1", data: {} },
      { type: "message", id: "1", data: "x".repeat(MAX_SOCKET_FRAME + 1) },
      { type: "close", id: "1", code: 999, reason: "" },
      { type: "close", id: "1", code: 5000, reason: "" },
      { type: "close", id: "1", code: 1000.5, reason: "" },
      { type: "close", id: "1", code: 1000 },
      { type: "close", id: "1", code: 1000, reason: "x".repeat(MAX_CLOSE_REASON + 1) },
      { type: "buffered", id: "1", amount: -1 },
      { type: "buffered", id: "1", amount: 1.5 },
      { type: "buffered", id: "1", amount: 1, sent: -1 },
      { type: "send", id: "1", data: "x" },
    ])
      expect(isRelayEvent(event), JSON.stringify(event)).toBe(false);
  });
});
