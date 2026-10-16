import { isEmojiOnlyText } from "../../shared/emoji";
import { isJumboEmoji, parseMarkdown, type Block, type Inline } from "../../shared/markdown";
import { el } from "./dom";

export interface MarkdownOptions {
  /** Image URL for a platform's custom emoji; without it they show as :name:. */
  customEmojiUrl?: (id: string, animated: boolean) => string | undefined;
}

const WRAP_TAGS = { bold: "strong", italic: "em", underline: "u", strike: "s" } as const;

function renderInline(doc: Document, nodes: Inline[], options: MarkdownOptions): Node[] {
  return nodes.map((node): Node => {
    switch (node.type) {
      case "text":
        return doc.createTextNode(node.text);
      case "br":
        return el(doc, "br");
      case "code":
        return el(doc, "code", "md-code", node.text);
      case "bold":
      case "italic":
      case "underline":
      case "strike": {
        const element = el(doc, WRAP_TAGS[node.type]);
        element.append(...renderInline(doc, node.children, options));
        return element;
      }
      case "spoiler": {
        const spoiler = el(doc, "span", "spoiler");
        spoiler.setAttribute("role", "button");
        spoiler.tabIndex = 0;
        spoiler.append(...renderInline(doc, node.children, options));
        const reveal = () => spoiler.classList.add("revealed");
        spoiler.addEventListener("click", reveal);
        spoiler.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") reveal();
        });
        return spoiler;
      }
      case "link": {
        const link = el(doc, "a", "md-link");
        link.href = node.href;
        link.target = "_blank";
        link.rel = "noreferrer";
        // Masked links show their real target on hover.
        link.title = node.href;
        link.append(...renderInline(doc, node.children, options));
        return link;
      }
      case "emoji": {
        const emoji = el(doc, "span", "emoji", node.unicode);
        emoji.title = `:${node.name}:`;
        return emoji;
      }
      case "customEmoji": {
        // Without a picture, its name stands in.
        const url = options.customEmojiUrl?.(node.id, node.animated);
        if (!url) return doc.createTextNode(`:${node.name}:`);
        const img = el(doc, "img", "emoji custom");
        img.src = url;
        img.alt = `:${node.name}:`;
        img.title = `:${node.name}:`;
        img.draggable = false;
        return img;
      }
    }
  });
}

function renderBlock(doc: Document, block: Block, options: MarkdownOptions): HTMLElement {
  switch (block.type) {
    case "paragraph": {
      const p = el(doc, "div", "md-p");
      p.append(...renderInline(doc, block.children, options));
      return p;
    }
    case "heading": {
      const h = el(doc, `h${block.level}` as "h1" | "h2" | "h3", "md-heading");
      h.append(...renderInline(doc, block.children, options));
      return h;
    }
    case "subtext": {
      const small = el(doc, "small", "md-subtext");
      small.append(...renderInline(doc, block.children, options));
      return small;
    }
    case "quote": {
      const quote = el(doc, "blockquote", "md-quote");
      quote.append(...block.children.map((b) => renderBlock(doc, b, options)));
      return quote;
    }
    case "codeblock": {
      const pre = el(doc, "pre", "md-codeblock");
      const code = el(doc, "code", undefined, block.text);
      if (block.lang) code.dataset.lang = block.lang;
      pre.append(code);
      return pre;
    }
    case "list": {
      const list = el(doc, block.ordered ? "ol" : "ul", "md-list");
      if (block.ordered && block.start !== 1) list.setAttribute("start", String(block.start));
      for (const item of block.items) {
        const li = el(doc, "li");
        li.append(...renderInline(doc, item, options));
        list.append(li);
      }
      return list;
    }
  }
}

/** Renders message markdown into DOM. Emoji-only messages get the "jumbo" class. */
export function renderMarkdown(doc: Document, source: string, options: MarkdownOptions = {}): HTMLElement {
  const blocks = parseMarkdown(source);
  const root = el(doc, "div", "markdown");
  root.classList.toggle("jumbo", isJumboEmoji(blocks, isEmojiOnlyText));
  root.append(...blocks.map((b) => renderBlock(doc, b, options)));
  return root;
}

/** How long an excerpt's text may run, in characters, before it is cut with "…". */
export const EXCERPT_LENGTH = 200;

/**
 * A message's text as a short excerpt for a list of messages (pinned ones,
 * search results), where the whole entry is one button: formatting shows
 * (bold, italics, code, custom emoji), but nothing in it is interactive or a
 * block. Links read as their text, spoilers stay hidden as "(spoiler)",
 * headings and quotes run on as text, list items get a bullet. Built from
 * text nodes and inline elements only, and cut at about `max` characters.
 */
export function renderExcerpt(doc: Document, source: string, options: MarkdownOptions = {}, max = EXCERPT_LENGTH): HTMLElement {
  const root = el(doc, "span", "markdown excerpt");
  let left = max;
  let cut = false;
  const text = (parent: Node, value: string): void => {
    if (value.length > left) cut = true;
    parent.appendChild(doc.createTextNode(value.slice(0, Math.max(left, 0))));
    left -= value.length;
  };
  const inline = (parent: Node, nodes: Inline[]): void => {
    for (const node of nodes) {
      if (left <= 0) {
        cut = true;
        return;
      }
      switch (node.type) {
        case "text":
          text(parent, node.text);
          break;
        case "br":
          text(parent, " ");
          break;
        case "code": {
          const code = el(doc, "code", "md-code");
          text(code, node.text);
          parent.appendChild(code);
          break;
        }
        case "bold":
        case "italic":
        case "underline":
        case "strike": {
          const element = el(doc, WRAP_TAGS[node.type]);
          inline(element, node.children);
          parent.appendChild(element);
          break;
        }
        case "spoiler":
          parent.appendChild(el(doc, "span", "excerpt-spoiler", "(spoiler)"));
          left -= 9;
          break;
        case "link":
          inline(parent, node.children);
          break;
        case "emoji":
          text(parent, node.unicode);
          break;
        case "customEmoji": {
          const url = options.customEmojiUrl?.(node.id, node.animated);
          if (!url) {
            text(parent, `:${node.name}:`);
            break;
          }
          const img = el(doc, "img", "emoji custom");
          img.src = url;
          img.alt = `:${node.name}:`;
          img.draggable = false;
          parent.appendChild(img);
          left -= 1;
          break;
        }
      }
    }
  };
  const block = (b: Block): void => {
    if (left <= 0) {
      cut = true;
      return;
    }
    // Blocks run on, a space apart.
    if (root.childNodes.length > 0 && !/\s$/.test(root.textContent ?? "")) text(root, " ");
    switch (b.type) {
      case "paragraph":
      case "subtext":
        return inline(root, b.children);
      case "heading": {
        const strong = el(doc, "strong");
        inline(strong, b.children);
        root.appendChild(strong);
        return;
      }
      case "quote":
        return b.children.forEach((child) => block(child));
      case "codeblock": {
        const code = el(doc, "code", "md-code");
        text(code, b.text.replace(/\s+/g, " ").trim());
        root.appendChild(code);
        return;
      }
      case "list":
        return b.items.forEach((item, i) => {
          text(root, `${i > 0 ? " " : ""}${b.ordered ? `${b.start + i}.` : "•"} `);
          inline(root, item);
        });
    }
  };
  for (const b of parseMarkdown(source)) block(b);
  if (cut) root.appendChild(doc.createTextNode("…"));
  return root;
}
