import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthWatch } from "../../src/main/healthWatch";
import type { HealthCheck } from "../../src/shared/adapter";

const ok = (name: string): HealthCheck => ({ name, ok: true });
const failed = (name: string): HealthCheck => ({ name, ok: false, detail: "Rail" });

describe("HealthWatch", () => {
  afterEach(() => vi.useRealTimers());

  it("reports a check that stops working once, and again after it recovered", () => {
    let checks = [ok("Server list"), ok("DMs")];
    const onBroken = vi.fn();
    const watch = new HealthWatch({ checks: () => new Map([["discord", { signedIn: false, checks }]]), onBroken, graceMs: 1000 });
    watch.start(0);
    watch.check(10);
    checks = [failed("Server list"), ok("DMs")];
    watch.check(500); // still starting up
    expect(onBroken).not.toHaveBeenCalled();
    watch.check(1500);
    watch.check(2500);
    expect(onBroken).toHaveBeenCalledTimes(1);
    expect(onBroken).toHaveBeenCalledWith("discord", [failed("Server list")]);
    checks = [ok("Server list"), ok("DMs")];
    watch.check(3000);
    checks = [failed("Server list"), failed("DMs")];
    watch.check(4000);
    expect(onBroken).toHaveBeenLastCalledWith("discord", [failed("Server list"), failed("DMs")]);
    watch.stop();
  });

  it("reports checks that never worked only while the service is signed in", () => {
    let signedIn = false;
    const onBroken = vi.fn();
    const watch = new HealthWatch({ checks: () => new Map([["discord", { signedIn, checks: [failed("Bridge")] }]]), onBroken, graceMs: 0 });
    watch.start(0);
    watch.check(1);
    expect(onBroken).not.toHaveBeenCalled();
    signedIn = true;
    watch.check(2);
    expect(onBroken).toHaveBeenCalledWith("discord", [failed("Bridge")]);
  });

  it("checks on a timer while started", () => {
    vi.useFakeTimers();
    const checks = vi.fn(() => new Map());
    const watch = new HealthWatch({ checks, onBroken: vi.fn(), intervalMs: 1000 });
    watch.start();
    watch.start(); // once
    vi.advanceTimersByTime(3000);
    expect(checks).toHaveBeenCalledTimes(3);
    watch.stop();
    vi.advanceTimersByTime(3000);
    expect(checks).toHaveBeenCalledTimes(3);
  });
});
