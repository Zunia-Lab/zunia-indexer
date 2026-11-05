import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryHistoryStore,
  LocalTxEventQueue,
  TxEventConsumer,
  extractTxHash,
  dedupeKey,
  walletEventKey,
  type TxDetectedEvent,
  type WakeUpNotification,
} from "../src/index.ts";

const HISTORY = {
  firstConnectLimit: 5,
  maxTxsPerWallet: 50,
  refreshPageSize: 20,
  maxQueryLimit: 50,
};

const drain = () => new Promise((r) => setTimeout(r, 20));

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

test("both watched sides of one transfer get their own event", async () => {
  const store = new MemoryHistoryStore();
  const wakeups: WakeUpNotification[] = [];
  const consumer = new TxEventConsumer(store, HISTORY, [], async (n) => {
    wakeups.push(n);
  });
  const queue = new LocalTxEventQueue((e) => consumer.handle(e));
  const base = { chainId: "osmosis-1", txHash: "F00D", detectedAt: new Date().toISOString(), source: "ws" as const };

  await queue.publish({ ...base, address: "osmo1sender" });
  await queue.publish({ ...base, address: "osmo1recipient" });
  await queue.publish({ ...base, address: "osmo1recipient" }); // a second sighting
  await drain();

  assert.deepEqual(wakeups.map((w) => w.address).sort(), ["osmo1recipient", "osmo1sender"]);
  assert.notEqual(
    walletEventKey({ ...base, address: "osmo1sender" }),
    walletEventKey({ ...base, address: "osmo1recipient" }),
  );
});

test("a transaction older than the notify window is cached without waking anyone", async () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");
  const store = new MemoryHistoryStore();
  const wakeups: WakeUpNotification[] = [];
  const consumer = new TxEventConsumer(
    store,
    HISTORY,
    [],
    async (n) => {
      wakeups.push(n);
    },
    15 * 60_000,
    () => now,
  );
  const event = (txHash: string, minutesAgo: number): TxDetectedEvent => ({
    chainId: "safrochain-1",
    address: "addr_safro1me",
    txHash,
    detectedAt: new Date(now).toISOString(),
    source: "poll",
    txTimestamp: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  // The first poll of a newly watched wallet: its last transactions are history.
  await consumer.handle(event("OLD1", 60 * 24));
  await consumer.handle(event("OLD2", 20));
  await consumer.handle(event("NEW1", 1));

  assert.deepEqual(wakeups.map((w) => w.txHash), ["NEW1"]);
  const cached = await store.listTxs("safrochain-1", "addr_safro1me", 10);
  assert.deepEqual(cached.map((t) => t.txHash).sort(), ["NEW1", "OLD1", "OLD2"]);
});
