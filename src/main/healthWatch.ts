import type { HealthCheck } from "../shared/adapter";

export interface HealthWatchDeps {
  /** Each running service's checks, and whether it is signed in, by service id. */
  checks(): Map<string, { signedIn: boolean; checks: HealthCheck[] }>;
  /** Checks of this service have started failing. */
  onBroken(serviceId: string, broken: HealthCheck[]): void;
  intervalMs?: number;
  /** Checks fail while a service is still starting; nothing is reported this soon. */
  graceMs?: number;
}

/**
 * The study's health-check harness, in the running app: integration points
 * (e.g. Discord's hooks after a Discord update) are checked now and then,
 * and one that fails (after working, or at all while signed in) is
 * reported once, so the user learns why something stopped working and
 * where to look.
 */
export class HealthWatch {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly seenOk = new Set<string>();
  private readonly reported = new Set<string>();
  private startedAt = 0;

  constructor(private readonly deps: HealthWatchDeps) {}

  start(now = Date.now()): void {
    if (this.timer) return;
    this.startedAt = now;
    this.timer = setInterval(() => this.check(), this.deps.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One round of checks; exposed for tests. */
  check(now = Date.now()): void {
    const settled = now - this.startedAt >= (this.deps.graceMs ?? 120_000);
    for (const [service, { signedIn, checks }] of this.deps.checks()) {
      const broken: HealthCheck[] = [];
      for (const check of checks) {
        const key = `${service}\n${check.name}`;
        if (check.ok) {
          this.seenOk.add(key);
          this.reported.delete(key); // working again: a later failure is news
        } else if (settled && (signedIn || this.seenOk.has(key)) && !this.reported.has(key)) {
          this.reported.add(key);
          broken.push(check);
        }
      }
      if (broken.length > 0) this.deps.onBroken(service, broken);
    }
  }
}
