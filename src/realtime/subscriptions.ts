import type { HistoryStore } from "../store/memory.js";
import type { WatchedWallet } from "../types.js";

/** Platform wallets only — from history registration / explicit subscribe */
export class SubscriptionRegistry {
  constructor(private readonly store: HistoryStore) {}

  list(): Promise<WatchedWallet[]> {
    return this.store.listWallets();
  }

  async ensure(chainId: string, address: string): Promise<void> {
    const existing = await this.store.getWallet(chainId, address);
    const now = new Date().toISOString();
    if (existing) {
      await this.store.upsertWallet({ ...existing, lastRefreshAt: now });
      return;
    }
    await this.store.upsertWallet({
      chainId,
      address,
      firstSeenAt: now,
      lastRefreshAt: now,
    });
  }
}
