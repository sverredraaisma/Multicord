import { describe, expect, it } from "vitest";
import * as engine from "../../src/shared/engine";
import * as protocol from "../../src/mobile/protocol";
// The cases native code's port runs too (mobile/android, ShellCommandsTest).
import cases from "../fixtures/shell-bridge-cases.json";

const limits: Record<string, number> = cases.limits;

function count(value: unknown): number {
  if (typeof value === "number") return value;
  const match = /^([A-Z_]+)([+-]1)?$/.exec(String(value));
  const base = match ? limits[match[1]!] : undefined;
  if (base === undefined) throw new Error(`Unknown count ${String(value)}`);
  return base + Number(match![2] ?? 0);
}

function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if ("$repeat" in v) return String(v.$repeat).repeat(count(v.times));
  if ("$limit" in v) return count(v.$limit);
  if ("$object" in v) {
    const [key, item] = v.$object as [string, unknown];
    return Object.fromEntries(Array.from({ length: count(v.times) }, (_, i) => [key.replaceAll("{i}", String(i)), expand(item)]));
  }
  return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, expand(item)]));
}

const validators: Record<string, (value: unknown) => boolean> = {
  isShellCommand: protocol.isShellCommand,
  isNativeEvent: protocol.isNativeEvent,
};

describe("shell bridge cases", () => {
  it("states the limits the validators use", () => {
    const own: Record<string, unknown> = { ...engine, ...protocol };
    for (const [name, value] of Object.entries(limits)) expect(own[name], name).toBe(value);
  });

  it("covers exactly the validators listed here", () => {
    expect(Object.keys(cases).filter((key) => key !== "about" && key !== "limits").sort()).toEqual(Object.keys(validators).sort());
  });

  for (const [name, validate] of Object.entries(validators)) {
    const section = (cases as unknown as Record<string, { valid: unknown[]; invalid: unknown[] }>)[name]!;
    describe(name, () => {
      it.each(section.valid.map((c) => [JSON.stringify(c).slice(0, 120), c]))("accepts %s", (_label, c) => expect(validate(expand(c))).toBe(true));
      it.each(section.invalid.map((c) => [JSON.stringify(c)?.slice(0, 120) ?? "null", c]))("refuses %s", (_label, c) => expect(validate(expand(c))).toBe(false));
    });
  }
});

describe("isBootInfo", () => {
  it("takes the shell's files, version and OS", () => {
    expect(protocol.isBootInfo({ files: {}, version: "0.1.0", os: "android 14" })).toBe(true);
    expect(protocol.isBootInfo({ files: { settings: "{}", platforms: "[]", order: "[]" }, version: "1", os: "a" })).toBe(true);
  });

  it("refuses anything else", () => {
    expect(protocol.isBootInfo(null)).toBe(false);
    expect(protocol.isBootInfo({ version: "1", os: "a" })).toBe(false);
    expect(protocol.isBootInfo({ files: { credentials: "x" }, version: "1", os: "a" })).toBe(false);
    expect(protocol.isBootInfo({ files: { settings: 5 }, version: "1", os: "a" })).toBe(false);
    expect(protocol.isBootInfo({ files: {}, version: 1, os: "a" })).toBe(false);
    expect(protocol.isBootInfo({ files: {}, version: "1" })).toBe(false);
  });

  it("knows instance ids as platforms.json does", () => {
    expect(protocol.isInstanceId("matrix-2")).toBe(true);
    expect(protocol.isInstanceId("../x")).toBe(false);
  });
});
