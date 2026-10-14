// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellApi } from "../../src/preload/shell";
import { renderPicker, startPicker } from "../../src/renderer/picker";
import type { PickerRequest } from "../../src/shared/ipc";

const request: PickerRequest = {
  audioSupported: true,
  sources: [
    { id: "screen:0", name: "Entire screen", thumbnail: "data:image/png;base64,AA" },
    { id: "window:1", name: "Game", thumbnail: "data:image/png;base64,BB" },
  ],
};

beforeEach(() => {
  document.body.innerHTML = `<main id="picker"></main>`;
});

describe("renderPicker", () => {
  it("chooses a source with the audio setting", () => {
    const api = { choose: vi.fn() };
    const root = document.getElementById("picker")!;
    renderPicker(root, request, api);
    expect(root.querySelectorAll(".source")).toHaveLength(2);
    expect(root.textContent).toContain("Share system audio");

    root.querySelector<HTMLButtonElement>('[data-id="window:1"]')!.click();
    expect(api.choose).toHaveBeenLastCalledWith({ id: "window:1", audio: true });

    root.querySelector<HTMLInputElement>("#share-audio")!.checked = false;
    root.querySelector<HTMLButtonElement>('[data-id="screen:0"]')!.click();
    expect(api.choose).toHaveBeenLastCalledWith({ id: "screen:0", audio: false });

    root.querySelector<HTMLButtonElement>(".cancel")!.click();
    expect(api.choose).toHaveBeenLastCalledWith(null);
  });

  it("disables audio where loopback is unsupported", () => {
    const root = document.getElementById("picker")!;
    renderPicker(root, { ...request, audioSupported: false }, { choose: vi.fn() });
    const audio = root.querySelector<HTMLInputElement>("#share-audio")!;
    expect(audio.disabled).toBe(true);
    expect(audio.checked).toBe(false);
    expect(root.textContent).toContain("not supported");
  });
});

describe("startPicker", () => {
  it("renders on request and cancels on Escape", () => {
    let push: (r: PickerRequest) => void = () => {};
    const api = { onPickerRequest: (cb: (r: PickerRequest) => void) => (push = cb), choose: vi.fn() } as unknown as ShellApi;
    startPicker(document, api);
    push(request);
    expect(document.querySelectorAll(".source")).toHaveLength(2);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(api.choose).not.toHaveBeenCalled();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(api.choose).toHaveBeenCalledWith(null);
  });
});
