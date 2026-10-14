// Runs in Discord's main world. Replaces the page's Notification constructor
// so Discord's notifications go to Multicord's shell, which shows them like
// every other platform's (respecting the notification setting and streamer
// mode). Clicking ours runs Discord's own click handler, so Discord itself
// navigates. Serialized into the page: it must not reference anything
// outside its own body.

export function discordNotificationRelay(eventName: string, clickEventName: string, maxRemembered: number): void {
  const w = window as any;
  const Original = w.Notification;
  if (!Original || Original.__multicord) return;
  const shown = new Map<string, any>();
  let next = 0;

  // Not an EventTarget subclass: its own small listener list behaves the same in every engine.
  class RelayedNotification {
    private readonly listeners = new Map<string, Set<(event: Event) => void>>();
    static __multicord = true;
    static get permission(): string {
      return Original.permission;
    }
    static requestPermission(...args: unknown[]): unknown {
      return Original.requestPermission(...args);
    }

    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly icon: string;
    readonly data: unknown;
    onclick: ((event: Event) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onshow: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    constructor(title: unknown, options: any = {}) {
      this.title = String(title ?? "");
      this.body = String(options?.body ?? "");
      this.tag = String(options?.tag ?? "");
      this.icon = String(options?.icon ?? "");
      this.data = options?.data;
      const id = String(++next);
      shown.set(id, this);
      if (shown.size > maxRemembered) shown.delete(shown.keys().next().value!);
      document.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify({ id, title: this.title, body: this.body }) }));
      setTimeout(() => this.fire("show"), 0);
    }

    close(): void {
      this.fire("close");
    }

    addEventListener(type: string, listener: (event: Event) => void): void {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type)!.add(listener);
    }

    removeEventListener(type: string, listener: (event: Event) => void): void {
      this.listeners.get(type)?.delete(listener);
    }

    private fire(type: "show" | "close" | "click"): void {
      const event = new Event(type);
      for (const listener of this.listeners.get(type) ?? []) listener.call(this, event);
      (this as any)[`on${type}`]?.call(this, event);
    }

    /** Called when the user clicks the shell's notification. */
    click(): void {
      this.fire("click");
    }
  }

  document.addEventListener(clickEventName, (event) => {
    const id = (event as CustomEvent<unknown>).detail;
    if (typeof id === "string") shown.get(id)?.click();
  });
  w.Notification = RelayedNotification;
}
