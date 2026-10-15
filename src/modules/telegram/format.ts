// Telegram formats text with entities (ranges marked bold, code, a link…);
// the view renders Discord-flavoured markdown (src/shared/markdown.ts). This
// converts between the two through that same parser, so what the user types
// is sent as they saw it in the preview, and what arrives shows as Telegram
// shows it: incoming text is escaped, so a literal * or _ stays literal.
// Custom emoji are `<:emoji:document id>` both ways, the emoji they stand
// for being the text Telegram's entity covers.

import { escapeMarkdown, parseMarkdown, type Block, type Inline } from "../../shared/markdown";
import { DOCUMENT_ID, type TgEntity, type TgText } from "./api";

/** Inline styles, outermost first: markers always nest in this order. */
const INLINE = ["textUrl", "spoiler", "strike", "underline", "bold", "italic", "code"] as const;
type InlineType = (typeof INLINE)[number];

interface Range {
  type: InlineType;
  start: number;
  end: number;
  url?: string;
}

interface LineRange {
  start: number;
  end: number;
}

/** Most entities read from one message; Telegram allows 100. */
export const MAX_ENTITIES = 500;
/** Longest link text shown as a link: the parser takes at most 256 characters, escapes included. */
const MAX_LINK_LABEL = 120;

/** The parser's own rule for bare links, so escaping agrees with it on where a link ends. */
const BARE_URL = /https?:\/\/[^\s<]*[^\s<.,:;"')\]]/g;

const isSpace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);

/** Plain text, escaped so the parser shows it as written. */
function escapePlain(part: string): string {
  return part
    .replace(/[\\`*_~|<[\]]/g, "\\$&")
    .replace(/:(?=[a-z0-9_+-]{1,40}:)/gi, "\\:")
    .replace(/^(\s*)([#>-])/gm, "$1\\$2")
    .replace(/^(\s*\d{1,9})\.(?= )/gm, "$1\\.");
}

/**
 * Escapes text for the view. Links stay as they are, so they still open;
 * one that something other than a space follows is put in <…>, so it ends
 * where Telegram's does. `last`: nothing follows this text in the message.
 */
export function escapeText(text: string, last = true): string {
  let out = "";
  let from = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const end = match.index + match[0].length;
    out += escapePlain(text.slice(from, match.index));
    const followed = end < text.length ? !isSpace(text[end]) : !last;
    if (!followed) out += match[0];
    else out += match[0].includes(">") ? escapePlain(match[0]) : `<${match[0]}>`;
    from = end;
  }
  return out + escapePlain(text.slice(from));
}

/** A link's address as the parser takes it: no spaces, ")" or ">" (percent-encoded instead). */
const linkTarget = (url: string): string => url.replace(/[\s)>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);

/** A code block's language as a fence line can carry it. */
const language = (value: string | undefined): string => (value && /^[A-Za-z0-9_+#.-]{1,32}$/.test(value) ? value : "");

/** A custom emoji drawn as its picture: `<:name:id>`, its name the emoji its range covers. */
interface EmojiRange extends LineRange {
  id: string;
}

/** What the entities say, cleaned: valid ranges, styles without surrounding white space, blocks on whole lines, custom emoji outside code. */
interface Layout {
  inline: Range[];
  pre: (LineRange & { language: string })[];
  quote: LineRange[];
  emoji: EmojiRange[];
}

/** Which custom emoji, by document id, show as their picture; the rest show as the emoji they cover. */
export type ShownEmoji = (id: string) => boolean;

/** Text the view's `<:name:id>` takes as a name. */
const EMOJI_NAME = /^[^\s:<>]{1,64}$/;

function layout(text: string, entities: readonly TgEntity[], shown: ShownEmoji): Layout {
  const out: Layout = { inline: [], pre: [], quote: [], emoji: [] };
  const lineStart = (i: number) => i === 0 || text[i - 1] === "\n";
  const lineEnd = (i: number) => i === text.length || text[i] === "\n";
  const emoji: EmojiRange[] = [];
  for (const entity of entities.slice(0, MAX_ENTITIES)) {
    let start = entity.offset;
    let end = entity.offset + entity.length;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start) continue;
    if (entity.type === "customEmoji") {
      const id = entity.documentId ?? "";
      if (DOCUMENT_ID.test(id) && shown(id) && EMOJI_NAME.test(text.slice(start, end))) emoji.push({ start, end, id });
      continue;
    }
    if (entity.type === "pre" || entity.type === "blockquote") {
      // A block keeps its lines whole; the line breaks around it belong to no one.
      if (text[start] === "\n") start++;
      if (text[end - 1] === "\n") end--;
      if (end > start && lineStart(start) && lineEnd(end)) {
        if (entity.type === "pre") out.pre.push({ start, end, language: language(entity.language) });
        else out.quote.push({ start, end });
        continue;
      }
      // Code that does not stand on lines of its own shows as inline code; a quote that way, not at all.
      if (entity.type === "blockquote") continue;
    }
    while (start < end && isSpace(text[start])) start++;
    while (end > start && isSpace(text[end - 1])) end--;
    if (end <= start) continue;
    if (entity.type === "textUrl") {
      const url = entity.url ?? "";
      const label = text.slice(start, end);
      // Only web links can be shown, and a link that reads as its own address is just the address.
      if (!/^https?:\/\/\S/i.test(url) || label === url || label.length > MAX_LINK_LABEL || /[\]\n]/.test(label)) continue;
      out.inline.push({ type: "textUrl", start, end, url: linkTarget(url) });
    } else out.inline.push({ type: entity.type === "pre" ? "code" : entity.type, start, end });
  }
  // Code shows its text as it is; emoji that overlap code, or one another, show as the emoji they cover.
  const code = [...out.pre, ...out.inline.filter((r) => r.type === "code")];
  const overlaps = (a: LineRange, b: LineRange) => a.start < b.end && b.start < a.end;
  for (const range of emoji.sort((a, b) => a.start - b.start)) {
    if (!code.some((c) => overlaps(c, range)) && !out.emoji.some((e) => overlaps(e, range))) out.emoji.push(range);
  }
  return out;
}

const MARKERS: Record<Exclude<InlineType, "textUrl" | "code" | "italic">, string> = { spoiler: "||", strike: "~~", underline: "__", bold: "**" };

interface Frame {
  type: InlineType;
  url?: string;
  parts: string[];
}

/** Text from `a` to `b` escaped, with the custom emoji in it as `<:name:id>`; `last`: nothing follows it. */
function escapeWithEmoji(text: string, a: number, b: number, emoji: readonly EmojiRange[], last: boolean): string {
  let out = "";
  let at = a;
  for (const e of emoji) {
    if (e.start < a || e.end > b) continue;
    out += escapeText(text.slice(at, e.start), false) + `<:${text.slice(e.start, e.end)}:${e.id}>`;
    at = e.end;
  }
  return out + escapeText(text.slice(at, b), last);
}

/** One stretch of lines without blocks in it, with its styles as markers and its custom emoji as pictures. */
function renderInline(text: string, start: number, end: number, ranges: Range[], italic: string, emoji: readonly EmojiRange[]): string {
  const clipped = ranges.flatMap((r) => {
    let s = Math.max(r.start, start);
    let e = Math.min(r.end, end);
    while (s < e && isSpace(text[s])) s++;
    while (e > s && isSpace(text[e - 1])) e--;
    return e > s ? [{ ...r, start: s, end: e }] : [];
  });
  const cuts = [...new Set([start, end, ...clipped.flatMap((r) => [r.start, r.end])])].sort((a, b) => a - b);
  const root: string[] = [];
  const stack: Frame[] = [];
  const close = () => {
    const frame = stack.pop()!;
    const inner = frame.parts.join("");
    let out: string;
    if (frame.type === "code") {
      const fence = "`".repeat(Math.max(0, ...(inner.match(/`+/g) ?? []).map((m) => m.length)) + 1);
      const pad = inner.startsWith("`") || inner.endsWith("`") ? " " : "";
      out = `${fence}${pad}${inner}${pad}${fence}`;
    } else if (frame.type === "textUrl") out = `[${inner}](<${frame.url}>)`;
    else if (frame.type === "italic") out = `${italic}${inner}${italic}`;
    else out = `${MARKERS[frame.type]}${inner}${MARKERS[frame.type]}`;
    (stack.at(-1)?.parts ?? root).push(out);
  };
  // Runs of one style each; white space between two runs takes only the styles both keep open, so markers never meet it.
  const runs: { a: number; b: number; wanted: Range[]; space: boolean }[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const [a, b] = [cuts[i]!, cuts[i + 1]!];
    const wanted = INLINE.flatMap((type) => {
      const range = clipped.find((r) => r.type === type && r.start <= a && r.end >= b);
      return range ? [range] : [];
    });
    let at = a;
    for (const chunk of text.slice(a, b).match(/\s+|\S+/g)!) {
      runs.push({ a: at, b: at + chunk.length, wanted, space: isSpace(chunk[0]) });
      at += chunk.length;
    }
  }
  const same = (x: Pick<Range, "type" | "url">, y: Pick<Range, "type" | "url">) => x.type === y.type && x.url === y.url;
  runs.forEach((run, i) => {
    if (!run.space) return;
    const before = runs.slice(0, i).findLast((r) => !r.space)?.wanted ?? [];
    const after = runs.slice(i + 1).find((r) => !r.space)?.wanted ?? [];
    let shared = 0;
    while (shared < run.wanted.length && shared < before.length && shared < after.length && same(run.wanted[shared]!, before[shared]!) && same(run.wanted[shared]!, after[shared]!)) shared++;
    run.wanted = run.wanted.slice(0, shared);
  });
  // Neighbouring runs of the same styles are one stretch of text.
  const spans: { a: number; b: number; wanted: Range[] }[] = [];
  for (const run of runs) {
    const previous = spans.at(-1);
    if (previous && previous.wanted.length === run.wanted.length && previous.wanted.every((r, k) => same(r, run.wanted[k]!))) previous.b = run.b;
    else spans.push({ ...run });
  }
  spans.forEach(({ a, b, wanted }, i) => {
    let keep = 0;
    while (keep < stack.length && keep < wanted.length && same(stack[keep]!, wanted[keep]!)) keep++;
    while (stack.length > keep) close();
    for (const range of wanted.slice(keep)) stack.push({ type: range.type, url: range.url, parts: [] });
    // Markers follow the stretch unless it is the last and unstyled.
    const last = i === spans.length - 1 && wanted.length === 0;
    (stack.at(-1)?.parts ?? root).push(stack.at(-1)?.type === "code" ? text.slice(a, b) : escapeWithEmoji(text, a, b, emoji, last));
  });
  while (stack.length > 0) close();
  return root.join("");
}

/** Text and entities as markdown, with the given italic marker; unchecked. */
function render(text: string, entities: readonly TgEntity[], italic: string, shown: ShownEmoji): string {
  const { inline, pre, quote, emoji } = layout(text, entities, shown);
  const lines: LineRange[] = [];
  for (let start = 0; ; ) {
    const end = text.indexOf("\n", start);
    lines.push({ start, end: end < 0 ? text.length : end });
    if (end < 0) break;
    start = end + 1;
  }
  const inside = <T extends LineRange>(blocks: T[], line: LineRange): T | undefined => blocks.find((b) => b.start <= line.start && line.end <= b.end);
  const out: string[] = [];
  const emit = (rendered: string[], quoted: boolean) => out.push(...rendered.map((line) => (!quoted ? line : line === "" ? ">" : `> ${line}`)));
  for (let i = 0; i < lines.length; ) {
    const quoted = inside(quote, lines[i]!) !== undefined;
    const code = inside(pre, lines[i]!);
    let j = i + 1;
    while (j < lines.length && inside(pre, lines[j]!) === code && (inside(quote, lines[j]!) !== undefined) === quoted) j++;
    const [first, final] = [lines[i]!.start, lines[j - 1]!.end];
    if (code) emit(["```" + code.language, ...text.slice(first, final).split("\n"), "```"], quoted);
    else emit(renderInline(text, first, final, inline, italic, emoji).split("\n"), quoted);
    i = j;
  }
  return out.join("\n");
}

/** Builds text and entities from parsed markdown. `strict`: undefined for anything plain text would not parse to. */
class Builder {
  text = "";
  entities: TgEntity[] = [];
  constructor(private readonly strict: boolean) {}

  private mark(type: TgEntity["type"], start: number, extra: Partial<TgEntity> = {}): void {
    if (this.text.length > start) this.entities.push({ type, offset: start, length: this.text.length - start, ...extra });
  }

  blocks(blocks: Block[]): boolean {
    return blocks.every((block, i) => {
      if (i > 0) this.text += "\n";
      const start = this.text.length;
      switch (block.type) {
        case "paragraph":
          return this.inline(block.children);
        case "quote": {
          const ok = this.blocks(block.children);
          this.mark("blockquote", start);
          return ok;
        }
        case "codeblock":
          this.text += block.text;
          this.mark("pre", start, { language: block.lang ?? "" });
          return true;
        case "heading":
          this.text += `${"#".repeat(block.level)} `;
          return !this.strict && this.inline(block.children);
        case "subtext":
          this.text += "-# ";
          return !this.strict && this.inline(block.children);
        case "list":
          return (
            !this.strict &&
            block.items.every((item, j) => {
              if (j > 0) this.text += "\n";
              this.text += block.ordered ? `${block.start + j}. ` : "- ";
              return this.inline(item);
            })
          );
      }
    });
  }

  inline(nodes: Inline[]): boolean {
    return nodes.every((node) => {
      const start = this.text.length;
      switch (node.type) {
        case "text":
          this.text += node.text;
          return true;
        case "br":
          this.text += "\n";
          return true;
        case "code":
          this.text += node.text;
          this.mark("code", start);
          return true;
        case "emoji":
          this.text += node.unicode;
          return !this.strict;
        case "customEmoji":
          // Telegram's own (by document id) as the emoji it stands for, marked; another module's syntax by name.
          if (!DOCUMENT_ID.test(node.id)) {
            this.text += `:${node.name}:`;
            return !this.strict;
          }
          this.text += node.name;
          this.mark("customEmoji", start, { documentId: node.id });
          return true;
        case "link": {
          const ok = this.inline(node.children);
          // A bare address is linked by Telegram itself.
          if (this.text.slice(start) !== node.href) this.mark("textUrl", start, { url: node.href });
          return ok;
        }
        default: {
          const ok = this.inline(node.children);
          this.mark(node.type, start);
          return ok;
        }
      }
    });
  }
}

/** The user's markdown as Telegram text and entities, sorted by where they start. */
export function fromMarkdown(markdown: string): TgText {
  const builder = new Builder(false);
  builder.blocks(parseMarkdown(markdown));
  return { text: builder.text, entities: builder.entities.sort((a, b) => a.offset - b.offset) };
}

/** Per character, the styles shown; white space counts for none. */
function styles(text: string, layout: Layout): string[] {
  // By UTF-16 unit, as entities count.
  const flags: string[][] = Array.from({ length: text.length }, () => []);
  const inPre = (i: number) => layout.pre.some((b) => b.start <= i && i < b.end);
  for (const r of layout.inline) for (let i = r.start; i < r.end; i++) if (!inPre(i)) flags[i]!.push(r.type === "textUrl" ? `L${r.url}` : r.type);
  for (const b of layout.pre) for (let i = b.start; i < b.end; i++) flags[i]!.push(`P${b.language}`);
  for (const b of layout.quote) for (let i = b.start; i < b.end; i++) flags[i]!.push("q");
  for (const e of layout.emoji) for (let i = e.start; i < e.end; i++) flags[i]!.push(`E${e.id}`);
  return flags.map((f, i) => (isSpace(text[i]) ? "" : [...new Set(f)].sort().join(" ")));
}

const ALL_EMOJI: ShownEmoji = () => true;
const NO_EMOJI: ShownEmoji = () => false;

/** Whether markdown shows exactly this text with these styles. */
function shows(markdown: string, text: string, expected: string[]): boolean {
  const builder = new Builder(true);
  if (!builder.blocks(parseMarkdown(markdown)) || builder.text !== text) return false;
  const actual = styles(text, layout(text, builder.entities, ALL_EMOJI));
  return actual.every((flags, i) => flags === expected[i]);
}

/**
 * Telegram text and entities as markdown for the view: bold, italic,
 * underline, strikethrough, spoilers, code, code blocks, web links and
 * quotes, and the custom emoji `shown` picks as `<:emoji:document id>`;
 * everything else escaped. The result is checked by parsing it back, and
 * where markers would be read otherwise (styles pressed together), the
 * other italic marker is tried, then the text shows unstyled.
 */
export function toMarkdown(text: string, entities: readonly TgEntity[] = [], shown: ShownEmoji = NO_EMOJI): string {
  const expected = styles(text, layout(text, entities, shown));
  for (const italic of ["*", "_"]) {
    const markdown = render(text, entities, italic, shown);
    if (shows(markdown, text, expected)) return markdown;
  }
  const plain = escapeText(text);
  return shows(plain, text, styles(text, layout(text, [], NO_EMOJI))) ? plain : escapeMarkdown(text);
}

/** Every custom emoji entity in a text's formatting, by document id, at most MAX_ENTITIES. */
export function customEmojiIds(entities: readonly TgEntity[] | undefined): string[] {
  const ids = (entities ?? []).slice(0, MAX_ENTITIES).flatMap((e) => (e.type === "customEmoji" && e.documentId && DOCUMENT_ID.test(e.documentId) ? [e.documentId] : []));
  return [...new Set(ids)];
}
