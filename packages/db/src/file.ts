import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PreCheckReport, TokenMeta } from '@sellable/core';
import { MemoryRepo } from './memory.js';
import type {
  Alert,
  AlertInput,
  PendingAlert,
  ProbeJob,
  ProbeJobStatus,
  ProbeRecord,
  Repo,
  Severity,
  Subscription,
  SubscriptionKind,
} from './types.js';

interface FileState {
  tokens: [string, TokenMeta][];
  prechecks: [string, PreCheckReport[]][];
  probes: [string, ProbeRecord[]][];
  jobs: ProbeRecordJob[];
  subs?: Subscription[];
  alerts?: Alert[];
}

type ProbeRecordJob = ProbeJob & { done: boolean };

/**
 * JSON-file-backed repo for local multi-process use (API + probe worker share
 * one store without Postgres). Every operation re-reads the file first so the
 * two processes see each other's writes.
 */
export class FileRepo extends MemoryRepo implements Repo {
  constructor(private readonly path: string) {
    super();
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const state: FileState = JSON.parse(readFileSync(this.path, 'utf8'));
      this.tokens = new Map(state.tokens);
      this.prechecks = new Map(state.prechecks);
      this.probes = new Map(state.probes);
      this.jobs = state.jobs;
      this.subs = state.subs ?? [];
      this.alerts = state.alerts ?? [];
      this.nextSubId = this.subs.reduce((m, s) => Math.max(m, s.id + 1), 1);
      this.nextAlertId = this.alerts.reduce((m, a) => Math.max(m, a.id + 1), 1);
    } catch {
      // corrupted store — start clean rather than crash the service
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const state: FileState = {
      tokens: [...this.tokens],
      prechecks: [...this.prechecks],
      probes: [...this.probes],
      jobs: this.jobs,
      subs: this.subs,
      alerts: this.alerts,
    };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    // atomic replace so the other process never reads a half-written file
    renameSync(tmp, this.path);
  }

  override async getToken(address: string): Promise<TokenMeta | null> {
    this.load();
    return super.getToken(address);
  }

  override async latestPrecheck(address: string): Promise<PreCheckReport | null> {
    this.load();
    return super.latestPrecheck(address);
  }

  override async listProbes(address: string): Promise<ProbeRecord[]> {
    this.load();
    return super.listProbes(address);
  }

  override async latestProbe(address: string): Promise<ProbeRecord | null> {
    this.load();
    return super.latestProbe(address);
  }

  override async todayCostWei(): Promise<bigint> {
    this.load();
    return super.todayCostWei();
  }

  override async upsertToken(meta: TokenMeta): Promise<void> {
    this.load();
    await super.upsertToken(meta);
    this.save();
  }

  override async savePrecheck(report: PreCheckReport): Promise<void> {
    this.load();
    await super.savePrecheck(report);
    this.save();
  }

  override async saveProbe(record: ProbeRecord): Promise<void> {
    this.load();
    await super.saveProbe(record);
    this.save();
  }

  override async enqueueProbe(address: string, reason: string): Promise<boolean> {
    this.load();
    const ok = await super.enqueueProbe(address, reason);
    this.save();
    return ok;
  }

  override async nextProbeJob(): Promise<ProbeJob | null> {
    this.load();
    const job = await super.nextProbeJob();
    this.save();
    return job;
  }

  override async finishProbeJob(address: string, status: ProbeJobStatus, error?: string): Promise<void> {
    this.load();
    await super.finishProbeJob(address, status, error);
    this.save();
  }

  override async listSubscriptions(chatId: number): Promise<Subscription[]> {
    this.load();
    return super.listSubscriptions(chatId);
  }

  override async allSubscriptions(): Promise<Subscription[]> {
    this.load();
    return super.allSubscriptions();
  }

  override async subscribers(address: string): Promise<Subscription[]> {
    this.load();
    return super.subscribers(address);
  }

  override async setMinSeverity(chatId: number, severity: Severity): Promise<number> {
    this.load();
    const n = await super.setMinSeverity(chatId, severity);
    this.save();
    return n;
  }

  override async pendingAlerts(limit: number): Promise<PendingAlert[]> {
    this.load();
    return super.pendingAlerts(limit);
  }

  override async subscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean> {
    this.load();
    const ok = await super.subscribe(chatId, address, kind);
    this.save();
    return ok;
  }

  override async unsubscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean> {
    this.load();
    const ok = await super.unsubscribe(chatId, address, kind);
    this.save();
    return ok;
  }

  override async enqueueAlert(alert: AlertInput): Promise<Alert> {
    this.load();
    const created = await super.enqueueAlert(alert);
    this.save();
    return created;
  }

  override async markAlertSent(id: number): Promise<void> {
    this.load();
    await super.markAlertSent(id);
    this.save();
  }
}
