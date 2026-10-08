import type { PreCheckReport, TokenMeta } from '@sellable/core';
import {
  norm,
  type Alert,
  type AlertInput,
  type PendingAlert,
  type ProbeJob,
  type ProbeRecord,
  type Repo,
  type Severity,
  type Subscription,
  type SubscriptionKind,
} from './types.js';

interface MemJob extends ProbeJob {
  done: boolean;
}

export class MemoryRepo implements Repo {
  protected tokens = new Map<string, TokenMeta>();
  protected prechecks = new Map<string, PreCheckReport[]>();
  protected probes = new Map<string, ProbeRecord[]>();
  protected jobs: MemJob[] = [];
  protected subs: Subscription[] = [];
  protected alerts: Alert[] = [];
  protected nextSubId = 1;
  protected nextAlertId = 1;

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {}

  async upsertToken(meta: TokenMeta): Promise<void> {
    this.tokens.set(norm(meta.address), meta);
  }

  async getToken(address: string): Promise<TokenMeta | null> {
    return this.tokens.get(norm(address)) ?? null;
  }

  async savePrecheck(report: PreCheckReport): Promise<void> {
    const key = norm(report.token.address);
    const list = this.prechecks.get(key) ?? [];
    list.unshift(report);
    if (list.length > 20) list.pop();
    this.prechecks.set(key, list);
    // set directly (not via this.upsertToken) so subclasses that re-read state
    // on every write don't clobber the precheck queued above
    this.tokens.set(key, report.token);
  }

  async latestPrecheck(address: string): Promise<PreCheckReport | null> {
    return this.prechecks.get(norm(address))?.[0] ?? null;
  }

  async saveProbe(record: ProbeRecord): Promise<void> {
    const key = norm(record.address);
    const list = this.probes.get(key) ?? [];
    list.unshift(record);
    this.probes.set(key, list);
  }

  async listProbes(address: string): Promise<ProbeRecord[]> {
    return this.probes.get(norm(address)) ?? [];
  }

  async latestProbe(address: string): Promise<ProbeRecord | null> {
    return this.listProbes(address).then((l) => l[0] ?? null);
  }

  async enqueueProbe(address: string, reason: string): Promise<boolean> {
    const key = norm(address);
    const pending = this.jobs.find((j) => !j.done && norm(j.address) === key);
    if (pending) return false;
    this.jobs.push({
      address: key,
      status: 'queued',
      reason,
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString(),
      done: false,
    });
    return true;
  }

  async nextProbeJob(): Promise<ProbeJob | null> {
    const job = this.jobs.find((j) => j.status === 'queued');
    if (!job) return null;
    job.status = 'running';
    job.attempts++;
    return { ...job };
  }

  async finishProbeJob(address: string, status: ProbeJob['status'], error?: string): Promise<void> {
    const job = this.jobs.find((j) => norm(j.address) === norm(address));
    if (!job) return;
    job.status = status;
    job.lastError = error ?? null;
    job.done = status === 'done' || status === 'failed';
  }

  async todayCostWei(): Promise<bigint> {
    const today = new Date().toISOString().slice(0, 10);
    let total = 0n;
    for (const list of this.probes.values()) {
      for (const p of list) {
        if (p.createdAt.slice(0, 10) === today) total += BigInt(p.costBotWei ?? '0');
      }
    }
    return total;
  }

  async subscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean> {
    const key = norm(address);
    if (this.subs.some((s) => s.chatId === chatId && norm(s.address) === key && s.kind === kind)) {
      return false;
    }
    this.subs.push({
      id: this.nextSubId++,
      chatId,
      address,
      kind,
      minSeverity: 'info',
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  async unsubscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean> {
    const key = norm(address);
    const before = this.subs.length;
    this.subs = this.subs.filter(
      (s) => !(s.chatId === chatId && norm(s.address) === key && s.kind === kind),
    );
    return this.subs.length < before;
  }

  async listSubscriptions(chatId: number): Promise<Subscription[]> {
    return this.subs.filter((s) => s.chatId === chatId).map((s) => ({ ...s }));
  }

  async allSubscriptions(): Promise<Subscription[]> {
    return this.subs.map((s) => ({ ...s }));
  }

  async subscribers(address: string): Promise<Subscription[]> {
    const key = norm(address);
    return this.subs.filter((s) => norm(s.address) === key).map((s) => ({ ...s }));
  }

  async setMinSeverity(chatId: number, severity: Severity): Promise<number> {
    let n = 0;
    this.subs = this.subs.map((s) => {
      if (s.chatId !== chatId) return s;
      n++;
      return { ...s, minSeverity: severity };
    });
    return n;
  }

  async enqueueAlert(alert: AlertInput): Promise<Alert> {
    const record: Alert = {
      ...alert,
      id: this.nextAlertId++,
      sent: false,
      createdAt: new Date().toISOString(),
    };
    this.alerts.push(record);
    return { ...record };
  }

  async pendingAlerts(limit: number): Promise<PendingAlert[]> {
    return this.alerts
      .filter((a) => !a.sent)
      .slice(0, limit)
      .map((a) => ({
        ...a,
        chatId: a.subscriptionId != null
          ? this.subs.find((s) => s.id === a.subscriptionId)?.chatId ?? null
          : null,
      }));
  }

  async markAlertSent(id: number): Promise<void> {
    const alert = this.alerts.find((a) => a.id === id);
    if (alert) alert.sent = true;
  }
}
