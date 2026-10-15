// Smoke test: starts the built app (dist/) in a scratch Electron and checks,
// over the Chrome DevTools Protocol, that it comes up: the rail lists the
// built-in services, Settings opens on its Services section, the native
// engines' pages load and stay up, and the main process logs no uncaught
// exception or unhandled rejection.
//
//   npm run build && npm run smoke        (or: node scripts/smoke.mjs [--online] [--keep])
//
// It needs no network: by default the scratch app resolves no host names but
// the local ones, so Discord's page and the engines fail to connect, as
// offline, and show their offline or sign-in states. --online lets them reach
// the internet. The app runs with a fresh temporary profile (--user-data-dir),
// never the user's own, and is stopped only by its own process id (with its
// children), plus on Windows a sweep for processes naming this run's temporary
// folder; the folder is deleted afterwards (--keep leaves it, for its log).
//
// Main-process errors are caught by a small hook loaded with NODE_OPTIONS
// --require, which Electron honours only for unpackaged apps: nothing in the
// app itself is for this test.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "./live-media/cdp.mjs";
import { launch, remaining, stop, sweep } from "./live-media/processes.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const ONLINE = args.has("--online");
const KEEP = args.has("--keep");
/** The whole run, start to teardown, must finish within this. */
const DEADLINE_MS = 150_000;
const BUILT_IN = ["discord", "fluxer", "telegram"];
const NATIVE = ["fluxer", "telegram"];
/** Marks the hook's lines in the log. */
const TAG = "[smoke-hook]";

const started = Date.now();
const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
const out = (line) => process.stdout.write(`[smoke ${elapsed()}] ${line}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(probe, what, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (!alive()) throw new Error(`the app exited while waiting for ${what}`);
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}${last ? ` (last error: ${last.message})` : ""}`);
    await sleep(500);
  }
}

/** A free local port for DevTools. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json`)).json();
}

// The main-process hook: reports uncaught exceptions and unhandled rejections
// on stderr (and so keeps Electron's error dialog from blocking a headless run).
const HOOK = `"use strict";
if (process.type === "browser") {
  const report = (kind, error) => process.stderr.write(${JSON.stringify(TAG)} + " " + kind + ": " + ((error && error.stack) || String(error)) + "\\n");
  process.on("uncaughtException", (error) => report("uncaught exception", error));
  process.on("unhandledRejection", (reason) => report("unhandled rejection", reason));
  process.stderr.write(${JSON.stringify(TAG)} + " loaded\\n");
}
`;

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

if (!existsSync(path.join(REPO, "dist", "main.js")) || !existsSync(path.join(REPO, "dist", "rail.html"))) {
  process.stderr.write("smoke: dist/ is missing; run `npm run build` first\n");
  process.exit(1);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "multicord-smoke-"));
const token = path.basename(dir);
const profile = path.join(dir, "profile");
mkdirSync(profile);
const hookFile = path.join(dir, "hook.cjs");
writeFileSync(hookFile, HOOK);
const logFile = path.join(dir, "multicord.log");
let child;
const alive = () => child !== undefined && child.exitCode === null && child.signalCode === null;

function teardown() {
  stop(child);
  sweep(token);
}
process.on("exit", teardown);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    teardown();
    process.exit(130);
  });
}
const watchdog = setTimeout(() => {
  process.stderr.write(`smoke: did not finish within ${DEADLINE_MS / 1000}s\n`);
  finish(new Error("deadline"));
}, DEADLINE_MS);

async function main() {
  const port = await freePort();
  out(`starting the app (profile ${profile}, DevTools port ${port}, ${ONLINE ? "online" : "offline"})`);
  const env = { ...process.env, NODE_OPTIONS: `--require "${hookFile.replaceAll(path.sep, "/")}"`, ELECTRON_ENABLE_LOGGING: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  child = launch(
    [
      ".",
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      // Offline: every name but the local ones fails to resolve.
      ...(ONLINE ? [] : ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1"]),
      "--enable-logging=stderr",
    ],
    { cwd: REPO, logFile, env },
  );
  child.once("exit", (code, signal) => out(`the app exited (${signal ?? `code ${code}`})`));

  // 1. The window: the rail page, with each built-in service's entry.
  const rail = (expression) => evaluate(port, "/rail\\.html$", expression, 15_000);
  await until(async () => {
    return (await targets(port)).some((t) => t.type === "page" && /\/rail\.html$/.test(t.url));
  }, "the rail page", 60_000);
  const keys = await until(async () => {
    const found = await rail(`[...document.querySelectorAll("#rail .rail-item[data-key]")].map((b) => b.dataset.key)`);
    return BUILT_IN.every((id) => found.some((k) => k.startsWith(`${id}:`))) ? found : undefined;
  }, "the rail to list the built-in services", 45_000).catch((error) => error);
  check("rail lists the built-in services", Array.isArray(keys), Array.isArray(keys) ? keys.join(", ") : keys.message);

  // 2. Settings: the gear opens it on the Services section, listing the built-ins.
  await rail(`document.getElementById("settings-button").click(), true`);
  const services = await until(async () => {
    if (!(await targets(port)).some((t) => t.type === "page" && /\/settings\.html$/.test(t.url))) return undefined;
    const r = await evaluate(port, "/settings\\.html$", `(() => {
      const section = document.querySelector('.settings-section[data-tab="services"]');
      const ids = [...document.querySelectorAll(".service-list .service")].map((s) => s.dataset.id);
      return section && ids.length ? { heading: section.querySelector("h1")?.textContent ?? "", ids } : null;
    })()`, 15_000);
    return r && BUILT_IN.every((id) => r.ids.includes(id)) ? r : undefined;
  }, "Settings to show the Services section", 30_000).catch((error) => error);
  check(
    "settings opens on Services",
    services && !(services instanceof Error) && /services/i.test(services.heading),
    services instanceof Error ? services.message : `"${services?.heading}": ${services?.ids.join(", ")}`,
  );
  const pressed = await rail(`document.getElementById("settings-button").getAttribute("aria-pressed")`).catch(() => "?");
  check("rail marks Settings as open", pressed === "true", `aria-pressed=${pressed}`);

  // 3. Engines: each native built-in's engine page loads, answers, and is still up a while later.
  const enginePages = async () => (await targets(port)).filter((t) => t.type === "page" && t.url.startsWith("multicord-engine://"));
  const engineUp = async (engine) => evaluate(port, `^multicord-engine://${engine}/`, `document.readyState === "complete" && location.origin`, 10_000);
  const firstSeen = await until(async () => {
    const pages = await enginePages();
    return NATIVE.every((e) => pages.some((p) => p.url.startsWith(`multicord-engine://${e}/`))) ? pages : undefined;
  }, "the native engine pages", 30_000).catch((error) => error);
  if (firstSeen instanceof Error) check("engine pages start", false, firstSeen.message);
  else {
    // Let the engines run (and fail to connect, offline) for a few seconds.
    await sleep(5000);
    for (const engine of NATIVE) {
      const origin = await engineUp(engine).catch((error) => `error: ${error.message}`);
      check(`engine "${engine}" runs`, origin === `multicord-engine://${engine}`, String(origin));
    }
  }
  check("app still running", alive());

  // 4. The log: the hook was loaded, and nothing uncaught; no engine stopped.
  const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  check("error hook loaded in the main process", log.includes(`${TAG} loaded`));
  const uncaught = log.split("\n").filter((l) => l.startsWith(TAG) && !l.endsWith(" loaded") && !l.endsWith(" loaded\r"));
  check("no uncaught main-process errors", uncaught.length === 0, uncaught.slice(0, 3).join(" | "));
  const stopped = log.split("\n").filter((l) => /\[engine [\w-]+\] stopped/.test(l));
  check("no engine crashes", stopped.length === 0, stopped.slice(0, 3).join(" | "));
  // The scratch profile is the one in use (never the user's own).
  // (Partitions holds the services' persistent sessions, which live under the app's userData.)
  check("app uses the scratch profile", existsSync(path.join(profile, "Partitions")));
}

let finished = false;
function finish(failure) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (failure) {
    process.stderr.write(`\nsmoke: ${failure.stack ?? failure}\n`);
    checks.push({ name: "run", ok: false, detail: failure.message });
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0 && existsSync(logFile)) {
    process.stderr.write(`--- multicord.log (last 40 lines)\n${readFileSync(logFile, "utf8").split("\n").slice(-40).join("\n")}\n`);
  }
  out("tearing down");
  teardown();
  // Windows needs a moment before the folder's files are released.
  let removed = KEEP;
  for (let i = 0; i < 20 && !removed; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      removed = !existsSync(dir);
    } catch {
      // still in use
    }
    if (!removed) {
      const until = Date.now() + 500;
      while (Date.now() < until);
    }
  }
  const left = remaining(token);
  if (left > 0) failed.push({ name: "teardown", detail: `${left} processes left` });
  if (!removed) failed.push({ name: "teardown", detail: `could not delete ${dir}` });
  if (KEEP) out(`kept ${dir}`);
  out(failed.length === 0 ? `all ${checks.length} checks passed in ${elapsed()}` : `FAILED: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`);
  process.exit(failed.length === 0 && checks.length > 0 ? 0 : 1);
}

main().then(() => finish(), finish);
