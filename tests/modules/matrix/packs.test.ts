import { describe, expect, it } from "vitest";
import type { MxPackImage } from "../../../src/modules/matrix/api";
import { emoticonHtml, emoticonMarkdown, emoticonTag, escapeHtml, packImageId, stickerFormat } from "../../../src/modules/matrix/packs";

const image = (shortcode: string, extra: Partial<MxPackImage> = {}): MxPackImage => ({ shortcode, url: `mxc://x.org/${shortcode}`, info: {}, emoticon: true, sticker: true, ...extra });
const known = new Map([
  ["cat", image("cat")],
  ["a&b", image("a&b", { url: "mxc://x.org/ab" })],
]);
const lookup = (code: string) => known.get(code);

describe("custom emoji in messages", () => {
  it("escapes text as HTML", () => {
    expect(escapeHtml(`<b>"it's" & more</b>\nnext`)).toBe("&lt;b&gt;&quot;it&#39;s&quot; &amp; more&lt;/b&gt;<br>next");
  });

  it("writes an emoji as MSC2545 has it", () => {
    expect(emoticonTag(image("cat"))).toBe('<img data-mx-emoticon src="mxc://x.org/cat" alt=":cat:" title=":cat:" height="32" />');
    expect(emoticonTag(known.get("a&b")!)).toBe('<img data-mx-emoticon src="mxc://x.org/ab" alt=":a&amp;b:" title=":a&amp;b:" height="32" />');
  });

  it("turns known shortcodes into pictures and leaves the rest as text", () => {
    expect(emoticonHtml("hi :cat: <3\n:dog: :a&b:", lookup)).toBe(
      `hi ${emoticonTag(image("cat"))} &lt;3<br>:dog: ${emoticonTag(known.get("a&b")!)}`,
    );
    // An unknown one's closing colon may open a known one.
    expect(emoticonHtml(":dog:cat:", lookup)).toBe(`:dog${emoticonTag(image("cat"))}`);
    expect(emoticonHtml(":cat::cat:", lookup)).toBe(emoticonTag(image("cat")).repeat(2));
  });

  it("writes known emoji in message text as the view's markdown, escaping the rest", () => {
    const ids = new Map([["blob_cat", "x.org/blob"]]);
    expect(emoticonMarkdown("*hi* :blob_cat: :dog: <b>", (code) => ids.get(code))).toBe("\\*hi\\* <:blob_cat:x.org/blob> :dog: \\<b>");
    expect(emoticonMarkdown("no_emoji", (code) => ids.get(code))).toBe("no\\_emoji");
  });

  it("has no HTML for text without known emoji", () => {
    expect(emoticonHtml("plain :dog: text", lookup)).toBeUndefined();
    expect(emoticonHtml("", lookup)).toBeUndefined();
  });
});

describe("pack pictures in the view", () => {
  it("names pictures by their mxc address, when that is plain enough", () => {
    expect(packImageId("mxc://x.org/cat")).toBe("x.org/cat");
    expect(packImageId("mxc://x.org:8448/cat")).toBe("x.org+8448/cat");
    expect(packImageId("mxc://[::1]:8448/cat")).toBeUndefined();
    expect(packImageId(`mxc://x.org/${"a".repeat(200)}`)).toBeUndefined();
  });

  it("shows stickers by their type", () => {
    expect(stickerFormat(image("a", { info: { mimetype: "image/gif" } }))).toBe("gif");
    expect(stickerFormat(image("a", { info: { mimetype: "image/webp" } }))).toBe("webp");
    expect(stickerFormat(image("a", { info: { mimetype: "image/png" } }))).toBe("png");
    expect(stickerFormat(image("a", { info: { mimetype: "image/jpeg" } }))).toBe("png");
    expect(stickerFormat(image("a"))).toBe("png");
  });
});
