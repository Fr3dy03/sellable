import { HOLDERS_TOP_N } from './config.js';
import { getTopHolders } from './blockscout.js';
import type { Check } from './types.js';

export interface Concentration {
  top10SharePct: number | null;
  top1: { holder: string; sharePct: number } | null;
  sampleSize: number;
}

const pct = (valueStr: string, totalSupply: bigint | null): number | null => {
  if (totalSupply == null || totalSupply <= 0n) return null;
  return Number((BigInt(valueStr) * 10000n) / totalSupply) / 100;
};

/**
 * Top-holder concentration from Blockscout holder pages.
 * `exclude` — pair/pool addresses (a pool is normally the #1 holder; including
 * it measures liquidity, not insider concentration).
 */
export async function holderConcentration(
  token: string,
  totalSupply: bigint | null,
  exclude: string[] = [],
): Promise<Concentration> {
  const holders = await getTopHolders(token, 4);
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  const relevant = holders.filter((h) => !skip.has(h.hash.toLowerCase()));

  let top10 = 0;
  let top1: Concentration['top1'] = null;
  let counted = 0;
  let anyKnown = false;
  for (const h of relevant.slice(0, HOLDERS_TOP_N)) {
    const share = h.sharePct ?? pct(h.value, totalSupply);
    if (share == null) continue;
    anyKnown = true;
    top10 += share;
    counted++;
    if (top1 == null) top1 = { holder: h.hash, sharePct: share };
  }
  return {
    top10SharePct: anyKnown ? Math.round(top10 * 100) / 100 : null,
    top1,
    sampleSize: counted,
  };
}

export function concentrationChecks(c: Concentration): Check[] {
  if (c.top10SharePct == null) {
    return [
      {
        id: 'concentration',
        title: 'Holder concentration',
        severity: 'info',
        passed: null,
        detail: 'could not compute concentration (supply or holder data unavailable)',
        source: 'scan.botchain.ai holders',
      },
    ];
  }
  const value = c.top10SharePct;
  const severity = value >= 80 ? 'danger' : value >= 50 ? 'warn' : 'info';
  return [
    {
      id: 'concentration',
      title: 'Holder concentration',
      severity,
      passed: severity === 'info',
      detail:
        `top ${c.sampleSize} non-pool holders own ${value}% of supply` +
        (c.top1 ? `; largest ${c.top1.sharePct}% (${c.top1.holder})` : ''),
      source: 'scan.botchain.ai holders',
    },
  ];
}
