import type { PageKeys } from "../core/modules";
import type { ShortcutAction, ShortcutSettings } from "../shared/settings";

/** The parts of Electron's globalShortcut used here. */
export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/**
 * The user's system-wide shortcuts. Applying a new set replaces the old one
 * entirely; shortcuts another app already holds are reported, not forced.
 */
export class GlobalShortcuts {
  private readonly active = new Map<ShortcutAction, string>();

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly run: (action: ShortcutAction) => void,
  ) {}

  /** Registers these shortcuts; returns the actions whose shortcut could not be had. */
  apply(shortcuts: ShortcutSettings): ShortcutAction[] {
    this.clear();
    const failed: ShortcutAction[] = [];
    for (const [action, accelerator] of Object.entries(shortcuts) as [ShortcutAction, string | null][]) {
      if (!accelerator) continue;
      let ok = false;
      try {
        ok = this.registry.register(accelerator, () => this.run(action));
      } catch {
        ok = false; // Electron throws for accelerators it cannot parse.
      }
      if (ok) this.active.set(action, accelerator);
      else failed.push(action);
    }
    return failed;
  }

  clear(): void {
    for (const accelerator of this.active.values()) this.registry.unregister(accelerator);
    this.active.clear();
  }
}

/** Electron input event modifiers for a page key on this OS. */
export function inputModifiers(keys: PageKeys, platform: NodeJS.Platform): ("control" | "meta" | "shift" | "alt")[] {
  return keys.modifiers.map((m) => (m === "commandOrControl" ? (platform === "darwin" ? "meta" : "control") : m));
}
