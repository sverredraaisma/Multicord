// Smoke test: starts the built app (dist/) in a scratch Electron and checks,
// over the Chrome DevTools Protocol, that it comes up: the rail lists the
// built-in services, Settings opens on its Services section, the native
// engines' pages load and stay up, and the main process logs no uncaught
// exception or unhandled rejection. In the main process it also checks what
// an Electron upgrade can break outside the pages: screen capture lists a
// screen, and push to talk's global keyboard hook (uiohook-napi) loads, starts
// and stops. In the native views it checks media: getUserMedia gives tracks
// from Chromium's fake camera and microphone, and getDisplayMedia reaches the
// shell's display-media handler, whose picker it answers, and gives a video
// track. Where the OS withholds a permission these need (macOS: Screen
// Recording, Accessibility, camera), the check is skipped with that reason.
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
// Main-process errors are caught, and the main-process checks run, by a small
// hook loaded with NODE_OPTIONS --require, which Electron honours only for
// unpackaged apps: nothing in the app itself is for this test.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, evaluateIn } from "./live-media/cdp.mjs";
import { launch, remaining, stop, sweep } from "./live-media/processes.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const ONLINE = args.has("--online");
const KEEP = args.has("--keep");
/** The whole run, start to teardown, must finish within this. */
const DEADLINE_MS = 150_000;
const BUILT_IN = ["discord", "fluxer", "telegram"];
const NATIVE = ["fluxer", "telegram"];
/** The native built-ins whose views can share the screen (their session has the shell's display-media handler). */
const SCREEN_SHARE = ["fluxer"];
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

/** The main-process checks, by the name the hook reports them under. */
const MAIN_CHECKS = {
  "capture-sources": "screen capture lists a screen",
  "key-hook-load": "keyboard hook (uiohook-napi) loads",
  "key-hook-run": "keyboard hook starts and stops",
};

/**
 * Runs in the app's main process, through the hook, once the app is ready.
 * Reports each check as `<tag> check {"name", "status": pass|fail|skip, "detail"}`.
 */
function mainChecks(tag) {
  const { app, desktopCapturer, systemPreferences } = require("electron");
  const { createRequire } = require("node:module");
  const path = require("node:path");
  const result = (name, status, detail, extra = {}) => process.stderr.write(`${tag} check ${JSON.stringify({ name, status, detail, ...extra })}\n`);
  const within = (promise, ms, what) =>
    Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took over ${ms / 1000}s`)), ms))]);
  const mac = process.platform === "darwin";
  app.whenReady().then(async () => {
    // Screen capture: the sources the screen share picker lists. macOS lists no screen without Screen Recording access.
    const access = mac ? systemPreferences.getMediaAccessStatus("screen") : "granted";
    const denied = access !== "granted";
    try {
      // Right after start, X11 under xvfb sometimes lists no screen yet: ask again a few times before failing.
      let sources = [];
      let screens = 0;
      for (let attempt = 0; attempt < 5 && screens === 0; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
        sources = await within(desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 16, height: 9 } }), 20_000, "getSources");
        screens = sources.filter((s) => s.id.startsWith("screen:")).length;
      }
      // With none, what Electron sees of the display, so the failure can be told apart from a bare X server.
      const why = screens > 0 ? "" : `; ${require("electron").screen.getAllDisplays().length} display(s), session ${process.env.XDG_SESSION_TYPE || "unset"}, DISPLAY ${process.env.DISPLAY || "unset"}, WAYLAND_DISPLAY ${process.env.WAYLAND_DISPLAY || "unset"}`;
      const detail = `${screens} screen(s), ${sources.length - screens} window(s)${why}`;
      if (screens > 0) result("capture-sources", "pass", detail, { access });
      else result("capture-sources", denied ? "skip" : "fail", denied ? `no Screen Recording permission (${access}); ${detail}` : detail, { access });
    } catch (error) {
      result("capture-sources", denied ? "skip" : "fail", denied ? `no Screen Recording permission (${access}); ${error.message}` : error.message, { access });
    }

    // Push to talk's keyboard hook, resolved as the built main.js resolves it (pushToTalk.ts, loadKeyHook).
    let hook;
    try {
      hook = createRequire(path.join(app.getAppPath(), "dist", "main.js"))("uiohook-napi").uIOhook;
      if (typeof hook?.start !== "function" || typeof hook.stop !== "function") throw new Error("uIOhook has no start/stop");
      result("key-hook-load", "pass", "uIOhook loaded");
    } catch (error) {
      hook = undefined;
      result("key-hook-load", "fail", error.message);
    }
    if (!hook) return;
    if (mac && !systemPreferences.isTrustedAccessibilityClient(false)) {
      result("key-hook-run", "skip", "no Accessibility permission, which macOS needs for a global key hook");
      return;
    }
    try {
      hook.start();
      await new Promise((resolve) => setTimeout(resolve, 300));
      hook.stop();
      result("key-hook-run", "pass", "started and stopped");
    } catch (error) {
      result("key-hook-run", "fail", error.message);
    }
  });
}

// The main-process hook: reports uncaught exceptions and unhandled rejections
// on stderr (and so keeps Electron's error dialog from blocking a headless run),
// and runs the main-process checks.
const HOOK = `"use strict";
if (process.type === "browser") {
  const report = (kind, error) => process.stderr.write(${JSON.stringify(TAG)} + " " + kind + ": " + ((error && error.stack) || String(error)) + "\\n");
  process.on("uncaughtException", (error) => report("uncaught exception", error));
  process.on("unhandledRejection", (reason) => report("unhandled rejection", reason));
  process.stderr.write(${JSON.stringify(TAG)} + " loaded\\n");
  // Electron's own module can be required only once the app's main script runs, after this hook.
  setImmediate(${mainChecks.toString()}, ${JSON.stringify(TAG)});
}
`;

const checks = [];
/** On GitHub Actions, also as an annotation: those show on the run's page without signing in, unlike its logs. */
function annotate(level, name, detail) {
  if (!process.env.GITHUB_ACTIONS) return;
  const escape = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stdout.write(`::${level} title=${escape(`Smoke (${process.platform}): ${name}`).replace(/[:,]/g, " ")}::${escape(detail || name)}\n`);
}
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  out(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
  if (!ok) annotate("error", name, detail);
}
/** A check the OS keeps from running here (say, a permission CI lacks): neither a pass nor a failure. */
function skip(name, reason) {
  checks.push({ name, ok: true, skipped: true, detail: reason });
  out(`SKIP ${name} - ${reason}`);
  annotate("notice", name, reason);
}

/** The main-process checks' results in the log so far, by name. */
function mainResults(log) {
  const results = new Map();
  for (const line of log.split("\n")) {
    if (!line.startsWith(`${TAG} check `)) continue;
    try {
      const r = JSON.parse(line.slice(`${TAG} check `.length).trim());
      results.set(r.name, r);
    } catch {
      // a line cut short
    }
  }
  return results;
}

/** In a page: the camera and microphone's tracks, stopped again. */
const USER_MEDIA = `navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((stream) => {
  const result = { audio: stream.getAudioTracks().length, video: stream.getVideoTracks().length, labels: stream.getTracks().map((t) => t.label).join(", ") };
  stream.getTracks().forEach((t) => t.stop());
  return result;
}, (e) => ({ error: e.name + ": " + e.message }))`;

/** In a page: a screen share's video tracks, stopped again (also if it comes after the time is up). */
const DISPLAY_MEDIA = `new Promise((resolve) => {
  let late = false;
  const timer = setTimeout(() => { late = true; resolve({ error: "no answer within 20s" }); }, 20000);
  navigator.mediaDevices.getDisplayMedia({ video: true }).then((stream) => {
    const video = stream.getVideoTracks();
    const result = { video: video.length, state: video[0] ? video[0].readyState : "" };
    stream.getTracks().forEach((t) => t.stop());
    clearTimeout(timer);
    if (!late) resolve(result);
  }, (e) => { clearTimeout(timer); resolve({ error: e.name + ": " + e.message }); });
})`;

/** In the picker: chooses a screen (else the first source), without system audio; its name, or "" before the sources show. */
const PICK_SCREEN = `(() => {
  const button = document.querySelector('.source[data-id^="screen:"]') || document.querySelector(".source");
  if (!button) return "";
  const audio = document.getElementById("share-audio");
  if (audio) audio.checked = false;
  button.click();
  return button.textContent;
})()`;

/**
 * Asks a page for a screen share and answers the shell's picker if it shows.
 * @returns {Promise<{ picked: string, video?: number, state?: string, error?: string }>}
 */
async function shareIn(port, view) {
  let settled = false;
  const answer = evaluateIn(view, DISPLAY_MEDIA, 25_000)
    .catch((error) => ({ error: error.message }))
    .finally(() => (settled = true));
  let picked = "";
  const end = Date.now() + 20_000;
  while (!settled && !picked && Date.now() < end) {
    const picker = (await targets(port).catch(() => [])).find((t) => t.type === "page" && t.webSocketDebuggerUrl && /\/picker\.html$/.test(t.url));
    if (picker) picked = await evaluateIn(picker, PICK_SCREEN, 5_000).catch(() => "");
    if (!picked) await sleep(250);
  }
  return { picked, ...(await answer) };
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
      // Chromium's fake camera and microphone, for the getUserMedia check: no real device is opened.
      "--use-fake-device-for-media-stream",
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
  // 4. The main process: screen capture and the keyboard hook, as the hook reported them.
  const readLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
  const names = Object.keys(MAIN_CHECKS);
  await until(async () => names.every((n) => mainResults(readLog()).has(n)), "the main-process checks", 30_000).catch(() => undefined);
  const results = mainResults(readLog());
  for (const name of names) {
    const r = results.get(name);
    if (r?.status === "skip") skip(MAIN_CHECKS[name], r.detail);
    else check(MAIN_CHECKS[name], r?.status === "pass", r ? r.detail : "not reported by the main process");
  }
  check("app still running", alive());

  // 5. Media in the native views (native.html, one per native built-in).
  const mac = process.platform === "darwin";
  const nativeViews = await until(async () => {
    const views = (await targets(port)).filter((t) => t.type === "page" && t.webSocketDebuggerUrl && /\/native\.html$/.test(t.url));
    return views.length === NATIVE.length ? views : undefined;
  }, "the native views", 15_000).catch((error) => error);
  if (nativeViews instanceof Error) check("native views load", false, nativeViews.message);
  else {
    // Camera and microphone, from Chromium's fake devices.
    const media = await evaluateIn(nativeViews[0], USER_MEDIA, 15_000).catch((error) => ({ error: error.message }));
    const ok = media.audio > 0 && media.video > 0;
    if (!ok && mac && /NotAllowedError/.test(media.error ?? "")) skip("camera and microphone (fake devices) give tracks", `macOS refused access: ${media.error}`);
    else check("camera and microphone (fake devices) give tracks", ok, media.error ?? `${media.audio} audio, ${media.video} video: ${media.labels}`);

    // Screen share: getDisplayMedia goes to the shell's handler, whose picker we answer with a screen.
    const shared = [];
    for (const view of nativeViews) shared.push(await shareIn(port, view));
    const answered = shared.filter((s) => s.video > 0).length;
    const refused = shared.filter((s) => s.error && !s.picked).length;
    const detail = shared.map((s) => (s.error ? `${s.error}${s.picked ? ` (picked ${s.picked})` : ""}` : `${s.video} video track from "${s.picked}", ${s.state}`)).join("; ");
    const sharedOk = answered === SCREEN_SHARE.length && refused === NATIVE.length - SCREEN_SHARE.length;
    const access = results.get("capture-sources")?.access;
    if (!sharedOk && mac && access !== "granted") skip("screen share in the native views gives a video track", `no Screen Recording permission (${access}): ${detail}`);
    else check("screen share in the native views gives a video track", sharedOk, detail);
  }

  // 6. The log: the hook was loaded, and nothing uncaught; no engine stopped.
  const log = readLog();
  check("error hook loaded in the main process", log.includes(`${TAG} loaded`));
  const uncaught = log.split("\n").filter((l) => l.startsWith(`${TAG} uncaught exception:`) || l.startsWith(`${TAG} unhandled rejection:`));
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
  const skipped = checks.filter((c) => c.skipped).length;
  out(failed.length === 0 ? `all ${checks.length - skipped} checks passed${skipped ? ` (${skipped} skipped)` : ""} in ${elapsed()}` : `FAILED: ${failed.map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ""}`).join("; ")}`);
  process.exit(failed.length === 0 && checks.length > 0 ? 0 : 1);
}

main().then(() => finish(), finish);
