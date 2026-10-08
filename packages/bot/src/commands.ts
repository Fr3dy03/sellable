import { CURRENT, type PreCheckReport } from '@sellable/core';
import type { Repo, Severity } from '@sellable/db';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SEVERITIES: ReadonlySet<string> = new Set(['info', 'warn', 'danger']);

export const HELP = [
  'sellable — paste the CA. know if you can sell.',
  '',
  '/check 0x…   run the trade-safety pre-check',
  '/probe 0x…   queue a real buy→sell probe (~0.02 BOT) + watch it',
  '/watch 0x…   push me probe results for this token',
  '/unwatch 0x… stop alerts for a token',
  '/join        new-pair alerts for this chat',
  '/leave       stop new-pair alerts',
  '/alerts lvl  minimum severity: info | warn | danger',
  '/list        my watchlist',
  '',
  'or just paste a contract address.',
].join('\n');

export interface CommandDeps {
  repo: Repo;
  check: (address: string) => Promise<PreCheckReport>;
}

export const isAddress = (s: string): boolean => ADDRESS_RE.test(s.trim());

export function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function formatReport(r: PreCheckReport): string {
  const sym = r.token.symbol || '??';
  const lines = [`${r.verdict} · ${sym} · block ${r.block}`];
  lines.push(r.risks.length ? `risks: ${r.risks.join(', ')}` : 'risks: none');
  if (r.quote) {
    const out = Number(r.quote.amountOut) / 10 ** r.token.decimals;
    lines.push(`buy sim: 0.01 BOT → ${out.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${sym}`);
  }
  lines.push(`explorer: ${CURRENT.explorer}/address/${r.token.address}`);
  return lines.join('\n');
}

async function runCheck(address: string, deps: CommandDeps): Promise<string> {
  const report = await deps.check(address);
  return formatReport(report);
}

export async function handleCommand(
  text: string,
  chatId: number,
  deps: CommandDeps,
): Promise<string[]> {
  const raw = text.trim();
  if (!raw) return [];

  if (isAddress(raw)) return [await runCheck(raw.trim(), deps)];

  const [cmd, ...args] = raw.split(/\s+/);
  const name = cmd.split('@')[0].toLowerCase();

  switch (name) {
    case '/start':
    case '/help':
      return [HELP];

    case '/check': {
      const addr = args[0];
      if (!addr || !isAddress(addr)) return ['usage: /check 0x…'];
      return [await runCheck(addr.trim(), deps)];
    }

    case '/probe': {
      const addr = args[0];
      if (!addr || !isAddress(addr)) return ['usage: /probe 0x…'];
      const normalized = addr.trim();
      const queued = await deps.repo.enqueueProbe(normalized, `telegram:${chatId}`);
      await deps.repo.subscribe(chatId, normalized, 'token');
      return [
        queued
          ? `probe queued for ${short(normalized)} — verdict will be pushed here (~1 min).`
          : `a probe for ${short(normalized)} is already queued or running — verdict will be pushed here.`,
      ];
    }

    case '/join': {
      const ok = await deps.repo.subscribe(chatId, '', 'new-listing');
      return [
        ok ? 'joined — new-pair alerts are on for this chat. /leave to stop.' : 'already joined.',
      ];
    }

    case '/leave': {
      const ok = await deps.repo.unsubscribe(chatId, '', 'new-listing');
      return [ok ? 'left — new-pair alerts are off.' : 'not joined.'];
    }

    case '/alerts': {
      const level = args[0]?.toLowerCase();
      if (!level) {
        const subs = await deps.repo.listSubscriptions(chatId);
        if (!subs.length) return ['no subscriptions yet — /join or /watch first.'];
        return [
          `minimum severity: ${subs[0].minSeverity} — info = everything, warn = skip info, danger = only severe verdicts.`,
        ];
      }
      if (!SEVERITIES.has(level)) return ['usage: /alerts info|warn|danger'];
      const n = await deps.repo.setMinSeverity(chatId, level as Severity);
      if (!n) return ['no subscriptions yet — /join or /watch first.'];
      return [
        `minimum severity for ${n} subscription${n === 1 ? '' : 's'}: ${level}.`,
      ];
    }

    case '/watch': {
      const addr = args[0];
      if (!addr || !isAddress(addr)) return ['usage: /watch 0x…'];
      const normalized = addr.trim();
      const known = await deps.repo.getToken(normalized);
      if (!known) await deps.check(normalized);
      const ok = await deps.repo.subscribe(chatId, normalized, 'token');
      return [
        ok
          ? `watching ${short(normalized)} — probe verdicts will be pushed here.`
          : `already watching ${short(normalized)}.`,
      ];
    }

    case '/unwatch': {
      const addr = args[0];
      if (!addr || !isAddress(addr)) return ['usage: /unwatch 0x…'];
      const ok = await deps.repo.unsubscribe(chatId, addr.trim(), 'token');
      return [ok ? `stopped watching ${short(addr.trim())}.` : `no subscription for ${short(addr.trim())}.`];
    }

    case '/list': {
      const subs = await deps.repo.listSubscriptions(chatId);
      if (!subs.length) return ['watchlist is empty — /watch 0x…'];
      const rows = await Promise.all(
        subs.map(async (s) => {
          if (s.kind === 'new-listing') return `• 🔔 new listings · ≥${s.minSeverity}`;
          const token = await deps.repo.getToken(s.address);
          const sym = token?.symbol ? `$${token.symbol} ` : '';
          return `• ${sym}${short(s.address)} · ≥${s.minSeverity}`;
        }),
      );
      return ['watchlist:', ...rows];
    }

    default:
      return [HELP];
  }
}
