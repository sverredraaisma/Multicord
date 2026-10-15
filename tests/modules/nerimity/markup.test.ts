import { describe, expect, it } from "vitest";
import { emojiMarkup, toMarkdown, toPlainLine, type MarkupNames } from "../../../src/modules/nerimity/markup";

const names: MarkupNames = {
  user: (id) => (id === "2" ? "ana" : undefined),
  channel: (id) => (id === "111" ? "general" : undefined),
  role: (id) => (id === "120" ? "Admins" : undefined),
  quote: (id) => (id === "3" ? "first\nsecond" : undefined),
};

describe("Nevula to the view's markdown", () => {
  it("resolves mentions of users, everyone, channels and roles, leaving unknown ones", () => {
    expect(toMarkdown("hi [@:2], [@:e] and [@:s]: see [#:111] ([r:120])", names)).toBe("hi @ana, @everyone and @someone: see #general (@Admins)");
    expect(toMarkdown("[@:9] [#:9] [r:9]", names)).toBe("[@:9] [#:9] [r:9]");
  });

  it("turns custom emoji into the view's form, by kind", () => {
    expect(toMarkdown("[ce:130:party] [wace:131:dance] [ace:132:old] [ce:bad]", names)).toBe("<:party:130> <:dance:131> <a:old:132> [ce:bad]");
    expect(emojiMarkup({ id: "130", name: "party", gif: false, webp: true })).toBe("[ce:130:party]");
    expect(emojiMarkup({ id: "131", name: "dance", gif: true, webp: true })).toBe("[wace:131:dance]");
    expect(emojiMarkup({ id: "132", name: "old", gif: true, webp: false })).toBe("[ace:132:old]");
  });

  it("converts //italic//, links and quotes, and drops colour tags", () => {
    expect(toMarkdown("so //very// nice, see https://x.org//path", names)).toBe("so *very* nice, see https://x.org//path");
    expect(toMarkdown("[#ff0000]red[#reset] [#abc]x", names)).toBe("red x");
    expect(toMarkdown("[link: https://x.org -> X] [link: javascript:alert(1) -> no] [link: https://x.org]", names)).toBe("[X](https://x.org) [link: javascript:alert(1) -> no] [link: https://x.org]");
    expect(toMarkdown("look[q:3]", names)).toBe("look\n> first\n> second\n");
    expect(toMarkdown("gone[q:4]", names)).toBe("gone");
  });

  it("leaves code as it is", () => {
    expect(toMarkdown("`[@:2]` and ```\n//x// [ce:1:a]\n``` but [@:2]", names)).toBe("`[@:2]` and ```\n//x// [ce:1:a]\n``` but @ana");
  });

  it("makes one plain line for previews", () => {
    expect(toPlainLine("a <:party:130>\n\nb <a:old:1>")).toBe("a :party: b :old:");
  });
});
