import { CURRENT } from './config.js';
import type { Check, PreCheckReport, PreVerdict, TokenMeta } from './types.js';

export const DISCLAIMER =
  'pre-check only: buy-side verified by simulation. Final SELLABLE/HONEYPOT verdict requires the Phase 1 probe (real micro buy->sell).';

export function aggregate(args: {
  block: number;
  token: TokenMeta;
  checks: Check[];
  hasPair: boolean;
  quoteOk: boolean;
  quoteBlocked: boolean;
}): PreCheckReport {
  const { block, token, checks, hasPair, quoteOk, quoteBlocked } = args;
  const risks = checks
    .filter((c) => c.severity === 'danger' && c.passed === false)
    .map((c) => c.id);

  let verdict: PreVerdict;
  if (token.isContract === false) verdict = 'NOT_A_CONTRACT';
  else if (quoteBlocked) verdict = 'BUY_BLOCKED';
  else if (quoteOk) verdict = 'QUOTE_OK';
  else if (hasPair) verdict = 'UNKNOWN';
  else verdict = 'NO_LIQUIDITY';

  return {
    stage: 'pre-check',
    chainId: CURRENT.chainId,
    block,
    token,
    verdict,
    checks,
    risks,
    quote: null,
    sellable: 'not-run',
    disclaimer: DISCLAIMER,
  };
}

export function summaryLine(r: PreCheckReport): string {
  const icons: Record<PreCheckReport['verdict'], string> = {
    QUOTE_OK: 'QUOTE OK (buy sim passed — sell verdict pending probe)',
    NO_LIQUIDITY: 'NO LIQUIDITY / NOT TRADABLE',
    BUY_BLOCKED: 'BUY BLOCKED',
    NOT_A_CONTRACT: 'NOT A CONTRACT (EOA address)',
    UNKNOWN: 'UNKNOWN',
  };
  return `${r.token.symbol || '?'} (${r.token.name || 'unnamed'}) · ${icons[r.verdict]} · risks: ${r.risks.length}`;
}
