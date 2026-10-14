// Edits to platforms.json from the settings page. Each function takes the
// file's parsed content and returns the new content; unknown entries and
// fields are kept as they are, so hand edits survive.
import { BUILT_IN, loadPlatforms, parsePlatforms, PLATFORM_ID, type ModuleRule } from "./platforms";

type Entry = Record<string, unknown>;

/** The file's entries; anything but an array starts over empty. */
export function configEntries(raw: unknown): unknown[] {
  return Array.isArray(raw) ? [...raw] : [];
}

const isEntry = (value: unknown, id: string): value is Entry =>
  typeof value === "object" && value !== null && (value as Entry).id === id;

/** Changes the first entry for `id`, adding one if there is none. */
function upsert(raw: unknown, id: string, change: (entry: Entry) => void): unknown[] {
  const entries = configEntries(raw);
  const at = entries.findIndex((e) => isEntry(e, id));
  const entry: Entry = at >= 0 ? { ...(entries[at] as Entry) } : { id };
  change(entry);
  if (at >= 0) entries[at] = entry;
  else entries.push(entry);
  return entries;
}

export function setServiceEnabled(raw: unknown, id: string, enabled: boolean): unknown[] {
  return upsert(raw, id, (entry) => {
    if (enabled) delete entry.enabled;
    else entry.enabled = false;
  });
}

export function renameService(raw: unknown, id: string, name: string): unknown[] {
  return upsert(raw, id, (entry) => {
    entry.name = name.trim();
  });
}

/** Removes a user-added service; built-in ones can only be turned off. */
export function removeService(raw: unknown, id: string): unknown[] {
  if (BUILT_IN.some((p) => p.id === id)) return configEntries(raw);
  return configEntries(raw).filter((e) => !isEntry(e, id));
}

/** A free id from the name ("My Server" -> "my-server", then "my-server-2"), else from the module. */
export function newServiceId(name: string, module: string, taken: ReadonlySet<string>): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents, split off by NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const base = PLATFORM_ID.test(slug) ? slug : module;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export type ServiceEdit =
  | { ok: true; raw: unknown[]; id: string }
  | { ok: false; error: string };

/** Adds a service, checking it the way the shell will load it. */
export function addService(
  raw: unknown,
  service: { module: string; name: string; url?: string },
  modules: readonly ModuleRule[],
): ServiceEdit {
  const taken = new Set<string>(BUILT_IN.map((p) => p.id));
  for (const e of configEntries(raw)) {
    const existing = (e as Entry | null)?.id;
    if (typeof existing === "string") taken.add(existing);
  }
  const id = newServiceId(service.name, service.module, taken);
  const entry: Entry = { id, name: service.name.trim(), module: service.module };
  if (service.url?.trim()) entry.url = service.url.trim();
  const after = configEntries(raw).concat(entry);
  const check = loadPlatforms(() => JSON.stringify([entry]), modules);
  if (check.errors.length > 0) return { ok: false, error: check.errors[0]!.replace(/^entry \d+: /, "") };
  return { ok: true, raw: after, id };
}

/** Whether the edited config still turns at least one service on. */
export function keepsOneEnabled(raw: unknown, modules: readonly ModuleRule[]): boolean {
  return parsePlatforms(configEntries(raw), modules).entries.some((p) => p.enabled);
}
