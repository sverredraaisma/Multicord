// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
//
// The native chat view's bridge (NativeApi, src/preload/native.ts) in the shell WebView, as a document-start
// script native code injects into the shell's origin only. Display state comes in from the engine whose
// view this is; user actions go out to native code, which checks them with isNativeAction and hands them
// to that engine alone. Messages are JSON; a Uint8Array travels as {"$b64": "<base64>"} (Wire.kt).
(() => {
  const host = window.multicordShell;
  if (!host || window.multicordNative) return;
  const BYTES = "$b64";

  const fromBase64 = (base64) => {
    const text = atob(base64);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };
  const isEnvelope = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v[BYTES] === "string" && Object.keys(v).length === 1;
  const decode = (text) => JSON.parse(text, (_key, v) => (isEnvelope(v) ? fromBase64(v[BYTES]) : v));

  const listeners = { state: [] };
  host.addEventListener("message", (event) => {
    let message;
    try {
      message = decode(event.data);
    } catch {
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

  const send = (message) => host.postMessage(JSON.stringify(message));
  // What the desktop's shell sends besides state (voice settings, media limits, favourites, voice
  // commands) comes with the settings and call work of later milestones; until then the view's defaults hold.
  const later = () => {};

  window.multicordNative = Object.freeze({
    onState: (cb) => void listeners.state.push(cb),
    act: (action) => send({ k: "act", body: action }),
    screenAudioEnded: later,
    onVoiceSettings: later,
    onMediaAutoLoad: later,
    onCompact: later,
    onVoiceCommand: later,
    onFavourites: later,
    favourites: later,
  });
})();
