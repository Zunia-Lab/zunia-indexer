import { resolveLcd } from "../config.js";
import { fetchLcdTxs } from "../lcd/client.js";
import type { HistoryStore } from "../store/memory.js";
import type {
  GetHistoryResult,
  HistoryConfig,
  LcdEndpoint,
  TxRecord,
} from "../types.js";

export class TxHistoryService {
  constructor(
    private readonly store: HistoryStore,
    private readonly config: HistoryConfig,
    private readonly endpoints: LcdEndpoint[],
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Register a platform wallet and return history.
   * First connect → at most `firstConnectLimit` (default 5) txs from LCD, then cache.
   * Later → cache first, refresh from LCD up to refreshPageSize, trim to max.
   */
  async getHistory(input: {
    chainId: string;
    address: string;
    forceRefresh?: boolean;
  }): Promise<GetHistoryResult> {
    const address = input.address.trim();
    const chainId = input.chainId.trim();
    if (!address || !chainId) {
      throw new Error("chainId and address are required");
    }

    const existing = await this.store.getWallet(chainId, address);
    const firstConnect = !existing;
    const now = new Date().toISOString();

    if (firstConnect) {
      await this.store.upsertWallet({
        chainId,
        address,
        firstSeenAt: now,
        lastRefreshAt: now,
      });
      const fetched = await this.pullFromLcd(
        chainId,
        address,
        this.config.firstConnectLimit,
      );
      await this.persist(fetched, chainId, address);
      return {
        txs: fetched.slice(0, this.config.firstConnectLimit),
        firstConnect: true,
        maxStored: this.config.maxTxsPerWallet,
        source: "lcd",
      };
    }

    const cached = await this.store.listTxs(
      chainId,
      address,
      this.config.maxTxsPerWallet,
    );

    if (!input.forceRefresh && cached.length > 0) {
      return {
        txs: cached.slice(0, this.config.refreshPageSize),
        firstConnect: false,
        maxStored: this.config.maxTxsPerWallet,
        source: "cache",
      };
    }

    const fetched = await this.pullFromLcd(
      chainId,
      address,
      Math.min(this.config.refreshPageSize, this.config.maxQueryLimit),
    );
    await this.persist(fetched, chainId, address);
    await this.store.upsertWallet({
      chainId,
      address,
      firstSeenAt: existing.firstSeenAt,
      lastRefreshAt: now,
    });

    const merged = await this.store.listTxs(
      chainId,
      address,
      this.config.refreshPageSize,
    );
    return {
      txs: merged,
      firstConnect: false,
      maxStored: this.config.maxTxsPerWallet,
      source: fetched.length ? "mixed" : "cache",
    };
  }

  private async pullFromLcd(
    chainId: string,
    address: string,
    limit: number,
  ): Promise<TxRecord[]> {
    const rest = resolveLcd(chainId, this.endpoints);
    if (!rest) {
      return [];
    }
    return fetchLcdTxs({
      rest,
      chainId,
      address,
      limit,
      fetchImpl: this.fetchImpl,
    });
  }

  private async persist(
    txs: TxRecord[],
    chainId: string,
    address: string,
  ): Promise<void> {
    if (txs.length) await this.store.upsertTxs(txs);
    await this.store.trim(chainId, address, this.config.maxTxsPerWallet);
  }
}
