# zunia-indexer

> Light **user-scoped** tx history + realtime for wallets that connect to Zunia.

## Stack

- **Hono** + **Zod** validation, API key auth, rate limit
- **HistoryStore**: Postgres (Drizzle) when `DATABASE_URL` is set, else memory (dev only)
- **Realtime**: CometBFT WS + LCD poll on an **always-on container** (Fly/Railway/Render) — [ADR-0003](./docs/adr/0003-realtime-worker-host.md)
- Optional **Vercel Queues** fan-out for wake-up notifies (not for WS)

## Run

```bash
pnpm install
pnpm test
# apply sql/schema.sql then:
DATABASE_URL=postgres://... pnpm dev
```

## License

Apache-2.0.
