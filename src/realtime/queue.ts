import type { TxDetectedEvent } from "./types.js";

export interface TxEventPublisher {
  publish(event: TxDetectedEvent): Promise<void>;
}

export type TxEventHandler = (event: TxDetectedEvent) => Promise<void>;

/** In-process queue for the always-on indexer worker */
export class LocalTxEventQueue implements TxEventPublisher {
  private readonly seen = new Set<string>();
  private readonly pending: TxDetectedEvent[] = [];
  private pumping = false;

  constructor(private readonly handler: TxEventHandler) {}

  async publish(event: TxDetectedEvent): Promise<void> {
    const id = dedupeKey(event);
    if (this.seen.has(id)) return;
    this.seen.add(id);
    // Bound memory of dedupe set
    if (this.seen.size > 50_000) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }
    this.pending.push(event);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pending.length) {
        const next = this.pending.shift();
        if (!next) break;
        await this.handler(next);
      }
    } finally {
      this.pumping = false;
      if (this.pending.length) void this.pump();
    }
  }
}

/**
 * Optional fan-out to Vercel Queues (when VERCEL_QUEUE_ENABLED=true).
 * Uses official `@vercel/queue` send() + idempotencyKey = chainId:txHash.
 * Failures are swallowed so the local worker keeps working without Vercel creds.
 */
export class VercelTxEventPublisher implements TxEventPublisher {
  constructor(private readonly topic: string) {}

  async publish(event: TxDetectedEvent): Promise<void> {
    try {
      const mod = await import("@vercel/queue");
      await mod.send(this.topic, event, {
        idempotencyKey: dedupeKey(event),
        retentionSeconds: 3600,
      });
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err as { name: string }).name === "DuplicateMessageError"
      ) {
        return;
      }
      console.warn(
        "[realtime] vercel queue publish skipped:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export class CompositeTxEventPublisher implements TxEventPublisher {
  constructor(private readonly publishers: TxEventPublisher[]) {}

  async publish(event: TxDetectedEvent): Promise<void> {
    await Promise.all(this.publishers.map((p) => p.publish(event)));
  }
}

export function dedupeKey(event: Pick<TxDetectedEvent, "chainId" | "txHash">): string {
  return `${event.chainId}:${event.txHash}`;
}
