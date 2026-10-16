// The shell page on a phone: a bar on top (menu, title, settings), the rail
// as a drawer, the unified Messages list and the settings page. A service's chat view is a WebView of
// its own that native code puts under the bar; while the drawer is open this
// page lies over it.
import { el, countBadge, setColor } from "../renderer/components/dom";
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

/** Draws the bar, the drawer and which part of the page shows. */
export function renderShell(doc: Document, state: UiState, actions: { open(key: string): void; show(id: string): void }): void {
  const body = doc.body;
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
  messages.querySelector(".badge")?.remove();
  const messagesBadge = countBadge(doc, state.messagesBadge.mentions, "drawer-badge");
  if (messagesBadge) messages.append(messagesBadge);
  doc.getElementById("home")!.hidden = state.screen.page !== "home";
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
        drawerOpen = state.drawer;
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
