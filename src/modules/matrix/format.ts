// Matrix formats messages as HTML (formatted_body, org.matrix.custom.html);
// the view renders Discord-flavoured markdown (src/shared/markdown.ts).
// Incoming HTML is hostile input: it is read here, in the engine, into the
// few parts the view can show (MxRich), and written out as markdown that is
// checked by parsing it back. Nothing of the HTML itself reaches the view.
// Outgoing, the composer's markdown becomes formatted_body, every piece of
// text escaped.

import { parseMarkdown, type Block, type Inline } from "../../shared/markdown";
import type { MxRich, MxRichNode } from "./api";
import { escapeHtml } from "./packs";

/** Longest formatted_body read; Matrix events are at most 64 KiB. */
export const MAX_HTML = 65_536;
/** Elements read per message; the rest of the HTML is ignored. */
export const MAX_ELEMENTS = 2000;
/** How deep elements nest before deeper ones count as plain text containers. */
export const MAX_NESTING = 32;
/** Characters of text read per message, as for plain bodies (events.ts MAX_BODY). */
export const MAX_RICH_TEXT = 4000;
/** Longest link address kept. */
const MAX_HREF = 2000;

interface Element {
  tag: string;
  attrs: Map<string, string>;
  children: (Element | string)[];
}

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9-]{0,31})((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/y;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/y;
/** Elements without content. */
const VOID = new Set(["br", "img", "hr", "wbr", "input", "meta", "link", "area", "base", "col", "embed", "source", "track", "param"]);
/** Elements whose content is not shown: the reply fallback (mx-reply), and what is never text. */
const HIDDEN = new Set(["mx-reply", "script", "style", "head", "title", "template", "svg", "math", "iframe", "object", "noscript"]);
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: String.fromCharCode(0xa0) };

/** Text with HTML's character references decoded; unknown ones stay as written, and code points that cannot be text become U+FFFD. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,8}|#x[0-9a-f]{1,7}|[a-z]{2,6});/gi, (whole, ref: string) => {
    if (!ref.startsWith("#")) return NAMED[ref.toLowerCase()] ?? whole;
    const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
  });
}

/** HTML as a tree of elements and text, within the limits above; malformed markup reads as text. */
function parseTree(html: string): Element {
  const root: Element = { tag: "", attrs: new Map(), children: [] };
  const stack = [root];
  let elements = 0;
  let at = 0;
  const text = (value: string) => {
    const { children } = stack.at(-1)!;
    // Text next to text (around a lone "<", a comment) is one run.
    if (typeof children.at(-1) === "string") children[children.length - 1] += decodeEntities(value);
    else if (value !== "") children.push(decodeEntities(value));
  };
  while (at < html.length) {
    const next = html.indexOf("<", at);
    if (next < 0) break;
    text(html.slice(at, next));
    COMMENT.lastIndex = TAG.lastIndex = next;
    if (COMMENT.test(html)) {
      at = COMMENT.lastIndex;
      continue;
    }
    const match = TAG.exec(html);
    if (!match) {
      text("<");
      at = next + 1;
      continue;
    }
    at = TAG.lastIndex;
    const tag = match[2]!.toLowerCase();
    if (match[1]) {
      // A closing tag closes the nearest open element of its name, and those inside it; one with nothing to close is ignored.
      const open = stack.findLastIndex((e) => e.tag === tag);
      if (open > 0) stack.length = open;
      continue;
    }
    // Past the limit the rest is left out, not shown as text.
    if (elements >= MAX_ELEMENTS) return root;
    elements++;
    const attrs = new Map<string, string>();
    for (const [, name, double, single, bare] of match[3]!.matchAll(ATTRIBUTE)) attrs.set(name!.toLowerCase(), decodeEntities(double ?? single ?? bare ?? ""));
    const element: Element = { tag, attrs, children: [] };
    stack.at(-1)!.children.push(element);
    if (!VOID.has(tag) && stack.length <= MAX_NESTING) stack.push(element);
  }
  text(html.slice(at));
  return root;
}

/** A link's address when the view may open it: https, plain enough, not too long. */
function href(value: string | undefined): string | undefined {
  const url = value?.trim();
  return url && url.length <= MAX_HREF && /^https:\/\/[^\s<>"]+$/i.test(url) ? url : undefined;
}

/** A code block's language from its class (language-x), as a fence line can carry it. */
function language(code: Element | undefined): string | undefined {
  return /(?:^|\s)language-([A-Za-z0-9_+#.-]{1,32})(?:\s|$)/.exec(code?.attrs.get("class") ?? "")?.[1];
}

/** All the text inside an element, as written (for code). */
function textOf(node: Element | string): string {
  return typeof node === "string" ? node : node.tag === "br" ? "\n" : HIDDEN.has(node.tag) ? "" : node.children.map(textOf).join("");
}

const INLINE: Record<string, "b" | "i" | "u" | "s"> = { b: "b", strong: "b", i: "i", em: "i", cite: "i", u: "u", ins: "u", del: "s", s: "s", strike: "s" };
const CONTAINERS = new Set(["p", "div", "section", "article", "header", "footer", "details", "summary", "figure", "table", "thead", "tbody", "tfoot", "tr", "dl", "dt", "dd", "center"]);

/** Reads a tree of elements into what the view can show, counting the text it takes. */
class Reader {
  private left = MAX_RICH_TEXT;

  nodes(children: (Element | string)[], inLink: boolean): MxRich {
    return children.flatMap((child) => this.node(child, inLink));
  }

  /** As much of a text as is left to take; undefined once there is none. */
  private take(value: string): string | undefined {
    if (this.left <= 0) return undefined;
    const kept = value.slice(0, this.left);
    this.left -= kept.length;
    return kept.length < value.length ? `${kept}…` : kept;
  }

  private node(node: Element | string, inLink: boolean): MxRich {
    if (typeof node === "string") {
      const text = this.take(node.replace(/\s+/g, " "));
      return text === undefined ? [] : [{ t: "text", text }];
    }
    const { tag, attrs } = node;
    if (HIDDEN.has(tag)) return [];
    const inner = () => this.nodes(node.children, inLink);
    const wrap = INLINE[tag];
    if (wrap) return [{ t: wrap, c: inner() }];
    switch (tag) {
      case "br":
        return [{ t: "br" }];
      case "img": {
        // Custom emoji by their shortcode (their pictures come from the message's emotes); other pictures are not shown.
        const name = /^:?([^\s:<>]{1,64}):?$/.exec(attrs.get("title") ?? attrs.get("alt") ?? "")?.[1];
        return attrs.has("data-mx-emoticon") && name ? [{ t: "emote", shortcode: name }] : [];
      }
      case "code": {
        const text = this.take(textOf(node).replace(/\s+/g, " ").trim());
        return text ? [{ t: "code", text }] : [];
      }
      case "a": {
        const url = inLink ? undefined : href(attrs.get("href"));
        return url ? [{ t: "a", href: url, c: this.nodes(node.children, true) }] : inner();
      }
      case "span":
        return attrs.has("data-mx-spoiler") ? [{ t: "spoiler", c: inner() }] : inner();
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return [{ t: "h", level: Math.min(Number(tag[1]), 3) as 1 | 2 | 3, c: inner() }];
      case "pre": {
        const code = node.children.find((c): c is Element => typeof c !== "string" && c.tag === "code");
        const lang = language(code);
        const text = this.take(textOf(node).replace(/\n$/, ""));
        if (!text) return [];
        return [lang ? { t: "pre", lang, text } : { t: "pre", text }];
      }
      case "blockquote":
        return [{ t: "quote", c: inner() }];
      case "ul":
      case "ol": {
        const start = Number(attrs.get("start"));
        const items = node.children.filter((c): c is Element => typeof c !== "string" && c.tag === "li").map((li) => this.nodes(li.children, inLink));
        return [{ t: "list", ordered: tag === "ol", start: tag === "ol" && Number.isInteger(start) && start >= 0 && start < 1e9 ? start : 1, items }];
      }
      default:
        return CONTAINERS.has(tag) || tag === "li" ? [{ t: "p", c: inner() }] : inner();
    }
  }
}

/** Whether the nodes say more than their plain text: anything besides text, line breaks, custom emoji and paragraphs. */
function formatted(nodes: MxRich): boolean {
  return nodes.some((n) => (n.t === "p" ? formatted(n.c) : n.t !== "text" && n.t !== "br" && n.t !== "emote"));
}

/**
 * A formatted_body read into what the view can show, or undefined when it
 * has nothing plain text would not show as well. The reply fallback
 * (mx-reply), scripts, styles and other pictures are dropped, links kept
 * only when they are https.
 */
export function parseHtml(html: string): MxRich | undefined {
  const nodes = new Reader().nodes(parseTree(html.slice(0, MAX_HTML)).children, false);
  return formatted(nodes) ? nodes : undefined;
}

// --- Writing it as the view's markdown -------------------------------------------

/** What a piece of the message is as markdown, and the text it shows. */
interface Piece {
  md: string;
  plain: string;
}

const join = (pieces: Piece[]): Piece => ({ md: pieces.map((p) => p.md).join(""), plain: pieces.map((p) => p.plain).join("") });
/** The parser's own rule for bare links. */
const BARE_URL = /https?:\/\/[^\s<]*[^\s<.,:;"')\]]/g;
/** A link's address as the parser takes it: no spaces, ")" or ">" (percent-encoded instead). */
const linkTarget = (url: string): string => url.replace(/[\s)>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
const BLOCKS = new Set<MxRichNode["t"]>(["p", "h", "pre", "quote", "list"]);
const MARKERS = { b: "**", u: "__", s: "~~", spoiler: "||" } as const;

class Writer {
  /** The markdown's lines. */
  readonly lines: string[] = [];
  /** The text it should show. */
  plain = "";
  /** A paragraph ended: the next block starts after a blank line. */
  private gap = false;
  /** The last line written was quoted. */
  private quoted = false;

  constructor(
    private readonly escape: (text: string) => string,
    private readonly italic: string,
  ) {}

  /** Text escaped, its web addresses kept whole in <…> so nothing after them is read as part of them. */
  private text(value: string): Piece {
    let md = "";
    let from = 0;
    for (const match of value.matchAll(BARE_URL)) {
      md += this.escape(value.slice(from, match.index)) + `<${linkTarget(match[0])}>`;
      from = match.index + match[0].length;
    }
    return { md: md + this.escape(value.slice(from)), plain: value.replace(BARE_URL, linkTarget) };
  }

  /** Inline nodes; `flat` where a line break would end the block (a list item, a heading). */
  inline(nodes: MxRich, flat: boolean): Piece {
    return join(nodes.map((node) => this.piece(node, flat)));
  }

  private piece(node: MxRichNode, flat: boolean): Piece {
    switch (node.t) {
      case "text":
        return this.text(node.text);
      case "br":
        return flat ? { md: " ", plain: " " } : { md: "\n", plain: "\n" };
      case "emote":
        return { md: this.escape(`:${node.shortcode}:`), plain: `:${node.shortcode}:` };
      case "code": {
        const fence = "`".repeat(Math.max(0, ...(node.text.match(/`+/g) ?? []).map((m) => m.length)) + 1);
        const pad = node.text.startsWith("`") || node.text.endsWith("`") ? " " : "";
        return node.text === "" ? { md: "", plain: "" } : { md: `${fence}${pad}${node.text}${pad}${fence}`, plain: node.text };
      }
      case "a": {
        const target = linkTarget(node.href);
        const label = this.inline(node.c, true);
        if (label.plain.trim() === "" || label.plain === node.href) return { md: `<${target}>`, plain: target };
        // A label the parser cannot take as one keeps its address beside it.
        if (/[\]\n]/.test(label.md) || label.md.length > 256) return { md: `${label.md} (<${target}>)`, plain: `${label.plain} (${target})` };
        return { md: `[${label.md}](<${target}>)`, plain: label.plain };
      }
      case "b":
      case "i":
      case "u":
      case "s":
      case "spoiler": {
        const inner = this.inline(node.c, flat);
        // Markers hug the text: white space around it stays outside them.
        const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner.md)!;
        const marker = node.t === "i" ? this.italic : MARKERS[node.t];
        return core === "" ? inner : { md: `${lead}${marker}${core}${marker}${trail}`, plain: inner.plain };
      }
      default:
        // Blocks inside inline content (in a list item or a heading) show as their text.
        return this.inline(this.flatten([node]), true);
    }
  }

  /** Blocks as inline content: their inline parts, separated by spaces. */
  private flatten(nodes: MxRich): MxRich {
    return nodes.flatMap((node): MxRich => {
      switch (node.t) {
        case "p":
        case "h":
        case "quote":
          return [...this.flatten(node.c), { t: "text", text: " " }];
        case "pre":
          return [{ t: "code", text: node.text.replace(/\s+/g, " ").trim() }, { t: "text", text: " " }];
        case "list":
          return node.items.flatMap((item) => [...this.flatten(item), { t: "text", text: " " }]);
        default:
          return [node];
      }
    });
  }

  private emit(lines: string[], plain: string, quoted: boolean): void {
    if (lines.length === 0) return;
    // Within a quote the blank line is quoted too, so the quote goes on.
    if (this.gap && this.lines.length > 0) this.lines.push(quoted && this.quoted ? ">" : "");
    this.gap = false;
    this.quoted = quoted;
    this.lines.push(...lines.map((line) => (!quoted ? line : line === "" ? ">" : `> ${line}`)));
    this.plain += `${plain}\n`;
  }

  /** Block content; inline runs between blocks are paragraphs. Quotes do not nest in the view's markdown, so a quote in a quote is its content. */
  blocks(nodes: MxRich, quoted: boolean): void {
    let run: MxRich = [];
    const flush = () => {
      const piece = this.inline(run, false);
      run = [];
      if (piece.plain.trim() === "") return;
      this.emit(piece.md.trim().split("\n"), piece.plain, quoted);
    };
    for (const node of nodes) {
      if (!BLOCKS.has(node.t)) {
        run.push(node);
        continue;
      }
      flush();
      this.block(node, quoted);
    }
    flush();
  }

  private block(node: MxRichNode, quoted: boolean): void {
    switch (node.t) {
      case "p":
        this.gap = true;
        this.blocks(node.c, quoted);
        this.gap = true;
        return;
      case "quote":
        return this.blocks(node.c, true);
      case "h": {
        const title = this.inline(node.c, true);
        if (title.plain.trim() !== "") this.emit([`${"#".repeat(node.level)} ${title.md.trim()}`], title.plain, quoted);
        return;
      }
      case "pre":
        this.emit([`\`\`\`${node.lang ?? ""}`, ...node.text.split("\n"), "```"], node.text, quoted);
        return;
      case "list": {
        const lines: string[] = [];
        let plain = "";
        let number = node.start;
        for (const item of node.items) {
          const piece = this.inline(this.flatten(item), true);
          if (piece.plain.trim() === "") continue;
          lines.push(`${node.ordered ? `${number++}.` : "-"} ${piece.md.trim()}`);
          plain += `${piece.plain}\n`;
        }
        this.emit(lines, plain, quoted);
        return;
      }
    }
  }
}

/** The text a parsed message shows, for comparing; emoji count as their shortcode. */
function shown(blocks: Block[]): string {
  const inline = (nodes: Inline[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
          case "code":
            return node.text;
          case "br":
            return "";
          case "emoji":
          case "customEmoji":
            return `:${node.name}:`;
          default:
            return inline(node.children);
        }
      })
      .join("");
  return blocks
    .map((block) => {
      switch (block.type) {
        case "codeblock":
          return block.text;
        case "quote":
          return shown(block.children);
        case "list":
          return block.items.map(inline).join("");
        default:
          return inline(block.children);
      }
    })
    .join("");
}

const squash = (text: string): string => text.replace(/\s+/g, "");

/**
 * Formatting as the view's markdown, text through `escape` (which may name
 * custom emoji), checked by parsing it back: where markers would be read
 * otherwise, the other italic marker is tried, then undefined (show the
 * plain body instead).
 */
export function richMarkdown(nodes: MxRich, escape: (text: string) => string): string | undefined {
  for (const italic of ["*", "_"]) {
    const writer = new Writer(escape, italic);
    writer.blocks(nodes, false);
    const markdown = writer.lines.join("\n");
    if (squash(markdown) === "") return undefined;
    if (squash(shown(parseMarkdown(markdown))) === squash(writer.plain)) return markdown;
  }
  return undefined;
}

// --- The composer's markdown as formatted_body ----------------------------------

/** Text as HTML, line breaks kept as they are (for code and attributes). */
const escapeCode = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const TAGS = { bold: "strong", italic: "em", underline: "u", strike: "del" } as const;

/**
 * The composer's markdown (the view's dialect) as formatted_body: emphasis,
 * spoilers, code, links, quotes, lists and headings, each run of text
 * through `text` (which escapes it and may make custom emoji and pills of
 * it). Undefined when the message is plain text, which needs no HTML.
 */
export function markdownHtml(markdown: string, text: (plain: string) => string): string | undefined {
  const inline = (nodes: Inline[], plainText: boolean): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
            return plainText ? escapeHtml(node.text) : text(node.text);
          case "br":
            return "<br>";
          case "code":
            return `<code>${escapeCode(node.text)}</code>`;
          case "emoji": {
            // A custom emoji of the same name comes first, as typed.
            const own = plainText ? "" : text(`:${node.name}:`);
            return own !== "" && own !== escapeHtml(`:${node.name}:`) ? own : node.unicode;
          }
          case "customEmoji":
            return plainText ? escapeHtml(`:${node.name}:`) : text(`:${node.name}:`);
          case "link": {
            const only = node.children[0];
            // A bare address stays text: other apps link it themselves.
            if (node.children.length === 1 && only?.type === "text" && only.text === node.href) return escapeHtml(node.href);
            return `<a href="${escapeCode(node.href)}">${inline(node.children, true)}</a>`;
          }
          case "spoiler":
            return `<span data-mx-spoiler>${inline(node.children, plainText)}</span>`;
          default: {
            const tag = TAGS[node.type];
            return `<${tag}>${inline(node.children, plainText)}</${tag}>`;
          }
        }
      })
      .join("");
  const blocks = (list: Block[]): string =>
    list
      .map((block) => {
        switch (block.type) {
          case "paragraph":
            return inline(block.children, false);
          case "heading":
            return `<h${block.level}>${inline(block.children, false)}</h${block.level}>`;
          case "subtext":
            return `<sub>${inline(block.children, false)}</sub>`;
          case "quote":
            return `<blockquote>${blocks(block.children)}</blockquote>`;
          case "codeblock": {
            const lang = block.lang && /^[A-Za-z0-9_+#.-]{1,32}$/.test(block.lang) ? ` class="language-${block.lang}"` : "";
            return `<pre><code${lang}>${escapeCode(block.text)}</code></pre>`;
          }
          case "list": {
            const tag = block.ordered ? "ol" : "ul";
            const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
            return `<${tag}${start}>${block.items.map((item) => `<li>${inline(item, false)}</li>`).join("")}</${tag}>`;
          }
        }
      })
      .join("");
  const html = blocks(parseMarkdown(markdown));
  return html === escapeHtml(markdown) ? undefined : html;
}
