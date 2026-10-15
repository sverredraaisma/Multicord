// Runs in Discord's main world. Hands Rich Presence activities from local
// apps to Discord's client the way its desktop app does (a
// LOCAL_ACTIVITY_UPDATE action), so Discord publishes them itself. This is
// the one action Multicord dispatches, and only while the user has Rich
// Presence turned on. Serialized into the page: it must not reference
// anything outside its own body.

export function discordActivityBridge(eventName: string): void {
  const w = window as any;
  if (w.__multicordActivity) return;
  w.__multicordActivity = true;
  let dispatcher: any;

  const findDispatcher = (): any => {
    const chunks = w.webpackChunkdiscord_app;
    if (!chunks || typeof chunks.push !== "function") return undefined;
    // Several webpack runtimes share the chunk list; the app's is the one with the most modules.
    const found: any[] = [];
    const marker = [Symbol("multicord")];
    chunks.push([marker, {}, (r: any) => void found.push(r)]);
    if (chunks[chunks.length - 1]?.[0] === marker) chunks.pop();
    const size = (r: any): number => Object.keys(r?.c ?? {}).length;
    const req = found.reduce((best, r) => (size(r) > size(best) ? r : best), undefined);
    // The dispatcher the activity store itself listens to: Discord's stores
    // also have dispatch and subscribe, so their shape alone misleads.
    for (const mod of Object.values<any>(req?.c ?? {})) {
      const exports = mod?.exports;
      if (!exports || typeof exports !== "object") continue;
      for (const candidate of [exports, ...Object.values<any>(exports)]) {
        try {
          if (candidate?.getName?.() === "LocalActivityStore" && typeof candidate._dispatcher?.dispatch === "function") return candidate._dispatcher;
        } catch {
          // Not a store.
        }
      }
    }
    return undefined;
  };

  // Updates wait, newest per app, until Discord's modules have loaded.
  const pending = new Map<string, any>();
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    dispatcher ??= findDispatcher();
    if (!dispatcher) {
      if (retries++ < 60) timer = setTimeout(flush, 1000);
      return;
    }
    for (const update of pending.values()) {
      try {
        void dispatcher.dispatch({ type: "LOCAL_ACTIVITY_UPDATE", socketId: update.source, pid: update.pid, activity: update.activity });
      } catch {
        // Discord rejected it; nothing else depends on this.
      }
    }
    pending.clear();
  };

  document.addEventListener(eventName, (event) => {
    let update: any;
    try {
      update = JSON.parse(String((event as CustomEvent).detail));
    } catch {
      return;
    }
    pending.set(String(update.source), update);
    if (timer === undefined) flush();
  });
}
