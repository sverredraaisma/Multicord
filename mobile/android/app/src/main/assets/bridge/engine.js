// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
//
// The EngineBridge (src/preload/engine.ts) for an engine page, as a document-start script that native code
// injects into the engine's own origin only, in the page's world. It talks to native code through relay.js
// (in an isolated world where the WebView supports one). It is glue, not a boundary: the page could replace
// it, and gains nothing by that, because native code decides which engine a message comes from (the WebView
// it arrived in) and validates every message as the desktop's main process does.
//
// Messages are JSON; a Uint8Array travels as {"$b64": "<base64>"} (Wire.kt).
(() => {
  if (window.multicordEngine) return;
  const CHANNEL = "multicord-engine";
  const BYTES = "$b64";

  const toBase64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const fromBase64 = (base64) => {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };
  const encode = (value) =>
    JSON.stringify(value, function (key, v) {
      const raw = this[key];
      return raw instanceof Uint8Array ? { [BYTES]: toBase64(raw) } : v;
    });
  const isEnvelope = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v[BYTES] === "string" && Object.keys(v).length === 1;
  const decode = (text) => JSON.parse(text, (_key, v) => (isEnvelope(v) ? fromBase64(v[BYTES]) : v));

  const pending = new Map();
  let nextId = 0;
  const listeners = { command: [], action: [], socket: [] };

  window.addEventListener(`${CHANNEL}:in`, (event) => {
    if (typeof event.detail !== "string") return;
    let message;
    try {
      message = decode(event.detail);
    } catch {
      return;
    }
    if (message.k === "res") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.value);
      else waiting.reject(new Error(typeof message.error === "string" ? message.error : "Request failed"));
      return;
    }
    for (const listener of listeners[message.k] ?? []) {
      try {
        listener(message.body);
      } catch (error) {
        console.error(error);
      }
    }
  });

  const send = (message) => window.dispatchEvent(new CustomEvent(`${CHANNEL}:out`, { detail: encode(message) }));

  window.multicordEngine = Object.freeze({
    request: (body) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        try {
          send({ k: "req", id, body });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      }),
    emit: (body) => send({ k: "emit", body }),
    render: (body) => send({ k: "render", body }),
    onCommand: (cb) => void listeners.command.push(cb),
    onAction: (cb) => void listeners.action.push(cb),
    onSocket: (cb) => void listeners.socket.push(cb),
  });
})();
