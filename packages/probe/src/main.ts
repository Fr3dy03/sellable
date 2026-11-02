import { ethers } from 'ethers';
import {
  CURRENT,
  findLiquidity,
  getProvider,
  getBlockNumber,
  assertChain,
} from '@sellable/core';
import { makeRepo, type ProbeRecord, type Repo } from '@sellable/db';
import { runProbe } from './engine.js';
import { makeWalletDeps, WBOT } from './walletDeps.js';
import { tokenPriceUsd } from '@sellable/core';
import type { ProbeDeps } from './types.js';
import { MAX_PROBE_GAS_COST, openProbeGuard } from './safety.js';

const QUEUE_POLL_MS = 15_000;
const MIN_BALANCE_BOT = 3n * 10n ** 17n; // 0.3 BOT

function log(msg: string): void {
  console.log(`[probe ${new Date().toISOString()}] ${msg}`);
}

/** hard daily stop: today's recorded cost + this probe's notional must fit the budget */
async function budgetAllows(repo: Repo, amountIn: bigint, budgetWei: bigint): Promise<boolean> {
  const spent = await repo.todayCostWei();
  return spent + amountIn <= budgetWei;
}

async function probeOnce(
  address: string,
  repo: Repo,
  deps: ProbeDeps,
): Promise<void> {
  const token = ethers.getAddress(address);
  log(`probe start ${token}`);

  if (token.toLowerCase() === WBOT.toLowerCase()) {
    const rec = inconclusive(token, 'WBOT is the wrap token — nothing to probe');
    await repo.saveProbe(rec);
    log(`inconclusive: ${rec.revertReason}`);
    return;
  }

  const liq = await findLiquidity(token);
  if (!liq.pairs.length) {
    const rec = inconclusive(token, 'no BDEX V2 pair — nothing to swap');
    await repo.saveProbe(rec);
    log(`inconclusive: ${rec.revertReason}`);
    return;
  }

  const outcome = await runProbe(token, deps);

  const amountIn = BigInt(outcome.amountInWei);
  const gasSpent = BigInt(outcome.gasSpentWei ?? '0');
  const sellReceived = outcome.sellOk ? BigInt(outcome.sellReceived ?? '0') : 0n;
  const loss = outcome.buyOk ? (outcome.sellOk ? amountIn - sellReceived : amountIn) : 0n;
  const costBot = (loss > 0n ? loss : 0n) + gasSpent;

  let costUsd: number | null = null;
  try {
    const wbotUsd = await tokenPriceUsd(WBOT);
    if (wbotUsd != null) {
      costUsd = Math.round(Number(ethers.formatEther(costBot)) * wbotUsd * 10000) / 10000;
    }
  } catch {
    /* price feed optional */
  }

  const rec: ProbeRecord = {
    address: token,
    chainId: CURRENT.chainId,
    amountInWei: outcome.amountInWei,
    buyOk: outcome.buyOk,
    sellOk: outcome.sellOk,
    buyReceived: outcome.buyReceived,
    sellReceived: outcome.sellReceived,
    fairBuyOut: outcome.fairBuyOut,
    fairSellOut: outcome.fairSellOut,
    buyTaxBps: outcome.buyTaxBps,
    sellTaxBps: outcome.sellTaxBps,
    lossBps: outcome.lossBps,
    buyTx: outcome.buyTx,
    approveTx: outcome.approveTx,
    sellTx: outcome.sellTx,
    gasSpentWei: outcome.gasSpentWei,
    costBotWei: costBot.toString(),
    costUsd,
    revertReason: outcome.revertReason,
    verdict: outcome.verdict,
    createdAt: new Date().toISOString(),
  };
  await repo.saveProbe(rec);
  log(
    `${token} → ${rec.verdict} · loss ${rec.lossBps ?? '?'} bps` +
      ` · cost ${ethers.formatEther(costBot)} BOT` +
      (costUsd != null ? ` (~$${costUsd})` : '') +
      (rec.revertReason ? ` · ${rec.revertReason}` : ''),
  );
}

function inconclusive(address: string, reason: string): ProbeRecord {
  return {
    address,
    chainId: CURRENT.chainId,
    amountInWei: '0',
    buyOk: false,
    sellOk: false,
    buyReceived: null,
    sellReceived: null,
    fairBuyOut: null,
    fairSellOut: null,
    buyTaxBps: null,
    sellTaxBps: null,
    lossBps: null,
    buyTx: null,
    approveTx: null,
    sellTx: null,
    gasSpentWei: '0',
    costBotWei: '0',
    costUsd: null,
    revertReason: reason,
    verdict: 'INCONCLUSIVE',
    createdAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  if (process.env.PROBE_ENABLED !== 'true') throw new Error('Live spending is disabled; set PROBE_ENABLED=true to run the worker');
  if (CURRENT.chainId === 677 && !process.env.DB_URL) throw new Error('Mainnet probes require Postgres for durable budget reservations');
  await assertChain();
  const pk = process.env.PROBE_PRIVATE_KEY;
  if (!pk) {
    console.error('PROBE_PRIVATE_KEY not set — Phase 1 probe needs a hot wallet with ~0.5 BOT.');
    console.error('See .env.example. Only ever fund a throwaway probe wallet.');
    process.exit(1);
  }

  const dbUrl = process.env.DB_URL;
  const repo = makeRepo(dbUrl);
  if (!(await repo.ping())) throw new Error('Database unavailable');
  const guard = dbUrl ? await openProbeGuard(process.env.PROBE_DB_URL || dbUrl) : null;
  log(`repo: ${dbUrl ? 'postgres' : process.env.DB_FILE ? `file ${process.env.DB_FILE}` : 'memory'} · chain env: ${process.env.CHAIN_ENV || 'mainnet'}`);

  const wallet = new ethers.Wallet(pk, getProvider());
  const balance = await getProvider().getBalance(wallet.address);
  log(`wallet ${wallet.address} · ${ethers.formatEther(balance)} BOT · block ${await getBlockNumber()}`);
  if (balance < MIN_BALANCE_BOT) {
    console.error(`balance below ${ethers.formatEther(MIN_BALANCE_BOT)} BOT — fund the probe wallet first.`);
    process.exit(1);
  }

  const deps = makeWalletDeps(wallet);
  const budgetWei = ethers.parseEther(process.env.PROBE_DAILY_BUDGET_BOT || '1');
  if (budgetWei <= 0n) throw new Error('PROBE_DAILY_BUDGET_BOT must be positive');
  const reserve = (address: string) => guard
    ? guard.reserve(address, deps.amountInWei + MAX_PROBE_GAS_COST, budgetWei)
    : budgetAllows(repo, deps.amountInWei + MAX_PROBE_GAS_COST, budgetWei);
  log(`daily budget: ${ethers.formatEther(budgetWei)} BOT · probe size: ${ethers.formatEther(deps.amountInWei)} BOT`);

  const oneShot = process.argv[2] && process.argv[2] !== '--loop' ? process.argv[2] : null;

  if (oneShot) {
    try {
      if (!(await reserve(oneShot))) {
        console.error('daily probe budget exceeded — set PROBE_DAILY_BUDGET_BOT or wait for tomorrow (UTC).');
        process.exit(2);
      }
      await probeOnce(oneShot, repo, deps);
    } finally {
      await repo.close();
      await guard?.close();
    }
    return;
  }

  log('queue loop started (poll every 15s) — Ctrl+C to stop');
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const job = await repo.nextProbeJob();
      if (job) {
        log(`job picked up: ${job.address} (${job.reason}, attempt ${job.attempts})`);
        if (!(await reserve(job.address))) {
          log('daily budget exceeded — failing job until tomorrow (UTC)');
          await repo.finishProbeJob(job.address, 'failed', 'daily budget exceeded');
          return;
        }
        try {
          await probeOnce(job.address, repo, makeWalletDeps(wallet));
          await repo.finishProbeJob(job.address, 'done');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`job failed: ${msg}`);
          await repo.finishProbeJob(job.address, 'failed', msg);
        }
      }
    } catch (err) {
      log(`queue error: ${err instanceof Error ? err.message : err}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), QUEUE_POLL_MS);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    // Let an in-flight buy/sell finish before releasing the wallet lock.
    while (busy) await new Promise((resolve) => setTimeout(resolve, 100));
    await repo.close();
    await guard?.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await tick();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
