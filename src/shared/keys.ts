// Key names as Electron's accelerators and input events spell them, by KeyboardEvent.code.

const KEY_NAMES: Record<string, string> = {
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Minus: "-",
  Equal: "=",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
};

/** Keys a push-to-talk key may be that accelerators have no use for. */
const INPUT_ONLY: Record<string, string> = {
  ControlLeft: "Control",
  ControlRight: "Control",
  AltLeft: "Alt",
  AltRight: "Alt",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  MetaLeft: "Meta",
  MetaRight: "Meta",
  CapsLock: "Capslock",
  NumLock: "Numlock",
  ScrollLock: "Scrolllock",
  NumpadAdd: "numadd",
  NumpadSubtract: "numsub",
  NumpadMultiply: "nummult",
  NumpadDivide: "numdiv",
  NumpadDecimal: "numdec",
};

/** The accelerator name of a key, e.g. "M", "5", "F13" or "Up"; undefined for modifiers and the like. */
export function keyNameForCode(code: string): string | undefined {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  return Object.hasOwn(KEY_NAMES, code) ? KEY_NAMES[code] : undefined;
}

/** The keyCode for an Electron input event of this key, modifiers and numpad keys included. */
export function inputKeyCode(code: string): string | undefined {
  const numpad = /^Numpad(\d)$/.exec(code);
  if (numpad) return `num${numpad[1]}`;
  return keyNameForCode(code) ?? (Object.hasOwn(INPUT_ONLY, code) ? INPUT_ONLY[code] : undefined);
}
