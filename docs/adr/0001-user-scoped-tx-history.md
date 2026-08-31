# ADR-0001: User-scoped light transaction history

- Status: **Accepted**
- Date: 2026-08-31

## Context

Full-chain indexers (or indexing every address on every Cosmos chain) produce huge databases and are unnecessary for a wallet. Zunia only needs history for **wallets that connect on our platform**.

Product rules:

- History only (not a general blockchain explorer)
- Keep the DB small
- First time a wallet connects: show the **latest 5 txs** quickly
- Cap stored txs per wallet so storage stays bounded

## Decision

**User-scoped, on-demand LCD pull + capped cache.**

1. A wallet address is indexed **only after** the extension/mobile registers it with the backend (user connected on Zunia).
2. Source of truth for history is each chain’s public LCD (`/cosmos/tx/v1beta1/txs`), filtered by that address — not a full block ingest pipeline.
3. **First connect / cold cache:** fetch and return at most **5** latest txs.
4. **Stored cap:** keep at most **`max_txs_per_wallet`** (default **50**) txs per `(chain_id, address)`. Trim older rows on write.
5. **Refresh:** later opens merge newer LCD results into the cache, then trim to the cap.
6. Optional later: poll **only subscribed** addresses for notifications — still no full-chain index.

## Explicitly rejected

- Indexing all chains / all addresses
- Storing unbounded history
- Depending on a heavy third-party portfolio indexer for v1 history (may still use vendors later as an LCD fallback)
- Storing seeds or private keys

## Consequences

- DB size ≈ `active_wallets × chains_per_wallet × max_txs_per_wallet` rows (tiny).
- First paint is fast and predictable (5 txs).
- Coverage depends on LCD availability per chain (from chain registry REST endpoints).
- Balances / staking rewards stay out of this service for now (RPC or a later module).
