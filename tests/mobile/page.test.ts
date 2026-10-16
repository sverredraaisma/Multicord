// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

async function page(platforms = PLATFORMS) {
  const sent: ShellCommand[] = [];
  let emit: (event: unknown) => void = () => {};
  const bridge: ShellBridge = {
    request: async () => ({ files: { platforms }, version: "0.1.0", os: "android" }),
    send: (command) => void sent.push(command),
    onEvent: (cb) => {
      emit = cb;
    },
  };
  const shell = startMobileShell(document, bridge);
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

  it("closes the drawer from its scrim", async () => {
    await page();
    $("menu").click();
    $("scrim").click();
    expect($("drawer").hidden).toBe(true);
  });

  it("opens the settings page, built once, from the bar, the drawer and the home page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sent } = await page(JSON.stringify([{ id: "fluxer", enabled: false }, { id: "telegram", enabled: false }]));
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
