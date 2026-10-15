// Custom emoji and stickers from image packs (MSC2545): how they go into
// messages. A custom emoji is an <img data-mx-emoticon> in the message's
// formatted_body, its plain body keeping ":shortcode:", as Element, Cinny and
// FluffyChat send it; a sticker is an m.sticker event with the pack's mxc://
// address, which stays unencrypted in encrypted rooms too, as in Element.

import type { MxPackImage } from "./api";
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
  const pattern = new RegExp(IN_TEXT.source, "g");
  let html = "";
  let done = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const image = emoticon(match[1]!);
    if (!image) {
      // Its closing colon may open the next one (":not:known:").
      pattern.lastIndex = match.index + 1;
      continue;
    }
    html += escapeHtml(text.slice(done, match.index)) + emoticonTag(image);
    done = pattern.lastIndex;
  }
  return done === 0 ? undefined : html + escapeHtml(text.slice(done));
}

/**
 * A pack picture's id for the view (emoji and sticker ids): its mxc://
 * address without the scheme, when it is plain enough to pass back.
 */
export function packImageId(url: string): string | undefined {
  const id = url.slice("mxc://".length);
  return /^[A-Za-z0-9:._/-]{1,200}$/.test(id) ? id : undefined;
}

/** How the picker shows a pack's sticker, by its type: PNG unless it says GIF or WebP. */
export function stickerFormat(image: MxPackImage): NativeStickerFormat {
  const mime = image.info.mimetype;
  return mime === "image/gif" ? "gif" : mime === "image/webp" ? "webp" : "png";
}
