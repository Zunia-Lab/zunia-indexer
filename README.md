# zunia-indexer

> Light **user-scoped** tx history + realtime for wallets that connect to Zunia.

## Stack

- **Hono** + **Zod** validation, API key auth, rate limit
- **HistoryStore**: Postgres (Drizzle) when `DATABASE_URL` is set, else memory (dev only)
- **Realtime**: CometBFT WS + LCD poll on an **always-on container** (Fly/Railway/Render) — [ADR-0003](./docs/adr/0003-realtime-worker-host.md)
- Optional **Vercel Queues** fan-out for wake-up notifies (not for WS)
- **OpenTelemetry stub** middleware (`OTEL_STUB_LOG=true` for JSON span logs)

## Run

```bash
pnpm install
pnpm test
# apply migrations then:
DATABASE_URL=postgres://... pnpm db:migrate
DATABASE_URL=postgres://... pnpm dev
```

Schema source of truth: `sql/schema.sql` (mirrored in `drizzle/0000_init.sql` + `src/store/postgres.ts`).

## Push wake-ups

zunia-backend registers each wallet a device subscribes to (`POST /v1/wallets/subscribe` with `{chainId, address}`, headers `x-api-key`, `x-zunia-subscribe-token`, and the device id as `x-zunia-subject`, which gives each device its own quota). Such a wallet stays watched for `INDEXER_PUSH_WATCH_TTL_HOURS` whether or not its history is read, and each new subscribe renews it; the end is stored in `watched_wallets.watch_until` (`drizzle/0001_push_watch.sql`), so it survives a restart.

Each transaction the detectors see for a watched wallet goes to the backend's `POST /internal/tx-events` (`{chainId, address, txHash}`, header `x-zunia-internal-token`), once per wallet and transaction, retried with backoff on a timeout, a 429 or a 5xx. Only a transaction younger than `REALTIME_NOTIFY_MAX_AGE_SEC` is sent: the first poll of a newly watched wallet returns its last few, which are history.

| Variable | Purpose |
|----------|---------|
| `INDEXER_SUBSCRIBE_TOKEN` | Comma-separated secrets of 24+ characters accepted as `x-zunia-subscribe-token`. In production, subscribe is closed while it is unset. |
| `BACKEND_EVENTS_URL` | The backend's intake on this host, `http://127.0.0.1:8788/internal/tx-events`. Never the public hostname: the backend refuses these calls through the proxy. |
| `BACKEND_EVENTS_TOKEN` | Equal to the backend's `INTERNAL_EVENTS_TOKEN` (32+ characters). Without the URL and the token, wake-ups are only logged (`REALTIME_LOG_NOTIFY=true`). |
| `INDEXER_PUSH_WATCH_TTL_HOURS` | How long a push subscription keeps a wallet watched without reads. Default 720 (30 days). |
| `REALTIME_NOTIFY_MAX_AGE_SEC` | Oldest transaction that still wakes anyone. Default 900. |

Callers presenting `INDEXER_API_KEY` get a higher per-minute ceiling (6000 instead of 120): the backend makes one call per wallet and chain for every device.

## Load test

```bash
pnpm start   # or point at a remote
INDEXER_URL=http://127.0.0.1:8787 CONCURRENCY=20 REQUESTS=100 pnpm load-test
```

## Realtime failover

WS subscriptions use exponential backoff (1s → 60s + jitter) on close/error.
Register multiple `RpcEndpoint` rows with the same `chainId` to enable endpoint rotation after consecutive failures (every 3rd attempt). Poll mode remains the safety net for gaps.

## Deploy (Fly / Railway)

### Docker

```bash
docker build -t zunia-indexer .
docker run --rm -p 8787:8787 \
  -e DATABASE_URL=postgres://... \
  -e INDEXER_API_KEY=... \
  -e REALTIME_ENABLED=true \
  zunia-indexer
```

### Fly.io

```bash
fly launch --name zunia-indexer --region ord --no-deploy
fly secrets set DATABASE_URL=... INDEXER_API_KEY=...
fly deploy
```

Keep at least one always-on machine (realtime WS cannot sleep). Prefer `min_machines_running = 1` and a dedicated Postgres (Fly Managed Postgres or Neon via `DATABASE_URL`).

### Railway

1. New service from this repo; Dockerfile auto-detected.
2. Add Postgres plugin; set `DATABASE_URL`, `INDEXER_API_KEY`, `PORT=8787`.
3. Disable sleep / use a Worker service so WS stays connected.
4. Run migrate once: `pnpm db:migrate` in a one-off job or release command.

## License

Apache-2.0.
