// Live check of Matrix call media: Multicord's real call view (a scratch
// Electron instance) against an Element-style peer (matrix-js-sdk MatrixRTC +
// livekit-client with E2EE), through real Synapse, LiveKit and lk-jwt-service
// in Docker. Prints a result table, tears everything down (also on failure or
// Ctrl-C) and exits non-zero when any check fails. See README.md here.
//
//   npm run live:media [-- --format legacy|sticky] [--no-build] [--verbose] [--json <file>]
import { initAsync } from "@matrix-org/matrix-sdk-crypto-wasm";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { evaluate, hasPage } from "./cdp.mjs";
import { launch, remaining, stop, sweep } from "./processes.mjs";
import { startProxy } from "./proxy.mjs";
import { ELEMENT_HZ, MULTICORD_HZ, register, runFormat, until } from "./scenario.mjs";
import * as stack from "./stack.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const { values: opts } = parseArgs({
  options: {
    format: { type: "string", default: "both" },
    "no-build": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    json: { type: "string" },
  },
});
const FORMATS = opts.format === "both" ? ["legacy", "sticky"] : [opts.format];
if (!FORMATS.every((f) => f === "legacy" || f === "sticky")) {
  process.stderr.write(`--format must be legacy, sticky or both\n`);
  process.exit(2);
}

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0)}s`;
const out = (line) => process.stdout.write(`[${elapsed().padStart(4)}] ${line}\n`);
// matrix-js-sdk logs a great deal through console; this script writes to stdout directly.
if (!opts.verbose) for (const name of ["log", "debug", "info", "warn", "trace", "error"]) console[name] = () => {};

// Everything of this run lives in one temporary folder whose name is unique:
// configs, secrets, certificates, both Electron profiles, logs.
const dir = mkdtempSync(path.join(os.tmpdir(), "mc-media-"));
const token = path.basename(dir);
const children = [];
let proxy;
let pageServer;
let tornDown = false;

/** Stops everything this run started. Synchronous and idempotent, so exit handlers can use it. */
function teardown() {
  if (tornDown) return;
  tornDown = true;
  for (const child of children) stop(child);
  // Windows: catch stray child processes, and wait until none hold the folder.
  for (let i = 0; i < 20 && (sweep(token) > 0 || remaining(token) > 0); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  proxy?.close();
  pageServer?.close();
  stack.down();
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } catch (error) {
    process.stderr.write(`could not remove ${dir}: ${error.message}\n`);
  }
}
process.on("exit", teardown);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    process.stderr.write(`\n${signal}: tearing down\n`);
    teardown();
    process.exit(130);
  });
}

const rows = [];
const check = (format) => (phase, name, ok, detail) => {
  rows.push({ format, phase, name, ok, detail });
  out(`  ${ok ? "PASS" : "FAIL"} ${phase}: ${name} (${detail})`);
};

/** A 10 s, 48 kHz mono sine at -12 dBFS, for a fake microphone (Chromium loops it). */
function tone(hz, file) {
  const rate = 48000;
  const n = rate * 10;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8192), 44 + i * 2);
  writeFileSync(file, buf);
}

/** Serves the Element page's folder on 127.0.0.1 only. */
function servePage(root, port) {
  const types = { ".html": "text/html", ".js": "text/javascript" };
  const server = http.createServer((req, res) => {
    const name = path.basename((req.url ?? "/").split("?")[0]);
    const file = path.join(root, name);
    if (!name || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[path.extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function printTable() {
  const header = { format: "format", phase: "phase", name: "check", ok: "result", detail: "detail" };
  const all = [header, ...rows.map((r) => ({ ...r, ok: r.ok ? "PASS" : "FAIL" }))];
  const width = (key) => Math.max(...all.map((r) => String(r[key]).length));
  const w = { format: width("format"), phase: width("phase"), name: width("name"), ok: width("ok") };
  const line = (r) => `${String(r.format).padEnd(w.format)}  ${String(r.phase).padEnd(w.phase)}  ${String(r.name).padEnd(w.name)}  ${String(r.ok).padEnd(w.ok)}  ${r.detail}`;
  process.stdout.write(`\n${line(header)}\n${"-".repeat(w.format + w.phase + w.name + w.ok + 30)}\n`);
  for (const r of all.slice(1)) process.stdout.write(`${line(r)}\n`);
}

async function main() {
  const secrets = stack.makeSecrets();
  const { PORTS, HOSTS } = stack;

  out(`working folder ${dir}`);
  out("certificates and Synapse config");
  const proxyTls = stack.prepare(dir, secrets);
  out("starting mc-media-hs, mc-media-lk, mc-media-jwt");
  stack.up(dir, secrets);
  await stack.ready();
  out("servers ready");

  if (!opts["no-build"]) {
    out("building Multicord (npm run build)");
    const b = spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: REPO, stdio: opts.verbose ? "inherit" : "pipe", encoding: "utf8" });
    if (b.status !== 0) throw new Error(`build failed:\n${b.stderr ?? ""}${b.stdout ?? ""}`);
  }
  if (!existsSync(path.join(REPO, "dist", "main.js"))) throw new Error("dist/main.js is missing: run without --no-build");

  // Element's page: bundled from element/page.ts, with livekit-client's E2EE worker beside it.
  const pageDir = path.join(dir, "element-page");
  mkdirSync(pageDir);
  await build({ entryPoints: [path.join(HERE, "element", "page.ts")], bundle: true, format: "iife", target: "chrome140", outfile: path.join(pageDir, "page.js"), logLevel: "warning" });
  copyFileSync(path.join(REPO, "node_modules", "livekit-client", "dist", "livekit-client.e2ee.worker.js"), path.join(pageDir, "livekit-e2ee-worker.js"));
  writeFileSync(path.join(pageDir, "page.html"), `<!doctype html><meta charset="utf-8"><title>element</title><body><script src="page.js"></script></body>\n`);
  pageServer = await servePage(pageDir, PORTS.elementPage);

  const toneMc = path.join(dir, `tone${MULTICORD_HZ}.wav`);
  const toneEl = path.join(dir, `tone${ELEMENT_HZ}.wav`);
  tone(MULTICORD_HZ, toneMc);
  tone(ELEMENT_HZ, toneEl);

  const proxyLog = path.join(dir, "proxy.log");
  proxy = await startProxy({
    port: PORTS.proxy,
    ...proxyTls,
    routes: { [HOSTS.synapse]: PORTS.synapse, [HOSTS.focus]: PORTS.jwt, [HOSTS.livekit]: PORTS.livekit },
    lkHost: HOSTS.livekit,
    lkInternal: stack.LK_INTERNAL,
    log: (l) => appendFileSync(proxyLog, `${new Date().toISOString()} ${l}\n`),
  });

  // The scratch Multicord: a fresh profile with only a Matrix account on the test homeserver.
  const mcProfile = path.join(dir, "multicord-profile");
  mkdirSync(mcProfile);
  writeFileSync(path.join(mcProfile, "platforms.json"), JSON.stringify([
    { id: "discord", enabled: false },
    { id: "fluxer", enabled: false },
    { id: "telegram", enabled: false },
    { id: "mx", name: "Matrix media check", module: "matrix-native", url: `https://${HOSTS.synapse}` },
  ]));
  const media = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--disable-features=CalculateNativeWinOcclusion",
    "--disable-backgrounding-occluded-windows",
    // Chromium's fake camera handing frames over in GPU memory buffers (its
    // path once a page has a peer connection) crashes its video capture service
    // now and then on Windows; shared memory does not (see README).
    "--disable-video-capture-use-gpu-memory-buffer",
    // Chromium's warnings into the logs, such as "Detected crash of video capture service".
    "--enable-logging=stderr",
    "--log-level=1",
  ];
  out("starting the scratch Multicord and Element");
  const launchMulticord = () => launch([
    ".",
    `--user-data-dir=${mcProfile}`,
    `--remote-debugging-port=${PORTS.multicordCdp}`,
    // Only this scratch instance: everything goes through the TLS proxy, whose
    // certificate it accepts. The test hosts resolve to a documentation address
    // so they count as public; the proxy carries the traffic.
    `--proxy-server=http://127.0.0.1:${PORTS.proxy}`,
    "--host-resolver-rules=MAP *.mcmedia.test 203.0.113.7",
    "--ignore-certificate-errors",
    ...media,
    `--use-file-for-fake-audio-capture=${toneMc}`,
  ], { cwd: REPO, logFile: path.join(dir, "multicord.log") });
  let multicord = launchMulticord();
  children.push(multicord);
  children.push(launch([
    path.join(HERE, "element", "main.cjs"),
    `--mc-media-page=http://127.0.0.1:${PORTS.elementPage}/page.html`,
    `--user-data-dir=${path.join(dir, "element-profile")}`,
    `--remote-debugging-port=${PORTS.elementCdp}`,
    "--autoplay-policy=no-user-gesture-required",
    ...media,
    `--use-file-for-fake-audio-capture=${toneEl}`,
  ], { cwd: REPO, logFile: path.join(dir, "element.log") }));

  const mc = (expression, timeoutMs) => evaluate(PORTS.multicordCdp, "native\\.html", expression, timeoutMs);
  const el = (expression, timeoutMs) => evaluate(PORTS.elementCdp, "page\\.html", expression, timeoutMs);
  await until(() => hasPage(PORTS.multicordCdp, "native\\.html"), "Multicord's Matrix view", 60_000);
  await until(() => el(`document.title === "element-ready"`), "Element's media page", 60_000);

  await initAsync();
  const hs = `http://127.0.0.1:${PORTS.synapse}`;
  const mcUser = `mc-${Date.now().toString(36)}`;
  const mcPassword = `pw-${randomBytes(9).toString("base64url")}`;
  await register(hs, secrets.registration, mcUser, mcPassword);
  out(`signing Multicord in as @${mcUser}:${stack.SERVER_NAME}`);
  await until(() => mc(`Boolean(document.querySelector('input[name="user"]'))`), "Multicord's sign-in form", 60_000);
  await mc(`(() => {
    const set = (name, value) => { const i = document.querySelector('input[name="' + name + '"]'); i.value = value; i.dispatchEvent(new Event("input", { bubbles: true })); };
    set("user", ${JSON.stringify(mcUser)}); set("password", ${JSON.stringify(mcPassword)});
    [...document.querySelectorAll("button")].find((b) => b.textContent === "Sign in").click();
    return true;
  })()`);
  const mxid = `@${mcUser}:${stack.SERVER_NAME}`;
  const signedIn = () => mc(`!document.querySelector('input[name="password"]') && document.body.innerText.includes(${JSON.stringify(mxid)})`);
  await until(signedIn, "Multicord's sign-in to finish", 60_000);

  // Multicord fixes the hosts its Matrix engine may reach when it starts, and
  // learns the homeserver's LiveKit server only once signed in: the first
  // start after signing in allows it (as the app tells users). So restart once.
  out("restarting the scratch Multicord once, so its host lock includes the call server");
  // The session is stored encrypted with Electron's safeStorage. On Windows
  // its key sits in the profile's "Local State", which Chromium writes some
  // seconds later: stopping before that would lose the session.
  const localState = path.join(mcProfile, "Local State");
  await until(async () => existsSync(localState) && (process.platform !== "win32" || readFileSync(localState, "utf8").includes('"encrypted_key"')), "the profile's Local State to be written", 60_000);
  await new Promise((r) => setTimeout(r, 2000));
  const restart = async () => {
    stop(multicord);
    await until(async () => !(await hasPage(PORTS.multicordCdp, ".")), "the scratch Multicord to exit", 30_000);
    await new Promise((r) => setTimeout(r, 1000));
    multicord = launchMulticord();
    children.push(multicord);
    await until(() => hasPage(PORTS.multicordCdp, "native\\.html"), "Multicord's Matrix view after the restart", 60_000);
    await until(signedIn, "Multicord to resume its session", 60_000).catch(async (error) => {
      throw new Error(`${error.message}; the view shows: ${String(await mc("document.body.innerText.slice(0, 300)").catch(() => "?")).replace(/\s+/g, " ")}`);
    });
  };
  await restart();

  const ctx = {
    hs,
    focus: `http://127.0.0.1:${PORTS.jwt}`,
    livekitHttp: `http://127.0.0.1:${PORTS.livekit}`,
    livekitWs: `ws://127.0.0.1:${PORTS.livekit}`,
    lkInternal: stack.LK_INTERNAL,
    lkPublic: `wss://${HOSTS.livekit}`,
    focusPublic: `https://${HOSTS.focus}`,
    sharedSecret: secrets.registration,
    lkKey: secrets.lkKey,
    lkSecret: secrets.lkSecret,
    serverName: stack.SERVER_NAME,
    mcUser,
    mcPassword,
    mc,
    el,
    out,
    /** How often each side's log says Chromium's video capture service crashed (so far, over all its restarts). */
    captureCrashes: () => Object.fromEntries(["multicord", "element"].map((side) => {
      const file = path.join(dir, `${side}.log`);
      return [side, existsSync(file) ? readFileSync(file, "utf8").split("Detected crash of video capture service").length - 1 : 0];
    })),
  };
  for (const [i, format] of FORMATS.entries()) {
    // Each call in a fresh Multicord process: after a crash of Chromium's video
    // capture service a process lists no camera any more (see README).
    if (i > 0) {
      out("restarting the scratch Multicord, so this call is its first");
      await restart();
    }
    out(`${format} format`);
    await runFormat(ctx, format, check(format)).catch((error) => check(format)("aborted", "call ran to the end", false, error.message));
  }
}

let failure;
try {
  await main();
} catch (error) {
  failure = error;
  rows.push({ format: "-", phase: "setup", name: "stack, apps and sign-in", ok: false, detail: error.message.split("\n")[0] });
  process.stderr.write(`\n${error.stack ?? error}\n`);
  for (const name of ["multicord.log", "element.log"]) {
    const file = path.join(dir, name);
    if (existsSync(file)) process.stderr.write(`--- ${name} (last lines)\n${readFileSync(file, "utf8").split("\n").slice(-15).join("\n")}\n`);
  }
}

printTable();
if (opts.json) writeFileSync(opts.json, JSON.stringify({ rows, seconds: (Date.now() - started) / 1000 }, null, 1));
out("tearing down");
teardown();
const containers = stack.leftovers();
const processes = remaining(token);
const clean = containers.length === 0 && processes === 0 && !existsSync(dir);
out(`teardown: ${clean ? "clean" : `NOT clean (containers: ${containers.join(", ") || "none"}; processes: ${processes}; folder left: ${existsSync(dir)})`}`);
const failed = rows.filter((r) => !r.ok).length;
out(`${rows.length - failed}/${rows.length} checks passed in ${elapsed()}`);
process.exit(failure || failed > 0 || rows.length === 0 || !clean ? 1 : 0);
