// Accessibility check: runs axe-core (WCAG 2.1 A/AA and best practices) on the
// built pages in a scratch Electron, with sample states instead of accounts:
// the native chat view's screens and populated chat states (scripts/a11y/fixtures.ts)
// at desktop and phone width, the settings page on every tab at desktop and
// phone width, the component gallery, the phone's shell page (drawer,
// Messages, settings), the rail, the Messages page and the couldn't-reach page;
// all of them in the dark and the light theme (colour contrast in both), the
// light ones named "[light]". Fails on serious or critical violations that
// scripts/a11y-baseline.json does not list with a reason.
//
//   npm run build && npm run a11y        (or: node scripts/a11y.mjs [--all] [--json <file>])
//
// --all also prints the moderate and minor findings. Nothing here reaches the
// network or the user's profile: the pages get their states from fake bridges,
// the scratch Electron has its own temporary --user-data-dir and resolves no
// host names, and it is stopped by its own process id (on Windows also by a
// sweep for processes naming this run's temporary folder).
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { evaluateIn } from "./live-media/cdp.mjs";
import { launch, remaining, stop, sweep } from "./live-media/processes.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist");
const argv = process.argv.slice(2);
const ALL = argv.includes("--all");
const JSON_OUT = argv.includes("--json") ? argv[argv.indexOf("--json") + 1] : undefined;
const DEADLINE_MS = 420_000;
const FAILING = new Set(["serious", "critical"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (line) => process.stdout.write(`[a11y] ${line}\n`);

for (const file of ["native.html", "settings.html", "gallery.html", "mobile/shell.html"]) {
  if (!existsSync(path.join(DIST, file))) {
    process.stderr.write(`a11y: dist/${file} is missing; run \`npm run build\` first\n`);
    process.exit(1);
  }
}

/** The sample states, bundled from TypeScript so they follow the real contracts. */
async function fixtures() {
  const result = await build({ entryPoints: [path.join(REPO, "scripts", "a11y", "fixtures.ts")], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
}

// The scratch Electron: one window per page, each with a fake bridge in place of its preload.
const MAIN = `"use strict";
const { app, BrowserWindow, nativeTheme } = require("electron");
const path = require("node:path");
// The theme under test, as the shell passes the user's choice on: through prefers-color-scheme.
nativeTheme.themeSource = process.env.A11Y_THEME;
app.whenReady().then(() => {
  const open = (file, hash, width, height, preload) => {
    const win = new BrowserWindow({ width, height, useContentSize: true, show: false, paintWhenInitiallyHidden: true,
      webPreferences: { preload: preload && path.join(__dirname, preload), contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    void win.loadFile(file, { hash });
  };
  const dist = process.env.A11Y_DIST, shell = process.env.A11Y_SHELL;
  open(path.join(dist, "native.html"), "desktop", 1280, 800, "native.js");
  open(path.join(dist, "native.html"), "phone", 390, 844, "native.js");
  open(path.join(dist, "settings.html"), "desktop", 1280, 800, "settings.js");
  open(path.join(dist, "settings.html"), "phone", 390, 844, "settings.js");
  open(path.join(dist, "gallery.html"), "desktop", 1280, 800);
  open(path.join(shell, "shell.html"), "phone", 390, 844, "shell.js");
  open(path.join(dist, "rail.html"), "desktop", 72, 800, "shell-page.js");
  open(path.join(dist, "unreachable.html"), "desktop", 1208, 800, "shell-page.js");
  open(path.join(dist, "messages.html"), "desktop", 1208, 800, "messages.js");
});
`;

/** The rail and the couldn't-reach page share the shell's preload: their parts of it, fed by the check. */
const SHELL_PAGE_PRELOAD = `"use strict";
const { contextBridge } = require("electron");
const listeners = {};
const on = (name) => (cb) => { listeners[name] = cb; };
contextBridge.exposeInMainWorld("multicord", { onRail: on("rail"), onUnreachable: on("unreachable"), open() {}, ready() {}, tooltip() {}, reorder() {}, settings() {}, messages() {}, retry() {}, openSettings() {} });
contextBridge.exposeInMainWorld("a11y", { push: (name, state) => listeners[name] && listeners[name](state) });
`;

const MESSAGES_PRELOAD = `"use strict";
const { contextBridge } = require("electron");
let listener;
contextBridge.exposeInMainWorld("multicordMessages", { onState: (cb) => { listener = cb; }, open() {}, ready() {} });
contextBridge.exposeInMainWorld("a11y", { push: (state) => listener && listener(state) });
`;

const NATIVE_PRELOAD = `"use strict";
const { contextBridge } = require("electron");
const states = [], others = {};
const on = (name) => (cb) => { others[name] = cb; };
const api = { onState: (cb) => states.push(cb), act() {}, screenAudioEnded() {}, onVoiceSettings: on("voice"), onMediaAutoLoad: on("auto"), onCompact() {}, onVoiceCommand() {}, onFavourites: on("favourites"), favourites() {} };
// The phone's bridge: back presses and audio routes, which turn on the view's phone layout.
if (location.hash === "#phone") Object.assign(api, { onBack() {}, onAudioRoutes: on("routes"), setAudioRoute() {} });
contextBridge.exposeInMainWorld("multicordNative", api);
contextBridge.exposeInMainWorld("a11y", {
  push: (state) => states.forEach((cb) => cb(state)),
  favourites: (state) => others.favourites && others.favourites(state),
  routes: (routes) => others.routes && others.routes(routes),
});
`;

const SETTINGS_PRELOAD = `"use strict";
const { contextBridge } = require("electron");
let listener, last;
contextBridge.exposeInMainWorld("multicordSettings", { onState: (cb) => { listener = cb; if (last) cb(last); }, act() {}, ready() {} });
contextBridge.exposeInMainWorld("a11y", { push: (state) => { last = state; if (listener) listener(state); } });
`;

const SHELL_PRELOAD = `"use strict";
const { contextBridge } = require("electron");
const platforms = JSON.stringify([{ id: "discord", enabled: false }, { id: "matrix", name: "Matrix", module: "matrix-native", url: "https://matrix.org" }]);
let listener;
contextBridge.exposeInMainWorld("multicordShell", { request: async () => ({ files: { platforms }, version: "0.1.0", os: "android 14" }), send() {}, onEvent: (cb) => { listener = cb; } });
contextBridge.exposeInMainWorld("a11y", { emit: (event) => listener && listener(event) });
`;

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

async function target(port, pattern, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const found = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl && pattern.test(t.url));
      if (found) return found;
    } catch {
      // not up yet
    }
    if (Date.now() > end) throw new Error(`no page matching ${pattern}`);
    await sleep(250);
  }
}

const AXE = readFileSync(path.join(REPO, "node_modules", "axe-core", "axe.min.js"), "utf8");
const AXE_RUN = `axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } }).then((r) =>
  r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target.join(" "), summary: n.failureSummary || "" })) })))`;

/** Reloads a page (dropping what earlier checks opened in it) and waits for it to be ready. */
async function reload(page) {
  await evaluateIn(page, "location.reload(), true", 10_000).catch(() => undefined);
  await sleep(300);
  for (let i = 0; i < 40; i++) {
    if ((await evaluateIn(page, `document.readyState === "complete" && typeof a11y !== "undefined"`, 5_000).catch(() => false)) === true) break;
    await sleep(150);
  }
  await sleep(200);
}

const results = [];
/** The colour themes every page is checked in; the light theme's checks are named with "[light]". */
const THEMES = ["dark", "light"];
let theme = THEMES[0];
async function check(page, base) {
  const name = theme === "dark" ? base : `${base} [${theme}]`;
  if ((await evaluateIn(page, `typeof axe`, 10_000)) === "undefined") await evaluateIn(page, `${AXE};true`, 20_000);
  const violations = await evaluateIn(page, AXE_RUN, 60_000);
  results.push({ name, violations });
  const failing = violations.filter((v) => FAILING.has(v.impact)).length;
  out(`${name}: ${violations.length === 0 ? "no violations" : `${violations.length} rule(s) violated, ${failing} serious or critical`}`);
}

const dir = mkdtempSync(path.join(os.tmpdir(), "multicord-a11y-"));
const token = path.basename(dir);
let child;
function teardown() {
  stop(child);
  sweep(token);
}
process.on("exit", teardown);
const watchdog = setTimeout(() => {
  process.stderr.write(`a11y: did not finish within ${DEADLINE_MS / 1000}s\n`);
  process.exit(1);
}, DEADLINE_MS);

async function main() {
  const data = await fixtures();
  // The phone's shell page is served flat (as mobile/android does): its stylesheets sit beside it.
  const shellDir = path.join(dir, "shell");
  mkdirSync(shellDir);
  for (const file of ["mobile/shell.html", "mobile/shell.js", "mobile/mobile.css", "shell.css", "settings.css", "messages.css"]) cpSync(path.join(DIST, file), path.join(shellDir, path.basename(file)));
  const app = path.join(dir, "app");
  mkdirSync(app);
  writeFileSync(path.join(app, "main.js"), MAIN);
  writeFileSync(path.join(app, "native.js"), NATIVE_PRELOAD);
  writeFileSync(path.join(app, "settings.js"), SETTINGS_PRELOAD);
  writeFileSync(path.join(app, "shell.js"), SHELL_PRELOAD);
  writeFileSync(path.join(app, "shell-page.js"), SHELL_PAGE_PRELOAD);
  writeFileSync(path.join(app, "messages.js"), MESSAGES_PRELOAD);
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "multicord-a11y", main: "main.js" }));

  // Every page in each theme: a scratch Electron of its own per theme.
  for (const current of THEMES) {
    theme = current;
    const port = await freePort();
    const env = { ...process.env, A11Y_DIST: DIST, A11Y_SHELL: shellDir, A11Y_THEME: theme };
    delete env.ELECTRON_RUN_AS_NODE;
    child = launch([app, `--user-data-dir=${path.join(dir, `profile-${theme}`)}`, `--remote-debugging-port=${port}`, "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"], { cwd: app, logFile: path.join(dir, `electron-${theme}.log`), env });
    out(`checking the built pages in the ${theme} theme (DevTools port ${port})`);
    await pages(port, data);
    stop(child);
  }
}

/** Every page state, in the theme the scratch Electron runs with. */
async function pages(port, data) {
  // The native chat view.
  for (const width of ["desktop", "phone"]) {
    const page = await target(port, new RegExp(`/native\\.html#${width}$`));
    for (const sample of data.NATIVE.filter((s) => (s.phone === true) === (width === "phone"))) {
      await reload(page);
      await evaluateIn(page, `a11y.favourites(${JSON.stringify(data.FAVOURITES)}), true`);
      if (width === "phone") await evaluateIn(page, `a11y.routes({ current: "speaker", available: ["earpiece", "speaker"] }), true`);
      await evaluateIn(page, `a11y.push(${JSON.stringify(sample.state)}), true`);
      await sleep(250);
      if (sample.then) await evaluateIn(page, `(() => { ${sample.then}; return true; })()`);
      await sleep(250);
      await check(page, `native view (${width}): ${sample.name}`);
    }
  }

  // The settings page, every tab.
  for (const width of ["desktop", "phone"]) {
    const page = await target(port, new RegExp(`/settings\\.html#${width}$`));
    await reload(page);
    await evaluateIn(page, `a11y.push(${JSON.stringify(data.SETTINGS)}), true`);
    await sleep(300);
    const tabs = await evaluateIn(page, `[...document.querySelectorAll(".settings-tab")].map((b) => b.dataset.tab)`);
    for (const tab of tabs) {
      await evaluateIn(page, `document.querySelector('.settings-tab[data-tab="${tab}"]').click(), true`);
      await sleep(300);
      await check(page, `settings (${width}): ${tab}`);
    }
  }

  // The component gallery.
  await check(await target(port, /\/gallery\.html#desktop$/), "gallery");

  // The phone's shell page: its drawer with a service's servers and DMs, Messages, and settings.
  const shell = await target(port, /\/shell\.html#phone$/);
  await reload(shell);
  const emit = (event) => evaluateIn(shell, `a11y.emit(${JSON.stringify(event)}), true`);
  await emit({ type: "health", instance: "matrix", state: "running", restarts: 0 });
  await emit({ type: "engine", instance: "matrix", event: { type: "servers", servers: [{ key: "s1", name: "Open Source Hub", unread: true, mentions: 2 }, { key: "s2", name: "Board games", unread: false, mentions: 0 }] } });
  await emit({ type: "engine", instance: "matrix", event: { type: "directs", directs: [{ key: "d1", title: "Ana", lastActivity: Date.parse("2026-10-14T12:00:00Z"), preview: "See you at eight!", unread: true, mentions: 1 }] } });
  await sleep(300);
  await evaluateIn(shell, `document.getElementById("menu").click(), true`);
  await sleep(200);
  await check(shell, "phone shell: drawer");
  await evaluateIn(shell, `document.getElementById("drawer-messages").click(), true`);
  await sleep(300);
  await check(shell, "phone shell: Messages");
  await evaluateIn(shell, `document.getElementById("settings-button").click(), true`);
  await sleep(500);
  await check(shell, "phone shell: settings");

  // The rail, the couldn't-reach page and the Messages list on the desktop.
  const rail = await target(port, /\/rail\.html#desktop$/);
  await reload(rail);
  await evaluateIn(rail, `a11y.push("rail", ${JSON.stringify(data.RAIL)}), true`);
  await sleep(300);
  await check(rail, "rail");
  const unreachable = await target(port, /\/unreachable\.html#desktop$/);
  await reload(unreachable);
  await evaluateIn(unreachable, `a11y.push("unreachable", ${JSON.stringify(data.UNREACHABLE)}), true`);
  await sleep(200);
  await check(unreachable, "couldn't-reach page");
  const messages = await target(port, /\/messages\.html#desktop$/);
  await reload(messages);
  await evaluateIn(messages, `a11y.push(${JSON.stringify(data.MESSAGES_PAGE)}), true`);
  await sleep(300);
  await check(messages, "Messages page");
}

/** Whether a baseline entry covers a violation on a page: same rule, page and (if given) element. */
function baselined(baseline, page, violation, node) {
  return baseline.some((b) => b.rule === violation.id && new RegExp(b.page ?? ".").test(page) && (!b.target || node.target.includes(b.target)));
}

function report() {
  const baseline = JSON.parse(readFileSync(path.join(REPO, "scripts", "a11y-baseline.json"), "utf8")).entries;
  const failures = [];
  const used = new Set();
  for (const { name, violations } of results) {
    for (const v of violations) {
      for (const node of v.nodes) {
        const entry = baseline.find((b) => b.rule === v.id && new RegExp(b.page ?? ".").test(name) && (!b.target || node.target.includes(b.target)));
        if (entry) used.add(entry);
        const failing = FAILING.has(v.impact) && !baselined(baseline, name, v, node);
        if (failing) failures.push({ page: name, rule: v.id, impact: v.impact, help: v.help, target: node.target, summary: node.summary });
        else if (ALL) out(`  (${entry ? "baselined" : v.impact}) ${name}: ${v.id} at ${node.target}`);
      }
    }
  }
  for (const f of failures) out(`FAIL [${f.impact}] ${f.page}: ${f.rule} (${f.help}) at ${f.target}\n        ${f.summary.split("\n").slice(1, 2).join("").trim()}`);
  for (const entry of baseline) if (!used.has(entry)) out(`note: baseline entry for ${entry.rule}${entry.target ? ` at ${entry.target}` : ""} no longer matches anything; it can go`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  const pages = results.length;
  out(failures.length === 0 ? `${pages} page states checked: no serious or critical violations outside the baseline` : `${failures.length} serious or critical violation(s) in ${pages} page states`);
  return failures.length === 0;
}

let code = 1;
try {
  await main();
  code = report() ? 0 : 1;
} catch (error) {
  process.stderr.write(`a11y: ${error.stack ?? error}\n`);
} finally {
  clearTimeout(watchdog);
  teardown();
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(250);
    }
  }
  const left = remaining(token);
  if (left > 0) {
    process.stderr.write(`a11y: ${left} processes left\n`);
    code = 1;
  }
}
process.exit(code);
