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

    api.open("discord:home");
    api.ready();
    api.choose(null);
    expect(ipc.send.mock.calls).toEqual([
      [IPC.railOpen, "discord:home"],
      [IPC.railReady, null],
      [IPC.pickerChoose, null],
    ]);
  });
});
