import type { AddressPolicy } from "./address.js";
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
  // Safrochain first: it is this product's own chain, and it was missing here,
  // so every Safrochain address was refused as "prefix_not_served".
  { chainId: "safrochain-1", rest: "https://api.safrochain.network" },
  { chainId: "safro-testnet-1", rest: "https://rest.testnet.safrochain.com" },
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

/** bech32 prefix per chain the indexer can actually serve (see DEFAULT_LCD_ENDPOINTS). */
export const CHAIN_ADDRESS_PREFIXES: Readonly<Record<string, string>> = {
  // Mainnet and testnet share the "addr_safro" hrp, so the chainId is what
  // separates them; chainPrefixes is keyed by chainId precisely for this.
  "safrochain-1": "addr_safro",
  "safro-testnet-1": "addr_safro",
  "cosmoshub-4": "cosmos",
  "osmosis-1": "osmo",
  "akashnet-2": "akash",
  "noble-1": "noble",
};

export const DEFAULT_ADDRESS_POLICY: AddressPolicy = {
  allowedPrefixes: [...new Set(Object.values(CHAIN_ADDRESS_PREFIXES))],
  chainPrefixes: CHAIN_ADDRESS_PREFIXES,
  // 32 symbols = a 20-byte account; 103 covers a 64-byte value within bech32's 90-char cap.
  minDataLength: 32,
  maxDataLength: 103,
};

/**
 * Default is closed: only the chains with endpoints are accepted, so a request
 * for a chain the indexer cannot read is refused with a reason instead of
 * answering with a permanently empty history.
 * INDEXER_ALLOWED_ADDRESS_PREFIXES: comma-separated hrps, or "*" for any.
 */
export function loadAddressPolicy(
  overrides: Partial<AddressPolicy> = {},
): AddressPolicy {
  const raw = process.env.INDEXER_ALLOWED_ADDRESS_PREFIXES?.trim();
  let allowedPrefixes = DEFAULT_ADDRESS_POLICY.allowedPrefixes;
  if (raw === "*") {
    allowedPrefixes = "any";
  } else if (raw) {
    const parsed = raw
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    if (parsed.length > 0) allowedPrefixes = parsed;
  }
  return { ...DEFAULT_ADDRESS_POLICY, allowedPrefixes, ...overrides };
}

export interface SubscriptionLimits {
  /** Hard cap on wallets the detectors will watch; each costs 2 websockets. */
  maxWallets: number;
  /** New wallets one authenticated caller may add within idleTtlMs. */
  maxWalletsPerCaller: number;
  /** Same, for an unauthenticated caller (development only — see loadSubscribeAuth). */
  maxWalletsPerAnonymousCaller: number;
  /** A wallet not read within this window stops being watched. */
  idleTtlMs: number;
  /** Lower bound between eviction sweeps. */
  evictionIntervalMs: number;
}

export const DEFAULT_SUBSCRIPTION_LIMITS: SubscriptionLimits = {
  maxWallets: 2000,
  maxWalletsPerCaller: 200,
  maxWalletsPerAnonymousCaller: 25,
  idleTtlMs: 72 * 60 * 60 * 1000,
  evictionIntervalMs: 5 * 60 * 1000,
};

export function loadSubscriptionLimits(
  overrides: Partial<SubscriptionLimits> = {},
): SubscriptionLimits {
  return {
    maxWallets: numEnv("INDEXER_MAX_WATCHED_WALLETS", DEFAULT_SUBSCRIPTION_LIMITS.maxWallets),
    maxWalletsPerCaller: numEnv(
      "INDEXER_MAX_WALLETS_PER_CALLER",
      DEFAULT_SUBSCRIPTION_LIMITS.maxWalletsPerCaller,
    ),
    maxWalletsPerAnonymousCaller: numEnv(
      "INDEXER_MAX_WALLETS_PER_ANON_CALLER",
      DEFAULT_SUBSCRIPTION_LIMITS.maxWalletsPerAnonymousCaller,
    ),
    idleTtlMs:
      numEnv("INDEXER_WALLET_IDLE_TTL_HOURS", DEFAULT_SUBSCRIPTION_LIMITS.idleTtlMs / 3_600_000) *
      3_600_000,
    evictionIntervalMs: DEFAULT_SUBSCRIPTION_LIMITS.evictionIntervalMs,
    ...overrides,
  };
}

export interface SubscribeAuthConfig {
  /** Shared secrets accepted on the subscribe header. */
  tokens: string[];
  /** When true an unauthenticated caller may not register a wallet. */
  enforced: boolean;
}

/** Header carrying the subscribe token. Distinct from x-api-key, which only
 *  says "a Zunia service is calling" and is shared by every read path. */
export const SUBSCRIBE_TOKEN_HEADER = "x-zunia-subscribe-token";
/** Optional caller-scoped identity (a verified device session subject) used for
 *  per-user quota. Opaque to the indexer. */
export const SUBSCRIBE_SUBJECT_HEADER = "x-zunia-subject";

export const MIN_SUBSCRIBE_TOKEN_LENGTH = 24;

/**
 * INDEXER_SUBSCRIBE_TOKEN: comma-separated shared secrets.
 * Unset in production still means enforced — registration then fails with
 * "subscribe_not_configured" rather than silently accepting anonymous callers.
 */
export function loadSubscribeAuth(): SubscribeAuthConfig {
  const configured = (process.env.INDEXER_SUBSCRIBE_TOKEN ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  // A token too short to resist guessing is dropped, not accepted quietly: the
  // deployment then denies every registration instead of holding the door open.
  const tokens = configured.filter((t) => t.length >= MIN_SUBSCRIBE_TOKEN_LENGTH);
  return {
    tokens,
    enforced: configured.length > 0 || process.env.NODE_ENV === "production",
  };
}

