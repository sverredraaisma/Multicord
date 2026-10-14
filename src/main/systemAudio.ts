/**
 * Screen-share audio on Linux, where Chromium cannot capture system sound:
 * venmic (the PipeWire helper Vesktop uses) routes what the speakers play,
 * minus Multicord's own sound, into a virtual microphone (VIRTUAL_MIC in
 * shared/ipc), which the sharing page then adds to its stream.
 */

/** The parts of venmic's PatchBay used here. */
export interface PatchBayLike {
  link(data: { exclude: Record<string, string>[]; only_speakers?: boolean; only_default_speakers?: boolean; ignore_devices?: boolean }): boolean;
  unlink(): void;
}

export interface Venmic {
  PatchBay: { new (): PatchBayLike; hasPipeWire(): boolean };
}

/** venmic, when installed (it ships for Linux only) and loadable. */
export function loadVenmic(): Venmic | undefined {
  try {
    return require("@vencord/venmic") as Venmic;
  } catch {
    return undefined;
  }
}

export class SystemAudio {
  private bay: PatchBayLike | undefined;
  private checked = false;
  private venmic: Venmic | undefined;

  constructor(
    private readonly load: () => Venmic | undefined,
    /** Multicord's own process ids, whose sound stays out of the share. */
    private readonly ownProcesses: () => number[],
  ) {}

  private get lib(): Venmic | undefined {
    if (!this.checked) {
      this.checked = true;
      const venmic = this.load();
      try {
        this.venmic = venmic?.PatchBay.hasPipeWire() ? venmic : undefined;
      } catch {
        this.venmic = undefined;
      }
    }
    return this.venmic;
  }

  /** Whether system sound can be shared here (venmic is there and PipeWire runs). */
  available(): boolean {
    return this.lib !== undefined;
  }

  /** Starts routing the speakers' sound into the virtual microphone; false when it could not. */
  start(): boolean {
    const lib = this.lib;
    if (!lib) return false;
    try {
      this.bay ??= new lib.PatchBay();
      this.bay.unlink();
      return this.bay.link({
        exclude: this.ownProcesses().map((pid) => ({ "application.process.id": String(pid) })),
        only_speakers: true,
        only_default_speakers: true,
        ignore_devices: true,
      });
    } catch {
      return false;
    }
  }

  stop(): void {
    try {
      this.bay?.unlink();
    } catch {
      // Already gone with PipeWire.
    }
  }
}
