import { describe, expect, it } from "vitest";
import { decodeEntities, markdownHtml, MAX_ELEMENTS, MAX_NESTING, MAX_RICH_TEXT, parseHtml, richMarkdown } from "../../../src/modules/matrix/format";
import { escapeHtml } from "../../../src/modules/matrix/packs";
import { escapeMarkdown } from "../../../src/shared/markdown";

const md = (html: string) => richMarkdown(parseHtml(html)!, escapeMarkdown);

describe("reading formatted_body", () => {
  it("decodes character references, keeping unknown ones and refusing code points that are no text", () => {
    const expected = `&<>"'${String.fromCharCode(0xa0)}ABC&bogus;${String.fromCharCode(0xfffd).repeat(3)}`;
    expect(decodeEntities("&amp;&LT;&gt;&quot;&apos;&nbsp;&#65;&#x42;&#X43;&bogus;&#0;&#xD800;&#x110000;")).toBe(expected);
  });

  it("has nothing for HTML that plain text shows as well", () => {
    expect(parseHtml("hello<br>world &amp; more")).toBeUndefined();
    expect(parseHtml("<p>one</p>\n<p>two <span>three</span></p>")).toBeUndefined();
    expect(parseHtml('hi <img data-mx-emoticon src="mxc://x.org/cat" alt=":cat:">')).toBeUndefined();
    expect(parseHtml("")).toBeUndefined();
  });

  it("reads inline formatting, collapsing white space as HTML does", () => {
    expect(
      parseHtml(
        "<b>b</b><strong>s</strong><i>i</i><em>e</em><cite>c</cite><u>u</u><ins>n</ins><del>d</del><s>x</s><strike>k</strike> <code> a \n b </code><code> </code>" +
          "<span data-mx-spoiler>sp</span><span data-mx-spoiler='reason'>r</span><font color=red>f</font><sup>up</sup>",
      ),
    ).toEqual([
      ...["b", "s", "i", "e", "c", "u", "n", "d", "x", "k"].map((text, i) => ({ t: ["b", "b", "i", "i", "i", "u", "u", "s", "s", "s"][i], c: [{ t: "text", text }] })),
      { t: "text", text: " " },
      { t: "code", text: "a b" },
      { t: "spoiler", c: [{ t: "text", text: "sp" }] },
      { t: "spoiler", c: [{ t: "text", text: "r" }] },
      { t: "text", text: "f" },
      { t: "text", text: "up" },
    ]);
    expect(parseHtml("<b>a\n\t  b</b>")).toEqual([{ t: "b", c: [{ t: "text", text: "a b" }] }]);
  });

  it("keeps https links only, never one inside another", () => {
    expect(
      parseHtml(
        '<a href="https://x.org/a">A</a><a href=\'http://x.org\'>B</a><a href="javascript:alert(1)">C</a><a>D</a>' +
          `<a href="https://x.org/${"a".repeat(2000)}">E</a><a href="https://x.org/a b">F</a>` +
          '<a href=" https://x.org/out "><a href="https://x.org/in">G</a></a>',
      ),
    ).toEqual([
      { t: "a", href: "https://x.org/a", c: [{ t: "text", text: "A" }] },
      ...["B", "C", "D", "E", "F"].map((text) => ({ t: "text", text })),
      { t: "a", href: "https://x.org/out", c: [{ t: "text", text: "G" }] },
    ]);
  });

  it("drops the reply fallback, scripts, styles, comments and pictures other than custom emoji", () => {
    expect(
      parseHtml(
        '<mx-reply><blockquote>old <b>stuff</b></blockquote></mx-reply><script>alert(1)</script><style>b{}</style><!-- note --><b>new</b>' +
          '<img src="mxc://x.org/p" alt="photo"><img data-mx-emoticon src="mxc://x.org/cat" title=":cat:"><img data-mx-emoticon alt="no colons"><img data-mx-emoticon>',
      ),
    ).toEqual([
      { t: "b", c: [{ t: "text", text: "new" }] },
      { t: "emote", shortcode: "cat" },
    ]);
    // An unclosed comment hides the rest; a lone "<" is text.
    expect(parseHtml("<b>a < b</b><!-- open <b>c</b>")).toEqual([{ t: "b", c: [{ t: "text", text: "a < b" }] }]);
  });

  it("closes what a closing tag names and ignores closing tags with nothing open", () => {
    expect(parseHtml("<b><i>x</b>y</i></u>z")).toEqual([{ t: "b", c: [{ t: "i", c: [{ t: "text", text: "x" }] }] }, { t: "text", text: "yz" }]);
  });

  it("reads blocks: paragraphs, headings, code blocks, quotes and lists", () => {
    expect(
      parseHtml(
        "<h1>One</h1><h5>Five</h5><pre><code class=\"lang-x language-js\">let a;\n  b\n</code></pre><pre>plain</pre><pre></pre><blockquote>q</blockquote>" +
          '<ul><li>a</li>skipped<li>b</li></ul><ol start="3"><li>c</li></ol><ol start="x"><li>d</li></ol><ul start="5"><li>e</li></ul><li>loose</li><table><tr><td>cell</td></tr></table><hr>',
      ),
    ).toEqual([
      { t: "h", level: 1, c: [{ t: "text", text: "One" }] },
      { t: "h", level: 3, c: [{ t: "text", text: "Five" }] },
      { t: "pre", lang: "js", text: "let a;\n  b" },
      { t: "pre", text: "plain" },
      { t: "quote", c: [{ t: "text", text: "q" }] },
      { t: "list", ordered: false, start: 1, items: [[{ t: "text", text: "a" }], [{ t: "text", text: "b" }]] },
      { t: "list", ordered: true, start: 3, items: [[{ t: "text", text: "c" }]] },
      { t: "list", ordered: true, start: 1, items: [[{ t: "text", text: "d" }]] },
      { t: "list", ordered: false, start: 1, items: [[{ t: "text", text: "e" }]] },
      { t: "p", c: [{ t: "text", text: "loose" }] },
      { t: "p", c: [{ t: "p", c: [{ t: "text", text: "cell" }] }] },
    ]);
  });

  it("reads within limits: text, elements and nesting", () => {
    const long = parseHtml(`<b>${"a".repeat(MAX_RICH_TEXT + 10)}</b>more<code>c</code><pre>p</pre>`)!;
    expect(long).toEqual([{ t: "b", c: [{ t: "text", text: `${"a".repeat(MAX_RICH_TEXT)}…` }] }]);
    const many = parseHtml("<b>x</b>".repeat(MAX_ELEMENTS + 5) + "<i>late</i> tail")!;
    expect(many).toHaveLength(MAX_ELEMENTS);
    const deep = parseHtml(`${"<b>".repeat(MAX_NESTING + 3)}x${"</b>".repeat(MAX_NESTING + 3)}`)!;
    let depth = 0;
    for (let node = deep[0]; node && node.t === "b"; node = node.c[0]) depth++;
    expect(depth).toBe(MAX_NESTING + 1);
  });
});

describe("formatting as the view's markdown", () => {
  it("writes inline formatting, keeping white space outside the markers", () => {
    expect(md("<b>bold </b><i> it</i> <u>u</u> <del>s</del> <span data-mx-spoiler>sp</span> <b> </b>")).toBe("**bold**  *it* __u__ ~~s~~ ||sp||");
    expect(md("<code>a`b</code> <code>`x</code>")).toBe("``a`b`` `` `x ``");
  });

  it("tries the other italic marker where the first is read otherwise, then gives up", () => {
    expect(md("<b>a</b><i>b</i>")).toBe("**a**_b_");
    expect(md("<i>a</i><i>b</i>")).toBeUndefined();
  });

  it("escapes text, keeping web addresses whole, and names custom emoji through the escape", () => {
    expect(md("<b>*not*</b> see https://x.org/a)b, # no")).toBe("**\\*not\\*** see <https://x.org/a%29b>, # no");
    const nodes = parseHtml('<b>hi</b> <img data-mx-emoticon src="mxc://x.org/cat" alt=":cat:">')!;
    expect(richMarkdown(nodes, (text) => text.replace(":cat:", "<:cat:x.org/cat>"))).toBe("**hi** <:cat:x.org/cat>");
  });

  it("writes links by their label, or as the address where the label cannot be one", () => {
    expect(md('<a href="https://x.org/(a)">site</a> <a href="https://x.org">https://x.org</a> <a href="https://x.org/e"> </a>')).toBe(
      "[site](<https://x.org/(a%29>) <https://x.org> <https://x.org/e>",
    );
    expect(md('<a href="https://x.org">a [b]</a>')).toBe("a \\[b\\] (<https://x.org>)");
    expect(md(`<a href="https://x.org">${"w ".repeat(140)}</a>`)).toBe(`${"w ".repeat(140)} (<https://x.org>)`);
    expect(md('<a href="https://x.org"><b>bold</b> link</a>')).toBe("[**bold** link](<https://x.org>)");
  });

  it("writes paragraphs, headings, code blocks, quotes and lists", () => {
    expect(md("<p>one<br>two</p><p><b>three</b></p><h2>Head<br>ing</h2><h1> </h1><pre><code class=\"language-ts\">a\nb</code></pre>")).toBe(
      "one\ntwo\n\n**three**\n\n## Head ing\n```ts\na\nb\n```",
    );
    expect(md("<blockquote><p>q1</p><p><i>q2</i></p><blockquote>inner</blockquote></blockquote>after")).toBe("> q1\n>\n> *q2*\n>\n> inner\nafter");
    expect(md('<ol start="3"><li><b>c</b></li><li> </li><li>d<br>e</li></ol><ul><li><p>p</p><pre>   </pre><pre> x </pre><ul><li>n</li></ul></li></ul>')).toBe(
      "3. **c**\n4. d e\n- p  `x` n",
    );
    expect(md("<b><p>in</p>bold</b>")).toBe("**in bold**");
  });

  it("has nothing to show for formatting without text", () => {
    expect(md("<b> </b>")).toBeUndefined();
    expect(md("<b>x</b><ul><li> </li></ul>")).toBe("**x**");
  });

  it("keeps line breaks in code and quotes, and emoji shortcodes as written", () => {
    expect(md("<pre>a<br>b<script>x</script></pre><blockquote>c<br><br>d</blockquote><b>hi</b> :smile:")).toBe("```\na\nb\n```\n> c\n>\n> d\n**hi** :smile:");
  });
});

describe("the composer's markdown as formatted_body", () => {
  const html = (text: string) => markdownHtml(text, (run) => escapeHtml(run).replace(":cat:", "<img cat>").replace("@bo:x.org", "<a pill>"));

  it("leaves plain text alone", () => {
    expect(html("hello\nthere & <you>")).toBeUndefined();
    expect(html("see https://x.org/a")).toBeUndefined();
  });

  it("writes inline formatting, escaping text", () => {
    expect(html("**b** *i* __u__ ~~s~~ ||sp|| `a<b` <3")).toBe("<strong>b</strong> <em>i</em> <u>u</u> <del>s</del> <span data-mx-spoiler>sp</span> <code>a&#60;b</code> &lt;3");
    expect(html("[site *x*](https://x.org/?a=1&b=\"2\") :cat:")).toBe('<a href="https://x.org/?a=1&#38;b=&#34;2&#34;">site <em>x</em></a> <img cat>');
  });

  it("runs text through the hook, but not in links and code", () => {
    expect(html("hi @bo:x.org `@bo:x.org` [@bo:x.org :smile: <:cat:x.org/cat>](https://x.org)")).toBe(
      'hi <a pill> <code>@bo:x.org</code> <a href="https://x.org">@bo:x.org 😄 :cat:</a>',
    );
  });

  it("writes emoji shortcodes as emoji, unless a custom emoji has the name", () => {
    expect(markdownHtml(":smile: :cat:", (run) => escapeHtml(run).replace(":smile:", "<img smile>"))).toBe("<img smile> 🐱");
    expect(html(":smile: <:cat:x.org/cat>")).toBe("😄 <img cat>");
  });

  it("writes blocks", () => {
    expect(html("# One\n-# small\n> quoted\n```ts\nlet a = 1 < 2;\n```\n```bad\"\nx\n```\n```\ny\n```\n- a\n- b\n3. c\n4. d\n1. e")).toBe(
      '<h1>One</h1><sub>small</sub><blockquote>quoted</blockquote><pre><code class="language-ts">let a = 1 &#60; 2;</code></pre><pre><code>x</code></pre><pre><code>y</code></pre>' +
        '<ul><li>a</li><li>b</li></ul><ol start="3"><li>c</li><li>d</li><li>e</li></ol>',
    );
  });
});
