// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
//
// A chat view's bridge (NativeApi, src/preload/native.ts) in that instance's view WebView, as a document-start
// script native code injects into the view's own origin only, in the page's world; it talks to native code
// through relay.js (in an isolated world where the WebView supports one). Display state comes in from the
// engine whose view this is; user actions go out to native code, which checks them with isNativeAction and
// hands them to that engine alone. The view never reaches the shell page or another instance.
//
// Besides the desktop's API it has onBack: the system's back goes to the view first (one pane at a time,
// src/renderer/mobilePanes.ts), and native code hears whether the view used it. And a call's audio routes:
// onAudioRoutes hears where it plays and where it can, setAudioRoute asks for another (CallAudio.kt). And
// sockets: the WebSockets of the view's calls (LiveKit's signalling), which native code opens and relays as it
// does an engine's (ViewSockets.kt, bridgeWebSocket in src/engine/runtime.ts); the page has none of its own.
// Messages are JSON; a Uint8Array travels as {"$b64": "<base64>"} (Wire.kt).
(() => {
  if (window.multicordNative) return;
  const CHANNEL = "multicord-view";
  const BYTES = "$b64";

  const fromBase64 = (base64) => {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };
  const isEnvelope = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v[BYTES] === "string" && Object.keys(v).length === 1;
  const decode = (text) => JSON.parse(text, (_key, v) => (isEnvelope(v) ? fromBase64(v[BYTES]) : v));
  const toBase64 = (bytes) => {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  const encode = (message) => JSON.stringify(message, (_key, v) => (v instanceof Uint8Array ? { [BYTES]: toBase64(v) } : v));

  const send = (message) => window.dispatchEvent(new CustomEvent(`${CHANNEL}:out`, { detail: encode(message) }));
  const listeners = { state: [], media: [], back: [], routes: [], socket: [] };
  // Socket requests waiting for native code's answer, by number.
  const pending = new Map();
  let requests = 0;
  const run = (list, value) => {
    for (const listener of list) {
      try {
        listener(value);
      } catch (error) {
        console.error(error);
      }
    }
  };
  window.addEventListener(`${CHANNEL}:in`, (event) => {
    if (typeof event.detail !== "string") return;
    let message;
    try {
      message = decode(event.detail);
    } catch {
      return;
    }
    switch (message.k) {
      case "state":
        return run(listeners.state, message.body);
      // The service's limit for media that loads by itself; null for any size.
      case "media":
        if (message.body === null) return run(listeners.media, Infinity);
        if (typeof message.body === "number" && message.body >= 0) run(listeners.media, message.body);
        return;
      // Where a call plays and where it can (CallAudio.kt); the page checks the shape again (isAudioRoutes).
      case "routes":
        return run(listeners.routes, message.body);
      // What happens on the view's sockets; the page checks each event (isEngineSocketEvent).
      case "socket":
        return run(listeners.socket, message.body);
      case "socketDone": {
        const waiting = pending.get(message.n);
        if (!waiting) return;
        pending.delete(message.n);
        if (message.ok === true) waiting.resolve(message.value ?? null);
        else waiting.reject(new Error(typeof message.error === "string" ? message.error : "Socket request failed"));
        return;
      }
      case "back": {
        let handled = false;
        for (const listener of listeners.back) {
          try {
            handled = listener() === true || handled;
          } catch (error) {
            console.error(error);
          }
        }
        return send({ k: "back", id: message.id, handled });
      }
    }
  });

  // Voice settings, global voice keys and favourites are the desktop's; on the phone the view's defaults hold.
  const later = () => {};

  window.multicordNative = Object.freeze({
    onState: (cb) => void listeners.state.push(cb),
    act: (action) => send({ k: "act", body: action }),
    onMediaAutoLoad: (cb) => void listeners.media.push(cb),
    onBack: (cb) => void listeners.back.push(cb),
    onAudioRoutes: (cb) => void listeners.routes.push(cb),
    // Native code takes only a route it offered (AudioRoute.of), for a call in progress.
    setAudioRoute: (route) => send({ k: "route", route: String(route) }),
    // Native code checks each request (Validators.isEngineRequest) and the socket's URL (wss, the engine's hosts now, a call in progress).
    sockets: Object.freeze({
      request: (request) =>
        new Promise((resolve, reject) => {
          const n = ++requests;
          pending.set(n, { resolve, reject });
          send({ k: "socket", n, body: request });
        }),
      onSocket: (cb) => void listeners.socket.push(cb),
    }),
    screenAudioEnded: later,
    onVoiceSettings: later,
    onCompact: later,
    onVoiceCommand: later,
    onFavourites: later,
    favourites: later,
  });
})();
