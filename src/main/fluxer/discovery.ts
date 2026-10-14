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
  const body: unknown = await response.json();
  const endpoints = isRecord(body) && isRecord(body.endpoints) ? body.endpoints : {};
  const api = https(endpoints.api_public) ?? https(endpoints.api);
  const gateway = https(endpoints.gateway);
  const media = https(endpoints.media);
  if (!api || !gateway?.startsWith("wss:") || !media) throw new Error("Instance discovery returned incomplete endpoints");
  const features = isRecord(body) && isRecord(body.features) ? body.features : {};
  return {
    api: `${api}/v1`,
    gateway,
    media,
    identity: features.account_identity === "username" ? "username" : "email",
    presignedUploads: features.presigned_attachment_uploads !== false,
  };
}
