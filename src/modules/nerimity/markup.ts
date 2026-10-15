// Nerimity writes messages in Nevula (github.com/Nerimity/nevula), its own
// markup. Most of it is the markdown the view reads already (**bold**, *italic*,
// __underline__, ~~strike~~, `code`, ```blocks```, ||spoilers||, [text](url));
// what differs is turned into the view's forms here: //italic//, mentions and
// custom emoji in [type:value] brackets, and colour tags.

/** What a message's mentions name, as far as the session knows them. */
export interface MarkupNames {
  user(id: string): string | undefined;
  channel(id: string): string | undefined;
  role(id: string): string | undefined;
  /** A quoted message's text ([q:id]), already converted. */
  quote(id: string): string | undefined;
}

/** Code spans and blocks, which Nevula leaves as they are. */
const CODE = /(```[\s\S]*?```|`[^`\n]*`)/;
const ENTITY = /\[(@|#|r|q|ce|ace|wace|link):([^\]\n]{1,300})\]/g;
const COLOR = /\[#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|reset)\]/g;
/** //italic//, but not the slashes of an address (https://). */
const ITALIC = /(?<![:/\w])\/\/(?=\S)([^\n]*?\S)\/\//g;

function convertText(text: string, names: MarkupNames): string {
  return text
    .replace(COLOR, "")
    .replace(ITALIC, "*$1*")
    .replace(ENTITY, (match, type: string, value: string) => {
      switch (type) {
        case "@":
          if (value === "e") return "@everyone";
          if (value === "s") return "@someone";
          return names.user(value) !== undefined ? `@${names.user(value)}` : match;
        case "#":
          return names.channel(value) !== undefined ? `#${names.channel(value)}` : match;
        case "r":
          return names.role(value) !== undefined ? `@${names.role(value)}` : match;
        case "q": {
          const quote = names.quote(value);
          return quote === undefined ? "" : `\n> ${quote.replace(/\n/g, "\n> ")}\n`;
        }
        case "link": {
          // [link: url -> text]
          const [url, label] = value.split("->").map((s) => s.trim());
          return url && label && /^https?:\/\/\S+$/.test(url) ? `[${label}](${url})` : match;
        }
        default: {
          // Custom emoji: [ce:id:name]; [ace:...] are legacy GIFs, [wace:...] animated WebP.
          const emoji = /^(\d{1,20}):(\w{1,64})$/.exec(value);
          if (!emoji) return match;
          return `<${type === "ace" ? "a" : ""}:${emoji[2]}:${emoji[1]}>`;
        }
      }
    });
}

/** A message's text in the view's markdown, leaving code as it is. */
export function toMarkdown(content: string, names: MarkupNames): string {
  return content
    .split(CODE)
    .map((part, index) => (index % 2 === 1 ? part : convertText(part, names)))
    .join("");
}

/** One plain line for previews and notifications: custom emoji as :name:. */
export function toPlainLine(markdown: string): string {
  return markdown
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/\s+/g, " ")
    .trim();
}

/** The text a custom emoji goes into a message as, in Nevula. */
export function emojiMarkup(emoji: { id: string; name: string; gif: boolean; webp: boolean }): string {
  return `[${emoji.gif ? (emoji.webp ? "wace" : "ace") : "ce"}:${emoji.id}:${emoji.name}]`;
}
