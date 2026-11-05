-- Push subscriptions keep a wallet watched until watch_until, read or not
-- (zunia-backend renews it each time a device subscribes again).
ALTER TABLE watched_wallets ADD COLUMN IF NOT EXISTS watch_until TIMESTAMPTZ;
