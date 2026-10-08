# Sellable

> Paste the CA. Know if you can sell.

Trade-safety scanner + Telegram alerts for **BOT Chain** (chainId 677 mainnet /
chainId 968 Bohr testnet — switch with `CHAIN_ENV=testnet`).

## What it is

Paste a contract address → get a deterministic **pre-check** now, and a
**SELLABLE / HONEYPOT** verdict once the Phase 1 probe worker runs:

| Stage | Source of truth | Output |
|---|---|---|
| Pre-check (Phase 0, shipped) | bytecode scan, Blockscout, BDEX quotes, `eth_call` buy-sim | `QUOTE_OK / NO_LIQUIDITY / BUY_BLOCKED / NOT_A_CONTRACT` + risk checks |
| Probe (Phase 1) | real ~$0.20 micro buy→sell on live liquidity | `SELLABLE / HONEYPOT` + tax % |

Deterministic checks, not LLM opinions. Differentiator vs the in-ecosystem
security projects (most of which are broken or dead).

## Layout

```
packages/core      analyzer: static scan, fake-token matcher, holders, LP lock, quote, buy-sim, verdict
packages/cli       npm run check <ca>  |  npm run smoke (live USDT/WBOT sanity)
packages/db        repo: memory (dev) / JSON file (DB_FILE) / Postgres (DB_URL) + probe work queue
packages/probe     Phase 1: real buy->approve->sell probe engine + worker (verdicts)
packages/api       Phase 1: HTTP API (Hono): /check /tokens /probe /probes /health
packages/web       Phase 2: Next.js front-end (paste-box + token page), proxies /api → API
packages/harness   adversarial test tokens for Bohr testnet (honeypot/tax/blacklist/mint/fake-USDT)
db/migrations      Postgres schema (prechecks, probes, probe_jobs, subscriptions, alerts)
```

## Commands

```sh
npm install
npm test                      # unit tests: db + core + probe engine + api (api includes 1 live call)
npm run check -- <tokenCA>    # live pre-check against mainnet
CHAIN_ENV=testnet npm run check -- <tokenCA>   # same against Bohr testnet
npm run smoke                 # live sanity: official USDT + WBOT expect QUOTE_OK (mainnet)
npm run typecheck
```

`CHAIN_ENV=testnet` switches *everything* — RPC, factory/router, wrap token,
explorers, chainId — to Bohr testnet (968): core analyzer, CLI, probe worker,
API, and the harness scripts. No other flag needed.

### API (Phase 1)

```sh
npm run api                   # :8787, memory repo unless DB_URL is set
curl -s localhost:8787/health
curl -s -X POST localhost:8787/check -H 'content-type: application/json' -d '{"address":"0x..."}'
curl -s localhost:8787/tokens/0x...
curl -s -X POST localhost:8787/probe -H 'content-type: application/json' -d '{"address":"0x..."}'
```

`GET /tokens/:addr` returns the final verdict: `probe.verdict` when a probe
exists (`SELLABLE | HIGH_TAX | HONEYPOT | INCONCLUSIVE`), else the pre-check
verdict with a "pre-check" source marker.

### Probe worker (Phase 1 — real funds)

```sh
# needs: PROBE_PRIVATE_KEY (hot wallet, >= 0.3 BOT), optional DB_URL/DB_FILE, PROBE_DAILY_BUDGET_BOT
npm run probe -- 0x...        # one-shot probe
npm run probe -- --loop       # drain the queue (15s poll)
```

Engine: quote → buy (10% slip tolerance, FeeOnTransfer-safe router methods) →
balance delta → approve (with USDT-style reset) → sell (minOut=0 — measuring
*whether* it sells) → loss math: round-trip loss ≤ 25% = `SELLABLE`, ≤ 60% =
`HIGH_TAX`, worse or sell-revert = `HONEYPOT`, buy-side failure =
`INCONCLUSIVE`. Daily budget stops the worker.

### Web (Phase 2)

```sh
npm run api                  # terminal 1 — API on :8787
npm run web                  # terminal 2 — Next.js dev on :3000 (or web:build && start)
```

Home page = paste-box (`/`), token page = `/token/<address>` with verdict
banner, probe section (queue + poll), check list. The app proxies `/api/*` to
the API (override with `API_URL`), so it works against memory or Postgres repos.

### Telegram bot (Phase 3)

```sh
# needs: TELEGRAM_BOT_TOKEN (@BotFather), optional TELEGRAM_ALERT_CHAT
CHAIN_ENV=testnet DB_FILE=./data/dev-store.json npm run bot
```

Commands: `/check 0x…` (instant pre-check), `/probe 0x…` (queue a real
buy→sell probe + auto-watch), `/watch` / `/unwatch` / `/list`, `/join`/`/leave`
(new-pair alerts for the chat), `/alerts info|warn|danger` (minimum severity),
or just paste a CA. The new-pair scanner polls the V2 factory's `PairCreated`
logs via Blockscout (RPC has no `eth_getLogs`), runs a pre-check on each
listing, and pushes alerts; probe verdicts reach the same chats through the
shared alert outbox (`alerts` store/table). Without `TELEGRAM_BOT_TOKEN` the
bot exits with @BotFather instructions.

### Postgres (optional in dev)

```sh
DB_URL=postgres://... npm run migrate
DB_URL=postgres://... npm run api
```

Without Postgres, set `DB_FILE=./data/dev-store.json` so the API and the probe
worker share one JSON store across processes (job queue + verdicts).

### Harness (Phase 0 test tokens, Bohr testnet)

```sh
npm install -w @sellable/harness        # pulls solc
npm run harness:compile                 # writes packages/harness/artifacts/harness.json
$env:DEPLOYER_PRIVATE_KEY="0x..."       # after claiming tBOT (dev-docs)
npm run harness:deploy                  # writes packages/harness/fixtures/harness.json
npm run harness:verify                  # 15 checks: static scan + live behavior on testnet
CHAIN_ENV=testnet DEPLOYER_PRIVATE_KEY="0x..." npm run harness:liquidity
                                        # V2 pools vs WBOT for Benign/Tax/Honeypot,
                                        # arms HoneypotToken.setPair, funds a fresh
                                        # probe wallet (prints PROBE_PRIVATE_KEY)
```

Contracts: `BenignToken` (clean control), `HoneypotToken` (blocks
`to == pair` after `setPair`), `TaxToken` (5% fee-on-transfer), `BlacklistToken`,
`MintLaterToken`, `FakeUSDT` (impersonates official USDT, wrong decimals).
`harness:verify` asserts the analyzer flags each one correctly AND that the
on-chain mechanics behave as labeled (SELL BLOCKED revert, 5% tax, blacklist,
mint ACL).

### Live testnet probe demo (verified)

```sh
CHAIN_ENV=testnet DB_FILE=./data/dev-store.json npm run api
CHAIN_ENV=testnet DB_FILE=./data/dev-store.json PROBE_PRIVATE_KEY=<from harness:liquidity> npm run probe -- --loop
```

Then `POST /check` + `POST /probe` with a fixture address from
`packages/harness/fixtures/harness.json` and poll `GET /tokens/<ca>` (or use
the web token page). Verified results on Bohr testnet with real tBOT:

| Fixture | Pre-check | Probe verdict | loss |
|---|---|---|---|
| BenignToken | QUOTE_OK | `SELLABLE` | 57 bps |
| TaxToken (5% both ways) | QUOTE_OK | `SELLABLE` | 985 bps |
| HoneypotToken | QUOTE_OK | `HONEYPOT` (sell reverts) | — |

The honeypot row is the product thesis: the pre-check cannot see it, the probe
loses ~$0.30 of budget and says `HONEYPOT`.

### Database

```sh
DB_URL=postgres://user:pass@localhost:5432/sellable npm run migrate
```

## Deploy to Vercel

Import `Fr3dy03/sellable` at https://vercel.com/new and create **two projects**
from it (monorepo, one repo, two Root Directories):

**1 — API (Hono backend)**

| setting | value |
|---|---|
| Root Directory | `/` (repository root) |
| Framework preset | **Hono** — auto-detected from root `server.ts` |
| Build command | leave default — root `build` (`tsc -b tsconfig.build.json`) precompiles the workspace packages to `dist/*.js` so the lambda can `import` them; local dev (`tsx`) resolves `@sellable/*` to `src` via tsconfig `paths` |

Env vars: `CHAIN_ENV=testnet` (omit for mainnet), optional `DB_URL` (Postgres,
e.g. Neon — see below), optional `DB_FILE=/tmp/sellable-store.json` (per-instance
cache). Deploy and copy the URL.

**2 — Web (Next.js)**

| setting | value |
|---|---|
| Root Directory | `packages/web` |
| Framework preset | **Next.js** — auto-detected |
| Env vars | `API_URL=https://<api-project-url>` — **set before the first build**: the `/api/*` → API rewrite is compiled into the build |

Enable GitHub integration on both projects so pushes to `main` redeploy.

**What does not run on Vercel:** `npm run probe -- --loop` and `npm run bot`
are long-running processes — run them on any always-on host (your machine, a
VPS, Railway, …). For the deployed API and the local worker/bot to share the
probe queue and alert outbox, give all three the **same `DB_URL`**:

```sh
DB_URL=postgres://… CHAIN_ENV=testnet npm run migrate   # once
DB_URL=postgres://… npm run api                          # local dev, or leave on Vercel
DB_URL=postgres://… CHAIN_ENV=testnet npm run probe -- --loop
DB_URL=postgres://… CHAIN_ENV=testnet TELEGRAM_BOT_TOKEN=… npm run bot
```

Without `DB_URL` the Vercel API keeps state in memory (pre-checks still work,
caches reset on cold starts) and cannot share the queue with local processes.

## Phases

- **0 — done** — monorepo, pre-check engine, CLI, tests, harness tokens.
- **1 — done** — probe engine + worker, repo (memory/file/Postgres), HTTP API;
  **live probe verified on Bohr testnet** (SELLABLE / SELLABLE / HONEYPOT).
  Mainnet run needs a funded `PROBE_PRIVATE_KEY` (~0.3 BOT).
- **2 — done** — web paste-box + token page (Next.js, `/` and `/token/<ca>`).
- **3 — done** — Telegram bot (commands, watchlist, `/probe`, `/join` new-pair
  alerts, `/alerts` severity bar) + new-pair scanner (Blockscout `PairCreated`
  logs), shared alert outbox. Live-verified on testnet (3 harness pairs); bot
  needs your `TELEGRAM_BOT_TOKEN`.
- **4** — launch.

## Environment

Copy `.env.example` → `.env`. Pre-check/API run with no keys. The probe
worker needs a funded hot wallet (`PROBE_PRIVATE_KEY`) — on mainnet that's
real BOT, on testnet (`CHAIN_ENV=testnet`) `harness:liquidity` prints one with
2 tBOT; harness deploy needs a funded Bohr testnet key.
