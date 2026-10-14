import { describe, expect, it, vi } from "vitest";
import { FluxerRest } from "../../../src/main/fluxer/rest";
import { FluxerState } from "../../../src/main/fluxer/state";
import { ANA, ME, readyPayload } from "./fixtures";

function stateWithMessage() {
  const state = new FluxerState();
  state.apply("READY", readyPayload());
  state.addHistory("211", [], false);
  state.apply("MESSAGE_CREATE", { id: "700", channel_id: "211", author: ANA, content: "hi" });
  const message = () => state.messages.get("211")![0]!;
  return { state, message };
}

const react = (user: string, name: string, extra: Record<string, unknown> = {}) => ({
  user_id: user,
  channel_id: "211",
  message_id: "700",
  emoji: { name, ...extra },
});

describe("FluxerState reactions", () => {
  it("counts others' reactions and keeps ours idempotent", () => {
    const { state, message } = stateWithMessage();
    state.apply("MESSAGE_REACTION_ADD", react(ANA.id, "👍"));
    state.apply("MESSAGE_REACTION_ADD", react(ME.id, "👍"));
    state.apply("MESSAGE_REACTION_ADD", react(ME.id, "👍")); // echo of our own add
    state.applyReaction("211", "700", { name: "👍" }, true, true); // local apply after success
    expect(message().reactions).toEqual([{ emoji: { name: "👍" }, count: 2, me: true }]);

    state.apply("MESSAGE_REACTION_ADD", react("3", "party", { id: "55", animated: true }));
    expect(message().reactions![1]).toEqual({ emoji: { id: "55", name: "party" }, count: 1, me: false });

    state.apply("MESSAGE_REACTION_REMOVE", react(ME.id, "👍"));
    state.apply("MESSAGE_REACTION_REMOVE", react(ME.id, "👍")); // already removed
    expect(message().reactions![0]).toEqual({ emoji: { name: "👍" }, count: 1, me: false });
    state.apply("MESSAGE_REACTION_REMOVE", react(ANA.id, "👍"));
    state.apply("MESSAGE_REACTION_REMOVE", react(ANA.id, "🎉")); // never added
    expect(message().reactions!.map((r) => r.emoji.name)).toEqual(["party"]);
  });

  it("clears reactions per emoji or entirely", () => {
    const { state, message } = stateWithMessage();
    state.apply("MESSAGE_REACTION_ADD", react(ANA.id, "👍"));
    state.apply("MESSAGE_REACTION_ADD", react(ANA.id, "party", { id: "55" }));
    state.apply("MESSAGE_REACTION_REMOVE_EMOJI", { channel_id: "211", message_id: "700", emoji: { name: "party", id: "55" } });
    expect(message().reactions!.map((r) => r.emoji.name)).toEqual(["👍"]);
    state.apply("MESSAGE_REACTION_REMOVE_ALL", { channel_id: "211", message_id: "700" });
    expect(message().reactions).toEqual([]);
  });

  it("ignores reactions for unknown messages or malformed events", () => {
    const { state, message } = stateWithMessage();
    const changed = vi.fn();
    state.changed.on(changed);
    state.apply("MESSAGE_REACTION_ADD", { ...react(ANA.id, "👍"), message_id: "999" });
    state.apply("MESSAGE_REACTION_ADD", { ...react(ANA.id, "👍"), emoji: {} });
    state.apply("MESSAGE_REACTION_ADD", { ...react(ANA.id, "👍"), user_id: "x" });
    state.apply("MESSAGE_REACTION_REMOVE_ALL", { channel_id: "211", message_id: "999" });
    state.apply("MESSAGE_REACTION_REMOVE_ALL", { channel_id: "bad" });
    expect(message().reactions).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1); // only the unknown-message add reaches the end of apply
  });

  it("replaces and removes messages", () => {
    const { state, message } = stateWithMessage();
    const edited = { ...message(), content: "edited", edited: true };
    expect(state.replaceMessage(edited)).toBe(true);
    expect(message().content).toBe("edited");
    expect(state.replaceMessage({ ...edited, id: "999" })).toBe(false);
    expect(state.replaceMessage({ ...edited, channelId: "404" })).toBe(false);
    state.removeMessage("211", "700");
    state.removeMessage("404", "700");
    expect(state.messages.get("211")).toEqual([]);
  });
});

describe("FluxerRest message actions", () => {
  function rest() {
    const calls: { url: string; init: RequestInit }[] = [];
    const author = { id: "2", username: "ana" };
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const body = init.method === "PATCH" || init.method === "POST" ? { id: "9", channel_id: "5", author, content: "x" } : undefined;
      return { ok: true, status: body ? 200 : 204, json: async () => body } as Response;
    });
    const client = new FluxerRest("https://api.fx/v1", { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
    return { client, calls };
  }

  it("sends replies with a message reference", async () => {
    const { client, calls } = rest();
    await client.sendMessage("5", "re", "n", "8");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "re", nonce: "n", message_reference: { message_id: "8" } });
  });

  it("edits, deletes and reacts", async () => {
    const { client, calls } = rest();
    expect(await client.editMessage("5", "9", "new")).toMatchObject({ id: "9" });
    await client.deleteMessage("5", "9");
    await client.react("5", "9", "👍", true);
    await client.react("5", "9", "party:55", false);
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["PATCH", "https://api.fx/v1/channels/5/messages/9"],
      ["DELETE", "https://api.fx/v1/channels/5/messages/9"],
      ["PUT", "https://api.fx/v1/channels/5/messages/9/reactions/%F0%9F%91%8D/@me"],
      ["DELETE", "https://api.fx/v1/channels/5/messages/9/reactions/party%3A55/@me"],
    ]);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: "new" });
  });
});

describe("typing", () => {
  it("tracks who is typing until it expires or they send", () => {
    const { state } = stateWithMessage();
    state.apply("TYPING_START", { channel_id: "211", user_id: ANA.id, timestamp: 1000 });
    state.apply("TYPING_START", { channel_id: "211", user_id: ME.id, timestamp: 1000 }); // ourselves
    state.apply("TYPING_START", { channel_id: "211", user_id: "404", timestamp: 1000 }); // unknown user
    state.apply("TYPING_START", { channel_id: "x", user_id: ANA.id });
    expect(state.typingIn("211", 1_005_000).map((u) => u.id)).toEqual([ANA.id]);
    expect(state.typingIn("211", 1_011_000)).toEqual([]);
    expect(state.typingIn("999")).toEqual([]);

    state.apply("TYPING_START", { channel_id: "211", user_id: ANA.id });
    expect(state.typingIn("211").map((u) => u.id)).toEqual([ANA.id]);
    state.apply("MESSAGE_CREATE", { id: "701", channel_id: "211", author: ANA });
    expect(state.typingIn("211")).toEqual([]);
  });

  it("sends the typing call", async () => {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 204, json: async () => undefined } as Response;
    });
    const client = new FluxerRest("https://api.fx/v1", { fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
    await client.typing("5");
    expect(calls).toEqual(["https://api.fx/v1/channels/5/typing"]);
  });
});
