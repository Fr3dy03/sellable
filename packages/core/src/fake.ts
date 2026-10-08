import { OFFICIAL_TOKENS } from './config.js';
import type { Check } from './types.js';

/** Normalized Levenshtein similarity, 0..1. */
export function similarity(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  if (!s.length || !t.length) return 0;
  const dp: number[] = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  const dist = dp[t.length];
  return 1 - dist / Math.max(s.length, t.length);
}

export interface FakeMatch {
  impersonates: string; // official symbol
  kind: 'exact' | 'similar';
  similarity: number;
  decimalsMismatch: boolean;
}

export function matchFakeToken(meta: {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  isVerified: boolean;
}): FakeMatch | null {
  const addr = meta.address.toLowerCase();
  for (const official of OFFICIAL_TOKENS) {
    if (official.address.toLowerCase() === addr) return null;
    const symbolSame = official.symbol.toLowerCase() === meta.symbol.toLowerCase();
    const nameSame = official.name.toLowerCase() === meta.name.toLowerCase();
    const sim = Math.max(similarity(official.symbol, meta.symbol), similarity(official.name, meta.name));
    if ((symbolSame && nameSame) || (symbolSame && sim >= 0.9) || sim >= 0.92) {
      return {
        impersonates: official.symbol,
        kind: symbolSame && nameSame ? 'exact' : 'similar',
        similarity: sim,
        decimalsMismatch: official.decimals !== meta.decimals,
      };
    }
  }
  return null;
}

export function fakeTokenChecks(match: FakeMatch | null, isVerified: boolean): Check[] {
  if (!match) return [];
  const detail =
    `impersonates official ${match.impersonates} (${Math.round(match.similarity * 100)}% name match)` +
    (match.decimalsMismatch ? '; decimals differ from the official token' : '') +
    (isVerified ? '; note: contract source IS verified' : '; contract is NOT verified');
  return [
    {
      id: 'fake-token',
      title: `Impersonates ${match.impersonates}`,
      severity: 'danger',
      passed: false,
      detail,
      source: 'official token registry (dev-docs)',
    },
  ];
}
