-- Sellable Phase 0/1 schema (Postgres)
CREATE TABLE IF NOT EXISTS tokens (
  address        TEXT PRIMARY KEY,          -- checksummed
  chain_id       INT NOT NULL DEFAULT 677,
  symbol         TEXT,
  name           TEXT,
  decimals       INT,
  total_supply   NUMERIC(78,0),
  is_contract    BOOLEAN,
  is_verified    BOOLEAN,
  is_scam_flag   BOOLEAN,
  first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta_updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS prechecks (
  id            BIGSERIAL PRIMARY KEY,
  address       TEXT NOT NULL REFERENCES tokens(address),
  block_number  BIGINT NOT NULL,
  verdict       TEXT NOT NULL,   -- QUOTE_OK | NO_LIQUIDITY | BUY_BLOCKED | NOT_A_CONTRACT | UNKNOWN
  risks         TEXT[] NOT NULL DEFAULT '{}',
  checks        JSONB NOT NULL,  -- full Check[] payload
  quote         JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prechecks_address_idx ON prechecks (address, created_at DESC);

-- Phase 1: real-funds buy->sell probe results (source of final verdicts)
-- verdict: SELLABLE | HIGH_TAX | HONEYPOT | INCONCLUSIVE
CREATE TABLE IF NOT EXISTS probes (
  id             BIGSERIAL PRIMARY KEY,
  address        TEXT NOT NULL,
  chain_id       INT NOT NULL DEFAULT 677,
  buy_tx         TEXT,
  approve_tx     TEXT,
  sell_tx        TEXT,
  amount_in_wei  NUMERIC(78,0),
  amount_out_wei NUMERIC(78,0),        -- BOT received on sell
  buy_received_wei NUMERIC(78,0),      -- tokens received on buy
  buy_ok         BOOLEAN NOT NULL,
  sell_ok        BOOLEAN NOT NULL,
  buy_tax_bps    INT,                  -- vs fair quote (buy leg)
  sell_tax_bps   INT,                  -- vs fair quote (sell leg)
  tax_bps        INT,                  -- legacy: sell leg
  loss_bps       INT,                  -- round-trip loss incl. fees/tax/slippage
  gas_spent_wei  NUMERIC(78,0),
  cost_bot_wei   NUMERIC(78,0),        -- loss + gas: true cost of the probe
  cost_usd       NUMERIC(12,4),
  revert_reason  TEXT,
  verdict        TEXT NOT NULL,
  wallet         TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS probes_address_idx ON probes (address, created_at DESC);

-- Probe work queue (worker polls; one active job per address)
CREATE TABLE IF NOT EXISTS probe_jobs (
  address     TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  reason      TEXT NOT NULL DEFAULT 'manual',
  attempts    INT NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Background monitoring runs (Phase 0.5 alerts)
CREATE TABLE IF NOT EXISTS scans (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT NOT NULL,             -- new-pool | new-pair | interval
  trigger_ref  TEXT,                      -- tx hash / pool address
  ran_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  findings     JSONB NOT NULL DEFAULT '[]'
);

-- Telegram alert subscriptions (Phase 3)
CREATE TABLE IF NOT EXISTS subscriptions (
  id            BIGSERIAL PRIMARY KEY,
  chat_id       BIGINT NOT NULL,
  address       TEXT REFERENCES tokens(address),
  kind          TEXT NOT NULL DEFAULT 'token',  -- token | wallet | new-listing
  min_severity  TEXT NOT NULL DEFAULT 'warn',   -- info | warn | danger
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chat_id, address, kind)
);

CREATE TABLE IF NOT EXISTS alerts (
  id             BIGSERIAL PRIMARY KEY,
  subscription_id BIGINT REFERENCES subscriptions(id),
  address        TEXT,
  severity       TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  sent           BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_unsent_idx ON alerts (created_at) WHERE NOT sent;
