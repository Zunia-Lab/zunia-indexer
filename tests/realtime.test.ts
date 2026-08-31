import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryHistoryStore,
  LocalTxEventQueue,
  TxEventConsumer,
  extractTxHash,
  dedupeKey,
  type TxDetectedEvent,
} from "../src/index.ts";

test("dedupeKey is chainId:txHash", () => {
  assert.equal(dedupeKey({ chainId: "cosmoshub-4", txHash: "ABC" }), "cosmoshub-4:ABC");
});

test("extractTxHash from tendermint event JSON", () => {
  const hash = "A".repeat(64);
  const raw = JSON.stringify({
    result: {
      events: [{ type: "tx", attributes: [{ key: "hash", value: hash }] }],
    },
  });
  assert.equal(extractTxHash(raw), hash);
});

test("local queue dedupes and consumer writes cache + wake-up", async () => {
  const store = new MemoryHistoryStore();
  await store.upsertWallet({
    chainId: "cosmoshub-4",
    address: "cosmos1abc",
    firstSeenAt: new Date().toISOString(),
  });

  const wakeups: unknown[] = [];
  const consumer = new TxEventConsumer(
    store,
    {
      firstConnectLimit: 5,
      maxTxsPerWallet: 50,
      refreshPageSize: 20,
      maxQueryLimit: 50,
    },
    [],
    async (n) => {
      wakeups.push(n);
    },
  );

  const queue = new LocalTxEventQueue((e) => consumer.handle(e));
  const event: TxDetectedEvent = {
    chainId: "cosmoshub-4",
    address: "cosmos1abc",
    txHash: "DEADBEEF",
    detectedAt: new Date().toISOString(),
    source: "poll",
  };

  await queue.publish(event);
  await queue.publish(event); // dedupe
  // allow microtask drain
  await new Promise((r) => setTimeout(r, 20));

  const txs = await store.listTxs("cosmoshub-4", "cosmos1abc", 10);
  assert.equal(txs.length, 1);
  assert.equal(txs[0]?.txHash, "DEADBEEF");
  assert.equal(wakeups.length, 1);
  assert.deepEqual(wakeups[0], {
    event: "tx_update",
    chainId: "cosmoshub-4",
    address: "cosmos1abc",
    txHash: "DEADBEEF",
  });
});
