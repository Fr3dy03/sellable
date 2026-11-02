-- One database per network: all queues, subscriptions and cached reports share it.
CREATE TABLE IF NOT EXISTS deployment_network (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  chain_id INTEGER NOT NULL
);
-- Reservation is deliberately never refunded: crashes and unknown receipts still
-- consume the worst-case allowance. No secret material is stored here.
CREATE TABLE IF NOT EXISTS probe_budget_reservations (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  reserved_wei NUMERIC(78,0) NOT NULL CHECK (reserved_wei > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS probe_budget_day_idx ON probe_budget_reservations (chain_id, created_at);
