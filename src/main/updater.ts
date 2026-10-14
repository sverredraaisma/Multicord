import { Emitter } from "../shared/emitter";
import type { UpdateStatus } from "../shared/settings";

/** The parts of electron-updater's autoUpdater used here. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Keeps Multicord up to date from its GitHub releases (electron-updater
 * checks the published hashes). Only packaged builds update; a development
 * run reports "unavailable". Checks run at start and every few hours while
 * automatic updates are on, and on request.
 */
export class Updater {
  private current: UpdateStatus;
  private timer: ReturnType<typeof setInterval> | undefined;
  readonly changed = new Emitter<UpdateStatus>();

  constructor(
    private readonly updater: UpdaterLike,
    private readonly packaged: boolean,
  ) {
    this.current = packaged ? { state: "idle" } : { state: "unavailable" };
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on("checking-for-update", () => this.set({ state: "checking" }));
    updater.on("update-not-available", () => this.set({ state: "none" }));
    updater.on("update-available", (info: { version?: string }) => this.set({ state: "downloading", version: String(info?.version ?? ""), percent: 0 }));
    updater.on("download-progress", (progress: { percent?: number }) => {
      if (this.current.state === "downloading") this.set({ ...this.current, percent: Math.round(progress?.percent ?? 0) });
    });
    updater.on("update-downloaded", (info: { version?: string }) => this.set({ state: "ready", version: String(info?.version ?? "") }));
    updater.on("error", (error: Error) => this.set({ state: "error", message: error?.message ?? String(error) }));
  }

  get status(): UpdateStatus {
    return this.current;
  }

  /** Turns periodic checks on or off; turning them on checks right away. */
  setAutomatic(on: boolean): void {
    clearInterval(this.timer);
    this.timer = undefined;
    if (!on || !this.packaged) return;
    void this.check();
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    (this.timer as { unref?(): void }).unref?.();
  }

  async check(): Promise<void> {
    if (!this.packaged || this.current.state === "checking" || this.current.state === "downloading" || this.current.state === "ready") return;
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.set({ state: "error", message: (error as Error).message });
    }
  }

  /** Restarts into a downloaded update. */
  install(): void {
    if (this.current.state === "ready") this.updater.quitAndInstall();
  }

  private set(status: UpdateStatus): void {
    this.current = status;
    this.changed.emit(status);
  }
}
