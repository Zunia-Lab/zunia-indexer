import {
  DEFAULT_HISTORY_CONFIG,
  type HistoryConfig,
  type LcdEndpoint,
} from "./types.js";

export function loadHistoryConfig(
  overrides: Partial<HistoryConfig> = {},
): HistoryConfig {
  return {
    ...DEFAULT_HISTORY_CONFIG,
    firstConnectLimit: numEnv("INDEXER_FIRST_CONNECT_LIMIT", DEFAULT_HISTORY_CONFIG.firstConnectLimit),
    maxTxsPerWallet: numEnv("INDEXER_MAX_TXS_PER_WALLET", DEFAULT_HISTORY_CONFIG.maxTxsPerWallet),
    refreshPageSize: numEnv("INDEXER_REFRESH_PAGE_SIZE", DEFAULT_HISTORY_CONFIG.refreshPageSize),
    maxQueryLimit: numEnv("INDEXER_MAX_QUERY_LIMIT", DEFAULT_HISTORY_CONFIG.maxQueryLimit),
    ...overrides,
  };
}

function numEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Built-in LCD REST bases for common Cosmos chains (override via env / registry later). */
export const DEFAULT_LCD_ENDPOINTS: LcdEndpoint[] = [
  { chainId: "cosmoshub-4", rest: "https://cosmos-rest.publicnode.com" },
  { chainId: "osmosis-1", rest: "https://osmosis-rest.publicnode.com" },
  { chainId: "akashnet-2", rest: "https://akash-rest.publicnode.com" },
  { chainId: "noble-1", rest: "https://noble-rest.publicnode.com" },
];

export function resolveLcd(
  chainId: string,
  endpoints: LcdEndpoint[] = DEFAULT_LCD_ENDPOINTS,
): string | undefined {
  return endpoints.find((e) => e.chainId === chainId)?.rest;
}
