// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MOBILE_MODULES, type MobileModule } from "../../src/mobile/modules";
import { startMobileShell } from "../../src/mobile/page";
import type { ShellBridge, ShellCommand } from "../../src/mobile/protocol";

const PAGE = readFileSync("static/mobile/shell.html", "utf8");
const PLATFORMS = JSON.stringify([{ id: "discord", enabled: false }, { id: "fluxer", enabled: false }, { id: "telegram", enabled: false }, { id: "matrix", name: "Matrix", module: "matrix-native", url: "https://matrix.org" }]);

beforeEach(() => {
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(PAGE)![1]!.replace(/<script[^>]*><\/script>/, "");
  document.body.className = "mobile-shell";
  document.body.dataset.page = "home";
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function page(platforms = PLATFORMS, modules?: readonly MobileModule[]) {
  const sent: ShellCommand[] = [];
  let emit: (event: unknown) => void = () => {};
  const bridge: ShellBridge = {
    request: async () => ({ files: { platforms }, version: "0.1.0", os: "android" }),
    send: (command) => void sent.push(command),
    onEvent: (cb) => {
      emit = cb;
    },
  };
  const shell = startMobileShell(document, bridge, modules);
  await flush();
  return { shell, sent, emit: async (event: unknown) => (emit(event), await flush()) };
}

const $ = (id: string) => document.getElementById(id)!;

describe("the phone's shell page", () => {
  it("shows the first service under the bar, with its name as the title", async () => {
    await page();
    expect(document.body.dataset.page).toBe("service");
    expect($("title").textContent).toBe("Matrix");
    expect($("drawer").hidden).toBe(true);
    expect($("settings").hidden).toBe(true);
  });

  it("lists each service's entries in the drawer, with badges, and opens them", async () => {
    const { emit, sent } = await page();
    await emit({ type: "engine", instance: "matrix", event: { type: "servers", servers: [{ key: "g", name: "Folder", unread: false, mentions: 0, kind: "group", expanded: true, children: [{ key: "c", name: "Inner", unread: true, mentions: 3 }] }] } });
    $("menu").click();
    await flush();
    expect($("drawer").hidden).toBe(false);
    expect(document.body.classList.contains("drawer-open")).toBe(true);
    expect([...document.querySelectorAll(".drawer-name")].map((e) => e.textContent)).toEqual(["Direct messages", "Folder", "Inner"]);
    expect(document.querySelector(".drawer-child .drawer-badge")!.textContent).toBe("3");
    expect(document.querySelector("[aria-expanded]")!.getAttribute("aria-expanded")).toBe("true");
    expect($("menu").querySelector(".badge")!.textContent).toBe("3");
    expect(document.title).toBe("(3) Multicord");
    (document.querySelectorAll(".drawer-name")[2] as HTMLElement).click();
    await flush();
    expect(sent.some((c) => c.type === "command" && c.command.type === "openServer" && c.command.key === "c")).toBe(true);
    expect($("drawer").hidden).toBe(true);
    // A heading opens its service.
    $("menu").click();
    (document.querySelector(".drawer-heading") as HTMLElement).click();
    await flush();
    expect($("drawer").hidden).toBe(true);
  });

  it("shows the unified Messages list from the drawer, and opens a conversation in its service", async () => {
    vi.useFakeTimers({ toFake: ["setInterval"] });
    const { emit, sent } = await page(JSON.stringify([{ id: "discord", enabled: false }, { id: "fluxer", enabled: false }, { id: "telegram", name: "TG" }]));
    await emit({ type: "engine", instance: "telegram", event: { type: "directs", directs: [{ key: "7", title: "Ana", preview: "hello", lastActivity: Date.now(), unread: true, mentions: 4 }] } });
    expect($("drawer-messages").querySelector(".drawer-badge")!.textContent).toBe("4");
    expect($("drawer-messages").classList.contains("unread")).toBe(true);
    $("menu").click();
    // Drawn again (the drawer opened): still the one badge.
    expect($("drawer-messages").querySelectorAll(".drawer-badge")).toHaveLength(1);
    $("drawer-messages").click();
    await flush();
    expect(document.body.dataset.page).toBe("messages");
    expect($("messages").hidden).toBe(false);
    expect($("title").textContent).toBe("Messages");
    expect($("drawer-messages").classList.contains("active")).toBe(true);
    expect([...document.querySelectorAll(".conversation-title")].map((e) => e.textContent)).toEqual(["Ana"]);
    expect(document.querySelector(".conversation-preview")!.textContent).toBe("hello");
    vi.advanceTimersByTime(60_000);
    expect(document.querySelectorAll(".conversation")).toHaveLength(1);
    document.querySelector<HTMLElement>(".conversation-button")!.click();
    await flush();
    expect(sent.some((c) => c.type === "command" && c.instance === "telegram" && c.command.type === "openConversation" && c.command.key === "7")).toBe(true);
    expect(document.body.dataset.page).toBe("service");
    expect($("messages").hidden).toBe(true);
    vi.useRealTimers();
  });

  it("takes the theme setting: as the system's, or always light or dark", async () => {
    const { shell } = await page();
    expect(document.documentElement.dataset.theme).toBeUndefined();
    await shell.settingsAction({ type: "update", patch: { general: { theme: "light" } } });
    expect(document.documentElement.dataset.theme).toBe("light");
    await shell.settingsAction({ type: "update", patch: { general: { theme: "dark" } } });
    expect(document.documentElement.dataset.theme).toBe("dark");
    await shell.settingsAction({ type: "update", patch: { general: { theme: "system" } } });
    expect(document.documentElement.dataset.theme).toBeUndefined();
  });

  it("closes the drawer from its scrim", async () => {
    await page();
    $("menu").click();
    $("scrim").click();
    expect($("drawer").hidden).toBe(true);
  });

  it("moves focus into the open drawer, keeps Tab there, and gives it back to the menu button as it closes", async () => {
    const { emit } = await page();
    const servers = (names: string[]) => ({ type: "engine", instance: "matrix", event: { type: "servers", servers: names.map((name) => ({ key: name, name, unread: false, mentions: 0 })) } });
    await emit(servers(["a", "b"]));
    const key = (event: string, shiftKey = false) => {
      const e = new KeyboardEvent("keydown", { key: event, shiftKey, bubbles: true, cancelable: true });
      (document.activeElement ?? document.body).dispatchEvent(e);
      return e;
    };
    expect($("menu").getAttribute("aria-controls")).toBe("drawer");
    // Closed, the page's keys are its own.
    expect(key("Escape").defaultPrevented).toBe(false);
    $("menu").focus();
    $("menu").click();
    expect($("menu").getAttribute("aria-expanded")).toBe("true");
    // The open service's entry has focus; the rest of the page is out of reach.
    const start = document.activeElement as HTMLElement;
    expect($("drawer").contains(start)).toBe(true);
    expect(start.dataset.service ?? start.dataset.key).toBeDefined();
    expect(["bar", "home", "messages", "settings"].every((id) => $(id).hasAttribute("inert"))).toBe(true);
    const items = [...$("drawer").querySelectorAll<HTMLElement>('button:not([tabindex="-1"])')];
    items.at(-1)!.focus();
    expect(key("Tab").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
    expect(key("Tab", true).defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items.at(-1));
    items[1]!.focus();
    expect(key("Tab").defaultPrevented).toBe(false);
    expect(key("Enter").defaultPrevented).toBe(false);
    // Focus outside the drawer comes back into it.
    (document.activeElement as HTMLElement).blur();
    key("Tab", true);
    expect(document.activeElement).toBe(items.at(-1));
    // Drawn again while open: the same entry keeps focus, or, gone, the drawer's start has it.
    const b = [...document.querySelectorAll<HTMLElement>(".drawer-name")].find((e) => e.textContent === "b")!;
    const bKey = b.dataset.key;
    b.focus();
    await emit(servers(["a", "b", "c"]));
    expect((document.activeElement as HTMLElement).dataset.key).toBe(bKey);
    expect(bKey).toBeDefined();
    expect(document.activeElement).not.toBe(b);
    await emit(servers(["a"]));
    expect($("drawer").contains(document.activeElement)).toBe(true);
    document.querySelector<HTMLElement>(".drawer-heading")!.focus();
    await emit(servers(["a", "d"]));
    expect(document.activeElement).toBe(document.querySelector(".drawer-heading"));
    $("drawer-messages").focus();
    await emit(servers(["a"]));
    expect(document.activeElement).toBe($("drawer-messages"));
    // Escape closes it, and the menu button has focus again.
    expect(key("Escape").defaultPrevented).toBe(true);
    expect($("drawer").hidden).toBe(true);
    expect(document.activeElement).toBe($("menu"));
    expect($("bar").hasAttribute("inert")).toBe(false);
    // So does back.
    $("menu").click();
    expect(document.activeElement).not.toBe($("menu"));
    await emit({ type: "back" });
    expect($("drawer").hidden).toBe(true);
    expect(document.activeElement).toBe($("menu"));
  });

  it("opens the settings page, built once, from the bar, the drawer and the home page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Discord stays on (one built-in must), but this host has no Discord module: nothing runs.
    const { sent } = await page(JSON.stringify([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }]), MOBILE_MODULES.filter((m) => !m.discord));
    expect(document.body.dataset.page).toBe("home");
    expect($("home").hidden).toBe(false);
    expect(document.querySelector(".drawer-empty")).not.toBeNull();
    $("home-settings").click();
    await flush();
    expect(document.body.dataset.page).toBe("settings");
    expect($("settings").hidden).toBe(false);
    expect($("settings").querySelector(".settings-nav")).not.toBeNull();
    expect($("settings-button").getAttribute("aria-pressed")).toBe("true");
    $("settings-button").click();
    expect(document.body.dataset.page).toBe("home");
    $("menu").click();
    $("drawer-settings").click();
    await flush();
    expect(document.body.dataset.page).toBe("settings");
    expect(document.querySelectorAll(".settings-nav")).toHaveLength(1);
    // The page's actions reach core: a service added here goes to platforms.json.
    const form = document.querySelector<HTMLFormElement>(".add-service")!;
    form.querySelector<HTMLSelectElement>("select")!.value = "stoat-native";
    form.querySelector<HTMLSelectElement>("select")!.dispatchEvent(new Event("change"));
    form.querySelector<HTMLInputElement>('input[aria-label="Name"]')!.value = "Stoat";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(sent.filter((c) => c.type === "save" && c.file === "platforms").at(-1)).toMatchObject({ text: expect.stringContaining('"stoat-native"') });
  });

  it("says so in the title when core cannot start", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    startMobileShell(document, { request: async () => null, send: vi.fn(), onEvent: vi.fn() });
    await flush();
    expect($("title").textContent).toBe("Multicord could not start");
    expect(error).toHaveBeenCalled();
  });
});
