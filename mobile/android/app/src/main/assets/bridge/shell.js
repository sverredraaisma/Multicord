// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
//
// The shell bridge (ShellBridge, src/mobile/protocol.ts) for the shell page, which runs src/core: a
// document-start script native code injects into the shell's origin only, in the page's world; it talks to
// native code through relay.js (in an isolated world where the WebView supports one). The page asks for its
// files once (boot), sends ShellCommands, which native code checks with ShellCommands.isShellCommand, and
// hears NativeEvents, which it checks with isNativeEvent. No engine and no chat view has this bridge.
// Messages are JSON strings.
(() => {
  if (window.multicordShell) return;
  const CHANNEL = "multicord-shell";

  const pending = new Map();
  let nextId = 0;
  const listeners = [];
  // Events that come before the page listens are kept for it.
  const early = [];
  const deliver = (body) => {
    for (const listener of listeners) {
      try {
        listener(body);
      } catch (error) {
        console.error(error);
      }
    }
  };

  window.addEventListener(`${CHANNEL}:in`, (event) => {
    if (typeof event.detail !== "string") return;
    let message;
    try {
      message = JSON.parse(event.detail);
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
    if (message.k !== "event") return;
    if (listeners.length === 0) early.push(message.body);
    else deliver(message.body);
  });

  const send = (message) => window.dispatchEvent(new CustomEvent(`${CHANNEL}:out`, { detail: JSON.stringify(message) }));

  window.multicordShell = Object.freeze({
    request: (body) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ k: "req", id, body });
      }),
    send: (body) => send({ k: "cmd", body }),
    onEvent: (cb) => {
      listeners.push(cb);
      for (const body of early.splice(0)) deliver(body);
    },
  });
})();
