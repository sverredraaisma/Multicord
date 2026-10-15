import { isRecord } from "./types";

/** Where an instance's services are, as it publishes them. */
export interface SpacebarInstance {
  /** REST base including the version prefix, e.g. https://api.example.org/api/v9 */
  api: string;
  /** The gateway's WebSocket address, e.g. wss://gateway.example.org */
  gateway: string;
  /** The CDN: avatars, icons, emoji and attachments. */
  cdn: string;
}

/** Discord's API version 9, which Spacebar's own clients use. */
const API_PATH = "/api/v9";

/** An https: (or, for the gateway, wss:) address without its trailing slashes and with a default port dropped; undefined otherwise. */
function address(value: unknown, protocol: "https:" | "wss:"): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== protocol || url.username || url.password || url.search || url.hash) return undefined;
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

async function getJson(url: string, fetchFn: typeof fetch): Promise<Record<string, unknown>> {
  const response = await fetchFn(url);
  if (!response.ok) throw new Error(`Instance discovery failed (HTTP ${response.status})`);
  const json: unknown = await response.json().catch(() => undefined);
  if (!isRecord(json)) throw new Error("Instance discovery returned no endpoints");
  return json;
}

/** The API's origin from what an instance names: an origin, or an address ending in /api or /api/v<n>. */
function apiOrigin(value: unknown): string | undefined {
  const url = address(value, "https:");
  return url?.replace(/\/api(\/v\d+)?$/, "");
}

/**
 * Reads an instance's endpoints. Spacebar publishes them at
 * /.well-known/spacebar/client (its API, CDN and gateway); older instances
 * publish only their API at /.well-known/spacebar, whose
 * /policies/instance/domains then names the rest. The address the user gave
 * may also be the API's own host, which answers both.
 */
export async function discoverInstance(origin: string, fetchFn: typeof fetch): Promise<SpacebarInstance> {
  let client: Record<string, unknown> | undefined;
  try {
    client = await getJson(new URL("/.well-known/spacebar/client", origin).href, fetchFn);
  } catch {
    client = undefined;
  }
  if (client) {
    const api = apiOrigin(isRecord(client.api) ? client.api.baseUrl : undefined);
    const cdn = address(isRecord(client.cdn) ? client.cdn.baseUrl : undefined, "https:");
    const gateway = address(isRecord(client.gateway) ? client.gateway.baseUrl : undefined, "wss:");
    if (api && cdn && gateway) return { api: `${api}${API_PATH}`, cdn, gateway };
  }
  const legacy = await getJson(new URL("/.well-known/spacebar", origin).href, fetchFn);
  const api = apiOrigin(legacy.api);
  if (!api) throw new Error("Instance discovery returned no API address");
  const domains = await getJson(`${api}${API_PATH}/policies/instance/domains`, fetchFn);
  const cdn = address(domains.cdn, "https:");
  const gateway = address(domains.gateway, "wss:");
  if (!cdn || !gateway) throw new Error("Instance discovery returned incomplete endpoints");
  return { api: `${api}${API_PATH}`, cdn, gateway };
}

/** The hosts the engine needs once the instance is known: its API, gateway and CDN. */
export function instanceHosts(instance: SpacebarInstance): string[] {
  return [...new Set([instance.api, instance.gateway, instance.cdn].map((url) => new URL(url).hostname))];
}
