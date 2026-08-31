import { resolveLcd } from "../config.js";
import { fetchLcdTxs } from "../lcd/client.js";
import type { HistoryStore } from "../store/memory.js";
import type { LcdEndpoint } from "../types.js";
import type { TxEventPublisher } from "./queue.js";
import type { SubscriptionRegistry } from "./subscriptions.js";
import type { TxDetectedEvent } from "./types.js";

/**
 * Optimized fallback: poll LCD only for subscribed platform wallets.
 * Emits events for hashes not already in cache.
 */
export class LcdPollDetector {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly registry: SubscriptionRegistry,
    private readonly store: HistoryStore,
    private readonly publisher: TxEventPublisher,
    private readonly endpoints: LcdEndpoint[],
    private readonly intervalSec: number,
    private readonly limitPerWallet: number,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalSec * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const wallets = await this.registry.list();
      for (const w of wallets) {
        const rest = resolveLcd(w.chainId, this.endpoints);
        if (!rest) continue;
        const rows = await fetchLcdTxs({
          rest,
          chainId: w.chainId,
          address: w.address,
          limit: this.limitPerWallet,
        });
        for (const row of rows) {
          const known = this.store.hasTx
            ? await this.store.hasTx(w.chainId, w.address, row.txHash)
            : false;
          if (known) continue;
          const event: TxDetectedEvent = {
            chainId: w.chainId,
            address: w.address,
            txHash: row.txHash,
            detectedAt: new Date().toISOString(),
            source: "poll",
          };
          await this.publisher.publish(event);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
