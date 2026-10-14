import { describe, expect, it, vi } from "vitest";
import { createShellApi } from "../../src/preload/shell";
import { IPC } from "../../src/shared/ipc";

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

    api.open("discord:home");
    api.ready();
    api.tooltip({ text: "Gaming Club", y: 10 });
    api.tooltip(null);
    api.choose(null);
    expect(ipc.send.mock.calls).toEqual([
      [IPC.railOpen, "discord:home"],
      [IPC.railReady, null],
      [IPC.railTooltip, { text: "Gaming Club", y: 10 }],
      [IPC.railTooltip, null],
      [IPC.pickerChoose, null],
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
