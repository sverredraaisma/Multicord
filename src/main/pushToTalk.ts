/** The parts of uiohook-napi's keyboard hook used here. */
export interface KeyHook {
  on(event: "keydown" | "keyup", listener: (event: { keycode: number }) => void): unknown;
  off(event: "keydown" | "keyup", listener: (event: { keycode: number }) => void): unknown;
  start(): void;
  stop(): void;
}

const LETTERS: Record<string, number> = {
  A: 30, B: 48, C: 46, D: 32, E: 18, F: 33, G: 34, H: 35, I: 23, J: 36, K: 37, L: 38, M: 50,
  N: 49, O: 24, P: 25, Q: 16, R: 19, S: 31, T: 20, U: 22, V: 47, W: 17, X: 45, Y: 21, Z: 44,
};
const DIGITS = [11, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const FUNCTION_KEYS = [59, 60, 61, 62, 63, 64, 65, 66, 67, 68, 87, 88, 91, 92, 93, 99, 100, 101, 102, 103, 104, 105, 106, 107];
const NAMED: Record<string, number> = {
  Backquote: 41, Minus: 12, Equal: 13, BracketLeft: 26, BracketRight: 27, Backslash: 43, Semicolon: 39, Quote: 40,
  Comma: 51, Period: 52, Slash: 53, Space: 57, Tab: 15, CapsLock: 58, Insert: 3666, Delete: 3667, Home: 3655,
  End: 3663, PageUp: 3657, PageDown: 3665, ArrowUp: 57416, ArrowDown: 57424, ArrowLeft: 57419, ArrowRight: 57421,
  ControlLeft: 29, ControlRight: 3613, AltLeft: 56, AltRight: 3640, ShiftLeft: 42, ShiftRight: 54,
  MetaLeft: 3675, MetaRight: 3676, ScrollLock: 70, Pause: 3653, NumLock: 69,
  Numpad0: 82, Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad4: 75, Numpad5: 76, Numpad6: 77, Numpad7: 71,
  Numpad8: 72, Numpad9: 73, NumpadMultiply: 55, NumpadAdd: 78, NumpadSubtract: 74, NumpadDecimal: 83, NumpadDivide: 3637,
};

/** The hook's key code for a KeyboardEvent.code, if it can watch that key. */
export function hookKeycode(code: string): number | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return LETTERS[letter[1]!];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return DIGITS[Number(digit[1])];
  const fn = /^F(\d{1,2})$/.exec(code);
  if (fn) return FUNCTION_KEYS[Number(fn[1]) - 1];
  return Object.hasOwn(NAMED, code) ? NAMED[code] : undefined;
}

/**
 * Push to talk while Multicord is in the background: a keyboard hook that
 * reacts to the one chosen key and nothing else. It is loaded only while the
 * user has it on, and only presses and releases of that key leave it.
 */
export class GlobalPushToTalk {
  private hook: KeyHook | undefined;
  private running = false;
  private keycode: number | undefined;
  private held = false;

  constructor(
    private readonly loadHook: () => KeyHook,
    private readonly onTalk: (down: boolean) => void,
  ) {}

  private readonly down = (event: { keycode: number }): void => this.key(event.keycode, true);
  private readonly up = (event: { keycode: number }): void => this.key(event.keycode, false);

  private key(keycode: number, down: boolean): void {
    // The hook repeats key-downs while a key is held; only changes count.
    if (keycode !== this.keycode || down === this.held) return;
    this.held = down;
    this.onTalk(down);
  }

  /** Watches this key (a KeyboardEvent.code), or stops watching; returns what went wrong, if anything. */
  apply(code: string | undefined, enabled: boolean): string | undefined {
    const keycode = enabled && code ? hookKeycode(code) : undefined;
    if (keycode === undefined) {
      this.stop();
      return enabled && code ? "This key cannot be watched while Multicord is in the background." : undefined;
    }
    if (this.held && keycode !== this.keycode) {
      // A different key now: the old one's release would be ignored.
      this.held = false;
      this.onTalk(false);
    }
    this.keycode = keycode;
    if (this.running) return undefined;
    try {
      this.hook ??= this.loadHook();
      this.hook.on("keydown", this.down);
      this.hook.on("keyup", this.up);
      this.hook.start();
      this.running = true;
      return undefined;
    } catch (error) {
      this.stop();
      return `Could not watch the keyboard: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  stop(): void {
    if (this.held) this.onTalk(false);
    this.held = false;
    this.keycode = undefined;
    if (!this.hook) return;
    this.hook.off("keydown", this.down);
    this.hook.off("keyup", this.up);
    if (this.running) this.hook.stop();
    this.running = false;
  }
}

/** The native keyboard hook (uiohook-napi), loaded only when background push to talk is turned on. */
export function loadKeyHook(): KeyHook {
  return (require("uiohook-napi") as typeof import("uiohook-napi")).uIOhook;
}
