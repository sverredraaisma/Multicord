// The servers for the live media check, in Docker: Synapse, LiveKit and
// Element's lk-jwt-service on a network of their own. Every name starts with
// mc-media, and the host ports stay clear of the other live suites' stacks.
// Secrets and certificates are made fresh for each run, in a temporary folder.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(HERE, "config");

/** Host ports; container names; the hosts the client reaches through the TLS proxy. */
export const PORTS = {
  synapse: 28008,
  livekit: 27880,
  livekitTcp: 27881,
  livekitUdp: 27882,
  jwt: 28080,
  proxy: 28443,
  elementPage: 28490,
  multicordCdp: 29301,
  elementCdp: 29302,
};
export const NETWORK = "mc-media";
export const CONTAINERS = { synapse: "mc-media-hs", livekit: "mc-media-lk", jwt: "mc-media-jwt" };
export const SERVER_NAME = "mc-media-hs";
export const HOSTS = { synapse: "hs.mcmedia.test", focus: "focus.mcmedia.test", livekit: "lk.mcmedia.test" };
/** LiveKit's address as Synapse and lk-jwt-service name it (inside the Docker network). */
export const LK_INTERNAL = "ws://mc-media-lk:7880";

// Images pinned to what this check last passed with; override with MC_MEDIA_*_IMAGE.
export const IMAGES = {
  synapse: process.env.MC_MEDIA_SYNAPSE_IMAGE ?? "matrixdotorg/synapse:v1.163.0",
  livekit: process.env.MC_MEDIA_LIVEKIT_IMAGE ?? "livekit/livekit-server:v1.13.10",
  jwt: process.env.MC_MEDIA_JWT_IMAGE ?? "ghcr.io/element-hq/lk-jwt-service@sha256:d210fd778ba38b7e42e6fc64e8a24a7d66ccc3b938fb20d73bd713224af2dfea",
};

function docker(args, { check = true, quiet = false } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8", windowsHide: true });
  if (r.error) throw new Error(`docker ${args[0]}: ${r.error.message} (is Docker running?)`);
  if (check && r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(" ")}: ${(r.stderr || r.stdout).trim()}`);
  if (!quiet && r.status !== 0) process.stderr.write(r.stderr);
  return r.stdout.trim();
}

const secret = (bytes = 24) => randomBytes(bytes).toString("hex");
const fill = (file, values) => readFileSync(path.join(CONFIG, file), "utf8").replace(/@@([A-Z_]+)@@/g, (_, name) => {
  if (!(name in values)) throw new Error(`${file}: no value for @@${name}@@`);
  return String(values[name]);
});

/** Secrets for one run. */
export function makeSecrets() {
  return {
    registration: secret(),
    lkKey: `mcmedia${secret(3)}`,
    lkSecret: secret(32),
    asToken: secret(),
    hsToken: secret(),
  };
}

/**
 * Writes Synapse's folder (config, signing key, certificates) into dir/synapse
 * and the proxy's certificate into dir; returns the proxy's key and certificate.
 */
export function prepare(dir, secrets) {
  const data = path.join(dir, "synapse");
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "homeserver.yaml"), fill("homeserver.yaml", { REGISTRATION_SECRET: secrets.registration, MACAROON_SECRET: secret(), FORM_SECRET: secret() }));
  writeFileSync(path.join(data, "lk-as.yaml"), fill("lk-as.yaml", { AS_TOKEN: secrets.asToken, HS_TOKEN: secrets.hsToken }));
  copyFileSync(path.join(CONFIG, "log.yaml"), path.join(data, "log.yaml"));
  // Synapse's signing key format: "ed25519 <key id> <unpadded base64 seed>".
  const seed = randomBytes(32).toString("base64").replace(/=+$/, "");
  writeFileSync(path.join(data, "signing.key"), `ed25519 a_${createHash("sha256").update(seed).digest("hex").slice(0, 4)} ${seed}\n`);
  // Certificates come from the Synapse image's Python, so the host needs no OpenSSL.
  copyFileSync(path.join(CONFIG, "gencert.py"), path.join(data, "gencert.py"));
  const python = (args) => docker(["run", "--rm", "--entrypoint", "python", "-v", `${data}:/data`, IMAGES.synapse, "/data/gencert.py", "/data", ...args]);
  python(["tls", SERVER_NAME]);
  python(["proxy", ...Object.values(HOSTS)]);
  return { key: readFileSync(path.join(data, "proxy.key")), cert: readFileSync(path.join(data, "proxy.crt")) };
}

/** Starts the three containers (after removing any left from an earlier run). */
export function up(dir, secrets) {
  down();
  const data = path.join(dir, "synapse");
  docker(["network", "create", NETWORK]);
  const livekitConfig = fill("livekit.yaml", { RTC_TCP: PORTS.livekitTcp, RTC_UDP: PORTS.livekitUdp, LK_KEY: secrets.lkKey, LK_SECRET: secrets.lkSecret });
  docker(["run", "-d", "--name", CONTAINERS.livekit, "--network", NETWORK,
    "-p", `127.0.0.1:${PORTS.livekit}:7880`, "-p", `127.0.0.1:${PORTS.livekitTcp}:${PORTS.livekitTcp}`, "-p", `127.0.0.1:${PORTS.livekitUdp}:${PORTS.livekitUdp}/udp`,
    "-e", `LIVEKIT_CONFIG=${livekitConfig}`, IMAGES.livekit]);
  // On Linux and macOS Synapse runs as the host user, so it can write the mounted folder.
  const owner = process.getuid ? ["-e", `UID=${process.getuid()}`, "-e", `GID=${process.getgid()}`] : [];
  docker(["run", "-d", "--name", CONTAINERS.synapse, "--network", NETWORK, "-p", `127.0.0.1:${PORTS.synapse}:8008`,
    "-v", `${data}:/data`, "-e", "SYNAPSE_CONFIG_PATH=/data/homeserver.yaml", ...owner, IMAGES.synapse]);
  docker(["run", "-d", "--name", CONTAINERS.jwt, "--network", NETWORK, "-p", `127.0.0.1:${PORTS.jwt}:8080`,
    "-e", `LIVEKIT_URL=${LK_INTERNAL}`, "-e", `LIVEKIT_KEY=${secrets.lkKey}`, "-e", `LIVEKIT_SECRET=${secrets.lkSecret}`,
    "-e", `LIVEKIT_FULL_ACCESS_HOMESERVERS=${SERVER_NAME}`,
    // Synapse's federation certificate is the self-signed one above.
    "-e", "LIVEKIT_INSECURE_SKIP_VERIFY_TLS=YES_I_KNOW_WHAT_I_AM_DOING",
    "-e", `LIVEKIT_AS_TOKEN=${secrets.asToken}`, "-e", `LIVEKIT_HS_TOKEN=${secrets.hsToken}`,
    "-e", `LIVEKIT_HS_SERVER_NAME=${SERVER_NAME}`, "-e", `LIVEKIT_CS_API_URL_OVERRIDES=${SERVER_NAME}=http://${CONTAINERS.synapse}:8008`,
    IMAGES.jwt]);
}

/** Waits until all three answer on their host ports. */
export async function ready(timeoutMs = 120_000) {
  const checks = {
    synapse: `http://127.0.0.1:${PORTS.synapse}/health`,
    livekit: `http://127.0.0.1:${PORTS.livekit}/`,
    jwt: `http://127.0.0.1:${PORTS.jwt}/healthz`,
  };
  const end = Date.now() + timeoutMs;
  for (const [name, url] of Object.entries(checks)) {
    for (;;) {
      const ok = await fetch(url).then((r) => r.ok, () => false);
      if (ok) break;
      const state = docker(["inspect", "-f", "{{.State.Status}}", CONTAINERS[name]], { check: false, quiet: true });
      if (state && state !== "running") throw new Error(`${CONTAINERS[name]} stopped:\n${logs(name)}`);
      if (Date.now() > end) throw new Error(`${CONTAINERS[name]} did not answer on ${url}:\n${logs(name)}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** The last lines a container logged, for failure reports. */
export function logs(name, lines = 30) {
  const r = spawnSync("docker", ["logs", "--tail", String(lines), CONTAINERS[name]], { encoding: "utf8", windowsHide: true });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
}

/** Removes the containers and the network; safe to call when nothing runs. Synchronous, for exit handlers. */
export function down() {
  spawnSync("docker", ["rm", "-f", ...Object.values(CONTAINERS)], { windowsHide: true, stdio: "ignore" });
  spawnSync("docker", ["network", "rm", NETWORK], { windowsHide: true, stdio: "ignore" });
}

/** Names of mc-media containers still present (for the final check). */
export function leftovers() {
  return docker(["ps", "-a", "--filter", "name=^mc-media", "--format", "{{.Names}}"], { check: false, quiet: true }).split(/\s+/).filter(Boolean);
}
