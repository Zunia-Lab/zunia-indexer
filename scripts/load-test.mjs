#!/usr/bin/env node
/**
 * Simple concurrent load smoke: /health + /v1/wallets/history.
 *
 * Usage:
 *   INDEXER_URL=http://127.0.0.1:8787 CONCURRENCY=20 REQUESTS=100 node scripts/load-test.mjs
 */

const BASE = (process.env.INDEXER_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 10);
const REQUESTS = Number(process.env.REQUESTS ?? 50);
const API_KEY = process.env.INDEXER_API_KEY;

const headers = { "content-type": "application/json" };
if (API_KEY) headers["x-api-key"] = API_KEY;

const body = JSON.stringify({
  chainId: process.env.LOAD_CHAIN_ID ?? "cosmoshub-4",
  address:
    process.env.LOAD_ADDRESS ??
    "cosmos1abcdefghijklmnopqrstuvwxyz0123456789abc",
});

async function one(i) {
  const t0 = Date.now();
  const health = await fetch(`${BASE}/health`, { headers });
  const hist = await fetch(`${BASE}/v1/wallets/history`, {
    method: "POST",
    headers,
    body,
  });
  return {
    i,
    ms: Date.now() - t0,
    health: health.status,
    history: hist.status,
  };
}

async function pool(n, total, fn) {
  let next = 0;
  const results = [];
  async function worker() {
    while (next < total) {
      const i = next++;
      results.push(await fn(i));
    }
  }
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

const results = await pool(CONCURRENCY, REQUESTS, one);
const ok = results.filter((r) => r.health < 500 && r.history < 500).length;
const avg = results.reduce((a, r) => a + r.ms, 0) / results.length;
const max = Math.max(...results.map((r) => r.ms));

console.log(
  JSON.stringify(
    {
      base: BASE,
      concurrency: CONCURRENCY,
      requests: REQUESTS,
      ok,
      fail: REQUESTS - ok,
      avgMs: Math.round(avg),
      maxMs: max,
    },
    null,
    2,
  ),
);

if (ok < REQUESTS) process.exitCode = 1;
