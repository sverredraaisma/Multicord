// Multicord for Android. Copyright (C) 2026 Multicord contributors. AGPL-3.0-or-later, see LICENSE at the repo root.
//
// The relay between a page's bridge API (engine.js, shell.js, in the page's own world) and the native
// message listener. Where the WebView supports it, native code injects this script, and the listener, into
// a named isolated world: the page's scripts then never hold the listener object and reach native code
// only through this relay, as strings; native code accepts messages from that world alone. Elsewhere both
// run in the page's world. Native code fills in the listener's name and the channel before injecting.
//
// The two worlds share the DOM: the page sends with a "<channel>:out" event on window, this relay answers
// with "<channel>:in"; both carry a JSON string as their detail.
(() => {
  const host = window.__LISTENER__;
  const channel = "__CHANNEL__";
  if (!host || typeof host.postMessage !== "function") return;
  window.addEventListener(`${channel}:out`, (event) => {
    if (typeof event.detail === "string") host.postMessage(event.detail);
  });
  host.addEventListener("message", (event) => {
    if (typeof event.data === "string") window.dispatchEvent(new CustomEvent(`${channel}:in`, { detail: event.data }));
  });
})();
