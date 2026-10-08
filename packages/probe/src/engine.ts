import type { ProbeDeps, ProbeOutcome, TxResult } from './types.js';

export const DEFAULT_PROBE_CONFIG = {
  sellableMaxLossBps: 2500, // 25% round-trip loss => SELLABLE
  highTaxMaxLossBps: 6000, // <= 60% => HIGH_TAX, worse => HONEYPOT
};

const bps = (part: bigint, whole: bigint): number | null => {
  if (whole <= 0n) return null;
  const v = Number((part * 10000n) / whole);
  return v < 0 ? 0 : v;
};

/**
 * Real-funds probe: buy -> approve -> sell, measure round-trip loss.
 * Pure orchestration over injected deps so it unit-tests without a wallet.
 */
export async function runProbe(
  token: string,
  deps: ProbeDeps,
  config: typeof DEFAULT_PROBE_CONFIG = DEFAULT_PROBE_CONFIG,
): Promise<ProbeOutcome> {
  const amountIn = deps.amountInWei;
  const out: ProbeOutcome = {
    verdict: 'INCONCLUSIVE',
    buyOk: false,
    sellOk: false,
    amountInWei: amountIn.toString(),
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
    gasSpentWei: null,
    revertReason: null,
  };

  const fairBuy = await deps.quoteBuy(token, amountIn);
  if (fairBuy == null || fairBuy <= 0n) {
    out.revertReason = 'no buy quote (V2 path missing or dead pool)';
    return out;
  }
  out.fairBuyOut = fairBuy.toString();

  const minBuyOut = (fairBuy * (10000n - BigInt(deps.buySlippageBps))) / 10000n;
  const buy: TxResult = await deps.buy(token, amountIn, minBuyOut);
  out.buyTx = buy.txHash ?? null;
  if (!buy.ok) {
    out.revertReason = `buy failed: ${buy.reason}`;
    out.gasSpentWei = (await deps.gasSpent()).toString();
    return out;
  }
  out.buyOk = true;

  const bal = await deps.balanceOf(token);
  out.buyReceived = bal.toString();
  out.buyTaxBps = bps(fairBuy - bal, fairBuy);

  if (bal === 0n) {
    out.revertReason = 'buy succeeded but 0 tokens received';
    out.gasSpentWei = (await deps.gasSpent()).toString();
    return out;
  }

  const fairSell = await deps.quoteSell(token, bal);
  if (fairSell != null) out.fairSellOut = fairSell.toString();

  const approve: TxResult = await deps.approve(token, bal);
  out.approveTx = approve.txHash ?? null;
  if (!approve.ok) {
    out.revertReason = `approve failed: ${approve.reason}`;
    out.gasSpentWei = (await deps.gasSpent()).toString();
    return out;
  }

  // minOut = 0: we are measuring WHETHER it sells, not price
  const sell: TxResult = await deps.sell(token, bal, 0n);
  out.sellTx = sell.txHash ?? null;
  out.gasSpentWei = (await deps.gasSpent()).toString();
  if (!sell.ok) {
    out.revertReason = `sell reverted: ${sell.reason}`;
    out.verdict = 'HONEYPOT';
    return out;
  }
  out.sellOk = true;

  const received = sell.received ?? 0n;
  out.sellReceived = received.toString();
  if (fairSell != null) out.sellTaxBps = bps(fairSell - received, fairSell);
  out.lossBps = bps(amountIn - received, amountIn);

  const loss = out.lossBps ?? 10000;
  if (loss <= config.sellableMaxLossBps) out.verdict = 'SELLABLE';
  else if (loss <= config.highTaxMaxLossBps) out.verdict = 'HIGH_TAX';
  else out.verdict = 'HONEYPOT';

  return out;
}
