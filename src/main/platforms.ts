import { isHttpsUrl } from "../shared/ipc";

export interface PlatformDef {
  id: string;
  name: string;
  url: string;
  partition: string;
  kind: "discord" | "web";
  iconUrl?: string;
}

export const DISCORD: PlatformDef = {
  id: "discord",
  name: "Discord",
  url: "https://discord.com/app",
  partition: "persist:discord",
  kind: "discord",
};

const PLATFORM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Validates the user's platforms.json: a list of {id, name, url, iconUrl?}
 * entries, each loaded as a web view in its own partition. Invalid entries are
 * skipped and reported rather than failing the whole file.
 */
export function parsePlatforms(raw: unknown): { platforms: PlatformDef[]; errors: string[] } {
  const platforms: PlatformDef[] = [];
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { platforms, errors: ["platforms.json must contain an array"] };

  const seen = new Set([DISCORD.id]);
  raw.forEach((entry: unknown, index) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const problem =
      typeof e.id !== "string" || !PLATFORM_ID.test(e.id) ? "id must be lowercase letters, digits or dashes"
      : seen.has(e.id) ? `duplicate id "${e.id}"`
      : typeof e.name !== "string" || e.name.trim() === "" ? "name is required"
      : !isHttpsUrl(e.url) ? "url must be an https URL"
      : e.iconUrl !== undefined && !isHttpsUrl(e.iconUrl) ? "iconUrl must be an https URL"
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
      kind: "web",
      iconUrl: e.iconUrl as string | undefined,
    });
  });
  return { platforms, errors };
}

/** Discord is always first; user platforms follow. A missing file is not an error. */
export function loadPlatforms(readText: () => string | undefined): { platforms: PlatformDef[]; errors: string[] } {
  const text = readText();
  if (text === undefined) return { platforms: [DISCORD], errors: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { platforms: [DISCORD], errors: [`platforms.json is not valid JSON: ${(error as Error).message}`] };
  }
  const parsed = parsePlatforms(raw);
  return { platforms: [DISCORD, ...parsed.platforms], errors: parsed.errors };
}
