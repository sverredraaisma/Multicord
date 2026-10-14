export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1280, height: 800, maximized: false };

const MIN_SIZE = 400;

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

export function parseWindowState(text: string | undefined): WindowState {
  if (text === undefined) return { ...DEFAULT_WINDOW_STATE };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_WINDOW_STATE };
  const state: WindowState = {
    width: isInt(raw.width) && raw.width >= MIN_SIZE ? raw.width : DEFAULT_WINDOW_STATE.width,
    height: isInt(raw.height) && raw.height >= MIN_SIZE ? raw.height : DEFAULT_WINDOW_STATE.height,
    maximized: raw.maximized === true,
  };
  if (isInt(raw.x) && isInt(raw.y)) {
    state.x = raw.x;
    state.y = raw.y;
  }
  return state;
}

export function serializeWindowState(bounds: { x: number; y: number; width: number; height: number }, maximized: boolean): string {
  const { x, y, width, height } = bounds;
  return JSON.stringify({ x, y, width, height, maximized });
}
