import {
  buildTendermintQuery,
  TendermintQueryError,
} from "../tendermint-query.js";
import type { WatchedWallet } from "../types.js";
import type { TxEventPublisher } from "./queue.js";
import {
  DEFAULT_RPC_ENDPOINTS,
  rpcToWebsocketUrl,
  resolveRpcEndpoints,
  type RpcEndpoint,
} from "./types.js";
import type { TxDetectedEvent } from "./types.js";

/**
 * Read side of SubscriptionRegistry. Narrowed to what the detector needs so the
 * watch set can be supplied from a fixture in tests.
 */
export interface WatchedWalletSource {
  list(): Promise<WatchedWallet[]>;
}

/**
 * CometBFT / Tendermint WS subscriptions for platform wallets only.
 * One query per (chain, address, role) — never a chain-wide Tx stream.
 *
 * Reconnect: exponential backoff (1s → 60s) with jitter.
 * Failover: when multiple RPCs exist for a chainId, rotate on consecutive failures.
 * See docs/adr/0003-realtime-worker-host.md and README "Realtime failover".
 */
export class CometWsDetector {
  private sockets = new Map<string, WebSocket>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readonly WebSocketImpl: typeof WebSocket;
  /** Per-subscription reconnect attempt count */
  private attempts = new Map<string, number>();
  /** Per-chain RPC endpoint index for failover */
  private endpointIndex = new Map<string, number>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly registry: WatchedWalletSource,
    private readonly publisher: TxEventPublisher,
    private readonly rpcEndpoints: RpcEndpoint[] = DEFAULT_RPC_ENDPOINTS,
    webSocketImpl?: typeof WebSocket,
  ) {
    this.WebSocketImpl = webSocketImpl ?? WebSocket;
  }

  start(): void {
    void this.reconcile();
    this.refreshTimer = setInterval(() => void this.reconcile(), 30_000);
    this.refreshTimer.unref?.();
  }

  stop(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    for (const t of this.reconnectTimers.values()) clearTimeout(t);
    this.reconnectTimers.clear();
    for (const ws of this.sockets.values()) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
  }

  async reconcile(): Promise<void> {
    const wallets = await this.registry.list();
    const desired = new Set<string>();

    for (const w of wallets) {
      const endpoints = resolveRpcEndpoints(w.chainId, this.rpcEndpoints);
      if (endpoints.length === 0) continue;
      for (const role of ["recipient", "sender"] as const) {
        const id = `${w.chainId}::${w.address}::${role}`;
        desired.add(id);
        if (this.sockets.has(id) || this.reconnectTimers.has(id)) continue;
        this.openSubscription(id, w.chainId, w.address, role);
      }
    }

    for (const [id, ws] of this.sockets) {
      if (desired.has(id)) continue;
      const timer = this.reconnectTimers.get(id);
      if (timer) clearTimeout(timer);
      this.reconnectTimers.delete(id);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.sockets.delete(id);
      this.attempts.delete(id);
    }
  }

  private pickRpc(chainId: string): string | undefined {
    const endpoints = resolveRpcEndpoints(chainId, this.rpcEndpoints);
    if (endpoints.length === 0) return undefined;
    const idx = (this.endpointIndex.get(chainId) ?? 0) % endpoints.length;
    return endpoints[idx];
  }

  private rotateEndpoint(chainId: string): void {
    const endpoints = resolveRpcEndpoints(chainId, this.rpcEndpoints);
    if (endpoints.length <= 1) return;
    const next = ((this.endpointIndex.get(chainId) ?? 0) + 1) % endpoints.length;
    this.endpointIndex.set(chainId, next);
    console.warn(
      `[realtime] failover chain=${chainId} → ${endpoints[next]}`,
    );
  }

  private scheduleReconnect(
    id: string,
    chainId: string,
    address: string,
    role: "recipient" | "sender",
  ): void {
    if (this.reconnectTimers.has(id)) return;
    const n = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, n);
    // After 3 consecutive failures, rotate RPC endpoint for the chain.
    if (n > 0 && n % 3 === 0) this.rotateEndpoint(chainId);

    const base = Math.min(60_000, 1000 * 2 ** Math.min(n - 1, 5));
    const jitter = Math.floor(Math.random() * 250);
    const delay = base + jitter;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(id);
      if (this.sockets.has(id)) return;
      this.openSubscription(id, chainId, address, role);
    }, delay);
    timer.unref?.();
    this.reconnectTimers.set(id, timer);
  }

  private openSubscription(
    id: string,
    chainId: string,
    address: string,
    role: "recipient" | "sender",
  ): void {
    const rpc = this.pickRpc(chainId);
    if (!rpc) return;

    // Built before the socket: an address that cannot be a query literal must
    // never reach the wire, and retrying it would never help, so the wallet is
    // dropped instead of scheduling a reconnect.
    let query: string;
    try {
      query = buildTendermintQuery([
        { key: "tm.event", value: "Tx" },
        role === "recipient"
          ? { key: "transfer.recipient", value: address }
          : { key: "message.sender", value: address },
      ]);
    } catch (err) {
      if (!(err instanceof TendermintQueryError)) throw err;
      // Quoted: the id embeds the offending address, which may carry newlines.
      console.warn(
        `[realtime] refusing subscription for unusable wallet ${JSON.stringify(id)}: ${err.message}`,
      );
      return;
    }

    const url = rpcToWebsocketUrl(rpc);
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (err) {
      console.warn("[realtime] ws open failed", id, err);
      this.scheduleReconnect(id, chainId, address, role);
      return;
    }
    this.sockets.set(id, ws);

    ws.addEventListener("open", () => {
      this.attempts.set(id, 0);
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "subscribe",
          id: 1,
          params: { query },
        }),
      );
    });

    ws.addEventListener("message", (ev) => {
      void this.onMessage(chainId, address, String(ev.data));
    });

    ws.addEventListener("error", () => {
      /* close handler schedules reconnect; poll fallback covers gaps */
    });

    ws.addEventListener("close", () => {
      this.sockets.delete(id);
      this.scheduleReconnect(id, chainId, address, role);
    });
  }

  private async onMessage(
    chainId: string,
    address: string,
    raw: string,
  ): Promise<void> {
    const txHash = extractTxHash(raw);
    if (!txHash) return;
    const event: TxDetectedEvent = {
      chainId,
      address,
      txHash,
      detectedAt: new Date().toISOString(),
      source: "ws",
    };
    await this.publisher.publish(event);
  }
}

/** Best-effort parse of Tendermint subscription result JSON */
export function extractTxHash(raw: string): string | undefined {
  try {
    const msg = JSON.parse(raw) as {
      result?: {
        data?: {
          value?: {
            TxResult?: { tx?: string };
            tx_result?: unknown;
          };
        };
        events?: Array<{ type?: string; attributes?: Array<{ key?: string; value?: string }> }>;
      };
    };
    const events = msg.result?.events;
    if (Array.isArray(events)) {
      for (const e of events) {
        if (e.type === "tx") {
          const hashAttr = e.attributes?.find((a) => a.key === "hash");
          if (hashAttr?.value) return hashAttr.value.toUpperCase();
        }
      }
    }
    const nested = JSON.stringify(msg.result ?? {});
    const m = nested.match(/"hash"\s*:\s*"([A-Fa-f0-9]{64})"/);
    if (m?.[1]) return m[1].toUpperCase();
  } catch {
    return undefined;
  }
  return undefined;
}
