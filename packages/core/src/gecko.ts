import { GECKO } from './config.js';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`geckoterminal ${res.status}: ${url}`);
  return (await res.json()) as T;
}

export interface GeckoPool {
  id: string;
  address: string;
  name: string;
  baseTokenPriceUsd: string | null;
  quoteTokenPriceUsd: string | null;
  reserveUsd: number | null;
  h24VolumeUsd: number | null;
}

interface GeckoPoolsRaw {
  data: {
    id: string;
    attributes: {
      name: string;
      address: string;
      base_token_price_usd?: string;
      quote_token_price_usd?: string;
      reserve_in_usd?: string;
      volume_usd?: { h24?: number };
    };
    relationships?: { base_token?: { data?: { id?: string } } };
  }[];
}

/** Pools that contain `token` as base token (GeckoTerminal covers chain 677 — verified). */
export async function poolsForToken(token: string): Promise<GeckoPool[]> {
  try {
    const r = await getJson<GeckoPoolsRaw>(`${GECKO.base}/networks/${GECKO.network}/pools?page=1`);
    const t = token.toLowerCase();
    return r.data
      .filter((p) => p.relationships?.base_token?.data?.id?.toLowerCase().endsWith(t))
      .map((p) => ({
        id: p.id,
        address: p.attributes.address,
        name: p.attributes.name,
        baseTokenPriceUsd: p.attributes.base_token_price_usd ?? null,
        quoteTokenPriceUsd: p.attributes.quote_token_price_usd ?? null,
        reserveUsd: p.attributes.reserve_in_usd != null ? Number(p.attributes.reserve_in_usd) : null,
        h24VolumeUsd: p.attributes.volume_usd?.h24 ?? null,
      }));
  } catch {
    return [];
  }
}

/** Best-effort USD price of a token from its deepest pool (chain: bot-chain). */
export async function tokenPriceUsd(token: string): Promise<number | null> {
  const pools = await poolsForToken(token);
  const priced = pools
    .map((p) => ({ p, usd: p.baseTokenPriceUsd != null ? Number(p.baseTokenPriceUsd) : null }))
    .filter((x): x is { p: GeckoPool; usd: number } => x.usd != null && x.usd > 0);
  if (!priced.length) return null;
  // prefer the pool with the highest 24h volume (most reliable price)
  priced.sort((a, b) => (b.p.h24VolumeUsd ?? 0) - (a.p.h24VolumeUsd ?? 0));
  return priced[0].usd;
}

export interface OhlcvPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function ohlcv(poolId: string, limit = 48): Promise<OhlcvPoint[]> {
  try {
    const r = await getJson<{
      data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } };
    }>(
      `${GECKO.base}/networks/${GECKO.network}/pools/${poolId}/ohlcv/hour?limit=${limit}`,
    );
    return (r.data.attributes.ohlcv_list ?? []).map((t) => ({
      time: t[0],
      open: t[1],
      high: t[2],
      low: t[3],
      close: t[4],
      volume: t[5],
    }));
  } catch {
    return [];
  }
}
