// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsApi } from "../../src/preload/settings";
import type { DeviceInfo, MediaEnv } from "../../src/renderer/media";
import { accountText, CONFIRM_MS, confirmButton, deviceOptions, SettingsPage, startSettings, switchRow, TABS } from "../../src/renderer/settings";
import { DEFAULT_SETTINGS, type ModuleInfo, type ServiceInfo, type SettingsViewState } from "../../src/shared/settings";

const service = (over: Partial<ServiceInfo> = {}): ServiceInfo => ({
  id: "discord",
  name: "Discord",
  url: "https://discord.com",
  module: "discord",
  moduleName: "Discord",
  label: "DC",
  color: "#5865f2",
  enabled: true,
  builtIn: true,
  account: { state: "signed-in", name: "Sam" },
  ...over,
});

const modules: ModuleInfo[] = [
  { id: "discord", name: "Discord", label: "DC", color: "#5865f2", defaultUrl: "https://discord.com", fixedUrl: true },
  { id: "fluxer", name: "Fluxer", label: "FX", color: "#4641d9", defaultUrl: "https://fluxer.app", fixedUrl: false },
  { id: "web", name: "Web app", label: "WB", color: "#888888", fixedUrl: false },
];

const viewState = (over: Partial<SettingsViewState> = {}): SettingsViewState => ({
  settings: structuredClone(DEFAULT_SETTINGS),
  services: [service()],
  modules,
  restartNeeded: false,
  secretsPersistent: true,
  launchAtLoginSupported: true,
  version: "1.2.3",
  ...over,
});

const dev = (kind: string, deviceId: string, label: string): DeviceInfo => ({ kind, deviceId, label });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const fakeStream = () => {
  const stream = new MediaStream();
  const tracks = [{ stop: vi.fn() }];
  stream.getTracks = () => tracks as unknown as MediaStreamTrack[];
  return stream as MediaStream & { getTracks(): { stop: ReturnType<typeof vi.fn> }[] };
};

function fakeContext(setSinkId?: (id: string) => Promise<void>) {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  return {
    currentTime: 0,
    destination: {},
    createAnalyser: () => ({ fftSize: 0, getByteTimeDomainData: (s: Uint8Array) => s.fill(192) }),
    createMediaStreamSource: () => ({ connect: vi.fn() }),
    createGain: () => ({ gain: param(), connect: vi.fn() }),
    createOscillator: () => ({ frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }),
    close: vi.fn(async () => {}),
    ...(setSinkId ? { setSinkId } : {}),
  };
}

type FakeEnv = MediaEnv & { enumerate: ReturnType<typeof vi.fn>; getUserMedia: ReturnType<typeof vi.fn>; changeCb?: () => void };

let devices: DeviceInfo[];
let context: ReturnType<typeof fakeContext>;
let env: FakeEnv;
let act: ReturnType<typeof vi.fn>;
let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = `<div id="settings"></div>`;
  root = document.getElementById("settings")!;
  devices = [];
  context = fakeContext();
  act = vi.fn();
  env = {
    enumerate: vi.fn(async () => devices),
    getUserMedia: vi.fn(async () => fakeStream()),
    onDeviceChange: (cb: () => void) => void (env.changeCb = cb),
    audioContext: () => context as unknown as AudioContext,
    frame: vi.fn(() => 1),
    cancelFrame: vi.fn(),
  };
});

afterEach(() => vi.useRealTimers());

function mount(state: SettingsViewState | null = viewState()): SettingsPage {
  const page = new SettingsPage(root, { act } as Pick<SettingsApi, "act">, env);
  if (state) page.render(state);
  return page;
}

const q = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = root): T => scope.querySelector<T>(sel)!;
const button = (text: string, scope: ParentNode = root): HTMLButtonElement =>
  [...scope.querySelectorAll("button")].find((b) => b.textContent === text) as HTMLButtonElement;
const row = (id = "discord") => q(`li[data-id="${id}"]`);
const change = (input: HTMLInputElement | HTMLSelectElement, value?: string | boolean) => {
  if (typeof value === "boolean") (input as HTMLInputElement).checked = value;
  else if (value !== undefined) input.value = value;
  input.dispatchEvent(new Event("change"));
};
const switchFor = (label: string) =>
  q<HTMLInputElement>("input", [...root.querySelectorAll(".switch-row")].find((r) => r.textContent!.includes(label)) as HTMLElement);
const submit = (form: Element) => form.dispatchEvent(new Event("submit", { cancelable: true }));
const goVoice = async (page: SettingsPage) => {
  page.showTab("voice");
  await flush();
};
const sel = (label: string) => q<HTMLSelectElement>(`select[aria-label="${label}"]`);
const optionTexts = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);
const hintNotAvailable = () => [...root.querySelectorAll<HTMLElement>("p.hint")].find((p) => p.textContent!.includes("not available"))!;

describe("helpers", () => {
  it("accountText describes every state", () => {
    expect(accountText(service({ enabled: false }))).toBe("Turned off");
    expect(accountText(service({ account: undefined }))).toBe("Starts after a restart");
    expect(accountText(service())).toBe("Signed in as Sam");
    expect(accountText(service({ account: { state: "signed-in" } }))).toBe("Signed in");
    expect(accountText(service({ account: { state: "signed-out" } }))).toBe("Not signed in");
    expect(accountText(service({ account: { state: "unknown" } }))).toBe("Open it to see the account");
  });

  it("switchRow reports changes and shows its hint", () => {
    const onChange = vi.fn();
    const { row, input } = switchRow(document, "Label", "Hint", onChange);
    expect(row.textContent).toContain("Hint");
    expect(input.getAttribute("role")).toBe("switch");
    change(input, true);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(switchRow(document, "L", undefined, onChange).row.querySelector(".hint")).toBeNull();
  });

  it("confirmButton needs two clicks and resets after CONFIRM_MS", () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    const b = confirmButton(document, "Sign out", "Sure?", onConfirm);
    b.click();
    expect(b.textContent).toBe("Sure?");
    expect(b.classList.contains("confirming")).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CONFIRM_MS);
    expect(b.textContent).toBe("Sign out");
    expect(b.classList.contains("confirming")).toBe(false);
    b.click();
    b.click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(b.className).toContain("danger");
    vi.advanceTimersByTime(CONFIRM_MS);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("deviceOptions lists defaults, matches by id or label and keeps missing devices", () => {
    const list = [dev("audioinput", "default", "Default"), dev("audioinput", "a", "Mic A"), dev("audioinput", "b", ""), dev("videoinput", "c", "Cam")];
    expect(deviceOptions(list, "input", undefined)).toEqual([
      { value: "", label: "System default", selected: true },
      { value: "a", label: "Mic A", selected: false },
      { value: "b", label: "Microphone 2", selected: false },
    ]);
    expect(deviceOptions(list, "input", { id: "a", label: "x" }).map((o) => o.selected)).toEqual([false, true, false]);
    expect(deviceOptions(list, "input", { id: "zzz", label: "Mic A" }).map((o) => o.selected)).toEqual([false, true, false]);
    expect(deviceOptions(list, "output", { id: "old", label: "" }).at(-1)).toEqual({ value: "old", label: "Speaker (not connected)", selected: true });
  });
});

describe("services tab", () => {
  it("renders names, module tags and account text", () => {
    mount(
      viewState({
        services: [
          service(),
          service({ id: "two", name: "Anon", account: { state: "signed-in" } }),
          service({ id: "out", name: "Out", account: { state: "signed-out" } }),
          service({ id: "unk", name: "Unk", account: { state: "unknown" } }),
          service({ id: "off", name: "Off", enabled: false, account: undefined }),
          service({ id: "new", name: "New", account: undefined }),
        ],
      }),
    );
    expect(q(".service-name", row()).textContent).toBe("Discord");
    expect(q(".module-tag", row()).textContent).toBe("DC");
    expect(q(".module-tag", row()).style.getPropertyValue("--module-color")).toBe("#5865f2");
    const status = (id: string) => q(".service-status", row(id));
    expect(status("discord").textContent).toBe("Signed in as Sam");
    expect(status("two").textContent).toBe("Signed in");
    expect(status("out").textContent).toBe("Not signed in");
    expect(status("unk").dataset.state).toBe("unknown");
    expect(status("off").textContent).toBe("Turned off");
    expect(status("off").dataset.state).toBe("off");
    expect(row("off").classList.contains("off")).toBe(true);
    expect(status("new").textContent).toBe("Starts after a restart");
    expect(status("new").dataset.state).toBe("pending");
    expect(button("Open", row("new"))).toBeUndefined();
  });

  it("the switch sends setEnabled", () => {
    mount();
    const input = q<HTMLInputElement>('input[aria-label="Discord on"]');
    expect(input.checked).toBe(true);
    change(input, false);
    expect(act).toHaveBeenCalledWith({ type: "setEnabled", id: "discord", enabled: false });
  });

  it("Open and Sign in send openService", () => {
    mount(viewState({ services: [service(), service({ id: "out", account: { state: "signed-out" } })] }));
    button("Open", row()).click();
    expect(act).toHaveBeenCalledWith({ type: "openService", id: "discord" });
    expect(button("Sign out", row("out"))).toBeUndefined();
    button("Sign in", row("out")).click();
    expect(act).toHaveBeenCalledWith({ type: "openService", id: "out" });
  });

  it("Sign out and Remove ask for confirmation; built-in services have no Remove", () => {
    mount(viewState({ services: [service(), service({ id: "extra", builtIn: false })] }));
    expect(button("Remove", row())).toBeUndefined();
    button("Sign out", row()).click();
    expect(act).not.toHaveBeenCalled();
    button("Click again to sign out", row()).click();
    expect(act).toHaveBeenCalledWith({ type: "signOut", id: "discord" });
    button("Remove", row("extra")).click();
    expect(act).toHaveBeenCalledTimes(1);
    button("Click again to remove", row("extra")).click();
    expect(act).toHaveBeenCalledWith({ type: "removeService", id: "extra" });
  });

  it("renames a service only when the name changed", () => {
    mount();
    button("Rename", row()).click();
    const form = q(".rename", row());
    expect(q<HTMLInputElement>("input", form).value).toBe("Discord");
    expect(button("Rename", row())).toBeUndefined();
    submit(form);
    expect(act).not.toHaveBeenCalled();
    expect(root.querySelector(".rename")).toBeNull();

    button("Rename", row()).click();
    const input = q<HTMLInputElement>(".rename input", row());
    input.value = "  Work  ";
    input.dispatchEvent(new Event("input"));
    submit(q(".rename", row()));
    expect(act).toHaveBeenCalledWith({ type: "renameService", id: "discord", name: "Work" });
  });

  it("keeps the rename draft across state updates, and Cancel closes", () => {
    const page = mount();
    button("Rename", row()).click();
    const input = q<HTMLInputElement>(".rename input", row());
    input.value = "Draft";
    input.dispatchEvent(new Event("input"));
    page.render(viewState());
    expect(q<HTMLInputElement>(".rename input", row()).value).toBe("Draft");
    button("Cancel", row()).click();
    expect(root.querySelector(".rename")).toBeNull();
    expect(act).not.toHaveBeenCalled();
  });

  it("ignores a blank rename", () => {
    mount();
    button("Rename", row()).click();
    q<HTMLInputElement>(".rename input", row()).value = "  ";
    submit(q(".rename", row()));
    expect(act).not.toHaveBeenCalled();
  });
});

describe("add form", () => {
  const nameInput = () => q<HTMLInputElement>('input[aria-label="Name"]');
  const urlInput = () => q<HTMLInputElement>('input[aria-label="Address"]');
  const form = () => q(".add-service");
  const urlRow = () => urlInput().parentElement!;

  it("lists modules, labelling fixed-url ones as accounts", () => {
    mount();
    expect(optionTexts(sel("Service type"))).toEqual(["Discord account", "Fluxer", "Web app"]);
  });

  it("hides the address for fixedUrl modules and requires it without a default", () => {
    mount();
    const select = sel("Service type");
    expect(urlRow().hidden).toBe(true);
    change(select, "fluxer");
    expect(urlRow().hidden).toBe(false);
    expect(urlInput().placeholder).toBe("https://fluxer.app");
    expect(urlInput().required).toBe(false);
    change(select, "web");
    expect(urlInput().placeholder).toBe("https://");
    expect(urlInput().required).toBe(true);
  });

  it("sends addService with or without a url and clears the fields", () => {
    mount();
    nameInput().value = " Second ";
    submit(form());
    expect(act).toHaveBeenCalledWith({ type: "addService", module: "discord", name: "Second" });
    expect(nameInput().value).toBe("");

    change(sel("Service type"), "fluxer");
    nameInput().value = "Mine";
    urlInput().value = " https://example.org ";
    submit(form());
    expect(act).toHaveBeenLastCalledWith({ type: "addService", module: "fluxer", name: "Mine", url: "https://example.org" });
    expect(urlInput().value).toBe("");

    nameInput().value = "Plain";
    submit(form());
    expect(act).toHaveBeenLastCalledWith({ type: "addService", module: "fluxer", name: "Plain" });
  });

  it("drops the address for fixedUrl modules", () => {
    mount();
    nameInput().value = "Alt";
    urlInput().value = "https://evil.example";
    submit(form());
    expect(act).toHaveBeenCalledWith({ type: "addService", module: "discord", name: "Alt" });
  });

  it("ignores an empty name, and submitting before modules arrive", () => {
    mount();
    nameInput().value = "   ";
    submit(form());
    expect(act).not.toHaveBeenCalled();
    root.innerHTML = "";
    mount(viewState({ modules: [] }));
    nameInput().value = "x";
    submit(form());
    root.innerHTML = "";
    mount(null);
    nameInput().value = "x";
    submit(form());
    expect(act).not.toHaveBeenCalled();
  });

  it("keeps the chosen module across updates and when modules change", () => {
    const page = mount();
    change(sel("Service type"), "web");
    page.render(viewState());
    expect(sel("Service type").value).toBe("web");
    page.render(viewState({ modules: modules.slice(0, 2) }));
    expect(optionTexts(sel("Service type"))).toEqual(["Discord account", "Fluxer"]);
    expect(sel("Service type").value).toBe("discord");
    page.render(viewState({ modules: modules.slice(1) }));
    expect(sel("Service type").value).toBe("fluxer");
    page.render(viewState({ modules: [...modules.slice(1), { ...modules[0]!, id: "extra" }] }));
    expect(sel("Service type").value).toBe("fluxer");
  });
});

describe("banners", () => {
  it("shows the restart banner with a Restart now button", () => {
    const page = mount();
    expect(q(".restart-banner").hidden).toBe(true);
    page.render(viewState({ restartNeeded: true }));
    expect(q(".restart-banner").hidden).toBe(false);
    button("Restart now").click();
    expect(act).toHaveBeenCalledWith({ type: "restart" });
  });

  it("shows and clears the error", () => {
    const page = mount(viewState({ error: "Cannot turn off the only service" }));
    expect(q(".settings-error").hidden).toBe(false);
    expect(q(".settings-error").textContent).toBe("Cannot turn off the only service");
    page.render(viewState());
    expect(q(".settings-error").hidden).toBe(true);
    expect(q(".settings-error").textContent).toBe("");
  });
});

describe("general and about", () => {
  it("general switches reflect state and send updates", () => {
    const state = viewState();
    state.settings.general = { closeToTray: false, launchAtLogin: true, notifications: false };
    mount(state);
    expect(switchFor("tray").checked).toBe(false);
    expect(switchFor("Start with").checked).toBe(true);
    change(switchFor("tray"), true);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { general: { closeToTray: true } } });
    change(switchFor("Start with"), false);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { general: { launchAtLogin: false } } });
    change(switchFor("Desktop notif"), true);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { general: { notifications: true } } });
  });

  it("disables launch at login with a hint when unsupported", () => {
    const page = mount(viewState({ launchAtLoginSupported: false }));
    expect(switchFor("Start with").disabled).toBe(true);
    expect(hintNotAvailable().hidden).toBe(false);
    page.render(viewState());
    expect(switchFor("Start with").disabled).toBe(false);
    expect(hintNotAvailable().hidden).toBe(true);
  });

  it("shows the secrets note only when secrets are not persistent", () => {
    const page = mount(viewState({ secretsPersistent: false }));
    const note = q(".notice");
    expect(note.hidden).toBe(false);
    page.render(viewState());
    expect(note.hidden).toBe(true);
  });

  it("processing switches send voice updates", () => {
    const state = viewState();
    state.settings.voice.noiseSuppression = false;
    mount(state);
    expect(switchFor("Noise").checked).toBe(false);
    change(switchFor("Echo"), false);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { echoCancellation: false } } });
    change(switchFor("Noise"), true);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { noiseSuppression: true } } });
    change(switchFor("gain"), false);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { autoGainControl: false } } });
  });

  it("shows the version", () => {
    mount();
    expect(q(".version").textContent).toBe("Multicord 1.2.3");
  });
});

describe("tabs", () => {
  it("switches tabs, marking the current one and hiding the others", () => {
    const page = mount();
    const tabButtons = [...root.querySelectorAll<HTMLElement>(".settings-tab")];
    expect(tabButtons.map((b) => b.textContent)).toEqual(TABS.map((t) => t.title));
    const hiddenSections = () => [...root.querySelectorAll<HTMLElement>("section")].map((s) => s.hidden);
    expect(hiddenSections()).toEqual([false, true, true, true]);
    tabButtons[2]!.click();
    expect(page.activeTab).toBe("general");
    expect(hiddenSections()).toEqual([true, true, false, true]);
    expect(tabButtons[2]!.getAttribute("aria-current")).toBe("page");
    expect(tabButtons[0]!.hasAttribute("aria-current")).toBe(false);
    expect(tabButtons[2]!.classList.contains("active")).toBe(true);
  });
});

describe("voice tab", () => {
  it("lists devices when opened, with system default first", async () => {
    devices = [dev("audioinput", "default", "Default"), dev("audioinput", "m1", "Mic 1"), dev("audiooutput", "s1", "Speaker 1"), dev("videoinput", "c1", "Cam 1")];
    await goVoice(mount());
    expect(optionTexts(sel("Microphone"))).toEqual(["System default", "Mic 1"]);
    expect(optionTexts(sel("Speakers"))).toEqual(["System default", "Speaker 1"]);
    expect(optionTexts(sel("Camera"))).toEqual(["System default", "Cam 1"]);
    expect(env.getUserMedia).not.toHaveBeenCalled();
  });

  it("unlocks device names through the microphone when labels are empty", async () => {
    const stream = fakeStream();
    env.getUserMedia.mockResolvedValue(stream);
    env.enumerate.mockResolvedValueOnce([dev("audioinput", "m1", "")]).mockResolvedValue([dev("audioinput", "m1", "Real mic")]);
    await goVoice(mount());
    expect(env.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalled();
    expect(optionTexts(sel("Microphone"))).toEqual(["System default", "Real mic"]);
  });

  it("falls back to numbered names when permission is refused", async () => {
    devices = [dev("audioinput", "m1", "")];
    env.getUserMedia.mockRejectedValue(new Error("denied"));
    await goVoice(mount());
    expect(optionTexts(sel("Microphone"))).toEqual(["System default", "Microphone 1"]);
  });

  it("survives a failing enumerate and opening before any state arrived", async () => {
    env.enumerate.mockRejectedValue(new Error("nope"));
    const page = mount(null);
    await goVoice(page);
    page.render(viewState());
    await goVoice(page);
    expect(optionTexts(sel("Microphone"))).toEqual(["System default"]);
  });

  it("re-lists devices when they change", async () => {
    await goVoice(mount());
    devices = [dev("audioinput", "m2", "New mic")];
    env.changeCb!();
    await flush();
    expect(optionTexts(sel("Microphone"))).toEqual(["System default", "New mic"]);
  });

  it("choosing a device sends {id,label}; System default sends null", async () => {
    devices = [dev("audioinput", "m1", "Mic 1")];
    await goVoice(mount());
    change(sel("Microphone"), "m1");
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { input: { id: "m1", label: "Mic 1" } } } });
    change(sel("Microphone"), "");
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { input: null } } });
    sel("Microphone").replaceChildren();
    change(sel("Microphone"));
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { input: null } } });
  });

  it("shows a saved but missing device as not connected and keeps its label when chosen", async () => {
    const state = viewState();
    state.settings.voice.output = { id: "gone", label: "Old speakers" };
    await goVoice(mount(state));
    const select = sel("Speakers");
    expect(optionTexts(select)).toEqual(["System default", "Old speakers (not connected)"]);
    expect(select.value).toBe("gone");
    change(select);
    expect(act).toHaveBeenLastCalledWith({ type: "update", patch: { voice: { output: { id: "gone", label: "Old speakers" } } } });
  });

  describe("microphone test", () => {
    const meter = () => q(".meter");

    it("starts and stops, driving the meter", async () => {
      const state = viewState();
      state.settings.voice.noiseSuppression = false;
      devices = [dev("audioinput", "m1", "Mic 1")];
      await goVoice(mount(state));
      change(sel("Microphone"), "m1");
      button("Test").click();
      await flush();
      expect(env.getUserMedia).toHaveBeenCalledWith({
        audio: { deviceId: { exact: "m1" }, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      });
      expect(meter().style.getPropertyValue("--level")).toBe("1.000");
      button("Stop").click();
      await flush();
      expect(button("Test")).toBeDefined();
      expect(meter().style.getPropertyValue("--level")).toBe("0");
      expect(context.close).toHaveBeenCalled();
    });

    it("uses the default device and works before any state arrived", async () => {
      mount(null);
      button("Test").click();
      await flush();
      expect(env.getUserMedia).toHaveBeenCalledWith({
        audio: { echoCancellation: undefined, noiseSuppression: undefined, autoGainControl: undefined },
      });
    });

    it("restarts when another microphone is picked", async () => {
      devices = [dev("audioinput", "m1", "Mic 1"), dev("audioinput", "m2", "Mic 2")];
      await goVoice(mount());
      button("Test").click();
      await flush();
      change(sel("Microphone"), "m2");
      await flush();
      expect(env.getUserMedia).toHaveBeenCalledTimes(2);
      expect(env.getUserMedia).toHaveBeenLastCalledWith({ audio: expect.objectContaining({ deviceId: { exact: "m2" } }) });
      expect(button("Stop")).toBeDefined();
    });

    it("shows an error when the microphone cannot be opened", async () => {
      mount();
      env.getUserMedia.mockRejectedValue(new Error("busy"));
      button("Test").click();
      await flush();
      expect(q(".settings-error").hidden).toBe(false);
      expect(q(".settings-error").textContent).toBe("Could not open the microphone: busy");
      expect(button("Test")).toBeDefined();
    });
  });

  describe("camera preview", () => {
    it("starts and stops the preview", async () => {
      devices = [dev("videoinput", "c1", "Cam 1")];
      await goVoice(mount());
      const preview = q<HTMLVideoElement>("video");
      expect(preview.hidden).toBe(true);
      change(sel("Camera"), "c1");
      button("Preview").click();
      await flush();
      expect(env.getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: "c1" } } });
      expect(preview.hidden).toBe(false);
      button("Stop").click();
      await flush();
      expect(preview.hidden).toBe(true);
      expect(button("Preview")).toBeDefined();
    });

    it("restarts when another camera is picked", async () => {
      devices = [dev("videoinput", "c1", "Cam 1"), dev("videoinput", "c2", "Cam 2")];
      await goVoice(mount());
      button("Preview").click();
      await flush();
      change(sel("Camera"), "c2");
      await flush();
      expect(env.getUserMedia).toHaveBeenCalledTimes(2);
      expect(button("Stop")).toBeDefined();
    });

    it("shows an error when the camera cannot be opened", async () => {
      mount();
      env.getUserMedia.mockRejectedValue(new Error("no camera"));
      button("Preview").click();
      await flush();
      expect(q(".settings-error").textContent).toBe("Could not open the camera: no camera");
      expect(q<HTMLVideoElement>("video").hidden).toBe(true);
    });
  });

  describe("test sound", () => {
    it("plays on the chosen output and closes the context", async () => {
      vi.useFakeTimers();
      const setSinkId = vi.fn(async () => {});
      context = fakeContext(setSinkId);
      devices = [dev("audiooutput", "s1", "Speaker 1")];
      mount().showTab("voice");
      await vi.advanceTimersByTimeAsync(0);
      change(sel("Speakers"), "s1");
      button("Play test sound").click();
      await vi.advanceTimersByTimeAsync(900);
      expect(setSinkId).toHaveBeenCalledWith("s1");
      expect(context.close).toHaveBeenCalled();
      expect(q(".settings-error").hidden).toBe(true);
    });

    it("plays on the default output without choosing a sink", async () => {
      vi.useFakeTimers();
      const setSinkId = vi.fn(async () => {});
      context = fakeContext(setSinkId);
      mount();
      button("Play test sound").click();
      await vi.advanceTimersByTimeAsync(900);
      expect(setSinkId).not.toHaveBeenCalled();
      expect(context.close).toHaveBeenCalled();
    });

    it("shows an error when the output cannot be used", async () => {
      context = fakeContext(async () => {
        throw new Error("blocked");
      });
      devices = [dev("audiooutput", "s1", "Speaker 1")];
      await goVoice(mount());
      change(sel("Speakers"), "s1");
      button("Play test sound").click();
      await flush();
      expect(q(".settings-error").textContent).toBe("Could not play on that output: blocked");
    });
  });

  it("closes a device that opens after leaving the voice tab", async () => {
    const page = mount();
    await goVoice(page);
    let release: () => void = () => {};
    const mic = fakeStream();
    const camera = fakeStream();
    env.getUserMedia.mockImplementation(({ audio }: MediaStreamConstraints) => new Promise((resolve) => (release = () => resolve(audio ? mic : camera))));
    button("Test").click();
    const releaseMic = release;
    button("Preview").click();
    const releaseCamera = release;
    page.showTab("general");
    releaseMic();
    releaseCamera();
    await flush();
    expect(mic.getTracks()[0]!.stop).toHaveBeenCalled();
    expect(camera.getTracks()[0]!.stop).toHaveBeenCalled();
    expect(button("Test")).toBeDefined();
    expect(button("Preview")).toBeDefined();
  });

  it("leaving the voice tab stops the tests", async () => {
    const page = mount();
    await goVoice(page);
    button("Test").click();
    button("Preview").click();
    await flush();
    expect(button("Stop")).toBeDefined();
    page.showTab("general");
    await flush();
    expect(button("Test")).toBeDefined();
    expect(button("Preview")).toBeDefined();
    expect(q<HTMLVideoElement>("video").hidden).toBe(true);
    expect(context.close).toHaveBeenCalled();
  });
});

describe("startSettings", () => {
  function fakeApi() {
    let onState: (s: SettingsViewState) => void = () => {};
    const api: SettingsApi = { onState: vi.fn((cb) => void (onState = cb)), act: act as SettingsApi["act"], ready: vi.fn() };
    return { api, push: (s: SettingsViewState) => onState(s) };
  }
  const setVisibility = (value: string) => {
    Object.defineProperty(document, "visibilityState", { value, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };

  it("wires state updates and signals ready", () => {
    const { api, push } = fakeApi();
    expect(startSettings(document, api, env)).toBeInstanceOf(SettingsPage);
    expect(api.ready).toHaveBeenCalled();
    push(viewState());
    expect(q(".service-name").textContent).toBe("Discord");
  });

  it("stops the tests when the page becomes hidden, but not when visible", async () => {
    const { api } = fakeApi();
    startSettings(document, api, env).showTab("voice");
    await flush();
    button("Test").click();
    await flush();
    setVisibility("visible");
    expect(button("Stop")).toBeDefined();
    setVisibility("hidden");
    await flush();
    expect(button("Test")).toBeDefined();
    setVisibility("visible");
  });

  it("uses the browser's media APIs by default", () => {
    expect(startSettings(document, fakeApi().api)).toBeInstanceOf(SettingsPage);
  });
});
