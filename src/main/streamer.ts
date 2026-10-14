import { execFile } from "node:child_process";
import { Emitter } from "../shared/emitter";

/** Streaming and recording apps whose process means "someone may be watching". */
export const STREAMING_APPS = new Set([
  "obs",
  "obs64",
  "obs32",
  "obs-studio",
  "streamlabs obs",
  "streamlabs desktop",
  "xsplit.core",
  "xsplit broadcaster",
  "twitch studio",
  "prismlivestudio",
  "vmix",
  "vmix64",
  "wirecast",
]);

/** Whether a process name (bare, with .exe, or a full path) is a streaming app. */
export function isStreamingProcess(name: string): boolean {
  const base = name.trim().split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, "");
  return STREAMING_APPS.has(base);
}

/** Parses `tasklist /fo csv /nh` (Windows) or `ps -A -o comm=` (elsewhere) into process names. */
export function parseProcessList(output: string, platform: NodeJS.Platform): string[] {
  const lines = output.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (platform !== "win32") return lines.map((line) => line.trim());
  return lines.map((line) => /^"([^"]*)"/.exec(line)?.[1] ?? "").filter(Boolean);
}

/** Running process names, from the OS's own tool; empty when it cannot be run. */
export function listProcesses(platform: NodeJS.Platform): Promise<string[]> {
  const [command, args] = platform === "win32" ? ["tasklist", ["/fo", "csv", "/nh"]] : ["ps", ["-A", "-o", "comm="]];
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : parseProcessList(stdout, platform));
    });
  });
}

/**
 * Watches for streaming software while started. The first look comes a
 * moment after starting, then one every interval; timers never keep the
 * app alive on their own.
 */
export class StreamerWatch {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private current = false;
  readonly changed = new Emitter<boolean>();

  constructor(
    private readonly list: () => Promise<string[]>,
    private readonly intervalMs = 15_000,
    private readonly firstDelayMs = 2_000,
  ) {}

  get active(): boolean {
    return this.current;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(this.firstDelayMs);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.set(false);
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => void this.check(), delay);
    (this.timer as { unref?(): void }).unref?.();
  }

  private async check(): Promise<void> {
    const names = await this.list();
    if (!this.running) return;
    this.set(names.some(isStreamingProcess));
    this.schedule(this.intervalMs);
  }

  private set(active: boolean): void {
    if (active === this.current) return;
    this.current = active;
    this.changed.emit(active);
  }
}
