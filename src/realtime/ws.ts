import {
  DEFAULT_RPC_ENDPOINTS,
  rpcToWebsocketUrl,
  resolveRpc,
  type RpcEndpoint,
} from "./types.js";
import type { TxEventPublisher } from "./queue.js";
import type { SubscriptionRegistry } from "./subscriptions.js";
import type { TxDetectedEvent } from "./types.js";

/**
 * CometBFT / Tendermint WS subscriptions for platform wallets only.
 * One query per (chain, address, role) — never a chain-wide Tx stream.
 */
export class CometWsDetector {
  private sockets = new Map<string, WebSocket>();
  private refreshTimer?: ReturnType<typeof setInterval>;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(
    private readonly registry: SubscriptionRegistry,
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
      const rpc = resolveRpc(w.chainId, this.rpcEndpoints);
      if (!rpc) continue;
      for (const role of ["recipient", "sender"] as const) {
        const id = `${w.chainId}::${w.address}::${role}`;
        desired.add(id);
        if (this.sockets.has(id)) continue;
        this.openSubscription(id, w.chainId, w.address, role, rpc);
      }
    }

    for (const [id, ws] of this.sockets) {
      if (desired.has(id)) continue;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      this.sockets.delete(id);
    }
  }

  private openSubscription(
    id: string,
    chainId: string,
    address: string,
    role: "recipient" | "sender",
    rpc: string,
  ): void {
    const url = rpcToWebsocketUrl(rpc);
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (err) {
      console.warn("[realtime] ws open failed", id, err);
      return;
    }
    this.sockets.set(id, ws);

    const query =
      role === "recipient"
        ? `tm.event='Tx' AND transfer.recipient='${address}'`
        : `tm.event='Tx' AND message.sender='${address}'`;

    ws.addEventListener("open", () => {
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
      /* poll fallback covers gaps */
    });

    ws.addEventListener("close", () => {
      this.sockets.delete(id);
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
    // Some nodes nest hash under result.data.value.TxResult
    const nested = JSON.stringify(msg.result ?? {});
    const m = nested.match(/"hash"\s*:\s*"([A-Fa-f0-9]{64})"/);
    if (m?.[1]) return m[1].toUpperCase();
  } catch {
    return undefined;
  }
  return undefined;
}
