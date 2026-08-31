# zunia-indexer

> Transaction history, balances, staking rewards — **vendor or self-host decision**, not an implementation yet.

## Why

RPC alone is too slow/noisy for portfolio + notifications (PRE-DEVELOPMENT §1, §4.3).

## Options (pick via ADR)

| Option | Pros | Cons |
|--------|------|------|
| Numia / similar | Fast to market | Cost + vendor trust |
| Mintscan / public APIs | Easy | Rate limits, ToS |
| SubQuery / self-index | Control | Ops burden |
| Hybrid | Indexer history + CometBFT WS realtime | Complexity |

**Recommendation from audit:** indexer for history + CometBFT WS for realtime, polling fallback.

## Config

See [`config/providers.yaml`](./config/providers.yaml). Backend consumes `INDEXER_API_URL`.

## License

Apache-2.0 (scaffolding). Vendor SDKs retain their licences.
