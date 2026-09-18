import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { HistoryConfig, LcdEndpoint } from "../types.js";
import type { HistoryStore } from "../store/memory.js";
import type { TxHistoryService } from "../service/history.js";
import type { RealtimeRuntime } from "../realtime/runtime.js";
import { walletBodySchema } from "./schemas.js";
import { rateLimit, requireApiKey } from "./middleware.js";
import { otelStubMiddleware } from "../otel/stub.js";

export function createApp(deps: {
  store: HistoryStore;
  service: TxHistoryService;
  realtime: RealtimeRuntime;
  historyConfig: HistoryConfig;
  apiKey?: string;
}) {
  const app = new Hono();

  app.use("*", otelStubMiddleware());
  app.use(
    "*",
    rateLimit({ windowMs: 60_000, max: 120 }),
    requireApiKey(deps.apiKey),
  );

  app.get("/health", async (c) => {
    const wallets = await deps.store.listWallets();
    return c.json({
      ok: true,
      strategy: "user_scoped_lcd_cache",
      store: process.env.DATABASE_URL ? "postgres" : "memory",
      realtime: deps.realtime.config,
      subscribedWallets: wallets.length,
      firstConnectLimit: deps.historyConfig.firstConnectLimit,
      maxTxsPerWallet: deps.historyConfig.maxTxsPerWallet,
    });
  });

  app.post(
    "/v1/wallets/history",
    zValidator("json", walletBodySchema),
    async (c) => {
      const body = c.req.valid("json");
      await deps.realtime.registry.ensure(body.chainId, body.address);
      const result = await deps.service.getHistory({
        chainId: body.chainId,
        address: body.address,
        forceRefresh: body.forceRefresh,
      });
      return c.json(result);
    },
  );

  app.post(
    "/v1/wallets/subscribe",
    zValidator("json", walletBodySchema),
    async (c) => {
      const body = c.req.valid("json");
      await deps.realtime.registry.ensure(body.chainId, body.address);
      return c.json({
        ok: true,
        chainId: body.chainId,
        address: body.address,
        realtime: true,
      });
    },
  );

  return app;
}

export type { LcdEndpoint };
