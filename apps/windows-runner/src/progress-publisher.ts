import type { WindowsAuthoringProgress } from '@forgemind/core';

/**
 * Keeps authoring telemetry useful without allowing high-volume Codex activity
 * to consume the control-plane rate limit. Calls are non-blocking and only the
 * newest update waiting behind an in-flight request is retained.
 */
export class CoalescedAuthoringProgressPublisher {
  private pending: WindowsAuthoringProgress | undefined;
  private delivery: Promise<void> | undefined;
  private lastDeliveryAt = 0;

  constructor(
    private readonly send: (progress: WindowsAuthoringProgress) => Promise<unknown>,
    private readonly minimumIntervalMs = 5_000
  ) {}

  publish(progress: WindowsAuthoringProgress): Promise<void> {
    this.pending = progress;
    this.ensureDelivery();
    return Promise.resolve();
  }

  async flush(): Promise<void> {
    this.ensureDelivery();
    while (this.delivery) await this.delivery;
  }

  private ensureDelivery(): void {
    if (this.delivery || !this.pending) return;
    this.delivery = this.deliver().finally(() => {
      this.delivery = undefined;
      this.ensureDelivery();
    });
  }

  private async deliver(): Promise<void> {
    while (this.pending) {
      const waitMs = Math.max(0, this.minimumIntervalMs - (Date.now() - this.lastDeliveryAt));
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const progress = this.pending;
      this.pending = undefined;
      try { await this.send(progress); } catch { /* progress is best-effort; checkpoints remain durable locally */ }
      this.lastDeliveryAt = Date.now();
    }
  }
}
