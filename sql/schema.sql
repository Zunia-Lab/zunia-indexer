-- Light cache for platform wallets only.
-- Cap enforced in application (max_txs_per_wallet); this schema stays small by design.

CREATE TABLE IF NOT EXISTS watched_wallets (
  chain_id   TEXT NOT NULL,
  address    TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_refresh_at TIMESTAMPTZ,
  PRIMARY KEY (chain_id, address)
);

CREATE TABLE IF NOT EXISTS tx_history (
  chain_id   TEXT NOT NULL,
  address    TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  height     BIGINT,
  timestamp  TIMESTAMPTZ,
  success    BOOLEAN NOT NULL DEFAULT TRUE,
  summary    TEXT NOT NULL DEFAULT '',
  raw_json   JSONB,
  inserted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, address, tx_hash)
);

CREATE INDEX IF NOT EXISTS tx_history_addr_time
  ON tx_history (chain_id, address, timestamp DESC NULLS LAST);
