// Custom emoji and stickers from image packs (MSC2545): how they go into
// messages. A custom emoji is an <img data-mx-emoticon> in the message's
// formatted_body, its plain body keeping ":shortcode:", as Element, Cinny and
// FluffyChat send it; a sticker is an m.sticker event with the pack's mxc://
// address, which stays unencrypted in encrypted rooms too, as in Element.

import type { MxPackImage } from "./api";
import { escapeMarkdown } from "../../shared/markdown";
import type { NativeStickerFormat } from "../../shared/native";

/** What formatted_body is written in. */
export const HTML_FORMAT = "org.matrix.custom.html";
/** A ":shortcode:" in a message's text (shortcodes have no spaces, colons or angle brackets). */
const IN_TEXT = /:([^\s:<>]{1,64}):/g;
const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Plain text as HTML: escaped, its line breaks as <br>. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ENTITIES[char]!).replace(/\n/g, "<br>");
}

/** A custom emoji as MSC2545 has it go into formatted_body (32 pixels high for clients that take the height as it is). */
export function emoticonTag(image: MxPackImage): string {
  const name = escapeHtml(`:${image.shortcode}:`);
  return `<img data-mx-emoticon src="${image.url}" alt="${name}" title="${name}" height="32" />`;
}

/**
 * The text as formatted_body, each ":shortcode:" of a known custom emoji as
 * its picture; undefined when the text has none, and goes as plain text only.
 */
export function emoticonHtml(text: string, emoticon: (shortcode: string) => MxPackImage | undefined): string | undefined {
  const { out, found } = replaceShortcodes(text, (code) => {
    const image = emoticon(code);
    return image && emoticonTag(image);
  }, escapeHtml);
  return found ? out : undefined;
}

/**
 * Message text as the view's markdown: escaped, each ":shortcode:" `id`
 * names as <:shortcode:id>, which the view draws with its picture (emojiUrls).
 */
export function emoticonMarkdown(text: string, id: (shortcode: string) => string | undefined): string {
  return replaceShortcodes(text, (code) => {
    const found = id(code);
    return found && `<:${code}:${found}>`;
  }, escapeMarkdown).out;
}

/** Text with the ":shortcode:"s `replace` knows replaced, the rest escaped; and whether any was. */
function replaceShortcodes(text: string, replace: (shortcode: string) => string | undefined, escape: (text: string) => string): { out: string; found: boolean } {
  const pattern = new RegExp(IN_TEXT.source, "g");
  let out = "";
  let done = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const replaced = replace(match[1]!);
    if (!replaced) {
      // Its closing colon may open the next one (":not:known:").
      pattern.lastIndex = match.index + 1;
      continue;
    }
    out += escape(text.slice(done, match.index)) + replaced;
    done = pattern.lastIndex;
  }
  return { out: out + escape(text.slice(done)), found: done > 0 };
}

/**
 * A pack picture's id for the view (emoji and sticker ids, and emoji in
 * message text): its mxc:// address without the scheme, a port's colon as
 * "+", when it is plain enough to pass back.
 */
export function packImageId(url: string): string | undefined {
  const id = url.slice("mxc://".length).replace(/:/g, "+");
  return /^[A-Za-z0-9._+/-]{1,200}$/.test(id) ? id : undefined;
}

/** How the picker shows a pack's sticker, by its type: PNG unless it says GIF or WebP. */
export function stickerFormat(image: MxPackImage): NativeStickerFormat {
  const mime = image.info.mimetype;
  return mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "png";
}
