# ADR-0003: Realtime worker host (not Vercel serverless)

- Status: **Accepted**
- Date: 2026-08-31

## Context

`CometWsDetector` opens **long-lived WebSocket** subscriptions to CometBFT/Tendermint RPC for platform wallets only. Vercel Functions / serverless are request-scoped and cannot hold those sockets across invocations. Vercel Queues remains useful for **fan-out** of light `{chainId,address,txHash}` messages to notification consumers.

## Decision

1. Run the indexer **realtime worker** (`pnpm start` / `src/server.ts` with realtime enabled) on a **container or long-lived VM**: Fly.io, Railway, or Render (provisioned via `zunia-infra` Pulumi).
2. Use **Vercel Queues** (optional) only as a durable fan-out to `zunia-backend` push consumers — never as the WS host.
3. LCD poll fallback (60s) can run in the same worker process; it does not remove the need for an always-on host if WS is enabled.

## Consequences

- Deploy split: marketing/docs/dashboard stay on Vercel; indexer worker stays on Fly/Railway/Render.
- Health checks and process managers must restart the worker on crash so subscriptions recover.
- Document `REALTIME_MODE=poll` only for ephemeral environments (CI); production uses `hybrid` or `ws` on the container host.
