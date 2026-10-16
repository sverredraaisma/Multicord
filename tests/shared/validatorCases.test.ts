import { describe, expect, it } from "vitest";
import * as engine from "../../src/shared/engine";
import * as native from "../../src/shared/native";
// The cases every host's validators must pass; mobile/android runs them too (docs/mobile.md, section 5).
import cases from "../fixtures/engine-validator-cases.json";

const limits: Record<string, number> = cases.limits;

/** A count: a number, or a limit's name with an optional +1 or -1. */
function count(value: unknown): number {
  if (typeof value === "number") return value;
  const match = /^([A-Z_]+)([+-]1)?$/.exec(String(value));
  const base = match ? limits[match[1]!] : undefined;
  if (base === undefined) throw new Error(`Unknown count ${String(value)}`);
  return base + Number(match![2] ?? 0);
}

/** Replaces {i} in every string of a value. */
function indexed(value: unknown, i: number): unknown {
  if (typeof value === "string") return value.replaceAll("{i}", String(i));
  if (Array.isArray(value)) return value.map((v) => indexed(v, i));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [indexed(k, i), indexed(v, i)]));
  return value;
}

/** A fixture value with its expansions ($repeat, $bytes, $list, $object, $text, $limit) made. */
function expand(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(expand);
  if (value === null || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  if ("$repeat" in v) return String(expand(v.$repeat)).repeat(count(v.times));
  if ("$bytes" in v) return new Uint8Array(count(v.$bytes));
  if ("$limit" in v) return count(v.$limit);
  if ("$text" in v) return (v.$text as unknown[]).map((part) => (typeof part === "number" ? String.fromCodePoint(part) : String(expand(part)))).join("");
  if ("$list" in v) return Array.from({ length: count(v.times) }, (_, i) => expand(indexed(v.$list, i)));
  if ("$object" in v) {
    const [key, item] = v.$object as [unknown, unknown];
    return Object.fromEntries(Array.from({ length: count(v.times) }, (_, i) => [String(expand(indexed(key, i))), expand(indexed(item, i))]));
  }
  return Object.fromEntries(Object.entries(v).map(([k, item]) => [k, expand(item)]));
}

const validators: Record<string, (value: unknown) => boolean> = {
  isImageUrl: engine.isImageUrl,
  isEngineEvent: engine.isEngineEvent,
  isHttpRequest: engine.isHttpRequest,
  isEngineRequest: engine.isEngineRequest,
  isEngineCommand: engine.isEngineCommand,
  isNativeAction: native.isNativeAction,
};

/** A short name for a case in the test's title. */
const label = (value: unknown): string => {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
};

describe("shared validator cases", () => {
  it("states the limits the validators use", () => {
    const own: Record<string, unknown> = { ...engine, ...native };
    for (const [name, value] of Object.entries(limits)) expect(own[name], name).toBe(value);
  });

  it("covers exactly the validators listed here", () => {
    expect(Object.keys(cases).filter((key) => key !== "about" && key !== "limits").sort()).toEqual(Object.keys(validators).sort());
  });

  for (const [name, validate] of Object.entries(validators)) {
    const section = (cases as unknown as Record<string, { valid: unknown[]; invalid: unknown[] }>)[name]!;
    describe(name, () => {
      it.each(section.valid.map((c) => [label(c), c]))("accepts %s", (_label, c) => expect(validate(expand(c))).toBe(true));
      it.each(section.invalid.map((c) => [label(c), c]))("refuses %s", (_label, c) => expect(validate(expand(c))).toBe(false));
    });
  }
});
