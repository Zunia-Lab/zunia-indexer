import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKEND_EVENTS_TOKEN_HEADER,
  BackendEventsNotifier,
  loadBackendEventsConfig,
  type BackendEventsConfig,
  type WakeUpNotification,
} from "../src/index.ts";

const CONFIG: BackendEventsConfig = {
  url: "http://127.0.0.1:8788/internal/tx-events",
  token: "internal-events-token-0123456789abcdef",
  timeoutMs: 1_000,
  attempts: 3,
  backoffMs: 100,
};

const WAKE_UP: WakeUpNotification = {
  event: "tx_update",
  chainId: "osmosis-1",
  address: "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du",
  txHash: "D".repeat(64),
};

function harness(statuses: Array<number | "throw">) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  const logs: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const next = statuses.shift() ?? 200;
    if (next === "throw") throw new TypeError("fetch failed");
    return new Response("{}", { status: next });
  }) as typeof fetch;
  const notifier = new BackendEventsNotifier(
    CONFIG,
    fetchImpl,
    async (ms) => {
      sleeps.push(ms);
    },
    (message) => logs.push(message),
  );
  return { notifier, calls, sleeps, logs };
}

test("posts the wake-up to the backend with the shared secret", async () => {
  const { notifier, calls } = harness([200]);
  await notifier.notify(WAKE_UP);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, CONFIG.url);
  const headers = calls[0]?.init.headers as Record<string, string>;
  assert.equal(headers[BACKEND_EVENTS_TOKEN_HEADER], CONFIG.token);
  assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
    chainId: WAKE_UP.chainId,
    address: WAKE_UP.address,
    txHash: WAKE_UP.txHash,
  });
});

test("retries an outage with backoff, then delivers", async () => {
  const { notifier, calls, sleeps } = harness([503, "throw", 200]);
  await notifier.notify(WAKE_UP);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [100, 200]);
});

test("stops at a refusal, and gives up after its attempts without throwing", async () => {
  const refused = harness([401]);
  await refused.notifier.notify(WAKE_UP);
  assert.equal(refused.calls.length, 1, "a 4xx is final");

  const down = harness([500, 500, 500]);
  await down.notifier.notify(WAKE_UP);
  assert.equal(down.calls.length, 3);
  assert.equal(down.logs.length, 1);
  assert.ok(down.logs.every((line) => !line.includes(WAKE_UP.address)), "no address in logs");
});

test("delivers each wallet's transaction once", async () => {
  const { notifier, calls } = harness([200, 200, 200]);
  await Promise.all([notifier.notify(WAKE_UP), notifier.notify(WAKE_UP)]);
  await notifier.notify(WAKE_UP);
  assert.equal(calls.length, 1);
  await notifier.notify({ ...WAKE_UP, address: "osmo1other" });
  assert.equal(calls.length, 2, "the other side of the transfer is its own event");
});

test("a failed delivery may be tried again by a later sighting", async () => {
  const { notifier, calls } = harness([400, 200]);
  await notifier.notify(WAKE_UP);
  await notifier.notify(WAKE_UP);
  assert.equal(calls.length, 2);
});

test("is off unless both the URL and the secret are set", () => {
  assert.equal(loadBackendEventsConfig({}), undefined);
  assert.equal(loadBackendEventsConfig({ BACKEND_EVENTS_URL: CONFIG.url }), undefined);
  assert.deepEqual(
    loadBackendEventsConfig({ BACKEND_EVENTS_URL: CONFIG.url, BACKEND_EVENTS_TOKEN: CONFIG.token }),
    { url: CONFIG.url, token: CONFIG.token, timeoutMs: 5_000, attempts: 3, backoffMs: 500 },
  );
});
