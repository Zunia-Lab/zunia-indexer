# ADR-0002: Realtime subscribed transaction detection

- Status: **Accepted**
- Date: 2026-08-31

## Decision

For platform-registered wallets only:

1. **Detect** via CometBFT WS queries scoped to `transfer.recipient` / `message.sender` for that address, plus LCD poll every 60s as fallback (`hybrid`).
2. **Fan-out** light events `{ chainId, address, txHash }` through an in-process queue (always-on worker) and optionally **Vercel Queues** topic `zunia-tx-events` with `idempotencyKey = chainId:txHash`.
3. **Consume** by enriching one tx from LCD, writing into the capped history cache (max 50), and emitting a **wake-up** notification with no amounts.

## Rejected

- Chain-wide `tm.event='Tx'` without address filter
- Storing/pushing amounts in notification payloads
- Relying on serverless alone to hold long-lived WS (worker must be always-on for WS)
