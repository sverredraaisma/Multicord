import { isHttpsUrl } from "../shared/ipc";

export interface PlatformDef {
  id: string;
  name: string;
  url: string;
  partition: string;
  /** Id of the platform module that runs it (see main/modules). For "fluxer", url is the instance origin. */
  module: string;
  iconUrl?: string;
}

/** A platform from the config, whether or not it is turned on. */
export interface ConfiguredPlatform {
  def: PlatformDef;
  enabled: boolean;
  builtIn: boolean;
}

/** What platforms.json may say about a module's instances. */
export interface ModuleRule {
  id: string;
  /** Used when an entry has no url. */
  defaultUrl?: string;
  /** The module always uses defaultUrl, e.g. Discord. */
  fixedUrl?: boolean;
}

export const DISCORD: PlatformDef = {
  id: "discord",
  name: "Discord",
  url: "https://discord.com/app",
  partition: "persist:discord",
  module: "discord",
};

export const FLUXER: PlatformDef = {
  id: "fluxer",
  name: "Fluxer",
  url: "https://fluxer.app",
  partition: "persist:fluxer",
  module: "fluxer",
};

export const BUILT_IN = [DISCORD, FLUXER];
export const PLATFORM_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_NAME = 64;
/** Modules users may instantiate; the shell passes the real list from main/modules. */
const DEFAULT_MODULES: ModuleRule[] = [{ id: "web" }, { id: "fluxer", defaultUrl: FLUXER.url }];

/**
 * Validates the user's platforms.json: a list of {id, name, url, iconUrl?,
 * module?, enabled?} entries, each run by a configurable module ("web" by
 * default; "fluxer" for a Fluxer instance at url; "discord" for another
 * Discord account). The older "kind" field is accepted too. An entry with a
 * built-in id only overrides its name or turns it off: {"id": "fluxer",
 * "enabled": false}. Invalid entries are skipped and reported rather than
 * failing the whole file.
 */
export function parsePlatforms(
  raw: unknown,
  modules: readonly ModuleRule[] = DEFAULT_MODULES,
): { entries: ConfiguredPlatform[]; errors: string[] } {
  const builtIns = BUILT_IN.map((def) => ({ def: { ...def }, enabled: true, builtIn: true }));
  const entries: ConfiguredPlatform[] = [];
  const errors: string[] = [];
  if (!Array.isArray(raw)) return { entries: builtIns, errors: ["platforms.json must contain an array"] };

  const seen = new Set(BUILT_IN.map((p) => p.id));
  const overridden = new Set<string>();
  raw.forEach((entry: unknown, index) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const builtIn = builtIns.find((b) => b.def.id === e.id);
    if (builtIn && !overridden.has(builtIn.def.id)) {
      overridden.add(builtIn.def.id);
      if (e.enabled === false) builtIn.enabled = false;
      if (typeof e.name === "string" && e.name.trim() !== "") builtIn.def.name = e.name.trim().slice(0, MAX_NAME);
      return;
    }
    const moduleId = e.module ?? e.kind ?? "web";
    const rule = modules.find((m) => m.id === moduleId);
    const url = rule?.fixedUrl ? rule.defaultUrl : (e.url ?? rule?.defaultUrl);
    const problem =
      typeof e.id !== "string" || !PLATFORM_ID.test(e.id) ? "id must be lowercase letters, digits or dashes"
      : seen.has(e.id) ? `duplicate id "${e.id}"`
      : typeof e.name !== "string" || e.name.trim() === "" ? "name is required"
      : !rule ? `module must be one of ${modules.map((m) => `"${m.id}"`).join(", ")}`
      : !isHttpsUrl(url) ? "url must be an https URL"
      : e.iconUrl !== undefined && !isHttpsUrl(e.iconUrl) ? "iconUrl must be an https URL"
      : undefined;
    if (problem) {
      errors.push(`entry ${index}: ${problem}`);
      return;
    }
    const id = e.id as string;
    seen.add(id);
    entries.push({
      def: {
        id,
        name: (e.name as string).trim().slice(0, MAX_NAME),
        url: url as string,
        partition: `persist:${id}`,
        module: rule!.id,
        iconUrl: e.iconUrl as string | undefined,
      },
      enabled: e.enabled !== false,
      builtIn: false,
    });
  });
  return { entries: [...builtIns, ...entries], errors };
}

/**
 * Discord and Fluxer come first; user platforms follow. `platforms` holds the
 * ones turned on, `all` every configured one. A missing file is not an error.
 */
export function loadPlatforms(
  readText: () => string | undefined,
  modules?: readonly ModuleRule[],
): { platforms: PlatformDef[]; all: ConfiguredPlatform[]; errors: string[] } {
  const text = readText();
  let raw: unknown = [];
  const errors: string[] = [];
  if (text !== undefined) {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      errors.push(`platforms.json is not valid JSON: ${(error as Error).message}`);
    }
  }
  const parsed = parsePlatforms(raw, modules);
  errors.push(...parsed.errors);
  let all = parsed.entries;
  if (!all.some((p) => p.enabled)) {
    errors.push("at least one platform must stay enabled");
    all = all.map((p) => (p.builtIn ? { ...p, enabled: true } : p));
  }
  return { platforms: all.filter((p) => p.enabled).map((p) => p.def), all, errors };
}
