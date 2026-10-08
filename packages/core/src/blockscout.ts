import { CURRENT } from './config.js';

const API_V2 = CURRENT.apiV2;
const API = CURRENT.api;

async function getJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`blockscout ${res.status}: ${url}`);
  return (await res.json()) as T;
}

export interface BsAddressInfo {
  is_contract: boolean | null;
  is_verified: boolean;
  is_scam: boolean;
  name: string | null;
}

export interface BsTokenInfo {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  totalSupply?: string;
  holders?: string;
  exchange_rate?: string | null;
}

export interface BsHolder {
  hash: string;
  isContract: boolean;
  value: string;
  sharePct: number | null;
}

export async function getAddressInfo(address: string): Promise<BsAddressInfo> {
  try {
    return await getJson<BsAddressInfo>(`${API_V2}/addresses/${address}`);
  } catch {
    return { is_contract: null, is_verified: false, is_scam: false, name: null };
  }
}

export async function getTokenInfo(address: string): Promise<BsTokenInfo | null> {
  try {
    return await getJson<BsTokenInfo>(`${API_V2}/tokens/${address}`);
  } catch {
    return null;
  }
}

export async function getTokenCounters(
  address: string,
): Promise<{ holders: number | null; transfers: number | null }> {
  try {
    const r = await getJson<{ token_holders_count?: string; transfers_count?: string }>(
      `${API_V2}/tokens/${address}/counters`,
    );
    return {
      holders: r.token_holders_count ? Number(r.token_holders_count) : null,
      transfers: r.transfers_count ? Number(r.transfers_count) : null,
    };
  } catch {
    return { holders: null, transfers: null };
  }
}

interface BsHoldersRaw {
  items: {
    address?: { hash?: string; is_contract?: boolean };
    value?: string;
    share?: string;
    token?: { value?: string };
  }[];
}

/** Top holders, up to `pages` pages of 50. */
export async function getTopHolders(token: string, pages = 3): Promise<BsHolder[]> {
  const out: BsHolder[] = [];
  for (let p = 1; p <= pages; p++) {
    let r: BsHoldersRaw;
    try {
      r = await getJson<BsHoldersRaw>(`${API_V2}/tokens/${token}/holders?page=${p}&limit=50`);
    } catch {
      break;
    }
    if (!r.items?.length) break;
    for (const it of r.items) {
      const hash = it.address?.hash;
      if (!hash) continue;
      out.push({
        hash,
        isContract: !!it.address?.is_contract,
        value: it.value ?? it.token?.value ?? '0',
        sharePct: it.share != null ? Number(it.share) : null,
      });
    }
    if (r.items.length < 50) break;
  }
  return out;
}

export interface LogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

interface BsLogsRaw {
  status?: string;
  message?: string;
  result?: {
    address: string;
    topics: string[];
    data: string;
    blockNumber: string;
    transactionHash: string;
  }[];
}

/**
 * Official mainnet HTTP RPC disables eth_getLogs — Blockscout's logs module
 * works instead (verified live: Approval events with topic filters).
 */
export async function getLogs(opts: {
  fromBlock: number;
  toBlock: number;
  address?: string;
  topic0?: string;
  topic3?: string;
}): Promise<LogEntry[]> {
  const q = new URLSearchParams({
    module: 'logs',
    action: 'getLogs',
    fromBlock: String(opts.fromBlock),
    toBlock: String(opts.toBlock),
  });
  if (opts.address) q.set('address', opts.address);
  if (opts.topic0) q.set('topic0', opts.topic0);
  if (opts.topic3) q.set('topic3', opts.topic3);
  try {
    const r = await getJson<BsLogsRaw>(`${API}?${q.toString()}`, 60000);
    if (r.status !== '1' || !Array.isArray(r.result)) return [];
    return r.result as LogEntry[];
  } catch {
    return [];
  }
}
