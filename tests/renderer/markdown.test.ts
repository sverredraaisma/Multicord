// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/renderer/components/markdown";

const render = (source: string, withEmoji = false) =>
  renderMarkdown(document, source, withEmoji ? { customEmojiUrl: (id, animated) => `https://media/emojis/${id}.${animated ? "gif" : "webp"}` } : {});

describe("renderMarkdown", () => {
  it("renders inline formatting as semantic elements", () => {
    const root = render("**b** *i* __u__ ~~s~~ `c`");
    expect([...root.querySelectorAll("strong, em, u, s, code")].map((e) => e.tagName)).toEqual(["STRONG", "EM", "U", "S", "CODE"]);
    expect(root.textContent).toBe("b i u s c");
  });

  it("never turns message text into markup", () => {
    const root = render('<img src=x onerror="alert(1)"> **<b>hi</b>**');
    expect(root.querySelector("img, b")).toBeNull();
    expect(root.textContent).toBe('<img src=x onerror="alert(1)"> <b>hi</b>');
  });

  it("renders links that open externally and reveal their target", () => {
    const link = render("[docs](https://docs.fluxer.app)").querySelector("a")!;
    expect(link.getAttribute("href")).toBe("https://docs.fluxer.app");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noreferrer");
    expect(link.title).toBe("https://docs.fluxer.app");
    expect(link.textContent).toBe("docs");
  });

  it("hides spoilers until clicked or activated with the keyboard", () => {
    const spoilers = render("||secret|| ||other||").querySelectorAll<HTMLElement>(".spoiler");
    expect(spoilers[0]!.classList.contains("revealed")).toBe(false);
    spoilers[0]!.click();
    expect(spoilers[0]!.classList.contains("revealed")).toBe(true);
    spoilers[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(spoilers[1]!.classList.contains("revealed")).toBe(false);
    spoilers[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(spoilers[1]!.classList.contains("revealed")).toBe(true);
  });

  it("renders emoji and custom emoji", () => {
    const root = render("hi :joy: <:party:55> <a:dance:66>", true);
    const emoji = root.querySelector<HTMLElement>("span.emoji")!;
    expect(emoji.textContent).toBe("😂");
    expect(emoji.title).toBe(":joy:");
    const custom = root.querySelectorAll<HTMLImageElement>("img.emoji.custom");
    expect([...custom].map((i) => i.getAttribute("src"))).toEqual(["https://media/emojis/55.webp", "https://media/emojis/66.gif"]);
    expect(custom[0]!.alt).toBe(":party:");
    expect(render("<:party:55>").textContent).toBe(":party:");
  });

  it("renders blocks", () => {
    const root = render("# Title\n-# small\n> quoted\n```js\nlet x;\n```\n- a\n- b\n2. c\n1. d");
    expect(root.querySelector("h1")!.textContent).toBe("Title");
    expect(root.querySelector("small")!.textContent).toBe("small");
    expect(root.querySelector("blockquote")!.textContent).toBe("quoted");
    expect(root.querySelector("pre code")!.textContent).toBe("let x;");
    expect(root.querySelector<HTMLElement>("pre code")!.dataset.lang).toBe("js");
    expect(root.querySelectorAll("ul li")).toHaveLength(2);
    expect(root.querySelector("ol")!.getAttribute("start")).toBe("2");
    expect(render("1. one").querySelector("ol")!.hasAttribute("start")).toBe(false);
    expect(render("```\nplain\n```").querySelector("pre code")!.hasAttribute("data-lang")).toBe(false);
    expect(render("a\nb").querySelector("br")).not.toBeNull();
  });

  it("marks emoji-only messages as jumbo", () => {
    expect(render("😂🎉").classList.contains("jumbo")).toBe(true);
    expect(render("hi 😂").classList.contains("jumbo")).toBe(false);
  });
});
