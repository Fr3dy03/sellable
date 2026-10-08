import { norm, type Alert, type ProbeRecord, type Repo, type Severity, type Subscription } from '@sellable/db';
import { meetsMinSeverity } from './severity.js';
import type { Telegram } from './telegram.js';

export function probeVerdictSeverity(verdict: string): Severity {
  if (verdict === 'HONEYPOT') return 'danger';
  if (verdict === 'HIGH_TAX' || verdict === 'INCONCLUSIVE') return 'warn';
  return 'info';
}

const pct = (bps: number | null): string => (bps == null ? 'n/a' : `${(bps / 100).toFixed(2)}%`);
const usd = (v: number | null): string => (v == null ? 'n/a' : `$${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}`);

export function formatProbeAlert(probe: ProbeRecord, symbol: string, address: string): { title: string; body: string } {
  const title = `${probe.verdict} · ${symbol || '??'} (${address.slice(0, 6)}…${address.slice(-4)})`;
  const body = [
    `loss ${pct(probe.lossBps)} · buy tax ${pct(probe.buyTaxBps)} · sell tax ${pct(probe.sellTaxBps)}`,
    `cost ${usd(probe.costUsd)}`,
    probe.revertReason ? `revert ${probe.revertReason}` : null,
  ]
    .filter((l): l is string => l != null)
    .join('\n');
  return { title, body };
}

export async function notifyNewProbes(
  seen: Map<string, string>,
  repo: Repo,
  since = '1970-01-01T00:00:00.000Z',
): Promise<number> {
  const subs = await repo.allSubscriptions();
  const byAddress = new Map<string, Subscription[]>();
  for (const sub of subs) {
    const key = norm(sub.address);
    const list = byAddress.get(key);
    if (list) list.push(sub);
    else byAddress.set(key, [sub]);
  }

  let queued = 0;
  for (const [addr, list] of byAddress) {
    const probe = await repo.latestProbe(addr);
    if (!probe) continue;
    if (seen.get(addr) === probe.createdAt) continue;
    const eligible = list.filter((s) => s.createdAt <= probe.createdAt);
    const isFresh = eligible.length > 0 && probe.createdAt >= since;
    seen.set(addr, probe.createdAt);
    if (!isFresh) continue;

    const token = await repo.getToken(addr);
    const { title, body } = formatProbeAlert(probe, token?.symbol ?? '', probe.address);
    const severity = probeVerdictSeverity(probe.verdict);
    for (const sub of eligible) {
      if (!meetsMinSeverity(sub.minSeverity, severity)) continue;
      await repo.enqueueAlert({
        subscriptionId: sub.id,
        address: probe.address,
        severity,
        title,
        body,
      });
      queued++;
    }
  }
  return queued;
}

const emoji = (severity: Severity): string =>
  severity === 'danger' ? '🚨' : severity === 'warn' ? '⚠️' : 'ℹ️';

export function alertLine(alert: Alert): string {
  return `${emoji(alert.severity)} ${alert.title}\n${alert.body}`;
}

export async function flushAlerts(
  repo: Repo,
  telegram: Telegram,
  broadcastChat: number | null,
  failures: Map<number, number> = new Map(),
  maxFailures = 5,
): Promise<number> {
  const pending = await repo.pendingAlerts(20);
  let sent = 0;
  for (const alert of pending) {
    const chatId = alert.chatId ?? broadcastChat;
    if (chatId == null) {
      await repo.markAlertSent(alert.id);
      continue;
    }
    try {
      await telegram.sendMessage(chatId, alertLine(alert));
      await repo.markAlertSent(alert.id);
      failures.delete(alert.id);
      sent++;
    } catch {
      const attempts = (failures.get(alert.id) ?? 0) + 1;
      failures.set(alert.id, attempts);
      if (attempts >= maxFailures) {
        await repo.markAlertSent(alert.id);
        failures.delete(alert.id);
      }
    }
  }
  return sent;
}
