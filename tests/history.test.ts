import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryHistoryStore,
  TxHistoryService,
  type LcdEndpoint,
  type TxRecord,
} from "../src/index.ts";

test("first connect returns at most 5 txs and registers wallet", async () => {
  const store = new MemoryHistoryStore();
  const fixtures = fakeTxs("cosmoshub-4", "cosmos1abc", 12);
  const fetchImpl = mockLcdFetch(fixtures);
  const endpoints: LcdEndpoint[] = [
    { chainId: "cosmoshub-4", rest: "https://lcd.test" },
  ];
  const service = new TxHistoryService(
    store,
    {
      firstConnectLimit: 5,
      maxTxsPerWallet: 50,
      refreshPageSize: 20,
      maxQueryLimit: 50,
    },
    endpoints,
    fetchImpl,
  );

  const result = await service.getHistory({
    chainId: "cosmoshub-4",
    address: "cosmos1abc",
  });

  assert.equal(result.firstConnect, true);
  assert.equal(result.txs.length, 5);
  assert.equal(result.source, "lcd");
  assert.equal(result.maxStored, 50);

  const wallet = await store.getWallet("cosmoshub-4", "cosmos1abc");
  assert.ok(wallet);
});

test("trim keeps only max_txs_per_wallet newest", async () => {
  const store = new MemoryHistoryStore();
  const many = fakeTxs("osmosis-1", "osmo1xyz", 80);
  await store.upsertTxs(many);
  await store.trim("osmosis-1", "osmo1xyz", 50);
  const kept = await store.listTxs("osmosis-1", "osmo1xyz", 100);
  assert.equal(kept.length, 50);
  assert.equal(kept[0]?.txHash, "tx-79");
});

test("second call uses cache without forceRefresh", async () => {
  const store = new MemoryHistoryStore();
  const fixtures = fakeTxs("cosmoshub-4", "cosmos1abc", 5);
  let calls = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1;
    return mockLcdFetch(fixtures)(input, init);
  };
  const service = new TxHistoryService(
    store,
    {
      firstConnectLimit: 5,
      maxTxsPerWallet: 50,
      refreshPageSize: 20,
      maxQueryLimit: 50,
    },
    [{ chainId: "cosmoshub-4", rest: "https://lcd.test" }],
    fetchImpl,
  );

  await service.getHistory({ chainId: "cosmoshub-4", address: "cosmos1abc" });
  const second = await service.getHistory({
    chainId: "cosmoshub-4",
    address: "cosmos1abc",
  });
  assert.equal(second.firstConnect, false);
  assert.equal(second.source, "cache");
  assert.ok(calls >= 1);
  const callsAfterFirst = calls;
  await service.getHistory({ chainId: "cosmoshub-4", address: "cosmos1abc" });
  assert.equal(calls, callsAfterFirst);
});

function fakeTxs(chainId: string, address: string, n: number): TxRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    chainId,
    address,
    txHash: `tx-${i}`,
    height: i,
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    success: true,
    summary: "MsgSend",
    messages: ["/cosmos.bank.v1beta1.MsgSend"],
  }));
}

function mockLcdFetch(fixtures: TxRecord[]): typeof fetch {
  return async (input) => {
    const url = String(input);
    // Return half as recipient responses so merge path is exercised
    const slice = fixtures.slice().reverse().slice(0, 5);
    const body = {
      tx_responses: slice.map((t) => ({
        txhash: t.txHash,
        height: String(t.height ?? 0),
        timestamp: t.timestamp,
        code: 0,
        tx: {
          body: {
            messages: (t.messages ?? []).map((m) => ({ "@type": m })),
          },
        },
      })),
    };
    if (!url.includes("/cosmos/tx/v1beta1/txs")) {
      return new Response("not found", { status: 404 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}
