// Unicode emoji data (emojibase, MIT) with GitHub-style shortcodes, as used
// by the markdown renderer (":joy:" -> 😂) and the emoji picker.
import compact from "emojibase-data/en/compact.json";
import messages from "emojibase-data/en/messages.json";
import github from "emojibase-data/en/shortcodes/github.json";

export interface EmojiEntry {
  unicode: string;
  name: string;
  shortcodes: string[];
  tags: string[];
  group: number;
}

export interface EmojiGroup {
  id: number;
  name: string;
}

/** Emojibase's "component" group holds skin tones and hair parts, not emoji to pick. */
const COMPONENT_GROUP = 2;

interface CompactEmoji {
  hexcode: string;
  label: string;
  unicode: string;
  group?: number;
  order?: number;
  tags?: string[];
}

function shortcodesFor(hexcode: string): string[] {
  const value = (github as Record<string, string | string[]>)[hexcode];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export const EMOJI: readonly EmojiEntry[] = (compact as CompactEmoji[])
  .filter((e) => e.group !== undefined && e.group !== COMPONENT_GROUP)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  .map((e) => ({ unicode: e.unicode, name: e.label, shortcodes: shortcodesFor(e.hexcode), tags: e.tags ?? [], group: e.group! }));

export const EMOJI_GROUPS: readonly EmojiGroup[] = (messages.groups as { order: number; message: string }[])
  .filter((g) => g.order !== COMPONENT_GROUP)
  .map((g) => ({ id: g.order, name: g.message }));

const byShortcode = new Map<string, string>();
for (const emoji of EMOJI) for (const code of emoji.shortcodes) if (!byShortcode.has(code)) byShortcode.set(code, emoji.unicode);

/** The emoji for a shortcode without colons ("joy"), if there is one. */
export function emojiForShortcode(code: string): string | undefined {
  return byShortcode.get(code.toLowerCase());
}

/**
 * Finds emoji by shortcode, name or tag. Shortcode prefix matches rank first,
 * then name prefix, then anything containing the query.
 */
export function searchEmoji(query: string, limit = 50): EmojiEntry[] {
  const q = query.trim().toLowerCase().replace(/^:|:$/g, "");
  if (q === "") return EMOJI.slice(0, limit);
  const scored: { emoji: EmojiEntry; score: number }[] = [];
  for (const emoji of EMOJI) {
    const score = emoji.shortcodes.some((c) => c === q)
      ? 0
      : emoji.shortcodes.some((c) => c.startsWith(q))
        ? 1
        : emoji.name.toLowerCase().startsWith(q)
          ? 2
          : emoji.shortcodes.some((c) => c.includes(q)) || emoji.name.toLowerCase().includes(q) || emoji.tags.some((t) => t.startsWith(q))
            ? 3
            : -1;
    if (score >= 0) scored.push({ emoji, score });
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((s) => s.emoji);
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\s)+$/u;
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/** Whether text consists only of Unicode emoji (and whitespace), with at least one emoji. */
export function isEmojiOnlyText(text: string): boolean {
  return EMOJI_ONLY.test(text) && PICTOGRAPH.test(text);
}
