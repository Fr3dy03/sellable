import type { PreCheckReport, TokenMeta } from '@sellable/core';

export type ProbeVerdict = 'SELLABLE' | 'HIGH_TAX' | 'HONEYPOT' | 'INCONCLUSIVE';

export interface ProbeRecord {
  address: string;
  chainId: number;
  amountInWei: string;
  buyOk: boolean;
  sellOk: boolean;
  buyReceived: string | null;
  sellReceived: string | null;
  fairBuyOut: string | null;
  fairSellOut: string | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  lossBps: number | null;
  buyTx: string | null;
  approveTx: string | null;
  sellTx: string | null;
  gasSpentWei: string | null;
  costBotWei: string | null;
  costUsd: number | null;
  revertReason: string | null;
  verdict: ProbeVerdict;
  createdAt: string;
}

export type ProbeJobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface ProbeJob {
  address: string;
  status: ProbeJobStatus;
  reason: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export type SubscriptionKind = 'token' | 'new-listing';
export type Severity = 'info' | 'warn' | 'danger';

export interface Subscription {
  id: number;
  chatId: number;
  address: string;
  kind: SubscriptionKind;
  minSeverity: Severity;
  createdAt: string;
}

export interface AlertInput {
  subscriptionId: number | null;
  address: string | null;
  severity: Severity;
  title: string;
  body: string;
}

export interface Alert extends AlertInput {
  id: number;
  sent: boolean;
  createdAt: string;
}

export interface PendingAlert extends Alert {
  chatId: number | null;
}

export interface Repo {
  ping(): Promise<boolean>;
  close(): Promise<void>;

  upsertToken(meta: TokenMeta): Promise<void>;
  getToken(address: string): Promise<TokenMeta | null>;

  savePrecheck(report: PreCheckReport): Promise<void>;
  latestPrecheck(address: string): Promise<PreCheckReport | null>;

  saveProbe(record: ProbeRecord): Promise<void>;
  listProbes(address: string): Promise<ProbeRecord[]>;
  latestProbe(address: string): Promise<ProbeRecord | null>;

  enqueueProbe(address: string, reason: string): Promise<boolean>;
  nextProbeJob(): Promise<ProbeJob | null>;
  finishProbeJob(address: string, status: ProbeJobStatus, error?: string): Promise<void>;
  /** total probe cost (wei) already spent today (UTC) — budget guard */
  todayCostWei(): Promise<bigint>;

  subscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean>;
  unsubscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean>;
  listSubscriptions(chatId: number): Promise<Subscription[]>;
  allSubscriptions(): Promise<Subscription[]>;
  subscribers(address: string): Promise<Subscription[]>;
  /** raise/lower the minimum alert severity for every subscription of a chat */
  setMinSeverity(chatId: number, severity: Severity): Promise<number>;

  enqueueAlert(alert: AlertInput): Promise<Alert>;
  pendingAlerts(limit: number): Promise<PendingAlert[]>;
  markAlertSent(id: number): Promise<void>;
}

/** store addresses lowercase for consistent lookups */
export const norm = (address: string): string => address.toLowerCase();
