import { describe, expect, it, vi } from "vitest";
import { createShellApi } from "../../src/preload/shell";
import { createFocusApi } from "../../src/preload/focus";
import { IPC } from "../../src/shared/ipc";
import { createNativeApi } from "../../src/preload/native";
import { createSettingsApi } from "../../src/preload/settings";
import { createMessagesApi } from "../../src/preload/messages";
import { SETTINGS_IPC } from "../../src/shared/settings";

describe("createShellApi", () => {
  it("relays rail and picker traffic over IPC", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => listeners.set(c, l) };
    const api = createShellApi(ipc);

    const onRail = vi.fn();
    api.onRail(onRail);
    listeners.get(IPC.railState)!(null, { entries: [], activeKey: null });
    expect(onRail).toHaveBeenCalledWith({ entries: [], activeKey: null });

    const onPicker = vi.fn();
    api.onPickerRequest(onPicker);
    listeners.get(IPC.pickerSources)!(null, { sources: [], audioSupported: false });
    expect(onPicker).toHaveBeenCalledWith({ sources: [], audioSupported: false });

    const onTooltip = vi.fn();
    api.onTooltip(onTooltip);
    listeners.get(IPC.tooltipShow)!(null, "Gaming Club");
    expect(onTooltip).toHaveBeenCalledWith("Gaming Club");

    const onUnreachable = vi.fn();
    api.onUnreachable(onUnreachable);
    listeners.get(IPC.unreachableState)!(null, { service: "Discord", reason: "r", code: "c", retrying: false });
    expect(onUnreachable).toHaveBeenCalledWith({ service: "Discord", reason: "r", code: "c", retrying: false });

    api.open("discord:home");
    api.ready();
    api.tooltip({ text: "Gaming Club", y: 10 });
    api.tooltip(null);
    api.choose(null);
    api.retry();
    api.openSettings();
    expect(ipc.send.mock.calls).toEqual([
      [IPC.railOpen, "discord:home"],
      [IPC.railReady, null],
      [IPC.railTooltip, { text: "Gaming Club", y: 10 }],
      [IPC.railTooltip, null],
      [IPC.pickerChoose, null],
      [IPC.unreachableRetry, null],
      [IPC.unreachableSettings, null],
    ]);
  });
});

describe("reorder", () => {
  it("sends the new server order", () => {
    const ipc = { send: vi.fn(), on: vi.fn() };
    createShellApi(ipc).reorder(["a:1", "b:2"]);
    expect(ipc.send).toHaveBeenCalledWith(IPC.railReorder, ["a:1", "b:2"]);
  });
});

describe("settings", () => {
  it("opens and closes the settings page", () => {
    const ipc = { send: vi.fn(), on: vi.fn() };
    createShellApi(ipc).settings(true);
    expect(ipc.send).toHaveBeenCalledWith(IPC.railSettings, true);
  });

  it("relays the settings page's state and actions", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => listeners.set(c, l) };
    const api = createSettingsApi(ipc);
    const onState = vi.fn();
    api.onState(onState);
    listeners.get(SETTINGS_IPC.state)!(null, { version: "1" });
    expect(onState).toHaveBeenCalledWith({ version: "1" });
    api.act({ type: "restart" });
    api.ready();
    expect(ipc.send.mock.calls).toEqual([
      [SETTINGS_IPC.action, { type: "restart" }],
      [SETTINGS_IPC.ready, null],
    ]);
  });

  it("hands voice settings to the native view", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const api = createNativeApi({ send: vi.fn(), on: (c, l) => void listeners.set(c, l) });
    const onVoice = vi.fn();
    api.onVoiceSettings(onVoice);
    listeners.get(SETTINGS_IPC.voice)!(null, { echoCancellation: false });
    expect(onVoice).toHaveBeenCalledWith({ echoCancellation: false });
  });

  it("hands the native view its limit for media that loads by itself, if it is one", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const api = createNativeApi({ send: vi.fn(), on: (c, l) => void listeners.set(c, l) });
    const onLimit = vi.fn();
    api.onMediaAutoLoad(onLimit);
    for (const limit of [0, 5 * 1024 * 1024, Number.POSITIVE_INFINITY, -1, Number.NaN, "5mb", null]) listeners.get(SETTINGS_IPC.mediaAutoLoad)!(null, limit);
    expect(onLimit.mock.calls).toEqual([[0], [5 * 1024 * 1024], [Number.POSITIVE_INFINITY]]);
  });
});

describe("messages", () => {
  it("opens and closes the Messages page from the rail", () => {
    const ipc = { send: vi.fn(), on: vi.fn() };
    createShellApi(ipc).messages(true);
    expect(ipc.send).toHaveBeenCalledWith(IPC.railMessages, true);
  });

  it("relays the Messages page's list and the conversation to open", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => listeners.set(c, l) };
    const api = createMessagesApi(ipc);
    const onState = vi.fn();
    api.onState(onState);
    listeners.get(IPC.messagesState)!(null, { conversations: [], activeKey: null });
    expect(onState).toHaveBeenCalledWith({ conversations: [], activeKey: null });
    api.open("discord:dm:1");
    api.ready();
    expect(ipc.send.mock.calls).toEqual([
      [IPC.messagesOpen, "discord:dm:1"],
      [IPC.messagesReady, null],
    ]);
  });

  it("tells native views when they sit beside the Messages list", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => void listeners.set(c, l) };
    const api = createNativeApi(ipc);
    const onCompact = vi.fn();
    api.onCompact(onCompact);
    listeners.get(IPC.viewCompact)!(null, true);
    listeners.get(IPC.viewCompact)!(null, "yes");
    expect(onCompact.mock.calls).toEqual([[true], [false]]);
    const onVoiceCommand = vi.fn();
    api.onVoiceCommand(onVoiceCommand);
    listeners.get(SETTINGS_IPC.voiceCommand)!(null, "toggleMute");
    listeners.get(SETTINGS_IPC.voiceCommand)!(null, "explode");
    listeners.get(SETTINGS_IPC.voiceCommand)!(null, "talkStart");
    expect(onVoiceCommand.mock.calls).toEqual([["toggleMute"], ["talkStart"]]);
    api.screenAudioEnded();
    expect(ipc.send).toHaveBeenCalledWith(IPC.screenAudioEnd, null);
  });
});

describe("createFocusApi", () => {
  it("leaves the page in a direction and hears focus arrive, in either direction only", () => {
    const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
    const ipc = { send: vi.fn(), on: (c: string, l: (e: unknown, p: unknown) => void) => listeners.set(c, l) };
    const api = createFocusApi(ipc);
    api.leave(-1);
    expect(ipc.send).toHaveBeenCalledWith(IPC.focusLeave, -1);
    const onEnter = vi.fn();
    api.onEnter(onEnter);
    listeners.get(IPC.focusEnter)!(null, 1);
    listeners.get(IPC.focusEnter)!(null, -1);
    listeners.get(IPC.focusEnter)!(null, 2);
    expect(onEnter.mock.calls).toEqual([[1], [-1]]);
  });
});
