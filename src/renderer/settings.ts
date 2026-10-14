import type { SettingsApi } from "../preload/settings";
import { ZOOM_LEVELS, type AccountStatus, type DeviceChoice, type ModuleInfo, type ServiceInfo, type SettingsPatch, type SettingsViewState, type VoiceSettings } from "../shared/settings";
import { el, initials, setColor } from "./components/dom";
import { browserMediaEnv, playTestTone, startMeter, stopStream, type DeviceInfo, type MediaEnv, type Stop } from "./media";

export const TABS = [
  { id: "services", title: "Services & accounts" },
  { id: "voice", title: "Voice & video" },
  { id: "general", title: "General" },
  { id: "diagnostics", title: "Diagnostics" },
  { id: "about", title: "About" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** How long a "click again to confirm" button waits for the second click. */
export const CONFIRM_MS = 4000;

/**
 * A button that asks for a second click before doing something that cannot
 * be undone, such as signing out.
 */
export function confirmButton(doc: Document, label: string, confirmLabel: string, onConfirm: () => void, className = "danger"): HTMLButtonElement {
  const button = el(doc, "button", className, label);
  button.type = "button";
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener("click", () => {
    if (timer === undefined) {
      button.textContent = confirmLabel;
      button.classList.add("confirming");
      timer = setTimeout(() => {
        timer = undefined;
        button.textContent = label;
        button.classList.remove("confirming");
      }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    onConfirm();
  });
  return button;
}

/** A labelled on/off switch. */
export function switchRow(doc: Document, label: string, hint: string | undefined, onChange: (on: boolean) => void): { row: HTMLElement; input: HTMLInputElement } {
  const row = el(doc, "label", "switch-row");
  const text = el(doc, "span", "switch-text");
  text.append(el(doc, "span", "switch-label", label));
  if (hint) text.append(el(doc, "small", "hint", hint));
  const input = el(doc, "input", "switch");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.addEventListener("change", () => onChange(input.checked));
  row.append(text, input);
  return { row, input };
}

export function accountText(service: ServiceInfo): string {
  if (!service.enabled) return "Turned off";
  if (!service.account) return "Starts after a restart";
  return describeAccount(service.account);
}

function describeAccount(account: AccountStatus): string {
  switch (account.state) {
    case "signed-in":
      return account.name ? `Signed in as ${account.name}` : "Signed in";
    case "signed-out":
      return "Not signed in";
    default:
      return "Open it to see the account";
  }
}

const DEVICE_KINDS = {
  input: { kind: "audioinput", noun: "Microphone" },
  output: { kind: "audiooutput", noun: "Speaker" },
  camera: { kind: "videoinput", noun: "Camera" },
} as const;
type DeviceSlot = keyof typeof DEVICE_KINDS;

/** Options for a device picker: system default, the devices, and a saved device that is not connected. */
export function deviceOptions(devices: readonly DeviceInfo[], slot: DeviceSlot, chosen: DeviceChoice | undefined): { value: string; label: string; selected: boolean }[] {
  const { kind, noun } = DEVICE_KINDS[slot];
  // Chromium's "default" entry duplicates a real device; "System default" stands for it.
  const ofKind = devices.filter((d) => d.kind === kind && d.deviceId !== "default");
  const match = chosen && (ofKind.find((d) => d.deviceId === chosen.id) ?? ofKind.find((d) => d.label === chosen.label));
  const options = [{ value: "", label: "System default", selected: !chosen }];
  ofKind.forEach((d, i) => options.push({ value: d.deviceId, label: d.label || `${noun} ${i + 1}`, selected: d === match }));
  if (chosen && !match) options.push({ value: chosen.id, label: `${chosen.label || noun} (not connected)`, selected: true });
  return options;
}

/**
 * The settings page: services and their accounts, voice and video devices,
 * and general app behaviour. Built once; state updates refresh it in place,
 * so typing in a form or a running device test survives them.
 */
export class SettingsPage {
  private state: SettingsViewState | undefined;
  private tab: TabId = "services";
  private renaming: { id: string; draft: string } | undefined;
  private devices: DeviceInfo[] = [];
  private stopMeter: Stop | undefined;
  private stopCamera: Stop | undefined;
  /** Bumped by stopTests, so a device that opens afterwards is closed at once. */
  private testEpoch = 0;
  private readonly parts: {
    nav: HTMLElement;
    banner: HTMLElement;
    error: HTMLElement;
    sections: Map<TabId, HTMLElement>;
    services: HTMLElement;
    addModule: HTMLSelectElement;
    addName: HTMLInputElement;
    addUrl: HTMLInputElement;
    addUrlRow: HTMLElement;
    general: Record<"closeToTray" | "launchAtLogin" | "notifications" | "spellcheck", HTMLInputElement>;
    grouped: HTMLInputElement;
    zoom: HTMLSelectElement;
    streamer: HTMLSelectElement;
    streamingNote: HTMLElement;
    links: { row: HTMLElement; input: HTMLInputElement; label: HTMLElement };
    diagnostics: HTMLElement;
    launchHint: HTMLElement;
    secretsNote: HTMLElement;
    selects: Record<DeviceSlot, HTMLSelectElement>;
    processing: Record<"echoCancellation" | "noiseSuppression" | "autoGainControl", HTMLInputElement>;
    meter: HTMLElement;
    micTest: HTMLButtonElement;
    cameraTest: HTMLButtonElement;
    preview: HTMLVideoElement;
    version: HTMLElement;
  };

  constructor(
    private readonly root: HTMLElement,
    private readonly api: Pick<SettingsApi, "act">,
    private readonly media: MediaEnv,
  ) {
    const doc = root.ownerDocument;
    const nav = el(doc, "nav", "settings-nav");
    nav.append(el(doc, "h2", undefined, "Settings"));
    const main = el(doc, "main", "settings-main");
    const banner = el(doc, "div", "restart-banner");
    banner.hidden = true;
    const restart = el(doc, "button", "primary", "Restart now");
    restart.type = "button";
    restart.addEventListener("click", () => this.api.act({ type: "restart" }));
    banner.append(el(doc, "span", undefined, "Service changes are saved and take effect after a restart."), restart);
    const error = el(doc, "div", "settings-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    main.append(banner, error);

    const sections = new Map<TabId, HTMLElement>();
    for (const tab of TABS) {
      const button = el(doc, "button", "settings-tab", tab.title);
      button.type = "button";
      button.dataset.tab = tab.id;
      button.addEventListener("click", () => this.showTab(tab.id));
      nav.append(button);
      const section = el(doc, "section", "settings-section");
      section.dataset.tab = tab.id;
      section.append(el(doc, "h1", undefined, tab.title));
      sections.set(tab.id, section);
      main.append(section);
    }

    // Services and accounts
    const services = el(doc, "ul", "service-list");
    const addForm = el(doc, "form", "add-service");
    const addModule = el(doc, "select");
    addModule.setAttribute("aria-label", "Service type");
    const addName = el(doc, "input");
    addName.placeholder = "Name";
    addName.maxLength = 64;
    addName.required = true;
    addName.setAttribute("aria-label", "Name");
    const addUrl = el(doc, "input");
    addUrl.type = "url";
    addUrl.placeholder = "https://";
    addUrl.setAttribute("aria-label", "Address");
    const addUrlRow = el(doc, "div", "field");
    addUrlRow.append(el(doc, "span", "field-label", "Address"), addUrl);
    const addButton = el(doc, "button", "primary", "Add");
    addButton.type = "submit";
    const moduleRow = el(doc, "div", "field");
    moduleRow.append(el(doc, "span", "field-label", "Service"), addModule);
    const nameRow = el(doc, "div", "field");
    nameRow.append(el(doc, "span", "field-label", "Name"), addName);
    addForm.append(el(doc, "h2", undefined, "Add a service or account"), moduleRow, nameRow, addUrlRow, addButton);
    addModule.addEventListener("change", () => this.syncAddForm());
    addForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const module = this.modules().find((m) => m.id === addModule.value);
      if (!module || addName.value.trim() === "") return;
      const url = module.fixedUrl ? undefined : addUrl.value.trim() || undefined;
      this.api.act({ type: "addService", module: module.id, name: addName.value.trim(), ...(url ? { url } : {}) });
      addName.value = "";
      addUrl.value = "";
    });
    sections.get("services")!.append(
      el(doc, "p", "section-intro", "Each entry is one account. To use a second account on a service, add that service again."),
      services,
      addForm,
    );

    // Voice and video
    const voice = sections.get("voice")!;
    voice.append(el(doc, "p", "section-intro", "Used for Fluxer calls. Discord and web apps keep their own voice settings in their own settings screens."));
    const selects = {} as Record<DeviceSlot, HTMLSelectElement>;
    const deviceRow = (slot: DeviceSlot, title: string, extra: Node[]): HTMLElement => {
      const select = el(doc, "select");
      select.setAttribute("aria-label", title);
      select.addEventListener("change", () => this.chooseDevice(slot));
      selects[slot] = select;
      const row = el(doc, "div", "field");
      const control = el(doc, "div", "field-control");
      control.append(select, ...extra);
      row.append(el(doc, "span", "field-label", title), control);
      return row;
    };
    const micTest = el(doc, "button", "secondary", "Test");
    micTest.type = "button";
    micTest.addEventListener("click", () => void this.toggleMicTest());
    const meter = el(doc, "div", "meter");
    meter.append(el(doc, "div", "meter-fill"));
    const toneTest = el(doc, "button", "secondary", "Play test sound");
    toneTest.type = "button";
    toneTest.addEventListener("click", () => void this.playTone());
    const cameraTest = el(doc, "button", "secondary", "Preview");
    cameraTest.type = "button";
    cameraTest.addEventListener("click", () => void this.toggleCamera());
    const preview = el(doc, "video", "camera-preview");
    preview.muted = true;
    preview.autoplay = true;
    preview.hidden = true;
    voice.append(
      deviceRow("input", "Microphone", [micTest]),
      meter,
      deviceRow("output", "Speakers", [toneTest]),
      deviceRow("camera", "Camera", [cameraTest]),
      preview,
      el(doc, "h2", undefined, "Audio processing"),
    );
    const processing = {} as SettingsPage["parts"]["processing"];
    for (const [key, label, hint] of [
      ["echoCancellation", "Echo cancellation", "Stops others hearing themselves through your speakers."],
      ["noiseSuppression", "Noise suppression", "Filters steady background noise."],
      ["autoGainControl", "Automatic gain control", "Evens out your microphone volume."],
    ] as const) {
      const { row, input } = switchRow(doc, label, hint, (on) => this.update({ voice: { [key]: on } }));
      processing[key] = input;
      voice.append(row);
    }
    voice.append(el(doc, "p", "hint", "Processing changes apply the next time your microphone starts."));

    // General
    const general = sections.get("general")!;
    const generalInputs = {} as SettingsPage["parts"]["general"];
    for (const [key, label, hint] of [
      ["closeToTray", "Keep running in the tray", "Closing the window hides Multicord instead of quitting, so notifications keep coming."],
      ["launchAtLogin", "Start with your computer", undefined],
      ["notifications", "Desktop notifications", "Show notifications for new messages and mentions."],
      ["spellcheck", "Spell check", "Underline misspelled words while you type."],
    ] as const) {
      const { row, input } = switchRow(doc, label, hint, (on) => this.update({ general: { [key]: on } }));
      generalInputs[key] = input;
      general.append(row);
    }
    const grouping = switchRow(doc, "Group servers by service", "Off: servers of all services in one list, in your own order.", (on) =>
      this.update({ general: { railGrouping: on ? "platform" : "mixed" } }),
    );
    const zoom = el(doc, "select");
    zoom.setAttribute("aria-label", "Zoom");
    for (const level of ZOOM_LEVELS) {
      const option = el(doc, "option", undefined, `${Math.round(level * 100)}%`);
      option.value = String(level);
      zoom.append(option);
    }
    zoom.addEventListener("change", () => this.update({ general: { zoom: Number(zoom.value) } }));
    const zoomRow = el(doc, "div", "field");
    zoomRow.append(el(doc, "span", "field-label", "Zoom"), zoom, el(doc, "small", "hint", "Also Ctrl and + or −, and Ctrl and 0 to reset."));
    const streamer = el(doc, "select");
    streamer.setAttribute("aria-label", "Streamer mode");
    for (const [value, label] of [
      ["auto", "Automatic, while OBS or other streaming software runs"],
      ["on", "Always on"],
      ["off", "Off"],
    ] as const) {
      const option = el(doc, "option", undefined, label);
      option.value = value;
      streamer.append(option);
    }
    streamer.addEventListener("change", () => this.update({ general: { streamerMode: streamer.value as "auto" | "on" | "off" } }));
    const streamerRow = el(doc, "div", "field");
    const streamingNote = el(doc, "small", "hint streaming-note", "Streamer mode is on: notifications and message previews hide what was said.");
    streamingNote.hidden = true;
    streamerRow.append(el(doc, "span", "field-label", "Streamer mode"), streamer, el(doc, "small", "hint", "Keeps message content out of notifications and the Messages list."), streamingNote);
    const links = switchRow(doc, "Open app links in Multicord", "Off by default, so an installed app that also handles these links keeps them.", (on) =>
      this.update({ general: { openLinks: on } }),
    );
    links.row.hidden = true;
    general.append(grouping.row, links.row, el(doc, "h2", undefined, "Privacy"), streamerRow, el(doc, "h2", undefined, "Appearance"), zoomRow);
    const launchHint = el(doc, "p", "hint", "Starting with your computer is not available on this system.");
    launchHint.hidden = true;
    const secretsNote = el(doc, "p", "notice", "This system has no secure storage for passwords, so you will need to sign in to Fluxer again after each restart.");
    secretsNote.hidden = true;
    general.append(launchHint, secretsNote);

    // Diagnostics
    const diagnostics = el(doc, "div", "diagnostics");
    sections.get("diagnostics")!.append(
      el(doc, "p", "section-intro", "How Multicord's hooks into each service are doing. A failed check usually means the service changed its app; it shows what stops working."),
      diagnostics,
    );

    // About
    const version = el(doc, "p", "version");
    sections.get("about")!.append(
      version,
      el(doc, "p", undefined, "One app for Discord, Fluxer and other chat services."),
      el(doc, "p", "hint", "Free software under the GNU Affero General Public License, version 3 or later."),
    );

    const layout = el(doc, "div", "settings");
    layout.append(nav, main);
    root.replaceChildren(layout);
    this.parts = {
      nav,
      banner,
      error,
      sections,
      services,
      addModule,
      addName,
      addUrl,
      addUrlRow,
      general: generalInputs,
      grouped: grouping.input,
      zoom,
      streamer,
      streamingNote,
      links: { ...links, label: links.row.querySelector<HTMLElement>(".switch-label")! },
      diagnostics,
      launchHint,
      secretsNote,
      selects,
      processing,
      meter,
      micTest,
      cameraTest,
      preview,
      version,
    };
    this.showTab("services");
    this.media.onDeviceChange(() => void this.loadDevices());
  }

  update(patch: SettingsPatch): void {
    this.api.act({ type: "update", patch });
  }

  private modules(): ModuleInfo[] {
    return this.state?.modules ?? [];
  }

  showTab(tab: TabId): void {
    this.tab = tab;
    for (const button of this.parts.nav.querySelectorAll<HTMLElement>(".settings-tab")) {
      const active = button.dataset.tab === tab;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const [id, section] of this.parts.sections) section.hidden = id !== tab;
    if (tab === "voice") void this.loadDevices(true);
    else this.stopTests();
  }

  render(state: SettingsViewState): void {
    this.state = state;
    const { parts } = this;
    parts.banner.hidden = !state.restartNeeded;
    parts.error.hidden = !state.error;
    parts.error.textContent = state.error ?? "";
    this.renderServices(state.services);
    this.renderDiagnostics(state.services);
    this.renderModules(state.modules);

    const { general, voice } = state.settings;
    for (const key of ["closeToTray", "launchAtLogin", "notifications", "spellcheck"] as const) parts.general[key].checked = general[key];
    parts.grouped.checked = general.railGrouping === "platform";
    parts.zoom.value = String(general.zoom);
    parts.streamer.value = general.streamerMode;
    parts.streamingNote.hidden = state.streaming !== true;
    const schemes = state.linkSchemes ?? [];
    parts.links.row.hidden = schemes.length === 0;
    parts.links.label.textContent = `Open ${schemes.map((scheme) => `${scheme}://`).join(", ")} links in Multicord`;
    parts.links.input.checked = general.openLinks;
    parts.general.launchAtLogin.disabled = !state.launchAtLoginSupported;
    parts.launchHint.hidden = state.launchAtLoginSupported;
    parts.secretsNote.hidden = state.secretsPersistent;
    for (const key of ["echoCancellation", "noiseSuppression", "autoGainControl"] as const) parts.processing[key].checked = voice[key];
    this.renderDevices(voice);
    parts.version.textContent = `Multicord ${state.version}`;
  }

  private renderServices(services: ServiceInfo[]): void {
    const doc = this.root.ownerDocument;
    const items = services.map((service) => {
      const item = el(doc, "li", "service");
      item.dataset.id = service.id;
      item.classList.toggle("off", !service.enabled);
      const badge = el(doc, "span", "service-icon", initials(service.name));
      setColor(badge, "--module-color", service.color);
      const info = el(doc, "div", "service-info");
      const title = el(doc, "div", "service-title");
      if (this.renaming?.id === service.id) title.append(this.renameForm(service));
      else title.append(el(doc, "span", "service-name", service.name));
      const module = el(doc, "span", "module-tag", service.label);
      setColor(module, "--module-color", service.color);
      title.append(module);
      const status = el(doc, "div", "service-status", accountText(service));
      status.dataset.state = service.enabled ? (service.account?.state ?? "pending") : "off";
      const actions = el(doc, "div", "service-actions");
      const running = service.account !== undefined;
      if (running) {
        const signedOut = service.account!.state === "signed-out";
        const open = el(doc, "button", signedOut ? "primary" : "secondary", signedOut ? "Sign in" : "Open");
        open.type = "button";
        open.addEventListener("click", () => this.api.act({ type: "openService", id: service.id }));
        actions.append(open);
        if (!signedOut) actions.append(confirmButton(doc, "Sign out", "Click again to sign out", () => this.api.act({ type: "signOut", id: service.id })));
      }
      if (this.renaming?.id !== service.id) {
        const rename = el(doc, "button", "secondary", "Rename");
        rename.type = "button";
        rename.addEventListener("click", () => {
          this.renaming = { id: service.id, draft: service.name };
          this.renderServices(this.state!.services);
          this.parts.services.querySelector<HTMLInputElement>(".rename input")?.focus();
        });
        actions.append(rename);
      }
      if (!service.builtIn) {
        actions.append(confirmButton(doc, "Remove", "Click again to remove", () => this.api.act({ type: "removeService", id: service.id })));
      }
      info.append(title, status, actions);
      const { row, input } = switchRow(doc, "On", undefined, (on) => this.api.act({ type: "setEnabled", id: service.id, enabled: on }));
      row.classList.add("service-switch");
      input.checked = service.enabled;
      input.setAttribute("aria-label", `${service.name} on`);
      item.append(badge, info, row);
      return item;
    });
    this.parts.services.replaceChildren(...items);
  }

  private renderDiagnostics(services: ServiceInfo[]): void {
    const doc = this.root.ownerDocument;
    const checked = services.filter((s) => s.health && s.health.length > 0);
    if (checked.length === 0) {
      this.parts.diagnostics.replaceChildren(el(doc, "p", "hint", "No running service reports checks."));
      return;
    }
    this.parts.diagnostics.replaceChildren(
      ...checked.map((service) => {
        const block = el(doc, "section", "health");
        block.dataset.id = service.id;
        const list = el(doc, "ul", "health-list");
        for (const check of service.health!) {
          const item = el(doc, "li", check.ok ? "health-check ok" : "health-check failed");
          item.append(el(doc, "span", "health-mark", check.ok ? "✓" : "✗"), el(doc, "span", "health-name", check.name));
          if (!check.ok && check.detail) item.append(el(doc, "small", "hint", `Affects: ${check.detail}`));
          list.append(item);
        }
        const failed = service.health!.filter((c) => !c.ok).length;
        block.append(el(doc, "h2", undefined, `${service.name}: ${failed === 0 ? "all working" : `${failed} not working`}`), list);
        return block;
      }),
    );
  }

  private renameForm(service: ServiceInfo): HTMLElement {
    const doc = this.root.ownerDocument;
    const form = el(doc, "form", "rename");
    const input = el(doc, "input");
    input.value = this.renaming!.draft;
    input.maxLength = 64;
    input.required = true;
    input.setAttribute("aria-label", "New name");
    input.addEventListener("input", () => (this.renaming!.draft = input.value));
    const save = el(doc, "button", "primary", "Save");
    save.type = "submit";
    const cancel = el(doc, "button", "secondary", "Cancel");
    cancel.type = "button";
    const close = (): void => {
      this.renaming = undefined;
      this.renderServices(this.state!.services);
    };
    cancel.addEventListener("click", close);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name && name !== service.name) this.api.act({ type: "renameService", id: service.id, name });
      close();
    });
    form.append(input, save, cancel);
    return form;
  }

  private renderModules(modules: ModuleInfo[]): void {
    const select = this.parts.addModule;
    const current = select.value;
    const doc = this.root.ownerDocument;
    const options = modules.map((m) => {
      const option = el(doc, "option", undefined, m.fixedUrl ? `${m.name} account` : m.name);
      option.value = m.id;
      return option;
    });
    const same = options.length === select.options.length && options.every((o, i) => o.value === select.options[i]!.value);
    if (!same) {
      select.replaceChildren(...options);
      if (modules.some((m) => m.id === current)) select.value = current;
    }
    this.syncAddForm();
  }

  /** Shows the address field only for modules that take one, prefilled with their default. */
  private syncAddForm(): void {
    const module = this.modules().find((m) => m.id === this.parts.addModule.value);
    this.parts.addUrlRow.hidden = !module || module.fixedUrl;
    this.parts.addUrl.placeholder = module?.defaultUrl ?? "https://";
    this.parts.addUrl.required = Boolean(module && !module.fixedUrl && !module.defaultUrl);
  }

  // --- Devices ---------------------------------------------------------------

  /**
   * Lists devices. Names stay hidden until the page may use a microphone, so
   * the first visit asks for it once (the settings page only).
   */
  private async loadDevices(unlockLabels = false): Promise<void> {
    try {
      this.devices = await this.media.enumerate();
      if (unlockLabels && this.devices.some((d) => d.label === "")) {
        stopStream(await this.media.getUserMedia({ audio: true }));
        this.devices = await this.media.enumerate();
      }
    } catch {
      // No permission or no devices: the pickers offer the system default.
    }
    if (this.state) this.renderDevices(this.state.settings.voice);
  }

  private renderDevices(voice: VoiceSettings): void {
    const doc = this.root.ownerDocument;
    for (const slot of Object.keys(DEVICE_KINDS) as DeviceSlot[]) {
      const select = this.parts.selects[slot];
      select.replaceChildren(
        ...deviceOptions(this.devices, slot, voice[slot]).map(({ value, label, selected }) => {
          const option = el(doc, "option", undefined, label);
          option.value = value;
          option.selected = selected;
          return option;
        }),
      );
    }
  }

  private chooseDevice(slot: DeviceSlot): void {
    const select = this.parts.selects[slot];
    const option = select.selectedOptions[0];
    const choice = select.value === "" ? null : { id: select.value, label: option!.textContent!.replace(/ \(not connected\)$/, "") };
    this.update({ voice: { [slot]: choice } });
    if (slot === "input" && this.stopMeter) void this.toggleMicTest().then(() => this.toggleMicTest());
    if (slot === "camera" && this.stopCamera) void this.toggleCamera().then(() => this.toggleCamera());
  }

  private constraint(slot: DeviceSlot): MediaTrackConstraints {
    const value = this.parts.selects[slot].value;
    return value ? { deviceId: { exact: value } } : {};
  }

  private async toggleMicTest(): Promise<void> {
    const { micTest, meter } = this.parts;
    if (this.stopMeter) {
      this.stopMeter();
      this.stopMeter = undefined;
      micTest.textContent = "Test";
      meter.style.setProperty("--level", "0");
      return;
    }
    const voice = this.state?.settings.voice;
    const epoch = this.testEpoch;
    try {
      const stream = await this.media.getUserMedia({
        audio: {
          ...this.constraint("input"),
          echoCancellation: voice?.echoCancellation,
          noiseSuppression: voice?.noiseSuppression,
          autoGainControl: voice?.autoGainControl,
        },
      });
      if (epoch !== this.testEpoch) return stopStream(stream);
      this.stopMeter = startMeter(this.media, stream, (value) => meter.style.setProperty("--level", value.toFixed(3)));
      micTest.textContent = "Stop";
    } catch (error) {
      this.showError(`Could not open the microphone: ${(error as Error).message}`);
    }
  }

  private async playTone(): Promise<void> {
    try {
      await playTestTone(this.media, this.parts.selects.output.value || undefined);
    } catch (error) {
      this.showError(`Could not play on that output: ${(error as Error).message}`);
    }
  }

  private async toggleCamera(): Promise<void> {
    const { cameraTest, preview } = this.parts;
    if (this.stopCamera) {
      this.stopCamera();
      this.stopCamera = undefined;
      return;
    }
    const epoch = this.testEpoch;
    try {
      const stream = await this.media.getUserMedia({ video: this.constraint("camera") });
      if (epoch !== this.testEpoch) return stopStream(stream);
      preview.srcObject = stream;
      preview.hidden = false;
      cameraTest.textContent = "Stop";
      this.stopCamera = () => {
        stopStream(stream);
        preview.srcObject = null;
        preview.hidden = true;
        cameraTest.textContent = "Preview";
      };
    } catch (error) {
      this.showError(`Could not open the camera: ${(error as Error).message}`);
    }
  }

  /** Ends the microphone test and camera preview, e.g. when leaving the voice tab. */
  stopTests(): void {
    this.testEpoch++;
    if (this.stopMeter) void this.toggleMicTest();
    if (this.stopCamera) void this.toggleCamera();
  }

  private showError(message: string): void {
    this.parts.error.textContent = message;
    this.parts.error.hidden = false;
  }

  get activeTab(): TabId {
    return this.tab;
  }
}

export function startSettings(doc: Document, api: SettingsApi, media: MediaEnv = browserMediaEnv(doc.defaultView!)): SettingsPage {
  const page = new SettingsPage(doc.getElementById("settings")!, api, media);
  api.onState((state) => page.render(state));
  // Leaving the page (the view is hidden) must not leave the microphone or camera on.
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState === "hidden") page.stopTests();
  });
  api.ready();
  return page;
}
