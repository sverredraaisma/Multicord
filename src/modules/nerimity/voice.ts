import { iceServerHost, iceServers, type NativeIceServer } from "../../shared/native";

/**
 * Where Nerimity's server gets TURN credentials (generateTurnCredentials in
 * its services/Voice.ts): Cloudflare's TURN service, whose servers are these.
 */
export const CLOUDFLARE_ICE_HOSTS: readonly string[] = ["turn.cloudflare.com", "stun.cloudflare.com"];

/** Nerimity's client reuses TURN credentials for an hour (they last a day); the server gives out three per 20 seconds. */
export const TURN_REUSE_MS = 60 * 60_000;

/**
 * The ICE servers in what /voice/generate answers (Cloudflare's
 * iceServers: one server, or a list), as the view would take them, with
 * only their URLs on these hosts. Nothing else is ever used for a call.
 */
export function iceServersFrom(result: unknown, hosts: readonly string[]): NativeIceServer[] {
  return iceServers(Array.isArray(result) ? result : [result]).flatMap((server) => {
    const urls = server.urls.filter((url) => hosts.includes(iceServerHost(url)!));
    return urls.length > 0 ? [{ ...server, urls }] : [];
  });
}

/** Whether any of them is a relay (TURN), which a relay-only call needs. */
export const hasRelay = (servers: readonly NativeIceServer[]): boolean => servers.some((server) => server.urls.some((url) => /^turns?:/.test(url)));
