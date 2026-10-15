import { isRecord } from "./types";

export interface FluxerInstance {
  /** REST base including the version prefix, e.g. https://api.fluxer.app/v1 */
  api: string;
  gateway: string;
  media: string;
  /** Whether login asks for an email address or a username. */
  identity: "email" | "username";
  /** Whether attachments use the presigned upload flow (else inline multipart). */
  presignedUploads: boolean;
  voiceEnabled: boolean;
  /** Whether the instance proxies a GIF provider (/gifs/search, /gifs/trending). */
  gifs: boolean;
  /**
   * The instance's limit rules that set feature_global_expressions, which
   * decides whether an account may use emoji and stickers outside their own
   * guild (in other guilds and in DMs); undefined when it publishes none.
   */
  expressionRules?: LimitRule[];
  /** The instance's public status page, where it names one (https only). */
  statusPage?: string;
}

/** One rule of the instance's limits, reduced to feature_global_expressions. */
export interface LimitRule {
  traits: string[];
  guildFeatures: string[];
  /** Undefined where the rule leaves the limit alone. */
  value?: number;
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * Reads `limits` as the instance publishes it: either full `limits` per rule,
 * or the compact form (version 2) whose `overrides` differ from Fluxer's
 * restricted defaults, where feature_global_expressions is 0.
 */
function parseExpressionRules(limits: unknown): LimitRule[] | undefined {
  if (!isRecord(limits) || !Array.isArray(limits.rules)) return undefined;
  return limits.rules.flatMap((rule): LimitRule[] => {
    if (!isRecord(rule)) return [];
    const filters = isRecord(rule.filters) ? rule.filters : {};
    const compact = isRecord(rule.overrides);
    const values = compact ? (rule.overrides as Record<string, unknown>) : isRecord(rule.limits) ? rule.limits : {};
    const raw = values.feature_global_expressions;
    const value = typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : compact ? 0 : undefined;
    return [{ traits: strings(filters.traits), guildFeatures: strings(filters.guildFeatures), value }];
  });
}

/**
 * Whether an account with these traits may use emoji and stickers outside
 * their own guild, resolved as Fluxer's server does (packages/limits): rules
 * in order of how many filters they have; a rule without filters sets the
 * value, one with filters can only raise it. The server matches no guild
 * features here, so rules that need some never apply. Without published
 * limits, only premium accounts may (Fluxer's default rule).
 */
export function globalExpressions(instance: FluxerInstance, traits: readonly string[]): boolean {
  const rules = instance.expressionRules;
  if (!rules) return traits.includes("premium");
  const ranked = rules
    .map((rule, index) => ({ rule, index, filters: rule.traits.length + rule.guildFeatures.length }))
    .sort((a, b) => a.filters - b.filters || a.index - b.index);
  let value = 0;
  for (const { rule, filters } of ranked) {
    if (rule.value === undefined || rule.guildFeatures.length > 0 || !rule.traits.every((t) => traits.includes(t))) continue;
    value = filters === 0 ? rule.value : Math.max(value, rule.value);
  }
  return value > 0;
}

const https = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "wss:" ? value.replace(/\/+$/, "") : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads an instance's endpoints from /.well-known/fluxer. Third-party clients
 * use `api_public`; URLs are taken as published, never rewritten.
 */
export async function discoverInstance(origin: string, fetchFn: typeof fetch): Promise<FluxerInstance> {
  const response = await fetchFn(new URL("/.well-known/fluxer", origin).href, { redirect: "follow" });
  if (!response.ok) throw new Error(`Instance discovery failed (HTTP ${response.status})`);
  const json: unknown = await response.json();
  const body = isRecord(json) ? json : {};
  const endpoints = isRecord(body.endpoints) ? body.endpoints : {};
  const api = https(endpoints.api_public) ?? https(endpoints.api);
  const gateway = https(endpoints.gateway);
  const media = https(endpoints.media);
  if (!api || !gateway?.startsWith("wss:") || !media) throw new Error("Instance discovery returned incomplete endpoints");
  const features = isRecord(body.features) ? body.features : {};
  const branding = isRecord(body.app_public) && isRecord(body.app_public.branding) ? body.app_public.branding : {};
  const statusPage = https(branding.status_page_url);
  return {
    api: `${api}/v1`,
    gateway,
    media,
    identity: features.account_identity === "username" ? "username" : "email",
    presignedUploads: features.presigned_attachment_uploads !== false,
    voiceEnabled: features.voice_enabled !== false,
    gifs: isRecord(body.gif) && !(isRecord(body.services) && body.services.gif_enabled === false),
    expressionRules: parseExpressionRules(body.limits),
    ...(statusPage?.startsWith("https:") ? { statusPage } : {}),
  };
}
