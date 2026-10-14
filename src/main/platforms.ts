import { isHttpsUrl } from "../shared/ipc";

export interface PlatformDef {
  id: string;
  name: string;
  url: string;
  partition: string;
  /** "fluxer" is the native adapter; its url is the instance origin used for discovery. */
  kind: "discord" | "web" | "fluxer";
  iconUrl?: string;
}

export const DISCORD: PlatformDef = {
  id: "discord",
  name: "Discord",
  url: "https://discord.com/app",
  partition: "persist:discord",
  kind: "discord",
};

export const FLUXER: PlatformDef = {
  id: "fluxer",
  name: "Fluxer",
  url: "https://fluxer.app",
  partition: "persist:fluxer",
  kind: "fluxer",
};

const BUILT_IN = [DISCORD, FLUXER];
const PLATFORM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Validates the user's platforms.json: a list of {id, name, url, iconUrl?, kind?}
 * entries. Each is a web view in its own partition, or with kind "fluxer" a
 * native Fluxer client for a self-hosted instance at url. A built-in platform
 * is turned off with {"id": "fluxer", "enabled": false}. Invalid entries are
 * skipped and reported rather than failing the whole file.
 */
export function parsePlatforms(raw: unknown): { platforms: PlatformDef[]; disabled: string[]; errors: string[] } {
  const platforms: PlatformDef[] = [];
  const disabled: string[] = [];
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { platforms, disabled, errors: ["platforms.json must contain an array"] };

  const builtIn = new Set(BUILT_IN.map((p) => p.id));
  const seen = new Set(builtIn);
  raw.forEach((entry: unknown, index) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof e.id === "string" && builtIn.has(e.id) && e.enabled === false) {
      disabled.push(e.id);
      return;
    }
    const problem =
      typeof e.id !== "string" || !PLATFORM_ID.test(e.id) ? "id must be lowercase letters, digits or dashes"
      : seen.has(e.id) ? `duplicate id "${e.id}"`
      : typeof e.name !== "string" || e.name.trim() === "" ? "name is required"
      : !isHttpsUrl(e.url) ? "url must be an https URL"
      : e.iconUrl !== undefined && !isHttpsUrl(e.iconUrl) ? "iconUrl must be an https URL"
      : e.kind !== undefined && e.kind !== "web" && e.kind !== "fluxer" ? 'kind must be "web" or "fluxer"'
      : undefined;
    if (problem) {
      errors.push(`entry ${index}: ${problem}`);
      return;
    }
    const id = e.id as string;
    seen.add(id);
    platforms.push({
      id,
      name: (e.name as string).trim(),
      url: e.url as string,
      partition: `persist:${id}`,
      kind: e.kind === "fluxer" ? "fluxer" : "web",
      iconUrl: e.iconUrl as string | undefined,
    });
  });
  return { platforms, disabled, errors };
}

/** Discord and Fluxer come first; user platforms follow. A missing file is not an error. */
export function loadPlatforms(readText: () => string | undefined): { platforms: PlatformDef[]; errors: string[] } {
  const text = readText();
  if (text === undefined) return { platforms: [...BUILT_IN], errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { platforms: [...BUILT_IN], errors: [`platforms.json is not valid JSON: ${(error as Error).message}`] };
  }
  const parsed = parsePlatforms(raw);
  const platforms = [...BUILT_IN.filter((p) => !parsed.disabled.includes(p.id)), ...parsed.platforms];
  if (platforms.length === 0) {
    return { platforms: [...BUILT_IN], errors: [...parsed.errors, "at least one platform must stay enabled"] };
  }
  return { platforms, errors: parsed.errors };
}
