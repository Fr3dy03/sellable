# Mainnet deployment

The application targets BOT Chain mainnet (677). Preparing this checkout does
not deploy a contract, publish a service, send Telegram messages or spend BOT.

## Runtime and configuration

Use Node 22.9+ or 24 and `npm ci`. Scripts load `.env` when present; exported
environment variables take precedence. Set `CHAIN_ENV=mainnet` and
`NODE_ENV=production` on the API, worker and bot. Keep secrets in the hosting
provider's secret manager. Do not put wallet keys or `PROBE_API_KEY` in web
environment variables. The web only needs `API_URL` at build time.

Create a **fresh, dedicated mainnet Postgres database**. Do not reuse the Bohr
database: addresses, subscriptions and job queues are network-specific. Set
the same `DB_URL` on API, worker and bot. Production refuses file/memory stores.
Use a small pool on serverless hosts; ensure the provider connection limit can
support each API instance's pool of ten connections.

The worker holds a session advisory lock. Use a direct Postgres connection or
a pooler in session mode. For a transaction-pooled API URL, set `PROBE_DB_URL`
to a direct URL for **the same database**. Run one worker per network and use
a dedicated wallet that no other service or operator transacts from.

## Verification and release order

1. Run `npm run typecheck`, `npm test`, `npm run build`,
   `npm run contracts:compile`, `npm run web:build`, and
   `npm audit --omit=dev --audit-level=high`. The live API test is opt-in with
   `RUN_LIVE_TESTS=true`; ordinary tests do not need RPC access.
2. Verify the CI Postgres integration job passes. It tests migrations twice,
   exclusive worker locking, budget persistence across restarts, concurrent
   queue consumption and network mismatch rejection. To run locally, use a
   disposable database with `TEST_DB_URL` equal to `DB_URL`, then run
   `npm run migrate` and `npm run test:integration`. This test truncates its
   queues and budget reservations; never point it at production.
3. With the production database selected, run `npm run migrate`. Migrations
   are tracked and transactional. Existing token/probe rows from another
   network cause migration to fail. Back up existing data before migrations.
4. Run `npm run mainnet:preflight`. This performs only reads: chain ID,
   infrastructure bytecode, router factory/WBOT wiring, a USDT quote, database
   network marker and optional wallet balance. It never signs or enqueues.
5. Deploy the API at repository root (`server.ts`, Hono, `npm run build`) and
   the web from `packages/web` (Next.js). Set the web's `API_URL` to the HTTPS
   API origin **before building**. Give the API `DB_URL`, mainnet and production
   settings; give neither public deployment a wallet private key.
6. Put edge rate limits on `/check` (including refresh) and read endpoints.
   Configure this in the hosting platform/reverse proxy so limits are shared
   across instances. Verify `/health` returns HTTP 200 and `chainId: 677`;
   database failure returns 503. Perform a public USDT check in the web.
7. Initially keep `PROBE_ENABLED=false`. Review the intended wallet, enable
   probes explicitly, set a random `PROBE_API_KEY`, and choose a conservative
   `PROBE_DAILY_BUDGET_BOT`. Run the worker on an always-on host with the
   dedicated key. Start with one known-liquid token and inspect all receipts
   and measured costs before opening routine operation.
8. Start the Telegram bot only if needed. Give it a token and explicitly
   allow operator chat IDs with `PROBE_ALLOWED_CHAT_IDS`. Production `/probe`
   commands from other chats cannot enqueue spending. The web displays
   existing probe reports; only operators can request production probes.

An operator can call `POST /probe` with `Authorization: Bearer <PROBE_API_KEY>`
and JSON `{"address":"0x..."}`. Keep the credential outside browsers.

## Spending controls and recovery

Each mainnet probe reserves its input plus a conservative maximum for four
transactions (buy, allowance reset, approval, sell) **before** sending funds.
At the current caps (500,000 gas/transaction and 50 gwei), a 0.02 BOT probe
reserves 0.12 BOT. Higher gas requirements/prices fail closed. Reservations
are never refunded, including on crashes or unsuccessful probes. The daily
limit governs reserved worst-case expenditure, rather than net trading loss;
the reservation day is UTC. Restarting a worker does not reset reservations.

Stop intake by setting `PROBE_ENABLED=false` on the API/bot, then stop the
worker gracefully. SIGTERM waits for its current probe to finish; configure
the host's shutdown grace period accordingly. A transaction with an unknown
receipt must be reconciled before restarting. Do not automatically retry
pending transactions or clear reservations to bypass a budget stop.

A crash may leave a job `running`. Inspect the wallet nonce, pending/mined
transactions, token balances and probe history first; only then mark that
specific job failed for manual retry. Budget reservations remain charged.
Alert on failed jobs, database errors, worker exits and a low wallet balance.
Back up Postgres and preserve deployment JSON records. Displayed probe
results are historical observations, not guarantees for subsequent trades.

## Optional verdict registry

The scanner does not automatically publish reports to the registry. Treat
registry deployment and publisher operation as a separate release component.
Review the Solidity contract and arrange contract execution tests/independent
review before funding a mainnet publisher. The current registry uses a
single-step ownership transfer; validate the destination carefully and use
an appropriately controlled owner wallet.

Run `npm run contracts:compile`, then
`npm run contracts:deploy -- --network=mainnet` for a read-only gas estimate
using `DEPLOYER_PRIVATE_KEY` and optional
`SELLABLE_REGISTRY_PUBLISHER_ADDRESS`. The key is used to derive the sender;
the dry run does not sign. Only append `--broadcast` after reviewing the
target, publisher and estimate. Testnet remains the default without
`--network=mainnet`. An existing deployment record blocks accidental repeat
broadcasts. Confirm runtime bytecode and verify source on the explorer after
deployment; retain `packages/contracts/deployments/bot-mainnet.json`.

Official configuration sources:
[network](https://www.botchain.ai/en/help-center/docs/getting-started/add-bot-chain-metamask/),
[BDEX contracts](https://dev-docs.bohr.life/docs/DEX/contract-addresses/).
