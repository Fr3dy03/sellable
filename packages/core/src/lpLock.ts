import { CURRENT, OFFICIAL_TOKENS } from './config.js';
import { getTopHolders } from './blockscout.js';
import { pairBalanceOf, pairReserves, pairTotalSupply, getV2Pair } from './rpc.js';
import { poolsForToken } from './gecko.js';
import type { Check, PairInfo } from './types.js';

export interface LiquidityResult {
  pairs: PairInfo[];
  geckoDepthUsd: number | null;
  geckoVolume24hUsd: number | null;
}

/** Find V2 pairs vs official quote tokens, measure locker share + reserves. */
export async function findLiquidity(token: string): Promise<LiquidityResult> {
  const pairs: PairInfo[] = [];
  for (const quote of OFFICIAL_TOKENS) {
    if (quote.address.toLowerCase() === token.toLowerCase()) continue;
    const pair = await getV2Pair(token, quote.address);
    if (!pair) continue;
    const [reserves, totalSupply] = await Promise.all([
      pairReserves(pair, token),
      pairTotalSupply(pair),
    ]);
    const lockerHolders: PairInfo['lockerHolders'] = [];
    let locked = 0n;
    if (totalSupply && totalSupply > 0n) {
      for (const locker of CURRENT.lockers) {
        const bal = await pairBalanceOf(pair, locker.address);
        if (bal && bal > 0n) {
          const pct = Number((bal * 10000n) / totalSupply) / 100;
          lockerHolders.push({ address: locker.address, sharePct: pct });
          locked += bal;
        }
      }
    }
    // top LP holders (fallback unlocked signal): EOA-dominated LP = no locker involved
    let eoaShare: number | null = null;
    if (totalSupply && totalSupply > 0n) {
      const lpHolders = (await getTopHolders(pair, 1)).filter(
        (h) => lockerHolders.every((l) => l.address.toLowerCase() !== h.hash.toLowerCase()),
      );
      let eoa = 0n;
      for (const h of lpHolders) {
        if (!h.isContract) eoa += BigInt(h.value || '0');
      }
      eoaShare = Number((eoa * 10000n) / totalSupply) / 100;
    }
    pairs.push({
      pair,
      venue: 'v2',
      quoteToken: quote.address,
      quoteSymbol: quote.symbol,
      tokenReserve: reserves?.tokenReserve?.toString() ?? '0',
      quoteReserve: reserves?.quoteReserve?.toString() ?? '0',
      lockerSharePct:
        totalSupply && totalSupply > 0n && CURRENT.lockers.length
          ? Number((locked * 10000n) / totalSupply) / 100
          : null,
      lockerHolders,
      eoaTopHolderSharePct: eoaShare,
    });
  }
  const gecko = await poolsForToken(token);
  const depth = gecko.length ? Math.max(...gecko.map((p) => p.reserveUsd ?? 0)) : null;
  const vol = gecko.length ? Math.max(...gecko.map((p) => p.h24VolumeUsd ?? 0)) : null;
  return { pairs, geckoDepthUsd: depth && depth > 0 ? depth : null, geckoVolume24hUsd: vol };
}

export function liquidityChecks(liq: LiquidityResult): Check[] {
  const checks: Check[] = [];
  if (!liq.pairs.length) {
    checks.push({
      id: 'liquidity',
      title: 'BDEX V2 liquidity',
      severity: 'danger',
      passed: false,
      detail: 'no V2 pair against USDT or WBOT — token likely not tradable on BDEX',
      source: 'BDEX V2 factory',
    });
    return checks;
  }
  for (const p of liq.pairs) {
    checks.push({
      id: `pair-${p.quoteSymbol}`,
      title: `V2 pair vs ${p.quoteSymbol}`,
      severity: 'info',
      passed: true,
      detail: `${p.pair} · reserves ${p.tokenReserve} token / ${p.quoteReserve} ${p.quoteSymbol}`,
      source: 'BDEX V2 factory/pair',
    });
    if (p.lockerSharePct != null) {
      checks.push({
        id: `lp-lock-${p.quoteSymbol}`,
        title: `LP locked (${p.quoteSymbol} pair)`,
        severity: p.lockerSharePct >= 50 ? 'info' : p.lockerSharePct > 0 ? 'warn' : 'warn',
        passed: p.lockerSharePct >= 50,
        detail:
          p.lockerSharePct > 0
            ? `official lockers hold ${p.lockerSharePct}% of LP (${p.lockerHolders.map((l) => l.address).join(', ')})`
            : `0% of LP in official lockers${p.eoaTopHolderSharePct != null ? `; EOAs hold ~${p.eoaTopHolderSharePct}%` : ''} — LP can be pulled`,
        source: 'locker balanceOf / pair.totalSupply',
      });
    }
  }
  if (liq.geckoDepthUsd != null) {
    checks.push({
      id: 'depth',
      title: 'Pool depth',
      severity: liq.geckoDepthUsd < 1000 ? 'warn' : 'info',
      passed: liq.geckoDepthUsd >= 1000,
      detail: `$${liq.geckoDepthUsd.toFixed(0)} reserves, $${(liq.geckoVolume24hUsd ?? 0).toFixed(0)} 24h volume`,
      source: 'geckoterminal',
    });
  }
  return checks;
}
