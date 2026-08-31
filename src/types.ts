export interface HistoryConfig {
  firstConnectLimit: number;
  maxTxsPerWallet: number;
  refreshPageSize: number;
  maxQueryLimit: number;
}

/** Defaults match config/history.yaml */
export const DEFAULT_HISTORY_CONFIG: HistoryConfig = {
  firstConnectLimit: 5,
  maxTxsPerWallet: 50,
  refreshPageSize: 20,
  maxQueryLimit: 50,
};

export interface TxRecord {
  chainId: string;
  address: string;
  txHash: string;
  height?: number;
  timestamp?: string;
  success: boolean;
  summary: string;
  /** Minimal fields only — avoid storing full LCD payloads forever */
  messages?: string[];
}

export interface WatchedWallet {
  chainId: string;
  address: string;
  firstSeenAt: string;
  lastRefreshAt?: string;
}

export interface GetHistoryResult {
  txs: TxRecord[];
  /** True when this address was not watched before this call */
  firstConnect: boolean;
  /** Cap applied in store */
  maxStored: number;
  source: "cache" | "lcd" | "mixed";
}

export interface LcdEndpoint {
  chainId: string;
  rest: string;
}
