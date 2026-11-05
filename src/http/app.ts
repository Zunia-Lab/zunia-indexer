import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { HistoryConfig, LcdEndpoint } from "../types.js";
import type { HistoryStore } from "../store/memory.js";
import type { TxHistoryService } from "../service/history.js";
import type { RealtimeRuntime } from "../realtime/runtime.js";
import {
  resolveSubscriber,
  SubscriptionDeniedError,
  type SubscriptionDenialReason,
} from "../realtime/subscriptions.js";
import {
  loadSubscribeAuth,
  SUBSCRIBE_SUBJECT_HEADER,
  SUBSCRIBE_TOKEN_HEADER,
  type SubscribeAuthConfig,
} from "../config.js";
import { walletBodySchema } from "./schemas.js";
import { rateLimit, requireApiKey } from "./middleware.js";
import { otelStubMiddleware } from "../otel/stub.js";

/** Requests per minute for a caller holding the API key (see rateLimit). */
const TRUSTED_REQUESTS_PER_MINUTE = 6000;

const DENIAL_STATUS: Record<SubscriptionDenialReason, 400 | 401 | 429 | 503> = {
  unauthenticated: 401,
  subscribe_not_configured: 503,
  caller_quota: 429,
  registry_full: 503,
  invalid_wallet: 400,
};

export function createApp(deps: {
  store: HistoryStore;
  service: TxHistoryService;
  realtime: RealtimeRuntime;
  historyConfig: HistoryConfig;
  apiKey?: string;
  /** Defaults to INDEXER_SUBSCRIBE_TOKEN; enforced in production. */
  subscribeAuth?: SubscribeAuthConfig;
}) {
  const app = new Hono();
  const subscribeAuth = deps.subscribeAuth ?? loadSubscribeAuth();

  app.use("*", otelStubMiddleware());

  // Public so nginx, Cloudflare, and the status page can probe it.
  // Wallet routes below stay behind the API key.
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

  app.use(
    "*",
    rateLimit({
      windowMs: 60_000,
      max: 120,
      trusted: { apiKey: deps.apiKey, max: TRUSTED_REQUESTS_PER_MINUTE },
    }),
    requireApiKey(deps.apiKey),
  );

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

  /**
   * A device's push subscription, from zunia-backend: a resource grant, so the
   * caller presents a subscribe token, and the device id as subject gives each
   * device its own quota. The wallet stays watched for pushWatchTtlMs, read or
   * not; the backend calls again whenever the app subscribes again.
   */
  app.post(
    "/v1/wallets/subscribe",
    zValidator("json", walletBodySchema),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const caller = resolveSubscriber(
          {
            token: c.req.header(SUBSCRIBE_TOKEN_HEADER),
            subject: c.req.header(SUBSCRIBE_SUBJECT_HEADER),
          },
          subscribeAuth,
        );
        await deps.realtime.registry.registerPush(body.chainId, body.address, caller);
      } catch (err) {
        if (err instanceof SubscriptionDeniedError) {
          return c.json({ error: err.reason, message: err.message }, DENIAL_STATUS[err.reason]);
        }
        throw err;
      }
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
