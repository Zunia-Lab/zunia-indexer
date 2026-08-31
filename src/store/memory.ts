import type { TxRecord, WatchedWallet } from "../types.js";

export interface HistoryStore {
  getWallet(chainId: string, address: string): Promise<WatchedWallet | undefined>;
  upsertWallet(wallet: WatchedWallet): Promise<void>;
  listWallets(): Promise<WatchedWallet[]>;
  listTxs(chainId: string, address: string, limit: number): Promise<TxRecord[]>;
  upsertTxs(txs: TxRecord[]): Promise<void>;
  /** Keep only the newest `max` txs for this wallet */
  trim(chainId: string, address: string, max: number): Promise<void>;
  hasTx?(chainId: string, address: string, txHash: string): Promise<boolean>;
}

function key(chainId: string, address: string): string {
  return `${chainId}::${address}`;
}

/** In-process store — fine for scaffold / single node; swap for SQLite/Postgres using sql/schema.sql */
export class MemoryHistoryStore implements HistoryStore {
  private wallets = new Map<string, WatchedWallet>();
  private txs = new Map<string, TxRecord[]>();

  async getWallet(chainId: string, address: string) {
    return this.wallets.get(key(chainId, address));
  }

  async upsertWallet(wallet: WatchedWallet) {
    this.wallets.set(key(wallet.chainId, wallet.address), wallet);
  }

  async listWallets() {
    return [...this.wallets.values()];
  }

  async listTxs(chainId: string, address: string, limit: number) {
    const list = this.txs.get(key(chainId, address)) ?? [];
    return list
      .slice()
      .sort(compareTxNewestFirst)
      .slice(0, limit);
  }

  async upsertTxs(txs: TxRecord[]) {
    for (const tx of txs) {
      const k = key(tx.chainId, tx.address);
      const list = this.txs.get(k) ?? [];
      const idx = list.findIndex((t) => t.txHash === tx.txHash);
      if (idx >= 0) list[idx] = tx;
      else list.push(tx);
      this.txs.set(k, list);
    }
  }

  async trim(chainId: string, address: string, max: number) {
    const k = key(chainId, address);
    const list = this.txs.get(k) ?? [];
    const kept = list.slice().sort(compareTxNewestFirst).slice(0, max);
    this.txs.set(k, kept);
  }

  async hasTx(chainId: string, address: string, txHash: string) {
    const list = this.txs.get(key(chainId, address)) ?? [];
    return list.some((t) => t.txHash === txHash);
  }
}

export function compareTxNewestFirst(a: TxRecord, b: TxRecord): number {
  const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
  const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
  if (tb !== ta) return tb - ta;
  return (b.height ?? 0) - (a.height ?? 0);
}
