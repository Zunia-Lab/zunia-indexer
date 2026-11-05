import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/http/app.ts";
import { loadRealtimeConfig } from "../src/realtime/types.ts";
import { SubscriptionRegistry } from "../src/realtime/subscriptions.ts";
import { MemoryHistoryStore, TxHistoryService } from "../src/index.ts";
import type { SubscriptionLimits } from "../src/config.ts";

const TOKEN = "zunia-indexer-subscribe-token-0001";
const API_KEY = "indexer-api-key";
// Valid bech32 account addresses (20-byte payload, checksummed).
const OSMO = "osmo1qv9pzxqlyckngw6zf9g9whn9d3eh4qvgev269q";
const HUB = "cosmos1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg3he2nj";
const HISTORY = { firstConnectLimit: 5, maxTxsPerWallet: 50, refreshPageSize: 20, maxQueryLimit: 50 };
const LIMITS: Partial<SubscriptionLimits> = { maxWallets: 10, maxWalletsPerCaller: 1 };

function harness(options: { tokens?: string[]; apiKey?: string } = {}) {
  const store = new MemoryHistoryStore();
  const registry = new SubscriptionRegistry(store, LIMITS);
  const app = createApp({
    store,
    service: new TxHistoryService(store, HISTORY, []),
    realtime: { start() {}, stop() {}, registry, config: loadRealtimeConfig() },
    historyConfig: HISTORY,
    apiKey: options.apiKey,
    subscribeAuth: { tokens: options.tokens ?? [TOKEN], enforced: true },
  });
  const subscribe = (address: string, chainId: string, headers: Record<string, string> = {}) =>
    app.request("/v1/wallets/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ chainId, address }),
    });
  return { store, subscribe };
}

test("a push subscription needs the subscribe token", async () => {
  const { store, subscribe } = harness();
  assert.equal((await subscribe(OSMO, "osmosis-1")).status, 401);
  assert.equal((await subscribe(OSMO, "osmosis-1", { "x-zunia-subscribe-token": "wrong-token-wrong-token-0000" })).status, 401);
  assert.equal((await store.listWallets()).length, 0);
});

test("with the token, the wallet is watched for push", async () => {
  const { store, subscribe } = harness();
  const res = await subscribe(OSMO, "osmosis-1", { "x-zunia-subscribe-token": TOKEN, "x-zunia-subject": "device-1" });
  assert.equal(res.status, 200);
  const wallet = await store.getWallet("osmosis-1", OSMO);
  assert.ok(wallet?.watchUntil, "a push watch end is set");
  assert.ok(Date.parse(wallet.watchUntil) > Date.now());
});

test("the quota is per device subject, and a full quota says so", async () => {
  const { subscribe } = harness();
  const as = (subject: string) => ({ "x-zunia-subscribe-token": TOKEN, "x-zunia-subject": subject });
  assert.equal((await subscribe(OSMO, "osmosis-1", as("device-1"))).status, 200);
  assert.equal((await subscribe(HUB, "cosmoshub-4", as("device-1"))).status, 429);
  assert.equal((await subscribe(HUB, "cosmoshub-4", as("device-2"))).status, 200);
});

test("without a configured token, subscription is closed rather than anonymous", async () => {
  const { subscribe } = harness({ tokens: [] });
  assert.equal((await subscribe(OSMO, "osmosis-1", { "x-zunia-subscribe-token": TOKEN })).status, 503);
});

test("the API key lifts the per-minute ceiling the backend would otherwise hit", async () => {
  const { subscribe } = harness({ apiKey: API_KEY });
  const trusted = { "x-api-key": API_KEY, "x-zunia-subscribe-token": TOKEN };
  let status = 0;
  for (let i = 0; i < 130; i += 1) {
    status = (await subscribe(OSMO, "osmosis-1", { ...trusted, "x-zunia-subject": "device-1" })).status;
  }
  assert.equal(status, 200, "130 calls in a minute with the key");

  const anonymous = harness({ apiKey: API_KEY });
  let last = 0;
  for (let i = 0; i < 125; i += 1) last = (await anonymous.subscribe(OSMO, "osmosis-1", { "x-api-key": "guess" })).status;
  assert.equal(last, 429, "without the key, the usual ceiling");
});
