import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GlobalPushToTalk, hookKeycode, loadKeyHook } from "../../src/main/pushToTalk";
import { inputKeyCode, keyNameForCode } from "../../src/shared/keys";

class FakeHook extends EventEmitter {
  start = vi.fn();
  stop = vi.fn();
  press(keycode: number, down: boolean): void {
    this.emit(down ? "keydown" : "keyup", { keycode });
  }
}

describe("GlobalPushToTalk", () => {
  it("talks while the chosen key is held, ignoring repeats and other keys", () => {
    const hook = new FakeHook();
    const talk = vi.fn();
    const ptt = new GlobalPushToTalk(() => hook, talk);
    expect(ptt.apply("Backquote", true)).toBeUndefined();
    expect(hook.start).toHaveBeenCalledTimes(1);
    hook.press(30, true); // A
    hook.press(41, true);
    hook.press(41, true); // the hook repeats while held
    hook.press(41, false);
    expect(talk.mock.calls).toEqual([[true], [false]]);

    // Another key while running: no second hook, and a held key is let go.
    hook.press(41, true);
    expect(ptt.apply("F13", true)).toBeUndefined();
    expect(hook.start).toHaveBeenCalledTimes(1);
    expect(talk).toHaveBeenLastCalledWith(false);
    hook.press(91, true);
    expect(talk).toHaveBeenLastCalledWith(true);

    // Turning it off releases the key and stops the hook.
    expect(ptt.apply("F13", false)).toBeUndefined();
    expect(talk).toHaveBeenLastCalledWith(false);
    expect(hook.stop).toHaveBeenCalled();
    hook.press(91, true);
    expect(talk).toHaveBeenCalledTimes(6);
    expect(ptt.apply(undefined, true)).toBeUndefined();
  });

  it("reports keys it cannot watch and a hook that will not start", () => {
    const talk = vi.fn();
    expect(new GlobalPushToTalk(() => new FakeHook(), talk).apply("MediaPlayPause", true)).toBe(
      "This key cannot be watched while Multicord is in the background.",
    );
    const broken = new FakeHook();
    broken.start.mockImplementation(() => {
      throw new Error("Accessibility permission needed");
    });
    const ptt = new GlobalPushToTalk(() => broken, talk);
    expect(ptt.apply("F13", true)).toBe("Could not watch the keyboard: Accessibility permission needed");
    expect(broken.stop).not.toHaveBeenCalled();
    expect(broken.listenerCount("keydown")).toBe(0);
    expect(new GlobalPushToTalk(() => {
      throw "no binary";
    }, talk).apply("F13", true)).toBe("Could not watch the keyboard: no binary");
  });

  it("maps every key the recorder accepts to the hook's codes", () => {
    // The real library's table is the reference.
    const { UiohookKey } = require("uiohook-napi") as typeof import("uiohook-napi");
    const pairs: [string, number][] = [
      ["KeyA", UiohookKey.A],
      ["KeyM", UiohookKey.M],
      ["Digit0", UiohookKey[0]],
      ["Digit5", UiohookKey[5]],
      ["F1", UiohookKey.F1],
      ["F12", UiohookKey.F12],
      ["F13", UiohookKey.F13],
      ["F24", UiohookKey.F24],
      ["Backquote", UiohookKey.Backquote],
      ["Space", UiohookKey.Space],
      ["ControlRight", UiohookKey.CtrlRight],
      ["ShiftLeft", UiohookKey.Shift],
      ["Numpad7", UiohookKey.Numpad7],
      ["ArrowLeft", UiohookKey.ArrowLeft],
    ];
    for (const [code, keycode] of pairs) expect(hookKeycode(code)).toBe(keycode);
    expect(hookKeycode("F25")).toBeUndefined();
    expect(hookKeycode("toString")).toBeUndefined();
    expect(typeof loadKeyHook().start).toBe("function");
  });
});

describe("key names", () => {
  it("names keys as Electron does", () => {
    expect(keyNameForCode("KeyQ")).toBe("Q");
    expect(keyNameForCode("Digit3")).toBe("3");
    expect(keyNameForCode("F20")).toBe("F20");
    expect(keyNameForCode("ArrowDown")).toBe("Down");
    expect(keyNameForCode("ShiftLeft")).toBeUndefined();
    expect(keyNameForCode("constructor")).toBeUndefined();
    expect(inputKeyCode("Backquote")).toBe("`");
    expect(inputKeyCode("Numpad4")).toBe("num4");
    expect(inputKeyCode("NumpadAdd")).toBe("numadd");
    expect(inputKeyCode("ControlLeft")).toBe("Control");
    expect(inputKeyCode("Fn")).toBeUndefined();
  });
});
