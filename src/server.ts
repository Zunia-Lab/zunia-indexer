/**
 * Hono HTTP API + optional realtime worker.
 * Set DATABASE_URL for Postgres (durable). Otherwise in-memory (dev/tests only).
 * Realtime WS requires always-on host — see docs/adr/0003-realtime-worker-host.md
 */
import { serve } from "@hono/node-server";
import {
  DEFAULT_LCD_ENDPOINTS,
  loadHistoryConfig,
  MemoryHistoryStore,
  TxHistoryService,
} from "./index.js";
import { createApp } from "./http/app.js";
import { createRealtimeRuntime } from "./realtime/runtime.js";
import { createPostgresStore } from "./store/postgres.js";
import type { HistoryStore } from "./store/memory.js";

const config = loadHistoryConfig();
const databaseUrl = process.env.DATABASE_URL;
const apiKey = process.env.INDEXER_API_KEY;

let store: HistoryStore & { close?: () => Promise<void> };
if (databaseUrl) {
  store = createPostgresStore(databaseUrl);
  console.log("[store] postgres");
} else {
  store = new MemoryHistoryStore();
  console.warn("[store] memory — history lost on restart; set DATABASE_URL for prod");
}

const service = new TxHistoryService(store, config, DEFAULT_LCD_ENDPOINTS);
const realtime = createRealtimeRuntime({ store, historyConfig: config });
realtime.start();

const app = createApp({
  store,
  service,
  realtime,
  historyConfig: config,
  apiKey,
});

const port = Number(process.env.PORT ?? 8787);
const server = serve({ fetch: app.fetch, port }, () => {
  console.log(
    `zunia-indexer :${port} (first=${config.firstConnectLimit}, max=${config.maxTxsPerWallet}, realtime=${realtime.config.enabled})`,
  );
});

async function shutdown(signal: string) {
  console.log(`[shutdown] ${signal}`);
  realtime.stop();
  server.close();
  await store.close?.();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
