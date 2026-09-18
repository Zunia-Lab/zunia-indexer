import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANONYMOUS_SUBSCRIBER,
  resolveSubscriber,
  SubscriptionDeniedError,
  SubscriptionRegistry,
} from "../src/realtime/subscriptions.ts";
import type { SubscriptionLimits } from "../src/config.ts";
import type { TxRecord, WatchedWallet } from "../src/types.ts";

const TOKEN = "zunia-indexer-subscribe-token-0001";
const LIMITS: SubscriptionLimits = {
  maxWallets: 3,
  maxWalletsPerCaller: 2,
  maxWalletsPerAnonymousCaller: 1,
  idleTtlMs: 60_000,
  evictionIntervalMs: 1_000,
};

test("resolveSubscriber accepts a configured token and scopes the caller id", () => {
  const auth = { tokens: [TOKEN], enforced: true };
  const caller = resolveSubscriber({ token: TOKEN }, auth);
  assert.equal(caller.authenticated, true);

  const scoped = resolveSubscriber({ token: TOKEN, subject: "device-7" }, auth);
  assert.equal(scoped.authenticated, true);
  assert.notEqual(scoped.id, caller.id, "a subject narrows the quota bucket");
});

test("resolveSubscriber refuses a missing or wrong token when enforced", () => {
  const auth = { tokens: [TOKEN], enforced: true };
  assert.throws(() => resolveSubscriber({}, auth), (err: unknown) => {
    assert.ok(err instanceof SubscriptionDeniedError);
    assert.equal(err.reason, "unauthenticated");
    return true;
  });
  assert.throws(
    () => resolveSubscriber({ token: "wrong-token-wrong-token-000" }, auth),
    SubscriptionDeniedError,
  );
});

test("enforced with no token configured denies rather than falling open", () => {
  assert.throws(
    () => resolveSubscriber({ token: TOKEN }, { tokens: [], enforced: true }),
    (err: unknown) => {
      assert.ok(err instanceof SubscriptionDeniedError);
      assert.equal(err.reason, "subscribe_not_configured");
      return true;
    },
  );
});

test("unenforced deployments fall back to the anonymous caller", () => {
  const caller = resolveSubscriber({}, { tokens: [], enforced: false });
  assert.deepEqual(caller, ANONYMOUS_SUBSCRIBER);
});

test("per-caller quota bounds how many wallets one caller may register", async () => {
  const store = new FakeStore();
  const registry = new SubscriptionRegistry(store, LIMITS);
  const caller = { id: "caller-a", authenticated: true };

  assert.equal((await registry.ensure("cosmoshub-4", "cosmos1a", caller)).ok, true);
  assert.equal((await registry.ensure("cosmoshub-4", "cosmos1b", caller)).ok, true);

  const denied = await registry.ensure("cosmoshub-4", "cosmos1c", caller);
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.reason, "caller_quota");

  // Refreshing a wallet that is already watched costs no new resource.
  assert.equal((await registry.ensure("cosmoshub-4", "cosmos1a", caller)).ok, true);
});

test("an anonymous caller gets the smaller quota", async () => {
  const store = new FakeStore();
  const registry = new SubscriptionRegistry(store, LIMITS);
  assert.equal((await registry.ensure("cosmoshub-4", "cosmos1a")).ok, true);
  const denied = await registry.ensure("cosmoshub-4", "cosmos1b");
  assert.equal(denied.ok === false && denied.reason, "caller_quota");
});

test("the registry stops accepting wallets at maxWallets", async () => {
  const store = new FakeStore();
  const registry = new SubscriptionRegistry(store, LIMITS);
  for (let i = 0; i < LIMITS.maxWallets; i += 1) {
    const caller = { id: `caller-${i}`, authenticated: true };
    assert.equal((await registry.ensure("cosmoshub-4", `cosmos1${i}`, caller)).ok, true);
  }
  const denied = await registry.ensure("cosmoshub-4", "cosmos1z", {
    id: "caller-late",
    authenticated: true,
  });
  assert.equal(denied.ok === false && denied.reason, "registry_full");
});

test("register throws so the subscribe route can report the reason", async () => {
  const store = new FakeStore();
  const registry = new SubscriptionRegistry(store, LIMITS);
  const caller = { id: "caller-a", authenticated: true };
  await registry.register("cosmoshub-4", "cosmos1a", caller);
  await registry.register("cosmoshub-4", "cosmos1b", caller);
  await assert.rejects(
    registry.register("cosmoshub-4", "cosmos1c", caller),
    (err: unknown) => {
      assert.ok(err instanceof SubscriptionDeniedError);
      assert.equal(err.reason, "caller_quota");
      return true;
    },
  );
});

test("ensure refuses a wallet that could not be a query literal", async () => {
  const store = new FakeStore();
  const registry = new SubscriptionRegistry(store, LIMITS);
  const outcome = await registry.ensure(
    "cosmoshub-4",
    "x' OR message.action='/cosmos.bank.v1beta1.MsgSend",
  );
  assert.equal(outcome.ok === false && outcome.reason, "invalid_wallet");
  assert.equal((await store.listWallets()).length, 0);
});

test("list drops idle wallets and evicts them from a store that can delete", async () => {
  const store = new FakeStore();
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const registry = new SubscriptionRegistry(store, LIMITS, () => clock);

  await registry.ensure("cosmoshub-4", "cosmos1a", { id: "a", authenticated: true });
  clock += 30_000;
  await registry.ensure("cosmoshub-4", "cosmos1b", { id: "b", authenticated: true });

  clock += 40_000; // cosmos1a is now 70s idle, over the 60s TTL
  const live = await registry.list();
  assert.deepEqual(live.map((w) => w.address), ["cosmos1b"]);
  assert.deepEqual((await store.listWallets()).map((w) => w.address), ["cosmos1b"]);
});

test("list caps the watch set even when the store holds more rows", async () => {
  const store = new FakeStore();
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  for (let i = 0; i < 10; i += 1) {
    await store.upsertWallet({
      chainId: "cosmoshub-4",
      address: `cosmos1${i}`,
      firstSeenAt: new Date(now - i * 1_000).toISOString(),
      lastRefreshAt: new Date(now - i * 1_000).toISOString(),
    });
  }
  const registry = new SubscriptionRegistry(store, LIMITS, () => now);
  const live = await registry.list();
  assert.equal(live.length, LIMITS.maxWallets);
  assert.deepEqual(live.map((w) => w.address), ["cosmos10", "cosmos11", "cosmos12"]);
});

test("list never hands the detectors a row that cannot be a query literal", async () => {
  const store = new FakeStore();
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  await store.upsertWallet({
    chainId: "cosmoshub-4",
    address: "x' OR tm.event='Tx",
    firstSeenAt: new Date(now).toISOString(),
  });
  const registry = new SubscriptionRegistry(store, LIMITS, () => now);
  assert.deepEqual(await registry.list(), []);
});

/** HistoryStore with the deleteWallet the eviction path uses when present. */
class FakeStore {
  private readonly wallets = new Map<string, WatchedWallet>();

  async getWallet(chainId: string, address: string) {
    return this.wallets.get(`${chainId}::${address}`);
  }

  async upsertWallet(wallet: WatchedWallet) {
    this.wallets.set(`${wallet.chainId}::${wallet.address}`, wallet);
  }

  async listWallets() {
    return [...this.wallets.values()];
  }

  async deleteWallet(chainId: string, address: string) {
    this.wallets.delete(`${chainId}::${address}`);
  }

  async listTxs(): Promise<TxRecord[]> {
    return [];
  }

  async upsertTxs() {
    /* not exercised here */
  }

  async trim() {
    /* not exercised here */
  }
}
