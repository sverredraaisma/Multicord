// Custom emoji and stickers from image packs (MSC2545): how they go into
// messages. A custom emoji is an <img data-mx-emoticon> in the message's
// formatted_body, its plain body keeping ":shortcode:", as Element, Cinny and
// FluffyChat send it; a sticker is an m.sticker event with the pack's mxc://
// address, which stays unencrypted in encrypted rooms too, as in Element.
// User IDs in the text (as the composer inserts mentions) become pills: links
// to https://matrix.to/#/<user id> showing the name, as Element sends them.

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

/** A Matrix user ID in a message's text: "@localpart:server", the server with an optional port. */
const USER_IN_TEXT = /@[a-z0-9._=\-/+]{1,255}:[A-Za-z0-9.-]{1,255}(?::\d{1,5})?/;
/** Most users one message mentions. */
export const MAX_TEXT_MENTIONS = 50;

/** The user IDs a message's text names, each once, at most MAX_TEXT_MENTIONS. */
export function textMentions(text: string): string[] {
  const found = new Set(text.match(new RegExp(USER_IN_TEXT.source, "g")) ?? []);
  return [...found].slice(0, MAX_TEXT_MENTIONS);
}

/** A pill: a link to a user that clients show as their name. */
export function pillTag(userId: string, name: string): string {
  return `<a href="https://matrix.to/#/${userId}">${escapeHtml(name)}</a>`;
}

/**
 * The text as formatted_body, each ":shortcode:" of a known custom emoji as
 * its picture and each user ID `pill` names (it gives their name) as a pill;
 * undefined when the text has neither, and goes as plain text only.
 */
export function emoticonHtml(text: string, emoticon: (shortcode: string) => MxPackImage | undefined, pill: (userId: string) => string | undefined = () => undefined): string | undefined {
  const pattern = new RegExp(`${IN_TEXT.source}|(${USER_IN_TEXT.source})`, "g");
  const { out, found } = replaceMatches(text, pattern, (match) => {
    if (match[2]) {
      const name = pill(match[2]);
      return name === undefined ? undefined : pillTag(match[2], name);
    }
    const image = emoticon(match[1]!);
    return image && emoticonTag(image);
  }, escapeHtml);
  return found ? out : undefined;
}

/**
 * Message text as the view's markdown: escaped, each ":shortcode:" `id`
 * names as <:shortcode:id>, which the view draws with its picture (emojiUrls).
 */
export function emoticonMarkdown(text: string, id: (shortcode: string) => string | undefined): string {
  return replaceMatches(text, new RegExp(IN_TEXT.source, "g"), (match) => {
    const found = id(match[1]!);
    return found && `<:${match[1]}:${found}>`;
  }, escapeMarkdown).out;
}

/** Text with the matches of a global pattern that `replace` knows replaced, the rest escaped; and whether any was. */
function replaceMatches(text: string, pattern: RegExp, replace: (match: RegExpExecArray) => string | undefined, escape: (text: string) => string): { out: string; found: boolean } {
  let out = "";
  let done = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const replaced = replace(match);
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
