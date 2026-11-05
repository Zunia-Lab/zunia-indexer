import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { createPostgresStore } from "../src/store/postgres.ts";

/** Set TEST_DATABASE_URL to a disposable database to run this file. */
const base = process.env.TEST_DATABASE_URL;
const SCHEMA = "indexer_store_test";
const url = base
  ? (() => {
      const parsed = new URL(base);
      parsed.searchParams.set("search_path", SCHEMA);
      return parsed.toString();
    })()
  : undefined;
const skip = !url && "TEST_DATABASE_URL unset";

let store: ReturnType<typeof createPostgresStore>;

before(async () => {
  if (!url) return;
  const admin = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await admin.unsafe(`CREATE SCHEMA "${SCHEMA}"`);
    // The migrations drizzle-kit applies on deploy, in order.
    for (const file of ["0000_init.sql", "0001_push_watch.sql"]) {
      await admin.unsafe(await readFile(new URL(`../drizzle/${file}`, import.meta.url), "utf8"));
    }
  } finally {
    await admin.end({ timeout: 5 });
  }
  store = createPostgresStore(url);
});

after(async () => {
  await store?.close();
});

const at = (iso: string) => new Date(iso).toISOString();

test("a push watch survives a restart and is never shortened", { skip }, async () => {
  await store.upsertWallet({
    chainId: "osmosis-1",
    address: "osmo1push",
    firstSeenAt: at("2026-11-05T10:00:00Z"),
    lastRefreshAt: at("2026-11-05T10:00:00Z"),
    watchUntil: at("2026-12-05T10:00:00Z"),
  });
  assert.equal((await store.getWallet("osmosis-1", "osmo1push"))?.watchUntil, at("2026-12-05T10:00:00Z"));

  // A history read carries no watch end; an earlier one is a stale renewal.
  await store.upsertWallet({
    chainId: "osmosis-1",
    address: "osmo1push",
    firstSeenAt: at("2026-11-05T10:00:00Z"),
    lastRefreshAt: at("2026-11-06T10:00:00Z"),
  });
  await store.upsertWallet({
    chainId: "osmosis-1",
    address: "osmo1push",
    firstSeenAt: at("2026-11-05T10:00:00Z"),
    lastRefreshAt: at("2026-11-06T11:00:00Z"),
    watchUntil: at("2026-11-20T10:00:00Z"),
  });
  const kept = await store.getWallet("osmosis-1", "osmo1push");
  assert.equal(kept?.watchUntil, at("2026-12-05T10:00:00Z"));
  assert.equal(kept?.lastRefreshAt, at("2026-11-06T11:00:00Z"));

  await store.upsertWallet({
    chainId: "osmosis-1",
    address: "osmo1push",
    firstSeenAt: at("2026-11-05T10:00:00Z"),
    lastRefreshAt: at("2026-11-07T10:00:00Z"),
    watchUntil: at("2026-12-07T10:00:00Z"),
  });
  const listed = await store.listWallets();
  assert.deepEqual(
    listed.map((w) => [w.address, w.watchUntil]),
    [["osmo1push", at("2026-12-07T10:00:00Z")]],
  );
});

test("a history-only wallet has no watch end", { skip }, async () => {
  await store.upsertWallet({
    chainId: "cosmoshub-4",
    address: "cosmos1read",
    firstSeenAt: at("2026-11-05T10:00:00Z"),
  });
  assert.equal((await store.getWallet("cosmoshub-4", "cosmos1read"))?.watchUntil, undefined);
});
