/** Short, locale-aware date and time; empty for unparsable input. */
export function formatTime(iso: string, locale?: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** "Ana is typing…", "Ana and Bo are typing…", or a summary for more people. */
export function typingText(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `${names[0]} is typing…`;
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} are typing…`;
  return "Several people are typing…";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When a conversation was last active, as chat apps show it: the time
 * today, the weekday within the past week, else the date.
 */
export function formatRecent(ms: number, now = Date.now(), locale?: string): string {
  const date = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (ms >= startOfToday - 6 * DAY_MS) return date.toLocaleDateString(locale, { weekday: "short" });
  if (date.getFullYear() === today.getFullYear()) return date.toLocaleDateString(locale, { day: "numeric", month: "short" });
  return date.toLocaleDateString(locale, { dateStyle: "short" });
}
