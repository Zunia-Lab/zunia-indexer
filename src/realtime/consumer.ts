import { resolveLcd } from "../config.js";
import type { HistoryConfig } from "../types.js";
import type { HistoryStore } from "../store/memory.js";
import type { LcdEndpoint, TxRecord } from "../types.js";
import type { TxDetectedEvent, WakeUpNotification } from "./types.js";

export type NotifyWakeUp = (n: WakeUpNotification) => Promise<void> | void;

/**
 * Consumer: enrich one tx via LCD (by hash when possible), cache, trim, wake-up notify.
 * Payload never includes amounts.
 */
export class TxEventConsumer {
  constructor(
    private readonly store: HistoryStore,
    private readonly config: HistoryConfig,
    private readonly endpoints: LcdEndpoint[],
    private readonly notify: NotifyWakeUp = defaultNotify,
  ) {}

  async handle(event: TxDetectedEvent): Promise<void> {
    if (this.store.hasTx) {
      const known = await this.store.hasTx(
        event.chainId,
        event.address,
        event.txHash,
      );
      if (known) {
        await this.notify(wakeUp(event));
        return;
      }
    }

    const record = await this.enrich(event);
    await this.store.upsertTxs([record]);
    await this.store.trim(
      event.chainId,
      event.address,
      this.config.maxTxsPerWallet,
    );
    await this.notify(wakeUp(event));
  }

  private async enrich(event: TxDetectedEvent): Promise<TxRecord> {
    const rest = resolveLcd(event.chainId, this.endpoints);
    if (rest) {
      try {
        const url = `${rest.replace(/\/$/, "")}/cosmos/tx/v1beta1/txs/${event.txHash}`;
        const res = await fetch(url, { headers: { Accept: "application/json" } });
        if (res.ok) {
          const data = (await res.json()) as {
            tx_response?: {
              txhash?: string;
              height?: string;
              timestamp?: string;
              code?: number;
              tx?: { body?: { messages?: Array<{ "@type"?: string }> } };
            };
          };
          const row = data.tx_response;
          if (row?.txhash) {
            const messages =
              row.tx?.body?.messages?.map((m) => m["@type"] ?? "unknown") ?? [];
            return {
              chainId: event.chainId,
              address: event.address,
              txHash: row.txhash,
              height: row.height ? Number(row.height) : undefined,
              timestamp: row.timestamp,
              success: (row.code ?? 0) === 0,
              summary: messages.map((m) => m.replace(/^.*\./, "")).slice(0, 3).join(", ") || "transaction",
              messages,
            };
          }
        }
      } catch {
        /* fall through stub */
      }
    }
    return {
      chainId: event.chainId,
      address: event.address,
      txHash: event.txHash,
      success: true,
      summary: "transaction",
      timestamp: event.detectedAt,
    };
  }
}

function wakeUp(event: TxDetectedEvent): WakeUpNotification {
  return {
    event: "tx_update",
    chainId: event.chainId,
    address: event.address,
    txHash: event.txHash,
  };
}

function defaultNotify(n: WakeUpNotification): void {
  // Hook for FCM / Web Push / chrome.notifications — wake-up only
  if (process.env.REALTIME_LOG_NOTIFY === "true") {
    console.log("[notify]", JSON.stringify(n));
  }
}
