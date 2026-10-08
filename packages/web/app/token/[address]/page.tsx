'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import {
  enqueueProbe,
  fetchProbes,
  isAddress,
  postCheck,
  shortAddress,
  verdictMeta,
  type Check,
  type PreCheckReport,
  type ProbeRecord,
} from '@/lib/api';

function CheckRow({ c }: { c: Check }) {
  const icon = c.severity === 'danger' ? '✕' : c.severity === 'warn' ? '!' : '·';
  const state =
    c.passed === null ? '~' : c.passed ? <span className="check-pass">ok</span> : <span className="check-fail">flag</span>;
  return (
    <div className="check-row">
      <span className={`check-icon s-${c.severity}`}>{icon}</span>
      <div>
        <span className="check-title">{c.title}</span> [{state}] —{' '}
        <span className="check-detail">{c.detail}</span>
        <div className="check-src">src: {c.source}</div>
      </div>
    </div>
  );
}

export default function TokenPage() {
  const params = useParams<{ address: string }>();
  const address = params.address;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [report, setReport] = useState<PreCheckReport | null>(null);
  const [probes, setProbes] = useState<ProbeRecord[]>([]);
  const [probeState, setProbeState] = useState<'idle' | 'queued' | 'error'>('idle');
  const [probeError, setProbeError] = useState('');
  const [cached, setCached] = useState(false);

  const load = useCallback(async () => {
    if (!address || !isAddress(address)) {
      setError('invalid token address');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await postCheck(address);
      setReport(res.report);
      setCached(res.cached);
      setProbes(await fetchProbes(address));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void load();
  }, [load]);

  const runProbe = async (): Promise<void> => {
    setProbeState('idle');
    setProbeError('');
    try {
      const res = await enqueueProbe(address);
      setProbeState(res.queued ? 'queued' : 'queued');
      setProbes(await fetchProbes(address));
    } catch (err) {
      setProbeState('error');
      setProbeError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return (
      <div className="loading">
        <span className="spin">◇</span> scanning {shortAddress(address)} — bytecode, holders,
        liquidity, buy sim… (10–30s)
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-box">
        scan failed: {error}
        <div style={{ marginTop: 12 }}>
          <button className="btn-ghost" onClick={() => void load()}>
            retry
          </button>
        </div>
      </div>
    );
  }

  if (!report) return null;

  const latestProbe = probes[0] ?? null;
  const effectiveVerdict = latestProbe ? latestProbe.verdict : report.verdict;
  const meta = verdictMeta(effectiveVerdict);
  const fromProbe = !!latestProbe;
  const t = report.token;

  return (
    <>
      <div className={`verdict v-${meta.tone}`}>
        <div className="verdict-label">{meta.label}</div>
        <div className="verdict-sub">
          {meta.blurb}
          {fromProbe
            ? ` probe ${new Date(latestProbe!.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`
            : ` source: pre-check${cached ? ' (cached)' : ''} @ block ${report.block}`}
        </div>
        {report.risks.length > 0 ? (
          <div className="risks">
            {report.risks.map((r) => (
              <span className="risk-tag" key={r}>
                {r}
              </span>
            ))}
          </div>
        ) : (
          <div className="risks">
            <span className="ok-tag">no danger flags</span>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>token</h2>
        <div className="meta-grid">
          <div className="meta-item">
            <div className="meta-k">name</div>
            <div className="meta-v">
              {t.name || '—'} ({t.symbol || '?'})
            </div>
          </div>
          <div className="meta-item">
            <div className="meta-k">address</div>
            <div className="meta-v">{shortAddress(t.address)}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">decimals</div>
            <div className="meta-v">{t.decimals}</div>
          </div>
          <div className="meta-item">
            <div className="meta-k">source</div>
            <div className="meta-v">{t.isVerified ? 'verified ✓' : 'not verified'}</div>
          </div>
          {report.quote && (
            <div className="meta-item">
              <div className="meta-k">buy sim</div>
              <div className="meta-v">
                0.01 BOT →{' '}
                {(
                  Number(report.quote.amountOut) / 10 ** t.decimals
                ).toLocaleString(undefined, { maximumFractionDigits: 4 })}{' '}
                {t.symbol}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>probe (real buy → sell)</h2>
        {latestProbe ? (
          <div className="probe-line">
            <div>
              <span className="label">verdict:</span> <b>{latestProbe.verdict}</b>
            </div>
            <div>
              <span className="label">round-trip loss:</span>{' '}
              {latestProbe.lossBps != null ? `${(latestProbe.lossBps / 100).toFixed(2)}%` : 'n/a'}
            </div>
            <div>
              <span className="label">buy tax:</span>{' '}
              {latestProbe.buyTaxBps != null ? `${(latestProbe.buyTaxBps / 100).toFixed(2)}%` : 'n/a'}{' '}
              · <span className="label">sell tax:</span>{' '}
              {latestProbe.sellTaxBps != null ? `${(latestProbe.sellTaxBps / 100).toFixed(2)}%` : 'n/a'}
            </div>
            {latestProbe.revertReason && (
              <div>
                <span className="label">reason:</span> {latestProbe.revertReason}
              </div>
            )}
            <div style={{ marginTop: 8 }}>
              <button className="btn-ghost" onClick={() => void load()}>
                refresh
              </button>
            </div>
          </div>
        ) : (
          <div className="probe-line">
            <span className="label">
              no live probe yet — pre-check above is simulation-only.
            </span>
            <div style={{ marginTop: 10 }}>
              <button className="btn-ghost" onClick={() => void runProbe()}>
                run probe (~0.02 BOT)
              </button>
              {probeState === 'queued' && (
                <span className="hint" style={{ marginLeft: 10 }}>
                  queued — waiting for the probe worker
                </span>
              )}
              {probeState === 'error' && (
                <span style={{ color: 'var(--red)', marginLeft: 10 }}>{probeError}</span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>checks ({report.checks.length})</h2>
        {report.checks.map((c) => (
          <CheckRow c={c} key={c.id + c.title} />
        ))}
        <p className="disclaimer">{report.disclaimer}</p>
      </div>
    </>
  );
}
