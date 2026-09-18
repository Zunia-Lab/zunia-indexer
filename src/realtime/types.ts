export interface RpcEndpoint {
  chainId: string;
  /** Tendermint / CometBFT RPC base (http/https). WS = replace http→ws + /websocket */
  rpc: string;
}

export const DEFAULT_RPC_ENDPOINTS: RpcEndpoint[] = [
  { chainId: "cosmoshub-4", rpc: "https://cosmos-rpc.publicnode.com" },
  { chainId: "osmosis-1", rpc: "https://osmosis-rpc.publicnode.com" },
  { chainId: "akashnet-2", rpc: "https://akash-rpc.publicnode.com" },
  { chainId: "noble-1", rpc: "https://noble-rpc.publicnode.com" },
];

export function resolveRpc(
  chainId: string,
  endpoints: RpcEndpoint[] = DEFAULT_RPC_ENDPOINTS,
): string | undefined {
  return resolveRpcEndpoints(chainId, endpoints)[0];
}

/** All RPC URLs for a chain (primary + failover mirrors). */
export function resolveRpcEndpoints(
  chainId: string,
  endpoints: RpcEndpoint[] = DEFAULT_RPC_ENDPOINTS,
): string[] {
  return endpoints.filter((e) => e.chainId === chainId).map((e) => e.rpc);
}

export function rpcToWebsocketUrl(rpc: string): string {
  const u = new URL(rpc.replace(/\/$/, ""));
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/$/, "")}/websocket`;
  return u.toString();
}

export type RealtimeMode = "ws" | "poll" | "hybrid";

export interface RealtimeConfig {
  enabled: boolean;
  mode: RealtimeMode;
  pollIntervalSec: number;
  pollLimitPerWallet: number;
  queueTopic: string;
  useVercelQueue: boolean;
}

export function loadRealtimeConfig(): RealtimeConfig {
  const mode = (process.env.REALTIME_MODE as RealtimeMode | undefined) ?? "hybrid";
  return {
    enabled: process.env.REALTIME_ENABLED !== "false",
    mode: ["ws", "poll", "hybrid"].includes(mode) ? mode : "hybrid",
    pollIntervalSec: Number(process.env.REALTIME_POLL_INTERVAL_SEC ?? 60) || 60,
    pollLimitPerWallet: Number(process.env.REALTIME_POLL_LIMIT ?? 5) || 5,
    queueTopic: process.env.REALTIME_QUEUE_TOPIC ?? "zunia-tx-events",
    useVercelQueue: process.env.VERCEL_QUEUE_ENABLED === "true",
  };
}

/** Light queue message — no amounts */
export interface TxDetectedEvent {
  chainId: string;
  address: string;
  txHash: string;
  detectedAt: string;
  source: "ws" | "poll";
}

export interface WakeUpNotification {
  event: "tx_update";
  chainId: string;
  address: string;
  txHash: string;
}
