// Interactive verification between the user's own devices by comparing
// emoji (SAS, m.sas.v1), over the crypto library's verification state
// machine. The library checks every verification event itself; this file
// moves a flow along where there is nothing for the user to decide
// (starting and accepting the emoji comparison), sends what the library
// asks to send, and tells the adapter what to show. A flow that hears
// nothing for ten minutes is cancelled, as the spec asks.

import {
  Sas,
  VerificationMethod,
  VerificationRequestPhase,
  type RoomMessageRequest,
  type SignatureUploadRequest,
  type ToDeviceRequest,
  type VerificationRequest,
} from "@matrix-org/matrix-sdk-crypto-wasm";

/** The spec's timeout for a verification that hears nothing. */
export const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
/** Only emoji (and the numbers that come with them); no QR codes. */
export const SAS_METHODS = [VerificationMethod.SasV1];
const CODE = /^[A-Za-z0-9._-]{1,64}$/;

export interface SasEmoji {
  symbol: string;
  /** Its English name from the spec's list, e.g. "Dog". */
  name: string;
}

/** What the adapter shows for a verification. */
export type VerificationState =
  /** Another device asked and waits for an answer here. */
  | { phase: "incoming"; device: string }
  /** Waiting for the other device: to accept, or for the emoji to be worked out. */
  | { phase: "waiting"; device: string }
  | { phase: "emoji"; emoji: SasEmoji[] }
  /** We said the emoji match; waiting for the other device to say so too. */
  | { phase: "confirmed" }
  | { phase: "done" }
  | { phase: "cancelled"; reason: string; byUs: boolean };

/** One verification with another of the user's devices. */
export interface Verification {
  /** We asked; else another device did. */
  readonly outgoing: boolean;
  state(): VerificationState;
  /** Accepts another device's request. */
  accept(): Promise<void>;
  /** The emoji match. */
  confirm(): Promise<void>;
  /** Declines or stops it; `mismatch` when the emoji differ. */
  cancel(mismatch?: boolean): Promise<void>;
  onChange(callback: () => void): void;
}

export type VerificationOutgoing = ToDeviceRequest | RoomMessageRequest | SignatureUploadRequest;

/** What a flow needs from the crypto state. */
export interface FlowHost {
  send(request: VerificationOutgoing): Promise<void>;
  /** Sends whatever else the library queued. */
  flush(): Promise<void>;
  /** Called once when the flow succeeds. */
  done(): Promise<void>;
  log(message: string): void;
}

const REASONS: Record<string, string> = {
  "m.user": "it was cancelled on the other device",
  "m.timeout": "it took too long: nothing happened for 10 minutes",
  "m.mismatched_sas": "the emoji did not match",
  "m.key_mismatch": "the devices' keys did not match",
  "m.user_mismatch": "the other device belongs to another account",
  "m.accepted": "another of your devices answered it",
  "m.unknown_method": "the other device cannot compare emoji",
  "m.unexpected_message": "a message arrived out of order",
  "m.invalid_message": "a message was not valid",
};

/** Why a verification was cancelled, in a few words; the other side's code is untrusted, so only known codes are named. */
export function cancelReason(code: string, byUs: boolean): string {
  if (byUs && code === "m.user") return "you cancelled it";
  const known = REASONS[code];
  if (known) return known;
  return CODE.test(code) ? `it was cancelled (${code})` : "it was cancelled";
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class SasFlow implements Verification {
  private sas: Sas | undefined;
  private started = false;
  private finished = false;
  private expired = false;
  private deadline = Date.now() + VERIFY_TIMEOUT_MS;
  private changed: () => void = () => {};
  /** Steps run one at a time; a failed one is logged and does not stop the next. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly request: VerificationRequest,
    private readonly host: FlowHost,
    /** The other device, as the user knows it. */
    readonly device: string,
  ) {
    request.registerChangesCallback(async () => this.update());
  }

  get outgoing(): boolean {
    return this.request.weStarted();
  }

  onChange(callback: () => void): void {
    this.changed = callback;
  }

  private run(step: () => Promise<void>): Promise<void> {
    const next = this.queue.then(step);
    this.queue = next.catch((error: unknown) => this.host.log(`Verification: ${messageOf(error)}`));
    return next;
  }

  /** The library saw news for this flow. */
  private update(): Promise<void> {
    this.deadline = Date.now() + VERIFY_TIMEOUT_MS;
    return this.run(() => this.advance());
  }

  /** Starts and accepts the emoji comparison by itself, and wraps up once done; then tells the adapter. */
  private async advance(): Promise<void> {
    const request = this.request;
    if (this.active() && request.phase() === VerificationRequestPhase.Ready && !this.started) {
      // Either side may start; when both do, the spec picks one.
      this.started = true;
      const started = await request.startSas();
      if (started) await this.host.send(started[1]);
    }
    const sas = request.getVerification();
    if (!this.sas && sas instanceof Sas) {
      this.sas = sas;
      sas.registerChangesCallback(async () => this.update());
      // Accepts the other side's start; nothing to accept when we started.
      const accept = sas.accept();
      if (accept) await this.host.send(accept);
    }
    if (!this.finished && this.isDone()) {
      this.finished = true;
      await this.host.done();
    }
    this.changed();
  }

  private isDone(): boolean {
    return this.request.isDone() || this.sas?.isDone() === true;
  }

  private isCancelled(): boolean {
    return this.expired || this.request.isCancelled() || this.sas?.isCancelled() === true;
  }

  /** Neither done nor cancelled. */
  active(): boolean {
    return !this.isDone() && !this.isCancelled();
  }

  state(): VerificationState {
    const request = this.request;
    const sas = this.sas;
    if (this.expired) return { phase: "cancelled", reason: cancelReason("m.timeout", true), byUs: true };
    if (this.isCancelled()) {
      const info = sas?.cancelInfo() ?? request.cancelInfo;
      const byUs = info?.cancelledbyUs() ?? false;
      return { phase: "cancelled", reason: cancelReason(info?.cancelCode() ?? "", byUs), byUs };
    }
    if (this.isDone()) return { phase: "done" };
    if (sas?.haveWeConfirmed()) return { phase: "confirmed" };
    const emoji = sas?.canBePresented() ? sas.emoji() : undefined;
    if (emoji) return { phase: "emoji", emoji: emoji.map((e) => ({ symbol: e.symbol, name: e.description })) };
    if (!request.weStarted() && request.phase() === VerificationRequestPhase.Requested) return { phase: "incoming", device: this.device };
    return { phase: "waiting", device: this.device };
  }

  async accept(): Promise<void> {
    await this.run(async () => {
      const accept = this.request.acceptWithMethods(SAS_METHODS);
      if (accept) await this.host.send(accept);
      await this.advance();
    });
  }

  async confirm(): Promise<void> {
    await this.run(async () => {
      const sas = this.sas;
      if (!sas?.canBePresented()) return;
      // The MAC and done messages, and for self-verification the signature of the other device.
      for (const request of await sas.confirm()) await this.host.send(request as VerificationOutgoing);
      await this.host.flush();
      await this.advance();
    });
  }

  async cancel(mismatch = false): Promise<void> {
    await this.run(async () => {
      const sas = this.sas;
      const request = sas ? (mismatch ? sas.cancelWithCode("m.mismatched_sas") : sas.cancel()) : this.request.cancel();
      if (request) await this.host.send(request);
      this.changed();
    });
  }

  /** Cancels a flow that heard nothing for too long; returns whether it is still going. */
  async expireIfDue(now = Date.now()): Promise<boolean> {
    if (!this.active()) return false;
    if (now < this.deadline && !this.request.timedOut() && !this.sas?.timedOut()) return true;
    this.expired = true;
    await this.run(async () => {
      const request = this.sas?.cancelWithCode("m.timeout") ?? this.request.cancel();
      if (request) await this.host.send(request);
      this.changed();
    });
    return false;
  }
}
