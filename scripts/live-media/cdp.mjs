// Chrome DevTools Protocol: evaluate an expression in the first page of a
// scratch Electron whose URL matches, and wait for its promise.

/** @returns {Promise<any>} the expression's value (returned by value) */
export async function evaluate(port, pattern, expression, timeoutMs = 60_000) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const target = targets.find((t) => t.webSocketDebuggerUrl && t.type === "page" && new RegExp(pattern).test(t.url));
  if (!target) throw new Error(`no page matching ${pattern} on DevTools port ${port}`);
  return evaluateIn(target, expression, timeoutMs, pattern);
}

/**
 * Evaluates an expression in one given target (from the DevTools /json list),
 * for pages that share a URL.
 * @returns {Promise<any>} the expression's value (returned by value)
 */
export async function evaluateIn(target, expression, timeoutMs = 60_000, name = target.url) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", () => reject(new Error(`DevTools connection to ${name} failed`)));
  });
  try {
    const reply = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out evaluating in ${name}`)), timeoutMs);
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.id !== 1) return;
        clearTimeout(timer);
        resolve(msg);
      });
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true, userGesture: true } }));
    });
    if (reply.error) throw new Error(`DevTools: ${reply.error.message}`);
    const r = reply.result;
    if (r?.exceptionDetails) throw new Error(`in page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r?.result?.value;
  } finally {
    ws.close();
  }
}

/** Whether a DevTools endpoint lists a page matching the pattern. */
export async function hasPage(port, pattern) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    return targets.some((t) => t.type === "page" && new RegExp(pattern).test(t.url));
  } catch {
    return false;
  }
}
