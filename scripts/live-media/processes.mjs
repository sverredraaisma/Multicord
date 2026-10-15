// Starting and stopping the two scratch Electrons. Each has its own temporary
// --user-data-dir. They are stopped only by their own process ids (with their
// child processes), and on Windows also by a CIM query for processes whose
// command line names this run's temporary folder: never by process name, as
// the developer's own Multicord and other Electron apps may be running.
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
/** The Electron binary from node_modules. */
export const ELECTRON = /** @type {string} */ (require("electron"));
const WINDOWS = process.platform === "win32";

/**
 * Starts an Electron with the given arguments, its output going to logFile
 * (with the given environment, or else this process's).
 * @returns {import("node:child_process").ChildProcess}
 */
export function launch(args, { cwd, logFile, env }) {
  const log = openSync(logFile, "a");
  try {
    // Own process group off Windows, so the whole tree can be signalled.
    return spawn(ELECTRON, args, { cwd, env, stdio: ["ignore", log, log], detached: !WINDOWS, windowsHide: false });
  } finally {
    // The child has its own handle; ours would keep Windows from removing the folder.
    closeSync(log);
  }
}

/** Stops a launched Electron and its children. Synchronous, for exit handlers. */
export function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (WINDOWS) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

/**
 * Windows: stops any process still running whose command line contains this
 * run's unique folder token (orphaned renderers, GPU processes). Returns how many.
 * Elsewhere the process-group kill in stop() covers the children.
 */
export function sweep(token) {
  if (!WINDOWS || !/^[\w-]+$/.test(token)) return 0;
  const script = [
    `$found = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${token}%'" | Where-Object { $_.ProcessId -ne $PID })`,
    "foreach ($p in $found) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }",
    "$found.Count",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return Number(r.stdout?.trim()) || 0;
}

/** Windows: how many processes' command lines still name the token (for the final check). */
export function remaining(token) {
  if (!WINDOWS || !/^[\w-]+$/.test(token)) return 0;
  const script = `@(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${token}%'" | Where-Object { $_.ProcessId -ne $PID }).Count`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  return Number(r.stdout?.trim()) || 0;
}
