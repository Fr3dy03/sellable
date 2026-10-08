import { ethers } from 'ethers';
import type { PreCheckReport } from '@sellable/core';
import type { LogEntry } from '@sellable/core';
import { norm, type Repo, type Severity } from '@sellable/db';
import { meetsMinSeverity } from './severity.js';

export const PAIR_CREATED_TOPIC =
  '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

export interface ParsedPair {
  token0: string;
  token1: string;
  pair: string;
  block: number;
}

const topicAddr = (topic: string): string => ethers.getAddress(`0x${topic.slice(-40)}`);

export function parsePairCreated(log: LogEntry): ParsedPair | null {
  if (!log.topics?.length || log.topics[0].toLowerCase() !== PAIR_CREATED_TOPIC) return null;
  if (log.topics.length < 3) return null;
  const word = log.data.replace(/^0x/, '').slice(0, 64);
  if (word.length < 40) return null;
  const block =
    typeof log.blockNumber === 'number' ? log.blockNumber : Number(log.blockNumber);
  if (!Number.isFinite(block)) return null;
  return {
    token0: topicAddr(log.topics[1]),
    token1: topicAddr(log.topics[2]),
    pair: ethers.getAddress(`0x${word.slice(-40)}`),
    block,
  };
}

export function pickListingToken(token0: string, token1: string, bases: string[]): string | null {
  const baseSet = new Set(bases.map((b) => b.toLowerCase()));
  const isToken0 = !baseSet.has(token0.toLowerCase());
  const isToken1 = !baseSet.has(token1.toLowerCase());
  if (isToken0 === isToken1) return null;
  return isToken0 ? token0 : token1;
}

export interface ScanState {
  lastBlock: number | null;
  seenPairs: Set<string>;
}

export const createScanState = (): ScanState => ({ lastBlock: null, seenPairs: new Set() });

export interface ScanDeps {
  repo: Repo;
  check: (address: string) => Promise<PreCheckReport>;
  getLogs: (fromBlock: number, toBlock: number) => Promise<LogEntry[]>;
  getBlockNumber: () => Promise<number>;
  bases: string[];
  window: number;
  broadcast: boolean;
}

export interface Listing {
  token: string;
  pair: string;
  block: number;
  verdict: string;
  symbol: string;
}

export async function scanTick(state: ScanState, deps: ScanDeps): Promise<Listing[]> {
  const to = await deps.getBlockNumber();
  const from = state.lastBlock != null ? state.lastBlock + 1 : Math.max(to - deps.window, 0);
  if (from > to) return [];
  const logs = await deps.getLogs(from, to);
  state.lastBlock = to;

  const listings: Listing[] = [];
  for (const log of logs) {
    const parsed = parsePairCreated(log);
    if (!parsed) continue;
    if (state.seenPairs.has(parsed.pair)) continue;
    state.seenPairs.add(parsed.pair);

    const token = pickListingToken(parsed.token0, parsed.token1, deps.bases);
    if (!token) continue;

    const report = await deps.check(token);
    const severity: Severity = report.risks.length ? 'warn' : 'info';
    const title = `new pair · ${report.token.symbol || '??'}`;
    const body = [
      `${report.verdict} @ block ${parsed.block}`,
      `pair ${parsed.pair}`,
      report.risks.length ? `risks: ${report.risks.join(', ')}` : 'risks: none',
    ].join('\n');

    const subs = await deps.repo.allSubscriptions();
    const targets = subs.filter(
      (s) =>
        meetsMinSeverity(s.minSeverity, severity) &&
        (s.kind === 'new-listing' || norm(s.address) === norm(token)),
    );
    for (const sub of targets) {
      await deps.repo.enqueueAlert({
        subscriptionId: sub.id,
        address: token,
        severity,
        title,
        body,
      });
    }
    if (deps.broadcast) {
      await deps.repo.enqueueAlert({
        subscriptionId: null,
        address: token,
        severity,
        title,
        body,
      });
    }

    listings.push({
      token,
      pair: parsed.pair,
      block: parsed.block,
      verdict: report.verdict,
      symbol: report.token.symbol,
    });
  }
  return listings;
}
