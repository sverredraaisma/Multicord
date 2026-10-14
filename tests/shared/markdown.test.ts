import { describe, expect, it } from "vitest";
import { EMOJI, EMOJI_GROUPS, emojiForShortcode, isEmojiOnlyText, searchEmoji } from "../../src/shared/emoji";
import { isJumboEmoji, parseInline, parseMarkdown } from "../../src/shared/markdown";

const text = (t: string) => ({ type: "text", text: t });

describe("emoji data", () => {
  it("maps GitHub shortcodes to emoji", () => {
    expect(emojiForShortcode("joy")).toBe("😂");
    expect(emojiForShortcode("+1")).toMatch(/^👍/);
    expect(emojiForShortcode("THUMBSUP")).toMatch(/^👍/);
    expect(emojiForShortcode("not_an_emoji")).toBeUndefined();
  });

  it("lists pickable emoji in groups without skin-tone components", () => {
    expect(EMOJI.length).toBeGreaterThan(1500);
    expect(EMOJI_GROUPS.map((g) => g.name)).not.toContain("components");
    expect(EMOJI_GROUPS[0]).toEqual({ id: 0, name: "smileys & emotion" });
    expect(EMOJI.some((e) => e.group === 2)).toBe(false);
  });

  it("searches by shortcode, name and tag, best matches first", () => {
    expect(searchEmoji("joy")[0]!.unicode).toBe("😂");
    expect(searchEmoji(":thumbsup:")[0]!.shortcodes).toContain("thumbsup");
    expect(searchEmoji("pizza").map((e) => e.unicode)).toContain("🍕");
    expect(searchEmoji("", 5)).toHaveLength(5);
    expect(searchEmoji("zzzzqqq")).toEqual([]);
    expect(searchEmoji("smil", 3)).toHaveLength(3);
  });

  it("detects emoji-only text", () => {
    expect(isEmojiOnlyText("😂👍🏽")).toBe(true);
    expect(isEmojiOnlyText(" 🇳🇱 ")).toBe(true);
    expect(isEmojiOnlyText("👨‍👩‍👧")).toBe(true);
    expect(isEmojiOnlyText("hi 😂")).toBe(false);
    expect(isEmojiOnlyText("   ")).toBe(false);
    expect(isEmojiOnlyText("123")).toBe(false);
  });
});

describe("inline markdown", () => {
  it("parses emphasis, nested", () => {
    expect(parseInline("**bold *and italic***")).toEqual([
      { type: "bold", children: [text("bold "), { type: "italic", children: [text("and italic")] }] },
    ]);
    expect(parseInline("__u__ ~~s~~ ||sp|| _it_")).toEqual([
      { type: "underline", children: [text("u")] },
      text(" "),
      { type: "strike", children: [text("s")] },
      text(" "),
      { type: "spoiler", children: [text("sp")] },
      text(" "),
      { type: "italic", children: [text("it")] },
    ]);
  });

  it("leaves snake_case, lone markers and unmatched pairs alone", () => {
    expect(parseInline("snake_case_name")).toEqual([text("snake_case_name")]);
    expect(parseInline("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
    expect(parseInline("**open")).toEqual([text("**open")]);
    expect(parseInline("a ~ b | c")).toEqual([text("a ~ b | c")]);
  });

  it("parses code without formatting inside", () => {
    expect(parseInline("run `npm **test**` now")).toEqual([text("run "), { type: "code", text: "npm **test**" }, text(" now")]);
    expect(parseInline("``a `tick` b``")).toEqual([{ type: "code", text: "a `tick` b" }]);
    expect(parseInline("` `")).toEqual([{ type: "code", text: " " }]);
  });

  it("parses links, keeping only http(s)", () => {
    expect(parseInline("see https://fluxer.app/x.")).toEqual([
      text("see "),
      { type: "link", href: "https://fluxer.app/x", children: [text("https://fluxer.app/x")] },
      text("."),
    ]);
    expect(parseInline("[the **docs**](https://docs.fluxer.app)")).toEqual([
      { type: "link", href: "https://docs.fluxer.app", children: [text("the "), { type: "bold", children: [text("docs")] }] },
    ]);
    expect(parseInline("<https://a.example/b>")).toEqual([
      { type: "link", href: "https://a.example/b", children: [text("https://a.example/b")] },
    ]);
    expect(parseInline("[x](javascript:alert(1))")).toEqual([text("[x](javascript:alert(1))")]);
    expect(parseInline("hello there")).toEqual([text("hello there")]);
  });

  it("parses emoji, custom emoji, escapes and line breaks", () => {
    expect(parseInline("hi :joy: :nope:")).toEqual([text("hi "), { type: "emoji", unicode: "😂", name: "joy" }, text(" :nope:")]);
    expect(parseInline("<:party:55><a:dance:66>")).toEqual([
      { type: "customEmoji", animated: false, name: "party", id: "55" },
      { type: "customEmoji", animated: true, name: "dance", id: "66" },
    ]);
    expect(parseInline("\\*not italic\\*")).toEqual([text("*not italic*")]);
    expect(parseInline("a\nb")).toEqual([text("a"), { type: "br" }, text("b")]);
  });

  it("stops nesting at a safe depth", () => {
    const deep = "||".repeat(20) + "x" + "||".repeat(20);
    expect(() => parseInline(deep)).not.toThrow();
  });
});

describe("block markdown", () => {
  it("parses paragraphs, headings, subtext and lists", () => {
    expect(parseMarkdown("# Title\n## Sub\n### Small\n-# fine print\nplain\nmore\n- a\n- b\n3. c\n4. d")).toEqual([
      { type: "heading", level: 1, children: [text("Title")] },
      { type: "heading", level: 2, children: [text("Sub")] },
      { type: "heading", level: 3, children: [text("Small")] },
      { type: "subtext", children: [text("fine print")] },
      { type: "paragraph", children: [text("plain"), { type: "br" }, text("more")] },
      { type: "list", ordered: false, start: 1, items: [[text("a")], [text("b")]] },
      { type: "list", ordered: true, start: 3, items: [[text("c")], [text("d")]] },
    ]);
  });

  it("parses code blocks, fenced and one-line, keeping their text raw", () => {
    expect(parseMarkdown("```ts\nconst a = **1**;\n```\nafter")).toEqual([
      { type: "codeblock", lang: "ts", text: "const a = **1**;" },
      { type: "paragraph", children: [text("after")] },
    ]);
    expect(parseMarkdown("```\nno lang\n```")).toEqual([{ type: "codeblock", lang: undefined, text: "no lang" }]);
    expect(parseMarkdown("```inline code```")).toEqual([{ type: "codeblock", text: "inline code" }]);
    expect(parseMarkdown("```\nnever closed")).toEqual([{ type: "paragraph", children: [text("```"), { type: "br" }, text("never closed")] }]);
  });

  it("parses quotes, line-wise and to the end", () => {
    expect(parseMarkdown("> one\n> **two**\n>\nafter")).toEqual([
      {
        type: "quote",
        children: [{ type: "paragraph", children: [text("one"), { type: "br" }, { type: "bold", children: [text("two")] }, { type: "br" }] }],
      },
      { type: "paragraph", children: [text("after")] },
    ]);
    expect(parseMarkdown("intro\n>>> all\nof this")).toEqual([
      { type: "paragraph", children: [text("intro")] },
      { type: "quote", children: [{ type: "paragraph", children: [text("all"), { type: "br" }, text("of this")] }] },
    ]);
    expect(parseMarkdown(">not a quote")).toEqual([{ type: "paragraph", children: [text(">not a quote")] }]);
  });

  it("normalises Windows line endings", () => {
    expect(parseMarkdown("a\r\nb")).toEqual([{ type: "paragraph", children: [text("a"), { type: "br" }, text("b")] }]);
  });

  it("recognises emoji-only messages for jumbo display", () => {
    const jumbo = (s: string) => isJumboEmoji(parseMarkdown(s), isEmojiOnlyText);
    expect(jumbo("😂😂")).toBe(true);
    expect(jumbo(":joy: <:party:55>")).toBe(true);
    expect(jumbo("hi 😂")).toBe(false);
    expect(jumbo("**😂**")).toBe(false);
    expect(jumbo("# 😂")).toBe(false);
    expect(jumbo("😂".repeat(28))).toBe(false);
    expect(jumbo("")).toBe(false);
  });
});

describe("escapeMarkdown", () => {
  it("makes plain text render literally but keeps URLs as links", async () => {
    const { escapeMarkdown, parseMarkdown } = await import("../../src/shared/markdown");
    const text = "*not bold* _x_ ~~y~~ ||z|| `c` <@1> [a](b)\n# no heading\n> no quote\n - no list\nsee https://ex.com/a_b*c#d-e";
    const escaped = escapeMarkdown(text);
    expect(escaped).toContain("https://ex.com/a_b*c#d-e");
    const flat = (nodes: unknown[]): string =>
      nodes.map((n) => {
        const node = n as { type: string; text?: string; href?: string; children?: unknown[] };
        return node.type === "text" ? node.text! : node.type === "link" ? `[link:${node.href}]` : node.children ? flat(node.children) : `[${node.type}]`;
      }).join("");
    const rendered = flat(parseMarkdown(escaped) as unknown[]);
    expect(rendered).toContain("*not bold* _x_ ~~y~~ ||z|| `c` <@1> [a](b)");
    expect(rendered).toContain("# no heading");
    expect(rendered).toContain("> no quote");
    expect(rendered).toContain("[link:https://ex.com/a_b*c#d-e]");
  });
});
