import { describe, expect, it } from "vitest";
import type { TgEntity } from "../../../src/modules/telegram/api";
import { escapeText, fromMarkdown, MAX_ENTITIES, toMarkdown } from "../../../src/modules/telegram/format";
import { escapeMarkdown } from "../../../src/shared/markdown";

const e = (type: TgEntity["type"], offset: number, length: number, extra: Partial<TgEntity> = {}): TgEntity => ({ type, offset, length, ...extra });

/** Markdown back to what Telegram would get, for round trips. */
const back = (markdown: string) => fromMarkdown(markdown);

describe("toMarkdown", () => {
  it("escapes plain text so markdown characters stay literal", () => {
    expect(toMarkdown("2*3*4 and snake_case_name")).toBe("2\\*3\\*4 and snake\\_case\\_name");
    expect(toMarkdown("a ~b~ |c| `d` <e> [f] \\g")).toBe("a \\~b\\~ \\|c\\| \\`d\\` \\<e> \\[f\\] \\\\g");
    expect(back(toMarkdown("2*3*4 and snake_case_name"))).toEqual({ text: "2*3*4 and snake_case_name", entities: [] });
  });

  it("keeps lines that look like headings, quotes, lists and code fences literal", () => {
    const text = "# not a heading\n> not a quote\n- not a list\n1. not ordered\n-# not small\n```\nnot code\n```\n:smile: stays";
    const markdown = toMarkdown(text);
    expect(back(markdown)).toEqual({ text, entities: [] });
    expect(markdown).toContain("1\\. not ordered");
    expect(markdown).toContain("\\:smile: stays");
  });

  it("leaves links open, and closes them off where something follows", () => {
    expect(toMarkdown("see https://example.org/a_b now")).toBe("see https://example.org/a_b now");
    expect(toMarkdown("https://example.org/a_b")).toBe("https://example.org/a_b");
    expect(toMarkdown("(https://example.org/x)")).toBe("(<https://example.org/x>)");
    // The parser takes the star into the link, as written.
    expect(toMarkdown("https://example.org/x*")).toBe("https://example.org/x*");
    expect(toMarkdown("https://example.org/x*", [e("bold", 0, 22)])).toBe("**<https://example.org/x*>**");
    expect(back(toMarkdown("https://example.org/x*")).text).toBe("https://example.org/x*");
  });

  it("marks bold, italic, underline, strikethrough, spoilers and code", () => {
    const text = "bold italic under strike secret code";
    const entities = [e("bold", 0, 4), e("italic", 5, 6), e("underline", 12, 5), e("strike", 18, 6), e("spoiler", 25, 6), e("code", 32, 4)];
    const markdown = toMarkdown(text, entities);
    expect(markdown).toBe("**bold** *italic* __under__ ~~strike~~ ||secret|| `code`");
    expect(back(markdown)).toEqual({ text, entities });
  });

  it("nests styles, and splits those that overlap", () => {
    expect(toMarkdown("both", [e("bold", 0, 4), e("italic", 0, 4)])).toBe("***both***");
    expect(toMarkdown("a b c", [e("italic", 0, 5), e("bold", 2, 1)])).toBe("*a* ***b*** *c*");
    // Overlapping bold and italic within a word read wrong with either marker: the text shows plain.
    expect(toMarkdown("abcd", [e("bold", 0, 3), e("italic", 1, 3)])).toBe("abcd");
    expect(back(toMarkdown("abcd", [e("bold", 0, 3), e("italic", 1, 3)])).text).toBe("abcd");
  });

  it("tries the other italic marker when the first would be misread", () => {
    // "*a****b***" reads as italic "a**": underscores work.
    expect(toMarkdown("ab", [e("italic", 0, 2), e("bold", 1, 1)])).toBe("_a_**_b_**");
  });

  it("shows text unstyled when no markers would read right", () => {
    // Italic inside a word, pressed against bold, reads wrong either way.
    const text = "xab";
    const markdown = toMarkdown(text, [e("italic", 1, 2), e("bold", 2, 1)]);
    expect(back(markdown).text).toBe(text);
  });

  it("moves white space out of styles", () => {
    expect(toMarkdown("a  bold  b", [e("bold", 1, 8)])).toBe("a  **bold**  b");
    expect(toMarkdown("   ", [e("bold", 0, 3)])).toBe("   ");
  });

  it("escapes inside styles, and keeps code literal with a fence longer than its backticks", () => {
    expect(toMarkdown("a*b", [e("bold", 0, 3)])).toBe("**a\\*b**");
    expect(toMarkdown("x `y` z", [e("code", 0, 7)])).toBe("``x `y` z``");
    expect(toMarkdown("`y`", [e("code", 0, 3)])).toBe("`` `y` ``");
    expect(back("`` `y` ``")).toEqual({ text: "`y`", entities: [e("code", 0, 3)] });
    expect(toMarkdown("**", [e("code", 0, 2)])).toBe("`**`");
  });

  it("links text to web addresses, encoding what would end the link", () => {
    const text = "click here please";
    expect(toMarkdown(text, [e("textUrl", 6, 4, { url: "https://example.org/a b)" })])).toBe("click [here](<https://example.org/a%20b%29>) please");
    expect(back("[**here**](<https://x.org>)")).toEqual({ text: "here", entities: [e("bold", 0, 4), e("textUrl", 0, 4, { url: "https://x.org" })] });
    // Not web links, a label that is its own address, labels the parser cannot take: plain text.
    expect(toMarkdown(text, [e("textUrl", 6, 4, { url: "tg://user?id=1" })])).toBe(text);
    expect(toMarkdown(text, [e("textUrl", 6, 4)])).toBe(text);
    expect(toMarkdown("https://x.org", [e("textUrl", 0, 13, { url: "https://x.org" })])).toBe("https://x.org");
    expect(toMarkdown("a]b", [e("textUrl", 0, 3, { url: "https://x.org" })])).toBe("a\\]b");
    expect(toMarkdown("x".repeat(121), [e("textUrl", 0, 121, { url: "https://x.org" })])).toBe("x".repeat(121));
  });

  it("puts code blocks on lines of their own, with their language", () => {
    const text = "look:\nconst a = 1;\nnext";
    const markdown = toMarkdown(text, [e("pre", 6, 13, { language: "js" })]);
    expect(markdown).toBe("look:\n```js\nconst a = 1;\n```\nnext");
    expect(back(markdown)).toEqual({ text, entities: [e("pre", 6, 12, { language: "js" })] });
    expect(toMarkdown("x", [e("pre", 0, 1, { language: "bad lang" })])).toBe("```\nx\n```");
    expect(toMarkdown("a\nb", [e("pre", 0, 1), e("pre", 2, 1)])).toBe("```\na\n```\n```\nb\n```");
  });

  it("leaves the line breaks around a code block out of it, and styles out of other lines", () => {
    expect(toMarkdown("a\nb\nc", [e("pre", 1, 3), e("bold", 0, 1)])).toBe("**a**\n```\nb\n```\nc");
    expect(toMarkdown("a\nb", [e("blockquote", 2, 1), e("italic", 0, 1)])).toBe("*a*\n> b");
  });

  it("shows code that shares its line with other text as inline code", () => {
    expect(toMarkdown("run ls now", [e("pre", 4, 2)])).toBe("run `ls` now");
  });

  it("falls back where a code block would end early", () => {
    const text = "a\n```\nb";
    expect(back(toMarkdown(text, [e("pre", 0, text.length)])).text).toBe(text);
  });

  it("quotes whole lines, and ignores quotes that do not cover them", () => {
    const text = "said:\nfirst\n\nsecond\nme";
    const markdown = toMarkdown(text, [e("blockquote", 6, 14)]);
    expect(markdown).toBe("said:\n> first\n>\n> second\nme");
    expect(back(markdown)).toEqual({ text, entities: [e("blockquote", 6, 13)] });
    expect(toMarkdown("a quote", [e("blockquote", 2, 5)])).toBe("a quote");
  });

  it("quotes code blocks and styles across lines", () => {
    const text = "x\ny\nz";
    expect(toMarkdown(text, [e("blockquote", 0, 5), e("pre", 2, 1), e("bold", 0, 5)])).toBe("> **x**\n> ```\n> y\n> ```\n> **z**");
    expect(toMarkdown("a\nb", [e("bold", 0, 3)])).toBe("**a\nb**");
    expect(toMarkdown("a\nb", [e("bold", 0, 3), e("blockquote", 2, 1)])).toBe("**a**\n> **b**");
  });

  it("ignores entities that do not fit the text, and more than MAX_ENTITIES", () => {
    const text = "abc";
    for (const bad of [e("bold", -1, 2), e("bold", 2, 5), e("bold", 1, 0), e("bold", 0.5, 1)]) expect(toMarkdown(text, [bad])).toBe(text);
    const many = Array.from({ length: MAX_ENTITIES + 1 }, (_, i) => e("bold", i, 1));
    const long = "x".repeat(MAX_ENTITIES + 1);
    expect(toMarkdown(long, many).endsWith("**x")).toBe(true);
  });

  it("counts in UTF-16 units, as Telegram does", () => {
    const text = "😀 hi";
    expect(toMarkdown(text, [e("bold", 3, 2)])).toBe("😀 **hi**");
    expect(back("😀 **hi**")).toEqual({ text, entities: [e("bold", 3, 2)] });
  });

  it("falls back to the shared escaping for what nothing else shows right", () => {
    // A link with ">" in it and something after: the parser reads it with the escapes in.
    const text = "https://x.org/a_>b)";
    expect(toMarkdown(text)).toBe(escapeMarkdown(text));
  });
});

describe("fromMarkdown", () => {
  it("sends plain text as it is, and drops escapes", () => {
    expect(fromMarkdown("hello")).toEqual({ text: "hello", entities: [] });
    expect(fromMarkdown("a\\*b\\_c")).toEqual({ text: "a*b_c", entities: [] });
    expect(fromMarkdown("")).toEqual({ text: "", entities: [] });
  });

  it("turns markers into entities, nested and sorted", () => {
    expect(fromMarkdown("**a _b_** __u__ ~~s~~ ||p|| `c`")).toEqual({
      text: "a b u s p c",
      entities: [e("bold", 0, 3), e("italic", 2, 1), e("underline", 4, 1), e("strike", 6, 1), e("spoiler", 8, 1), e("code", 10, 1)],
    });
  });

  it("leaves bare links for Telegram to find, and sends labelled ones as text links", () => {
    expect(fromMarkdown("go https://x.org")).toEqual({ text: "go https://x.org", entities: [] });
    expect(fromMarkdown("go <https://x.org>")).toEqual({ text: "go https://x.org", entities: [] });
    expect(fromMarkdown("[x](https://x.org)")).toEqual({ text: "x", entities: [e("textUrl", 0, 1, { url: "https://x.org" })] });
  });

  it("sends code blocks with their language, and quotes", () => {
    expect(fromMarkdown("```py\nprint(1)\n```")).toEqual({ text: "print(1)", entities: [e("pre", 0, 8, { language: "py" })] });
    expect(fromMarkdown("```\nx\n```")).toEqual({ text: "x", entities: [e("pre", 0, 1, { language: "" })] });
    expect(fromMarkdown("> a\n> b\nc")).toEqual({ text: "a\nb\nc", entities: [e("blockquote", 0, 3)] });
    // An empty quote marks nothing.
    expect(fromMarkdown(">\nx")).toEqual({ text: "\nx", entities: [] });
  });

  it("keeps headings, small text and lists as the text that was typed", () => {
    expect(fromMarkdown("# Title\n-# small\n- a\n- **b**\n3. c\n4. d")).toEqual({
      text: "# Title\n-# small\n- a\n- b\n3. c\n4. d",
      entities: [e("bold", 23, 1)],
    });
  });

  it("sends emoji shortcodes as emoji, and custom emoji by name", () => {
    expect(fromMarkdown(":smile: <:party:123>").text).toBe("😄 :party:");
  });
});

describe("escapeText", () => {
  it("closes off a link at the end when more follows the text", () => {
    expect(escapeText("https://x.org", false)).toBe("<https://x.org>");
    expect(escapeText("https://x.org")).toBe("https://x.org");
    expect(escapeText("https://x.org/>", false)).toBe("https://x.org/>");
  });
});
