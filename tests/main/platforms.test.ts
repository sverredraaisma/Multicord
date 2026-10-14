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
        module: "web",
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
    expect(parsePlatforms({})).toEqual({ platforms: [], disabled: [], errors: ["platforms.json must contain an array"] });
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

describe("platform modules", () => {
  it("accepts self-hosted Fluxer instances and rejects unknown modules and built-in ids", () => {
    const { platforms, errors } = parsePlatforms([
      { id: "my-fluxer", name: "My Fluxer", url: "https://chat.example.org", kind: "fluxer" },
      { id: "el", name: "Element", url: "https://app.element.io", module: "web" },
      { id: "x", name: "X", url: "https://x.example", kind: "matrix" },
      { id: "fluxer", name: "Clash", url: "https://y.example" },
    ]);
    expect(platforms.map((p) => [p.id, p.module, p.partition])).toEqual([
      ["my-fluxer", "fluxer", "persist:my-fluxer"],
      ["el", "web", "persist:el"],
    ]);
    expect(errors).toEqual(['entry 2: module must be one of "web", "fluxer"', 'entry 3: duplicate id "fluxer"']);
  });
});

describe("turning built-in platforms off", () => {
  it("removes disabled built-ins and keeps the rest", () => {
    const json = JSON.stringify([{ id: "fluxer", enabled: false }, { id: "el", name: "Element", url: "https://app.element.io" }]);
    expect(loadPlatforms(() => json).platforms.map((p) => p.id)).toEqual(["discord", "el"]);
    expect(parsePlatforms([{ id: "discord", enabled: false }]).disabled).toEqual(["discord"]);
  });

  it("refuses to turn everything off", () => {
    const json = JSON.stringify([{ id: "fluxer", enabled: false }, { id: "discord", enabled: false }]);
    const { platforms, errors } = loadPlatforms(() => json);
    expect(platforms.map((p) => p.id)).toEqual(["discord", "fluxer"]);
    expect(errors).toEqual(["at least one platform must stay enabled"]);
  });

  it("treats enabled: true on a built-in id as a duplicate", () => {
    expect(parsePlatforms([{ id: "fluxer", enabled: true }]).errors).toEqual(['entry 0: duplicate id "fluxer"']);
  });
});

describe("module selection", () => {
  it("only allows the modules the shell offers, accepting the old kind field", () => {
    const { platforms, errors } = parsePlatforms(
      [
        { id: "a", name: "A", url: "https://a.example", module: "matrix" },
        { id: "b", name: "B", url: "https://b.example", kind: "fluxer" },
        { id: "c", name: "C", url: "https://c.example", module: 5 },
      ],
      ["web", "matrix"],
    );
    expect(platforms.map((p) => [p.id, p.module])).toEqual([["a", "matrix"]]);
    expect(errors).toEqual(['entry 1: module must be one of "web", "matrix"', 'entry 2: module must be one of "web", "matrix"']);
    expect(loadPlatforms(() => JSON.stringify([{ id: "a", name: "A", url: "https://a.example", module: "matrix" }]), ["matrix"]).platforms.at(-1)!.module).toBe("matrix");
  });
});
