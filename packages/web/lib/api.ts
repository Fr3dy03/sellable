export interface Check {
  id: string;
  title: string;
  severity: 'info' | 'warn' | 'danger';
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

export interface PreCheckReport {
  stage: string;
  chainId: number;
  block: number;
  token: TokenMeta;
  verdict: string;
  checks: Check[];
  risks: string[];
  quote: { venue: string; path: string[]; amountIn: string; amountOut: string } | null;
  sellable: string;
  disclaimer: string;
}

export interface ProbeRecord {
  address: string;
  verdict: string;
  buyOk: boolean;
  sellOk: boolean;
  lossBps: number | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  costBotWei: string | null;
  costUsd: number | null;
  buyTx: string | null;
  approveTx?: string | null;
  sellTx: string | null;
  revertReason: string | null;
  createdAt: string;
}

export interface Health {
  ok: boolean;
  chainId: number;
  db: boolean;
  stage: string;
  network: string;
}

export interface CheckResponse {
  cached: boolean;
  report: PreCheckReport;
}

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`health failed (${res.status})`);
  return res.json();
}

export function explorerBase(network: string): string {
  return network === 'testnet' ? 'https://scan.bohr.life' : 'https://scan.botchain.ai';
}

export function fmtPct(bps: number | null | undefined, digits = 2): string {
  return bps == null ? '—' : `${(bps / 100).toFixed(digits)}%`;
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null) return '—';
  return `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`;
}

export async function postCheck(address: string, refresh = false): Promise<CheckResponse> {
  const res = await fetch('/api/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, refresh }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `check failed (${res.status})`);
  return body;
}

export async function fetchProbes(address: string): Promise<ProbeRecord[]> {
  const res = await fetch(`/api/probes/${address}`);
  if (!res.ok) return [];
  const body = (await res.json()) as { probes: ProbeRecord[] };
  return body.probes;
}

export async function enqueueProbe(address: string): Promise<{ queued: boolean }> {
  const res = await fetch('/api/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `probe failed (${res.status})`);
  return body;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'mute';

const VERDICTS: Record<string, { label: string; tone: Tone; blurb: string }> = {
  SELLABLE: {
    label: 'SELLABLE',
    tone: 'ok',
    blurb: 'real buy->sell probe succeeded with an acceptable round-trip loss.',
  },
  HIGH_TAX: {
    label: 'HIGH TAX',
    tone: 'warn',
    blurb: 'it sells, but the round-trip loss is heavy — you can exit, at a price.',
  },
  HONEYPOT: {
    label: 'HONEYPOT',
    tone: 'bad',
    blurb: 'the sell leg failed or the exit cost destroys your funds. do not buy.',
  },
  INCONCLUSIVE: {
    label: 'PROBE INCONCLUSIVE',
    tone: 'warn',
    blurb: 'the probe could not complete a clean round-trip. see probe details.',
  },
  QUOTE_OK: {
    label: 'BUY OK — SELL UNVERIFIED',
    tone: 'ok',
    blurb: 'buy-side verified by simulation. final sell verdict needs a live probe.',
  },
  NO_LIQUIDITY: {
    label: 'NO LIQUIDITY',
    tone: 'bad',
    blurb: 'no BDEX V2 pair — not tradable (or not yet).',
  },
  BUY_BLOCKED: {
    label: 'BUY BLOCKED',
    tone: 'bad',
    blurb: 'a simulated buy reverted — the token rejects buys.',
  },
  NOT_A_CONTRACT: {
    label: 'NOT A CONTRACT',
    tone: 'mute',
    blurb: 'this address has no code — it is a wallet, not a token.',
  },
  UNKNOWN: {
    label: 'UNKNOWN',
    tone: 'warn',
    blurb: 'a pair exists but it could not be priced. treat as unverified.',
  },
};

export function verdictMeta(verdict: string): { label: string; tone: Tone; blurb: string } {
  return (
    VERDICTS[verdict] ?? { label: verdict, tone: 'warn', blurb: 'unrecognized verdict.' }
  );
}

export function shortAddress(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
