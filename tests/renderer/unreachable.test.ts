// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { UnreachableState } from "../../src/shared/ipc";
import { startUnreachable } from "../../src/renderer/unreachable";

function setup() {
  document.body.innerHTML = `<h1 id="unreachable-title"></h1><p id="unreachable-reason"></p><button id="unreachable-retry"></button><button id="unreachable-settings"></button><p id="unreachable-code"></p>`;
  let push: (state: UnreachableState) => void = () => {};
  const api = { onUnreachable: (cb: (state: UnreachableState) => void) => (push = cb), retry: vi.fn(), openSettings: vi.fn() };
  startUnreachable(document, api);
  const $ = (id: string) => document.getElementById(id)!;
  return { api, push: (state: UnreachableState) => push(state), $ };
}

describe("startUnreachable", () => {
  it("names the service and says why in plain words, with the error code", () => {
    const { push, $ } = setup();
    push({ service: "Discord", reason: "there is no internet connection", code: "ERR_INTERNET_DISCONNECTED", retrying: false });
    expect($("unreachable-title").textContent).toBe("Couldn't reach Discord");
    expect($("unreachable-reason").textContent).toBe("There is no internet connection. Discord may also be down for a while.");
    expect($("unreachable-code").textContent).toBe("Error: ERR_INTERNET_DISCONNECTED");
    expect($("unreachable-retry").textContent).toBe("Try again");
    push({ service: "Discord", reason: "the page did not load", code: "", retrying: false });
    expect($("unreachable-code").textContent).toBe("");
  });

  it("tries again once at a time, and opens Settings", () => {
    const { api, push, $ } = setup();
    push({ service: "Element", reason: "the page did not load", code: "ERR_FAILED", retrying: false });
    $("unreachable-retry").click();
    expect(api.retry).toHaveBeenCalledTimes(1);
    push({ service: "Element", reason: "the page did not load", code: "ERR_FAILED", retrying: true });
    expect($("unreachable-retry").textContent).toBe("Trying again…");
    expect($("unreachable-retry").getAttribute("aria-disabled")).toBe("true");
    $("unreachable-retry").click();
    expect(api.retry).toHaveBeenCalledTimes(1);
    $("unreachable-settings").click();
    expect(api.openSettings).toHaveBeenCalled();
  });
});
