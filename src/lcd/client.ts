import type { TxRecord } from "../types.js";

interface LcdTxResponse {
  tx_responses?: Array<{
    txhash?: string;
    height?: string;
    timestamp?: string;
    code?: number;
    tx?: {
      body?: {
        messages?: Array<{ "@type"?: string }>;
      };
    };
  }>;
}

/**
 * Pull address-filtered history from Cosmos LCD.
 * Only called for platform-registered wallets — never a full-chain crawl.
 */
export async function fetchLcdTxs(options: {
  rest: string;
  chainId: string;
  address: string;
  limit: number;
  fetchImpl?: typeof fetch;
}): Promise<TxRecord[]> {
  const { rest, chainId, address, limit } = options;
  const fetchFn = options.fetchImpl ?? fetch;
  const base = rest.replace(/\/$/, "");

  // Recipient + sender queries; merge + dedupe by hash
  const queries = [
    `transfer.recipient='${address}'`,
    `message.sender='${address}'`,
  ];

  const collected: TxRecord[] = [];
  const seen = new Set<string>();

  for (const q of queries) {
    const url = new URL(`${base}/cosmos/tx/v1beta1/txs`);
    url.searchParams.set("query", q);
    url.searchParams.set("order_by", "2"); // ORDER_BY_DESC when supported
    url.searchParams.set("pagination.limit", String(limit));

    let data: LcdTxResponse;
    try {
      const res = await fetchFn(url, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) continue;
      data = (await res.json()) as LcdTxResponse;
    } catch {
      continue;
    }

    for (const row of data.tx_responses ?? []) {
      const txHash = row.txhash;
      if (!txHash || seen.has(txHash)) continue;
      seen.add(txHash);
      const messages =
        row.tx?.body?.messages
          ?.map((m) => m["@type"] ?? "unknown")
          .filter(Boolean) ?? [];
      collected.push({
        chainId,
        address,
        txHash,
        height: row.height ? Number(row.height) : undefined,
        timestamp: row.timestamp,
        success: (row.code ?? 0) === 0,
        summary: summarize(messages),
        messages,
      });
    }
  }

  return collected
    .sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      if (tb !== ta) return tb - ta;
      return (b.height ?? 0) - (a.height ?? 0);
    })
    .slice(0, limit);
}

function summarize(messages: string[]): string {
  if (messages.length === 0) return "transaction";
  const short = messages.map((m) => m.replace(/^.*\./, ""));
  return short.slice(0, 3).join(", ");
}
