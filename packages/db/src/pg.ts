import pg from 'pg';
import { CURRENT, type PreCheckReport, type TokenMeta } from '@sellable/core';
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

/** Postgres repo — schema from db/migrations/001_init.sql */
export class PgRepo implements Repo {
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 });
  }

  async ping(): Promise<boolean> {
    await this.pool.query('SELECT 1');
    return true;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async upsertToken(meta: TokenMeta): Promise<void> {
    await this.pool.query(
      `INSERT INTO tokens (address, chain_id, symbol, name, decimals, total_supply, is_contract, is_verified, is_scam_flag, meta_updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (address) DO UPDATE SET
         symbol = EXCLUDED.symbol, name = EXCLUDED.name, decimals = EXCLUDED.decimals,
         total_supply = EXCLUDED.total_supply, is_contract = EXCLUDED.is_contract,
         is_verified = EXCLUDED.is_verified, is_scam_flag = EXCLUDED.is_scam_flag,
         meta_updated_at = now()`,
      [
        meta.address,
        CURRENT.chainId,
        meta.symbol,
        meta.name,
        meta.decimals,
        meta.totalSupply,
        meta.isContract,
        meta.isVerified,
        meta.isScamFlagged,
      ],
    );
  }

  async getToken(address: string): Promise<TokenMeta | null> {
    const r = await this.pool.query(
      `SELECT address, symbol, name, decimals, total_supply, is_contract, is_verified, is_scam_flag
         FROM tokens WHERE lower(address) = $1`,
      [norm(address)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      address: row.address,
      symbol: row.symbol ?? '',
      name: row.name ?? '',
      decimals: Number(row.decimals ?? 18),
      totalSupply: row.total_supply != null ? String(row.total_supply) : null,
      isContract: row.is_contract,
      isVerified: !!row.is_verified,
      isScamFlagged: !!row.is_scam_flag,
    };
  }

  async savePrecheck(report: PreCheckReport): Promise<void> {
    await this.upsertToken(report.token);
    await this.pool.query(
      `INSERT INTO prechecks (address, block_number, verdict, risks, checks, quote)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        report.token.address,
        report.block,
        report.verdict,
        report.risks,
        JSON.stringify(report.checks),
        report.quote ? JSON.stringify(report.quote) : null,
      ],
    );
  }

  async latestPrecheck(address: string): Promise<PreCheckReport | null> {
    const r = await this.pool.query(
      `SELECT p.address, p.block_number, p.verdict, p.risks, p.checks, p.quote, p.created_at,
              t.symbol, t.name, t.decimals, t.total_supply, t.is_contract, t.is_verified, t.is_scam_flag
         FROM prechecks p JOIN tokens t ON lower(t.address) = lower(p.address)
        WHERE lower(p.address) = $1 ORDER BY p.created_at DESC LIMIT 1`,
      [norm(address)],
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      stage: 'pre-check',
      chainId: CURRENT.chainId,
      block: Number(row.block_number),
      token: {
        address: row.address,
        symbol: row.symbol ?? '',
        name: row.name ?? '',
        decimals: Number(row.decimals ?? 18),
        totalSupply: row.total_supply != null ? String(row.total_supply) : null,
        isContract: row.is_contract,
        isVerified: !!row.is_verified,
        isScamFlagged: !!row.is_scam_flag,
      },
      verdict: row.verdict,
      checks: row.checks,
      risks: row.risks ?? [],
      quote: row.quote,
      sellable: 'not-run',
      disclaimer:
        'pre-check only: buy-side verified by simulation. Final SELLABLE/HONEYPOT verdict requires the Phase 1 probe (real micro buy->sell).',
    };
  }

  async saveProbe(record: ProbeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO probes (address, chain_id, buy_tx, sell_tx, approve_tx, amount_in_wei,
         amount_out_wei, buy_ok, sell_ok, buy_tax_bps, sell_tax_bps, tax_bps, loss_bps,
         buy_received_wei, gas_spent_wei, cost_bot_wei, cost_usd, revert_reason, verdict, wallet, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        record.address,
        record.chainId,
        record.buyTx,
        record.sellTx,
        record.approveTx,
        record.amountInWei,
        record.sellReceived,
        record.buyOk,
        record.sellOk,
        record.buyTaxBps,
        record.sellTaxBps,
        record.sellTaxBps,
        record.lossBps,
        record.buyReceived,
        record.gasSpentWei,
        record.costBotWei,
        record.costUsd,
        record.revertReason,
        record.verdict,
        null,
        record.createdAt,
      ],
    );
  }

  async listProbes(address: string): Promise<ProbeRecord[]> {
    const r = await this.pool.query(
      `SELECT * FROM probes WHERE lower(address) = $1 ORDER BY created_at DESC LIMIT 20`,
      [norm(address)],
    );
    return r.rows.map((row) => ({
      address: row.address,
      chainId: Number(row.chain_id),
      amountInWei: String(row.amount_in_wei),
      buyOk: row.buy_ok,
      sellOk: row.sell_ok,
      buyReceived: row.buy_received_wei != null ? String(row.buy_received_wei) : null,
      sellReceived: row.amount_out_wei != null ? String(row.amount_out_wei) : null,
      fairBuyOut: null,
      fairSellOut: null,
      buyTaxBps: row.buy_tax_bps ?? null,
      sellTaxBps: row.sell_tax_bps ?? null,
      lossBps: row.loss_bps ?? null,
      buyTx: row.buy_tx ?? null,
      approveTx: row.approve_tx ?? null,
      sellTx: row.sell_tx ?? null,
      gasSpentWei: row.gas_spent_wei != null ? String(row.gas_spent_wei) : null,
      costBotWei: row.cost_bot_wei != null ? String(row.cost_bot_wei) : null,
      costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
      revertReason: row.revert_reason ?? null,
      verdict: row.verdict,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  async latestProbe(address: string): Promise<ProbeRecord | null> {
    return this.listProbes(address).then((l) => l[0] ?? null);
  }

  async enqueueProbe(address: string, reason: string): Promise<boolean> {
    const r = await this.pool.query(
      `INSERT INTO probe_jobs (address, status, reason)
       VALUES ($1, 'queued', $2)
       ON CONFLICT DO NOTHING
       RETURNING address`,
      [norm(address), reason],
    );
    if (r.rowCount && r.rowCount > 0) return true;
    // allow re-enqueue if previous job finished
    const upd = await this.pool.query(
      `UPDATE probe_jobs SET status = 'queued', reason = $2, attempts = 0, last_error = NULL, created_at = now()
        WHERE lower(address) = $1 AND status IN ('done','failed') AND NOT EXISTS (
          SELECT 1 FROM probe_jobs p2 WHERE lower(p2.address) = $1 AND p2.status IN ('queued','running'))
        RETURNING address`,
      [norm(address), reason],
    );
    return !!upd.rowCount && upd.rowCount > 0;
  }

  async nextProbeJob(): Promise<ProbeJob | null> {
    const r = await this.pool.query(
      `UPDATE probe_jobs SET status = 'running', attempts = attempts + 1
        WHERE address = (
          SELECT address FROM probe_jobs WHERE status = 'queued'
          ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING address, status, reason, attempts, last_error, created_at`,
    );
    const row = r.rows[0];
    if (!row) return null;
    return {
      address: row.address,
      status: row.status,
      reason: row.reason,
      attempts: Number(row.attempts),
      lastError: row.last_error ?? null,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async finishProbeJob(address: string, status: ProbeJob['status'], error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE probe_jobs SET status = $2, last_error = $3 WHERE lower(address) = $1`,
      [norm(address), status, error ?? null],
    );
  }

  async todayCostWei(): Promise<bigint> {
    const r = await this.pool.query(
      `SELECT COALESCE(SUM(cost_bot_wei), 0)::text AS total
         FROM probes WHERE created_at >= date_trunc('day', now())`,
    );
    return BigInt(r.rows[0]?.total ?? '0');
  }

  private static subFromRow(row: Record<string, unknown>): Subscription {
    return {
      id: Number(row.id),
      chatId: Number(row.chat_id),
      address: (row.address as string | null) ?? '',
      kind: row.kind as SubscriptionKind,
      minSeverity: (row.min_severity as Severity) ?? 'info',
      createdAt: new Date(String(row.created_at)).toISOString(),
    };
  }

  async subscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean> {
    if (address === '') {
      const exists = await this.pool.query(
        `SELECT 1 FROM subscriptions WHERE chat_id = $1 AND address IS NULL AND kind = $2`,
        [chatId, kind],
      );
      if (exists.rowCount && exists.rowCount > 0) return false;
      const r = await this.pool.query(
        `INSERT INTO subscriptions (chat_id, address, kind, min_severity)
         VALUES ($1, NULL, $2, 'info') RETURNING id`,
        [chatId, kind],
      );
      return !!r.rowCount && r.rowCount > 0;
    }
    const r = await this.pool.query(
      `INSERT INTO subscriptions (chat_id, address, kind, min_severity)
       VALUES ($1, $2, $3, 'info') ON CONFLICT DO NOTHING RETURNING id`,
      [chatId, address, kind],
    );
    return !!r.rowCount && r.rowCount > 0;
  }

  async unsubscribe(chatId: number, address: string, kind: SubscriptionKind): Promise<boolean> {
    const r = await this.pool.query(
      `DELETE FROM subscriptions
       WHERE chat_id = $1 AND kind = $3 AND COALESCE(lower(address), '') = lower($2)`,
      [chatId, address, kind],
    );
    return !!r.rowCount && r.rowCount > 0;
  }

  async listSubscriptions(chatId: number): Promise<Subscription[]> {
    const r = await this.pool.query(
      `SELECT id, chat_id, address, kind, min_severity, created_at
         FROM subscriptions WHERE chat_id = $1 ORDER BY created_at`,
      [chatId],
    );
    return r.rows.map(PgRepo.subFromRow);
  }

  async allSubscriptions(): Promise<Subscription[]> {
    const r = await this.pool.query(
      `SELECT id, chat_id, address, kind, min_severity, created_at FROM subscriptions ORDER BY created_at`,
    );
    return r.rows.map(PgRepo.subFromRow);
  }

  async subscribers(address: string): Promise<Subscription[]> {
    const r = await this.pool.query(
      `SELECT id, chat_id, address, kind, min_severity, created_at
         FROM subscriptions WHERE lower(address) = lower($1)`,
      [address],
    );
    return r.rows.map(PgRepo.subFromRow);
  }

  async setMinSeverity(chatId: number, severity: Severity): Promise<number> {
    const r = await this.pool.query(
      `UPDATE subscriptions SET min_severity = $2 WHERE chat_id = $1`,
      [chatId, severity],
    );
    return r.rowCount ?? 0;
  }

  async enqueueAlert(alert: AlertInput): Promise<Alert> {
    const r = await this.pool.query(
      `INSERT INTO alerts (subscription_id, address, severity, title, body)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, sent, created_at`,
      [alert.subscriptionId, alert.address, alert.severity, alert.title, alert.body],
    );
    const row = r.rows[0];
    return {
      ...alert,
      id: Number(row.id),
      sent: !!row.sent,
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  async pendingAlerts(limit: number): Promise<PendingAlert[]> {
    const r = await this.pool.query(
      `SELECT a.id, a.subscription_id, a.address, a.severity, a.title, a.body,
              a.sent, a.created_at, s.chat_id
         FROM alerts a LEFT JOIN subscriptions s ON s.id = a.subscription_id
        WHERE NOT a.sent ORDER BY a.created_at, a.id LIMIT $1`,
      [limit],
    );
    return r.rows.map((row) => ({
      id: Number(row.id),
      subscriptionId: row.subscription_id != null ? Number(row.subscription_id) : null,
      address: row.address ?? null,
      severity: row.severity as Severity,
      title: row.title,
      body: row.body,
      sent: !!row.sent,
      createdAt: new Date(row.created_at).toISOString(),
      chatId: row.chat_id != null ? Number(row.chat_id) : null,
    }));
  }

  async markAlertSent(id: number): Promise<void> {
    await this.pool.query(`UPDATE alerts SET sent = true WHERE id = $1`, [id]);
  }
}
