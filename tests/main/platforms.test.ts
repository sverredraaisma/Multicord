import { describe, expect, it } from "vitest";
import { DISCORD, FLUXER, loadPlatforms, parsePlatforms } from "../../src/main/platforms";

describe("parsePlatforms", () => {
  it("accepts valid web platforms with their own partition", () => {
    const { platforms, errors } = parsePlatforms([
      { id: "element", name: " Element ", url: "https://app.element.io", iconUrl: "https://example.com/e.png" },
    ]);
    expect(errors).toEqual([]);
    expect(platforms).toEqual([
      {
        id: "element",
        name: "Element",
        url: "https://app.element.io",
        partition: "persist:element",
        kind: "web",
        iconUrl: "https://example.com/e.png",
      },
    ]);
  });

  it("reports each invalid entry and keeps the rest", () => {
    const { platforms, errors } = parsePlatforms([
      null,
      { id: "Bad Id", name: "x", url: "https://x" },
      { id: "discord", name: "x", url: "https://x" },
      { id: "a", name: "", url: "https://x" },
      { id: "b", name: "B", url: "http://insecure" },
      { id: "c", name: "C", url: "https://c", iconUrl: "file:///etc/passwd" },
      { id: "d", name: "D", url: "https://d" },
      { id: "d", name: "D again", url: "https://d" },
    ]);
    expect(platforms.map((p) => p.id)).toEqual(["d"]);
    expect(errors).toEqual([
      "entry 0: id must be lowercase letters, digits or dashes",
      "entry 1: id must be lowercase letters, digits or dashes",
      'entry 2: duplicate id "discord"',
      "entry 3: name is required",
      "entry 4: url must be an https URL",
      "entry 5: iconUrl must be an https URL",
      'entry 7: duplicate id "d"',
    ]);
  });

  it("rejects a non-array file", () => {
    expect(parsePlatforms({})).toEqual({ platforms: [], errors: ["platforms.json must contain an array"] });
  });
});

describe("loadPlatforms", () => {
  it("returns only Discord when there is no file", () => {
    expect(loadPlatforms(() => undefined)).toEqual({ platforms: [DISCORD, FLUXER], errors: [] });
  });

  it("puts Discord first", () => {
    const { platforms } = loadPlatforms(() => JSON.stringify([{ id: "stoat", name: "Stoat", url: "https://stoat.example" }]));
    expect(platforms.map((p) => p.id)).toEqual(["discord", "fluxer", "stoat"]);
  });

  it("reports invalid JSON", () => {
    const { platforms, errors } = loadPlatforms(() => "{oops");
    expect(platforms).toEqual([DISCORD, FLUXER]);
    expect(errors[0]).toMatch(/^platforms.json is not valid JSON/);
  });
});

describe("native platform kinds", () => {
  it("accepts self-hosted Fluxer instances and rejects unknown kinds and built-in ids", () => {
    const { platforms, errors } = parsePlatforms([
      { id: "my-fluxer", name: "My Fluxer", url: "https://chat.example.org", kind: "fluxer" },
      { id: "el", name: "Element", url: "https://app.element.io", kind: "web" },
      { id: "x", name: "X", url: "https://x.example", kind: "matrix" },
      { id: "fluxer", name: "Clash", url: "https://y.example" },
    ]);
    expect(platforms.map((p) => [p.id, p.kind, p.partition])).toEqual([
      ["my-fluxer", "fluxer", "persist:my-fluxer"],
      ["el", "web", "persist:el"],
    ]);
    expect(errors).toEqual(['entry 2: kind must be "web" or "fluxer"', 'entry 3: duplicate id "fluxer"']);
  });
});
