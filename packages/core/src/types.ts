export type Severity = 'info' | 'warn' | 'danger';

export interface Check {
  id: string;
  title: string;
  severity: Severity;
  /** null = could not determine */
  passed: boolean | null;
  detail: string;
  source: string;
}

export interface TokenMeta {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string | null;
  isContract: boolean | null;
  isVerified: boolean;
  isScamFlagged: boolean;
}

export interface QuoteResult {
  venue: 'v2' | 'v3';
  path: string[];
  amountIn: string;
  amountOut: string;
}

export type PreVerdict =
  | 'NOT_A_CONTRACT'
  | 'NO_LIQUIDITY'
  | 'BUY_BLOCKED'
  | 'QUOTE_OK'
  | 'UNKNOWN';

export interface PreCheckReport {
  stage: 'pre-check';
  chainId: number;
  block: number;
  token: TokenMeta;
  verdict: PreVerdict;
  checks: Check[];
  risks: string[];
  quote: QuoteResult | null;
  /** Sell-side verdict requires the Phase 1 probe worker (real buy->sell). */
  sellable: 'probe-pending' | 'not-run';
  disclaimer: string;
}

export interface PairInfo {
  pair: string;
  venue: 'v2';
  quoteToken: string;
  quoteSymbol: string;
  tokenReserve: string;
  quoteReserve: string;
  lockerSharePct: number | null;
  lockerHolders: { address: string; sharePct: number }[];
  eoaTopHolderSharePct: number | null;
}
