// A Discord-flavoured markdown parser (Fluxer uses the same dialect). It
// produces a small syntax tree; components/markdown.ts turns that into DOM
// with text nodes only, so message content can never inject markup.
import { emojiForShortcode } from "./emoji";

export type Inline =
  | { type: "text"; text: string }
  | { type: "bold" | "italic" | "underline" | "strike" | "spoiler"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "emoji"; unicode: string; name: string }
  | { type: "customEmoji"; id: string; name: string; animated: boolean }
  | { type: "br" };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { type: "subtext"; children: Inline[] }
  | { type: "quote"; children: Block[] }
  | { type: "codeblock"; lang?: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] };

type Wrap = "bold" | "italic" | "underline" | "strike" | "spoiler";

interface InlineRule {
  match: RegExp;
  build(m: RegExpExecArray, depth: number): Inline | null;
}

const MAX_DEPTH = 8;

const wrap = (type: Wrap) => (m: RegExpExecArray, depth: number): Inline => ({ type, children: parseInline(m[1]!, depth + 1) });

/** Rules in priority order, as in Discord: code and escapes first, emphasis last. */
const INLINE_RULES: InlineRule[] = [
  // Any ASCII punctuation, underscore included, as in Discord.
  { match: /^\\([^A-Za-z0-9\s])/, build: (m) => ({ type: "text", text: m[1]! }) },
  { match: /^(`+)([\s\S]*?[^`])\1(?!`)/, build: (m) => ({ type: "code", text: m[2]!.trim() || m[2]! }) },
  { match: /^<(a?):(\w{2,32}):(\d{1,20})>/, build: (m) => ({ type: "customEmoji", animated: m[1] === "a", name: m[2]!, id: m[3]! }) },
  { match: /^<(https?:\/\/[^\s>]+)>/, build: (m) => ({ type: "link", href: m[1]!, children: [{ type: "text", text: m[1]! }] }) },
  {
    match: /^\[([^\]\n]{1,256})\]\(<?(https?:\/\/[^\s)>]+)>?\)/,
    build: (m, depth) => ({ type: "link", href: m[2]!, children: parseInline(m[1]!, depth + 1) }),
  },
  // Bare URLs. They cannot end in punctuation: that belongs to the sentence.
  {
    match: /^https?:\/\/[^\s<]*[^\s<.,:;"')\]]/,
    build: (m) => ({ type: "link", href: m[0], children: [{ type: "text", text: m[0] }] }),
  },
  { match: /^\|\|([\s\S]+?)\|\|/, build: wrap("spoiler") },
  { match: /^\*\*([\s\S]+?)\*\*(?!\*)/, build: wrap("bold") },
  { match: /^__([\s\S]+?)__(?!_)/, build: wrap("underline") },
  { match: /^\*(?=\S)([\s\S]*?\S)\*(?!\*)/, build: wrap("italic") },
  { match: /^_([^_]+?)_(?![_\w])/, build: wrap("italic") },
  { match: /^~~([\s\S]+?)~~/, build: wrap("strike") },
  {
    match: /^:([a-z0-9_+-]{1,40}):/i,
    build: (m) => {
      const unicode = emojiForShortcode(m[1]!);
      return unicode ? { type: "emoji", unicode, name: m[1]! } : null;
    },
  },
  { match: /^\n/, build: () => ({ type: "br" }) },
];

/** Characters where a rule might start; plain text runs up to the next one. */
const SPECIAL = /[\\`<[h|*_~:\n]/;

function pushText(out: Inline[], text: string): void {
  const last = out.at(-1);
  if (last?.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  // Underscore emphasis must not start inside a word (snake_case_names stay as they are).
  let afterWord = false;
  while (rest.length > 0) {
    let matched = false;
    if (depth < MAX_DEPTH) {
      for (const rule of INLINE_RULES) {
        if (afterWord && rule.match.source.startsWith("^_")) continue;
        const m = rule.match.exec(rest);
        if (!m) continue;
        const node = rule.build(m, depth);
        if (!node) continue;
        if (node.type === "text") pushText(out, node.text);
        else out.push(node);
        rest = rest.slice(m[0].length);
        afterWord = false;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Plain text: at least one character, then up to the next possible rule start.
    const next = rest.slice(1).search(SPECIAL);
    const text = next < 0 ? rest : rest.slice(0, next + 1);
    pushText(out, text);
    afterWord = /\w$/.test(text);
    rest = rest.slice(text.length);
  }
  return out;
}

const HEADING = /^(#{1,3}) +(.+)$/;
const SUBTEXT = /^-# +(.+)$/;
const LIST_ITEM = /^ *([-*]|(\d{1,9})\.) +(.+)$/;
const FENCE = /^```(\S*)\s*$/;

/** Parses a whole message into blocks. */
export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n"), depth) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // ```lang ... ``` code blocks, including a one-line ```code```.
    const oneLine = /^```([\s\S]+?)```$/.exec(line);
    if (oneLine) {
      flush();
      blocks.push({ type: "codeblock", text: oneLine[1]! });
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const end = lines.findIndex((l, j) => j > i && l.trimEnd() === "```");
      if (end > i) {
        flush();
        blocks.push({ type: "codeblock", lang: fence[1] || undefined, text: lines.slice(i + 1, end).join("\n") });
        i = end;
        continue;
      }
    }

    if (depth === 0 && line.startsWith(">>> ")) {
      flush();
      blocks.push({ type: "quote", children: parseMarkdown([line.slice(4), ...lines.slice(i + 1)].join("\n"), depth + 1) });
      break;
    }
    if (depth === 0 && /^>( |$)/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^>( |$)/.test(lines[i]!)) quoted.push(lines[i++]!.replace(/^> ?/, ""));
      i--;
      blocks.push({ type: "quote", children: parseMarkdown(quoted.join("\n"), depth + 1) });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      blocks.push({ type: "heading", level: heading[1]!.length as 1 | 2 | 3, children: parseInline(heading[2]!, depth) });
      continue;
    }
    const subtext = SUBTEXT.exec(line);
    if (subtext) {
      flush();
      blocks.push({ type: "subtext", children: parseInline(subtext[1]!, depth) });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const items: Inline[][] = [];
      const start = ordered ? Number(item[2]) : 1;
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]!);
        if (!m || (m[2] !== undefined) !== ordered) break;
        items.push(parseInline(m[3]!, depth));
        i++;
      }
      i--;
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    paragraph.push(line);
  }
  flush();
  return blocks;
}

/** Whether a message is only emoji (up to 27, as Discord), to show them large. */
export function isJumboEmoji(blocks: Block[], isEmojiText: (text: string) => boolean): boolean {
  const [only] = blocks;
  if (blocks.length !== 1 || only?.type !== "paragraph") return false;
  let count = 0;
  for (const node of only.children) {
    if (node.type === "emoji" || node.type === "customEmoji") count++;
    else if (node.type === "text") {
      if (node.text.trim() === "") continue;
      if (!isEmojiText(node.text)) return false;
      count += [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(node.text.trim())].filter((s) => s.segment.trim() !== "").length;
    } else return false;
  }
  return count > 0 && count <= 27;
}

const LITERAL_URL = /https?:\/\/\S+/g;

/**
 * Escapes plain text (e.g. from a platform without Discord-style markdown)
 * so it renders exactly as written: inline markers get a backslash, as do
 * heading, quote and list markers at line starts. URLs stay untouched, so
 * they still become links.
 */
export function escapeMarkdown(text: string): string {
  const escapePart = (part: string): string =>
    part.replace(/[\\`*_~|<[\]]/g, (c) => `\\${c}`).replace(/^(\s*)([#>-])/gm, (_m, space: string, marker: string) => `${space}\\${marker}`);
  let out = "";
  let last = 0;
  for (const match of text.matchAll(LITERAL_URL)) {
    out += escapePart(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + escapePart(text.slice(last));
}
