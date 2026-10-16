import { describe, expect, it } from "vitest";
import { DISCORD, FLUXER, loadPlatforms, parsePlatforms, TELEGRAM, type ModuleRule } from "../../src/core/platforms";

const user = (raw: unknown, modules?: readonly ModuleRule[]) => {
  const { entries, errors } = parsePlatforms(raw, modules);
  return { platforms: entries.filter((e) => !e.builtIn).map((e) => e.def), entries, errors };
};

describe("parsePlatforms", () => {
  it("accepts valid web platforms with their own partition", () => {
    const { platforms, errors } = user([
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
    const { platforms, errors } = user([
      null,
      { id: "Bad Id", name: "x", url: "https://x" },
      { id: "a", name: "", url: "https://x" },
      { id: "b", name: "B", url: "http://insecure" },
      { id: "c", name: "C", url: "https://c", iconUrl: "file:///etc/passwd" },
      { id: "d", name: "D", url: "https://d" },
      { id: "d", name: "D again", url: "https://d" },
      { id: "e", name: "E" },
    ]);
    expect(platforms.map((p) => p.id)).toEqual(["d"]);
    expect(errors).toEqual([
      "entry 0: id must be lowercase letters, digits or dashes",
      "entry 1: id must be lowercase letters, digits or dashes",
      "entry 2: name is required",
      "entry 3: url must be an https URL",
      "entry 4: iconUrl must be an https URL",
      'entry 6: duplicate id "d"',
      "entry 7: url must be an https URL",
    ]);
  });

  it("rejects a non-array file but keeps the built-ins", () => {
    const { entries, errors } = parsePlatforms({});
    expect(entries.map((e) => [e.def.id, e.enabled, e.builtIn])).toEqual([
      ["discord", true, true],
      ["fluxer", true, true],
      ["telegram", true, true],
    ]);
    expect(errors).toEqual(["platforms.json must contain an array"]);
  });

  it("keeps turned-off user platforms, marked as such", () => {
    const { entries } = user([{ id: "el", name: "Element", url: "https://app.element.io", enabled: false }]);
    expect(entries.at(-1)).toMatchObject({ enabled: false, builtIn: false, def: { id: "el" } });
  });
});

describe("loadPlatforms", () => {
  it("returns the built-ins when there is no file", () => {
    const { platforms, all, errors } = loadPlatforms(() => undefined);
    expect(platforms).toEqual([DISCORD, FLUXER, TELEGRAM]);
    expect(all.map((p) => p.builtIn)).toEqual([true, true, true]);
    expect(errors).toEqual([]);
  });

  it("puts the built-ins first and leaves out turned-off platforms", () => {
    const { platforms, all } = loadPlatforms(() =>
      JSON.stringify([
        { id: "stoat", name: "Stoat", url: "https://stoat.example" },
        { id: "off", name: "Off", url: "https://off.example", enabled: false },
      ]),
    );
    expect(platforms.map((p) => p.id)).toEqual(["discord", "fluxer", "telegram", "stoat"]);
    expect(all.map((p) => p.def.id)).toEqual(["discord", "fluxer", "telegram", "stoat", "off"]);
  });

  it("reports invalid JSON", () => {
    const { platforms, errors } = loadPlatforms(() => "{oops");
    expect(platforms).toEqual([DISCORD, FLUXER, TELEGRAM]);
    expect(errors[0]).toMatch(/^platforms.json is not valid JSON/);
  });
});

describe("platform modules", () => {
  it("accepts self-hosted Fluxer instances and rejects unknown modules", () => {
    const { platforms, errors } = user([
      { id: "my-fluxer", name: "My Fluxer", url: "https://chat.example.org", kind: "fluxer" },
      { id: "el", name: "Element", url: "https://app.element.io", module: "web" },
      { id: "x", name: "X", url: "https://x.example", kind: "matrix" },
    ]);
    expect(platforms.map((p) => [p.id, p.module, p.partition])).toEqual([
      ["my-fluxer", "fluxer", "persist:my-fluxer"],
      ["el", "web", "persist:el"],
    ]);
    expect(errors).toEqual(['entry 2: module must be one of "web", "fluxer"']);
  });

  it("fills in a module's default address and enforces a fixed one", () => {
    const modules: ModuleRule[] = [
      { id: "fluxer", defaultUrl: "https://fluxer.app" },
      { id: "discord", defaultUrl: "https://discord.com/app", fixedUrl: true },
    ];
    const { platforms } = user(
      [
        { id: "second", name: "Second", module: "fluxer" },
        { id: "work", name: "Work", module: "discord", url: "https://evil.example" },
      ],
      modules,
    );
    expect(platforms.map((p) => [p.id, p.url, p.partition])).toEqual([
      ["second", "https://fluxer.app", "persist:second"],
      ["work", "https://discord.com/app", "persist:work"],
    ]);
  });
});

describe("built-in overrides", () => {
  it("turns built-ins off and renames them", () => {
    const json = JSON.stringify([
      { id: "fluxer", enabled: false },
      { id: "telegram", enabled: false },
      { id: "discord", name: " Personal " },
      { id: "el", name: "Element", url: "https://app.element.io" },
    ]);
    const { platforms, all } = loadPlatforms(() => json);
    expect(platforms.map((p) => [p.id, p.name])).toEqual([
      ["discord", "Personal"],
      ["el", "Element"],
    ]);
    expect(all.find((p) => p.def.id === "fluxer")!.enabled).toBe(false);
    expect(DISCORD.name).toBe("Discord"); // the shared definition is untouched
  });

  it("refuses to turn everything off", () => {
    const json = JSON.stringify([
      { id: "discord", enabled: false },
      { id: "fluxer", enabled: false },
      { id: "telegram", enabled: false },
      { id: "el", name: "Element", url: "https://app.element.io", enabled: false },
    ]);
    const { platforms, all, errors } = loadPlatforms(() => json);
    // The built-in services come back on; the user's own stays off.
    expect(platforms.map((p) => p.id)).toEqual(["discord", "fluxer", "telegram"]);
    expect(all.find((p) => p.def.id === "el")!.enabled).toBe(false);
    expect(errors).toEqual(["at least one platform must stay enabled"]);
  });

  it("treats a second entry for a built-in id as a duplicate", () => {
    expect(parsePlatforms([{ id: "fluxer", enabled: true }]).errors).toEqual([]);
    expect(parsePlatforms([{ id: "fluxer" }, { id: "fluxer", name: "Again", url: "https://y.example" }]).errors).toEqual([
      'entry 1: duplicate id "fluxer"',
    ]);
  });
});

describe("module selection", () => {
  it("only allows the modules the shell offers, accepting the old kind field", () => {
    const { platforms, errors } = user(
      [
        { id: "a", name: "A", url: "https://a.example", module: "matrix" },
        { id: "b", name: "B", url: "https://b.example", kind: "fluxer" },
        { id: "c", name: "C", url: "https://c.example", module: 5 },
      ],
      [{ id: "web" }, { id: "matrix" }],
    );
    expect(platforms.map((p) => [p.id, p.module])).toEqual([["a", "matrix"]]);
    expect(errors).toEqual(['entry 1: module must be one of "web", "matrix"', 'entry 2: module must be one of "web", "matrix"']);
  });
});
