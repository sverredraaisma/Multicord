import { describe, expect, it } from "vitest";
import {
  isEngineCommand, isEngineEvent, isEngineRequest, isHttpRequest, isImageUrl,
  MAX_BODY_TEXT, MAX_DATA_IMAGE, MAX_DIRECTS, MAX_HTTP_BODY, MAX_KEY, MAX_READ, MAX_SECRET, MAX_SERVERS, MAX_TEXT,
} from "../../src/shared/engine";

const server = (over: object = {}) => ({ key: "k", name: "n", unread: false, mentions: 0, ...over });
const direct = (over: object = {}) => ({ key: "k", title: "t", lastActivity: 1, unread: false, mentions: 0, ...over });
const servers = (s: unknown) => isEngineEvent({ type: "servers", servers: [s] });
const directs = (d: unknown) => isEngineEvent({ type: "directs", directs: [d] });

describe("isImageUrl", () => {
  it("accepts https and small raster data URLs", () => {
    expect(isImageUrl("https://x.test/a.png")).toBe(true);
    for (const t of ["png", "jpeg", "gif", "webp"]) expect(isImageUrl(`data:image/${t};base64,QUJD==`)).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isImageUrl(5)).toBe(false);
    expect(isImageUrl("http://x.test/a.png")).toBe(false);
    expect(isImageUrl("https://x.test/" + "a".repeat(2000))).toBe(false);
    expect(isImageUrl("data:image/svg+xml;base64,QUJD")).toBe(false);
    expect(isImageUrl("data:image/png;base64,!!")).toBe(false);
    expect(isImageUrl("data:image/png;base64," + "A".repeat(MAX_DATA_IMAGE))).toBe(false);
  });
});

describe("isEngineEvent servers", () => {
  it("accepts a full server and a group with plain children", () => {
    expect(servers(server({ iconUrl: "https://x.test/i.png", kind: "server", expanded: true, color: "#AbC123", previewIconUrls: ["https://x.test/i.png"] }))).toBe(true);
    expect(servers(server({ kind: "group", children: [server({ key: "c" }), server({ key: "d", kind: "server" })] }))).toBe(true);
    expect(isEngineEvent({ type: "servers", servers: [] })).toBe(true);
  });

  it.each([
    ["non-record", "x"],
    ["array", []],
    ["empty key", server({ key: "" })],
    ["long key", server({ key: "k".repeat(MAX_KEY + 1) })],
    ["long name", server({ name: "n".repeat(MAX_TEXT + 1) })],
    ["bad icon", server({ iconUrl: "http://x.test/i.png" })],
    ["non-boolean unread", server({ unread: 1 })],
    ["fractional mentions", server({ mentions: 1.5 })],
    ["negative mentions", server({ mentions: -1 })],
    ["bad kind", server({ kind: "space" })],
    ["children on a non-group", server({ children: [] })],
    ["children not an array", server({ kind: "group", children: "x" })],
    ["too many children", server({ kind: "group", children: Array.from({ length: MAX_SERVERS + 1 }, () => server()) })],
    ["invalid child", server({ kind: "group", children: [server({ key: "" })] })],
    ["group child", server({ kind: "group", children: [server({ kind: "group", children: [] })] })],
    ["nested children", server({ kind: "group", children: [server({ children: [server()] })] })],
    ["bad expanded", server({ expanded: "yes" })],
    ["short color", server({ color: "#fff" })],
    ["non-string color", server({ color: 0xffffff })],
    ["non-hex color", server({ color: "#gggggg" })],
    ["too many previews", server({ previewIconUrls: Array(5).fill("https://x.test/i.png") })],
    ["bad preview", server({ previewIconUrls: ["http://x.test/i.png"] })],
    ["previews not an array", server({ previewIconUrls: "https://x.test/i.png" })],
  ])("rejects %s", (_n, s) => expect(servers(s)).toBe(false));

  it("accepts exactly 4 previews and rejects bad lists", () => {
    expect(servers(server({ previewIconUrls: Array(4).fill("https://x.test/i.png") }))).toBe(true);
    expect(isEngineEvent({ type: "servers", servers: "x" })).toBe(false);
    expect(isEngineEvent({ type: "servers", servers: Array.from({ length: MAX_SERVERS + 1 }, () => server()) })).toBe(false);
  });
});

describe("isEngineEvent directs", () => {
  it("accepts valid directs", () => {
    expect(directs(direct())).toBe(true);
    expect(directs(direct({ avatarUrl: "https://x.test/a.png", preview: "hi" }))).toBe(true);
    expect(isEngineEvent({ type: "directs", directs: [] })).toBe(true);
  });

  it.each([
    ["non-record", null],
    ["empty key", direct({ key: "" })],
    ["long title", direct({ title: "t".repeat(MAX_TEXT + 1) })],
    ["bad avatar", direct({ avatarUrl: "http://x.test/a.png" })],
    ["bad lastActivity", direct({ lastActivity: "1" })],
    ["long preview", direct({ preview: "p".repeat(MAX_BODY_TEXT + 1) })],
    ["bad unread", direct({ unread: "no" })],
    ["bad mentions", direct({ mentions: -2 })],
  ])("rejects %s", (_n, d) => expect(directs(d)).toBe(false));

  it("rejects non-arrays and too many entries", () => {
    expect(isEngineEvent({ type: "directs", directs: {} })).toBe(false);
    expect(isEngineEvent({ type: "directs", directs: Array.from({ length: MAX_DIRECTS + 1 }, () => direct()) })).toBe(false);
  });
});

describe("isEngineEvent notification, call, account, homeBadge", () => {
  const note = (over: object = {}) => ({ type: "notification", notification: { title: "t", body: "b", target: "x", ...over } });

  it("validates notifications", () => {
    expect(isEngineEvent(note())).toBe(true);
    expect(isEngineEvent(note({ railKey: "r", inView: true }))).toBe(true);
    expect(isEngineEvent({ type: "notification", notification: "x" })).toBe(false);
    expect(isEngineEvent(note({ title: "t".repeat(MAX_TEXT + 1) }))).toBe(false);
    expect(isEngineEvent(note({ body: "b".repeat(MAX_BODY_TEXT + 1) }))).toBe(false);
    expect(isEngineEvent(note({ target: "" }))).toBe(false);
    expect(isEngineEvent(note({ railKey: "" }))).toBe(false);
    expect(isEngineEvent(note({ inView: "yes" }))).toBe(false);
  });

  it("validates calls", () => {
    const call = (over: object = {}) => ({ type: "call", call: { conversationKey: "c", from: "me", video: false, ...over } });
    expect(isEngineEvent(call())).toBe(true);
    expect(isEngineEvent({ type: "call", call: null })).toBe(false);
    expect(isEngineEvent(call({ conversationKey: "" }))).toBe(false);
    expect(isEngineEvent(call({ from: "f".repeat(MAX_TEXT + 1) }))).toBe(false);
    expect(isEngineEvent(call({ video: 0 }))).toBe(false);
  });

  it("validates accounts", () => {
    for (const state of ["signed-in", "signed-out", "unknown"]) expect(isEngineEvent({ type: "account", account: { state } })).toBe(true);
    expect(isEngineEvent({ type: "account", account: { state: "signed-in", name: "me" } })).toBe(true);
    expect(isEngineEvent({ type: "account", account: { state: "other" } })).toBe(false);
    expect(isEngineEvent({ type: "account", account: { state: "unknown", name: "n".repeat(MAX_TEXT + 1) } })).toBe(false);
    expect(isEngineEvent({ type: "account", account: "x" })).toBe(false);
  });

  it("validates home badges", () => {
    expect(isEngineEvent({ type: "homeBadge", badge: { unread: true, mentions: 2 } })).toBe(true);
    expect(isEngineEvent({ type: "homeBadge", badge: { unread: 1, mentions: 2 } })).toBe(false);
    expect(isEngineEvent({ type: "homeBadge", badge: { unread: true, mentions: -1 } })).toBe(false);
    expect(isEngineEvent({ type: "homeBadge", badge: null })).toBe(false);
  });

  it("rejects unknown types and non-objects", () => {
    expect(isEngineEvent({ type: "nope" })).toBe(false);
    for (const v of [null, undefined, "servers", 1, []]) expect(isEngineEvent(v)).toBe(false);
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
    expect(isEngineCommand({ type: "unknown" })).toBe(false);
    for (const v of [null, "openHome", []]) expect(isEngineCommand(v)).toBe(false);
  });
});

describe("isHttpRequest", () => {
  const http = (over: object = {}) => ({ url: "https://x.test/", method: "GET", headers: {}, ...over });

  it("accepts valid requests", () => {
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) expect(isHttpRequest(http({ method }))).toBe(true);
    expect(isHttpRequest(http({ headers: { "X-Custom-1": "v" }, body: "text" }))).toBe(true);
    expect(isHttpRequest(http({ body: new Uint8Array(3) }))).toBe(true);
    expect(isHttpRequest(http({ headers: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`h${i}`, "v"])) }))).toBe(true);
  });

  it.each([
    ["non-record", "x"],
    ["empty url", http({ url: "" })],
    ["long url", http({ url: "h".repeat(8193) })],
    ["lowercase method", http({ method: "get" })],
    ["unknown method", http({ method: "TRACE" })],
    ["non-string method", http({ method: 1 })],
    ["headers not a record", http({ headers: [] })],
    ["bad header name", http({ headers: { "bad name": "v" } })],
    ["empty header name", http({ headers: { "": "v" } })],
    ["long header name", http({ headers: { ["h".repeat(65)]: "v" } })],
    ["non-string header value", http({ headers: { a: 1 } })],
    ["long header value", http({ headers: { a: "v".repeat(8193) } })],
    ["too many headers", http({ headers: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`h${i}`, "v"])) })],
    ["numeric body", http({ body: 5 })],
    ["array body", http({ body: [1] })],
  ])("rejects %s", (_n, r) => expect(isHttpRequest(r)).toBe(false));

  it("enforces the body cap", () => {
    expect(isHttpRequest(http({ body: "a".repeat(MAX_HTTP_BODY + 1) }))).toBe(false);
    expect(isHttpRequest(http({ body: new Uint8Array(MAX_HTTP_BODY + 1) }))).toBe(false);
    expect(isHttpRequest(http({ body: new Uint8Array(MAX_HTTP_BODY) }))).toBe(true);
  });
});

describe("isEngineRequest", () => {
  it("accepts simple requests", () => {
    expect(isEngineRequest({ type: "info" })).toBe(true);
    expect(isEngineRequest({ type: "pickFiles" })).toBe(true);
    expect(isEngineRequest({ type: "secretLoad", key: "k" })).toBe(true);
    expect(isEngineRequest({ type: "secretDelete", key: "k" })).toBe(true);
    expect(isEngineRequest({ type: "secretSave", key: "k", value: "" })).toBe(true);
    expect(isEngineRequest({ type: "http", request: { url: "https://x.test/", method: "GET", headers: {} } })).toBe(true);
  });

  it("rejects bad secrets and http requests", () => {
    expect(isEngineRequest({ type: "secretLoad", key: "" })).toBe(false);
    expect(isEngineRequest({ type: "secretDelete" })).toBe(false);
    expect(isEngineRequest({ type: "secretSave", key: "", value: "v" })).toBe(false);
    expect(isEngineRequest({ type: "secretSave", key: "k" })).toBe(false);
    expect(isEngineRequest({ type: "secretSave", key: "k", value: "v".repeat(MAX_SECRET + 1) })).toBe(false);
    expect(isEngineRequest({ type: "secretSave", key: "k", value: "v".repeat(MAX_SECRET) })).toBe(true);
    expect(isEngineRequest({ type: "http", request: { url: "", method: "GET", headers: {} } })).toBe(false);
  });

  it("validates readFile ranges", () => {
    const read = (over: object = {}) => ({ type: "readFile", handle: "h", start: 0, end: 10, ...over });
    expect(isEngineRequest(read())).toBe(true);
    expect(isEngineRequest(read({ start: 5, end: 5 }))).toBe(true);
    expect(isEngineRequest(read({ start: 0, end: MAX_READ }))).toBe(true);
    expect(isEngineRequest(read({ end: MAX_READ + 1 }))).toBe(false);
    expect(isEngineRequest(read({ start: 6, end: 5 }))).toBe(false);
    expect(isEngineRequest(read({ start: -1 }))).toBe(false);
    expect(isEngineRequest(read({ end: 1.5 }))).toBe(false);
    expect(isEngineRequest(read({ handle: "" }))).toBe(false);
    expect(isEngineRequest(read({ handle: "h".repeat(65) }))).toBe(false);
  });

  it("rejects unknown types and non-objects", () => {
    expect(isEngineRequest({ type: "nope" })).toBe(false);
    for (const v of [null, undefined, "info", []]) expect(isEngineRequest(v)).toBe(false);
  });
});
