// The shell page on a phone: a bar on top (menu, title, settings), the rail
// as a drawer, the unified Messages list and the settings page. A service's chat view is a WebView of
// its own that native code puts under the bar; while the drawer is open this
// page lies over it.
import { applyTheme, el, countBadge, setColor } from "../renderer/components/dom";
import { MessagesPage, REFRESH_MS } from "../renderer/messages";
import { serverIcon } from "../renderer/components/serverIcon";
import { startSettings } from "../renderer/settings";
import type { SettingsApi } from "../preload/settings";
import type { RailEntry } from "../shared/ipc";
import type { SettingsViewState } from "../shared/settings";
import type { MobileModule } from "./modules";
import type { ShellBridge } from "./protocol";
import { MobileShell, type UiState } from "./shell";

/**
 * The drawer: one section per service, headed by its name (which opens it),
 * then its home, unread DMs and servers; an expanded group's servers follow
 * it, indented.
 */
export function renderDrawer(root: HTMLElement, state: UiState, actions: { open(key: string): void; show(id: string): void }): void {
  const doc = root.ownerDocument;
  const byService = new Map<string, RailEntry[]>();
  for (const entry of state.rail.entries) {
    const list = byService.get(entry.platform) ?? [];
    list.push(entry);
    byService.set(entry.platform, list);
  }
  const sections = state.services.map((service) => {
    const section = el(doc, "section", "drawer-service");
    const heading = el(doc, "button", "drawer-heading");
    heading.type = "button";
    heading.dataset.service = service.id;
    const label = el(doc, "span", "drawer-module", service.label);
    setColor(label, "--module-color", service.color);
    heading.append(el(doc, "span", "drawer-heading-name", service.name), label);
    const shown = state.screen.page === "service" && state.screen.instance === service.id;
    heading.classList.toggle("active", shown);
    heading.addEventListener("click", () => actions.show(service.id));
    const list = el(doc, "ul", "drawer-list");
    for (const entry of byService.get(service.id) ?? []) {
      const row = el(doc, "li", "drawer-row");
      row.dataset.kind = entry.kind;
      if (entry.parentKey) row.classList.add("drawer-child");
      const active = entry.key === state.rail.activeKey && state.screen.page === "service";
      row.classList.toggle("active", active);
      row.classList.toggle("unread", entry.unread);
      const icon = serverIcon(doc, entry, { active, onOpen: actions.open });
      // The row's name says it; the icon's label would only repeat it.
      icon.tabIndex = -1;
      icon.setAttribute("aria-hidden", "true");
      const name = el(doc, "button", "drawer-name", entry.kind === "home" ? "Direct messages" : entry.name);
      name.type = "button";
      name.dataset.key = entry.key;
      if (entry.kind === "group") name.setAttribute("aria-expanded", String(entry.expanded === true));
      name.addEventListener("click", () => actions.open(entry.key));
      row.append(icon, name);
      const badge = countBadge(doc, entry.mentions, "drawer-badge");
      if (badge) row.append(badge);
      list.append(row);
    }
    section.append(heading, list);
    return section;
  });
  if (sections.length === 0) sections.push(el(doc, "p", "drawer-empty", "No services are turned on. Add one in Settings."));
  root.replaceChildren(...sections);
}

/** The parts of the page under the open drawer. */
const OUTSIDE_DRAWER = ["bar", "home", "messages", "settings"];

/** What takes focus in the drawer, in order; a row's icon repeats its name and is skipped. */
const DRAWER_FOCUSABLE = 'button:not([tabindex="-1"])';

/** Where focus goes as the drawer opens: the open entry (a server or the DMs, else the service, else Messages), else the first. */
function drawerStart(drawer: HTMLElement): HTMLElement {
  for (const selector of [".drawer-row.active .drawer-name", ".drawer-heading.active", "#drawer-messages.active"]) {
    const found = drawer.querySelector<HTMLElement>(selector);
    if (found) return found;
  }
  return drawer.querySelector<HTMLElement>(DRAWER_FOCUSABLE)!;
}

/**
 * The drawer's entries are drawn anew on every update: the one that has focus now, to focus again once
 * drawn (or, gone, where the drawer starts). Undefined when focus is elsewhere, or on a button that stays.
 */
function keepDrawerFocus(doc: Document, drawer: HTMLElement): (() => void) | undefined {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement) || !drawer.contains(active)) return undefined;
  const { key, service } = active.dataset;
  if (key === undefined && service === undefined) return undefined;
  return () => {
    const again = [...drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE)].find((b) => (key === undefined ? b.dataset.service === service : b.dataset.key === key));
    (again ?? drawerStart(drawer)).focus();
  };
}

/** Draws the bar, the drawer and which part of the page shows. */
export function renderShell(doc: Document, state: UiState, actions: { open(key: string): void; show(id: string): void }): void {
  const body = doc.body;
  // The theme setting: as the system's (prefers-color-scheme, as the WebView reports it), else always the one chosen.
  applyTheme(doc, state.theme);
  body.dataset.page = state.screen.page;
  body.classList.toggle("drawer-open", state.drawer);
  doc.getElementById("title")!.textContent = state.title;
  doc.title = state.mentions > 0 ? `(${state.mentions}) Multicord` : "Multicord";
  const menu = doc.getElementById("menu")!;
  menu.setAttribute("aria-expanded", String(state.drawer));
  menu.classList.toggle("unread", state.unread);
  menu.querySelector(".badge")?.remove();
  const badge = countBadge(doc, state.mentions);
  if (badge) menu.append(badge);
  doc.getElementById("settings-button")!.setAttribute("aria-pressed", String(state.screen.page === "settings"));
  const drawer = doc.getElementById("drawer")!;
  drawer.hidden = !state.drawer;
  doc.getElementById("scrim")!.hidden = !state.drawer;
  doc.getElementById("settings")!.hidden = state.screen.page !== "settings";
  doc.getElementById("messages")!.hidden = state.screen.page !== "messages";
  const messages = doc.getElementById("drawer-messages")!;
  messages.classList.toggle("active", state.screen.page === "messages");
  messages.classList.toggle("unread", state.messagesBadge.unread);
  // The badge drawn last time (its class is drawer-badge): one at a time, not one more per render.
  messages.querySelector(".drawer-badge")?.remove();
  const messagesBadge = countBadge(doc, state.messagesBadge.mentions, "drawer-badge");
  if (messagesBadge) messages.append(messagesBadge);
  doc.getElementById("home")!.hidden = state.screen.page !== "home";
  // While the drawer is open it is all there is: the rest of the page is out of reach (Tab, screen readers) until it closes.
  for (const id of OUTSIDE_DRAWER) doc.getElementById(id)!.toggleAttribute("inert", state.drawer);
  renderDrawer(doc.getElementById("drawer-services")!, state, actions);
}

/** Starts the shell page: the bar's buttons, the drawer, and core behind them. */
export function startMobileShell(doc: Document, bridge: ShellBridge, modules?: readonly MobileModule[]): MobileShell {
  let settingsListener: ((state: SettingsViewState) => void) | undefined;
  let settingsStarted = false;
  let pending: SettingsViewState | undefined;
  let drawerOpen = false;
  // The desktop's Messages page, as is: a tap opens the conversation in its service's chat view.
  const messages = new MessagesPage(doc.getElementById("messages")!, { open: (key) => void shell.openConversation(key) });
  doc.defaultView!.setInterval(() => messages.renderList(), REFRESH_MS);
  const shell: MobileShell = new MobileShell(
    bridge,
    {
      render: (state) => {
        const wasOpen = drawerOpen;
        drawerOpen = state.drawer;
        const drawer = doc.getElementById("drawer")!;
        const hadFocus = drawer.contains(doc.activeElement);
        const refocus = wasOpen ? keepDrawerFocus(doc, drawer) : undefined;
        if (state.screen.page === "settings" && !settingsStarted) {
          settingsStarted = true;
          const api: SettingsApi = {
            onState: (cb) => {
              settingsListener = cb;
              if (pending) cb(pending);
            },
            act: (action) => void shell.settingsAction(action),
            ready: () => shell.settingsReady(),
          };
          startSettings(doc, api);
        }
        renderShell(doc, state, { open: (key) => void shell.open(key), show: (id) => shell.show(id) });
        if (state.screen.page === "messages") messages.render(state.messages);
        // Opening moves focus into the drawer; closing (Escape, back, the scrim, a choice) gives it back to the menu button.
        if (state.drawer && !wasOpen) drawerStart(drawer).focus();
        else if (state.drawer) refocus?.();
        else if (wasOpen && (hadFocus || doc.activeElement === doc.body)) doc.getElementById("menu")!.focus();
      },
      settings: (state) => {
        pending = state;
        settingsListener?.(state);
      },
    },
    modules,
  );
  doc.getElementById("menu")!.addEventListener("click", () => shell.setDrawer(!drawerOpen));
  doc.getElementById("scrim")!.addEventListener("click", () => shell.setDrawer(false));
  // The open drawer keeps Tab to itself (it wraps), and Escape closes it, as back does.
  doc.addEventListener("keydown", (event) => {
    if (!drawerOpen) return;
    if (event.key === "Escape") {
      event.preventDefault();
      shell.setDrawer(false);
      return;
    }
    if (event.key !== "Tab") return;
    const drawer = doc.getElementById("drawer")!;
    const items = [...drawer.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE)];
    const first = items[0]!;
    const last = items.at(-1)!;
    const at = doc.activeElement;
    const wrapTo = !drawer.contains(at) ? (event.shiftKey ? last : first) : event.shiftKey && at === first ? last : !event.shiftKey && at === last ? first : undefined;
    if (!wrapTo) return;
    event.preventDefault();
    wrapTo.focus();
  });
  doc.getElementById("settings-button")!.addEventListener("click", () => shell.setSettingsOpen(doc.body.dataset.page !== "settings"));
  doc.getElementById("drawer-settings")!.addEventListener("click", () => shell.setSettingsOpen(true));
  doc.getElementById("drawer-messages")!.addEventListener("click", () => shell.setMessagesOpen(true));
  doc.getElementById("home-settings")!.addEventListener("click", () => shell.setSettingsOpen(true));
  void shell.start().catch((error: Error) => {
    doc.getElementById("title")!.textContent = "Multicord could not start";
    console.error(error);
  });
  return shell;
}
