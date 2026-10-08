import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { MemoryRepo } from '@sellable/db';
import { createApp } from '../src/server.js';

const USDT = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];
const test = (name: string, fn: Fn) => tests.push({ name, fn });

const call = (app: Hono, method: string, path: string, body?: unknown) =>
  app.fetch(
    new Request(`http://test${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );

test('health returns ok with memory repo', async () => {
  const app = createApp(new MemoryRepo());
  const res = await call(app, 'GET', '/health');
  assert.equal(res.status, 200);
  const j = (await res.json()) as { ok: boolean; db: boolean; stage: string };
  assert.equal(j.ok, true);
  assert.equal(j.db, true);
  assert.equal(j.stage, 'phase-1');
});

test('check rejects invalid address', async () => {
  const app = createApp(new MemoryRepo());
  const res = await call(app, 'POST', '/check', { address: 'nope' });
  assert.equal(res.status, 400);
  const res2 = await call(app, 'POST', '/check', {});
  assert.equal(res2.status, 400);
});

test('live pre-check of USDT, then cached read', async () => {
  const repo = new MemoryRepo();
  const app = createApp(repo);
  const res = await call(app, 'POST', '/check', { address: USDT });
  assert.equal(res.status, 200);
  const first = (await res.json()) as { cached: boolean; report: { verdict: string; risks: string[] } };
  assert.equal(first.cached, false);
  assert.equal(first.report.verdict, 'QUOTE_OK');

  const res2 = await call(app, 'POST', '/check', { address: USDT });
  const second = (await res2.json()) as { cached: boolean };
  assert.equal(second.cached, true);

  const res3 = await call(app, 'GET', `/tokens/${USDT}`);
  assert.equal(res3.status, 200);
  const tok = (await res3.json()) as { verdict: string; verdictSource: string; probe: unknown };
  assert.equal(tok.verdict, 'QUOTE_OK');
  assert.equal(tok.verdictSource, 'pre-check');
  assert.equal(tok.probe, null);
});

test('token endpoint 404s before first scan', async () => {
  const app = createApp(new MemoryRepo());
  const res = await call(app, 'GET', `/tokens/${USDT}`);
  assert.equal(res.status, 404);
});

test('probe enqueue + worker pickup', async () => {
  const repo = new MemoryRepo();
  const app = createApp(repo);

  const res = await call(app, 'POST', '/probe', { address: USDT });
  assert.equal(res.status, 202);
  const first = (await res.json()) as { queued: boolean };
  assert.equal(first.queued, true);

  const dup = await call(app, 'POST', '/probe', { address: USDT });
  const second = (await dup.json()) as { queued: boolean };
  assert.equal(second.queued, false);

  const job = await repo.nextProbeJob();
  assert.ok(job);
  assert.equal(job!.address, USDT.toLowerCase());
  assert.equal(job!.status, 'running');

  await repo.finishProbeJob(USDT, 'done');
  const none = await repo.nextProbeJob();
  assert.equal(none, null);

  const probes = await call(app, 'GET', `/probes/${USDT}`);
  const pj = (await probes.json()) as { probes: unknown[] };
  assert.equal(pj.probes.length, 0);
});

test('probe rejects non-contract / no-liquidity verdicts (422)', async () => {
  const repo = new MemoryRepo();
  const app = createApp(repo);
  // craft a precheck record with NO_LIQUIDITY via direct save
  const report = {
    stage: 'pre-check' as const,
    chainId: 677,
    block: 1,
    token: {
      address: USDT,
      name: 'Tether USD',
      symbol: 'USDT',
      decimals: 6,
      totalSupply: null,
      isContract: true,
      isVerified: true,
      isScamFlagged: false,
    },
    verdict: 'NO_LIQUIDITY' as const,
    checks: [],
    risks: [],
    quote: null,
    sellable: 'not-run' as const,
    disclaimer: 'x',
  };
  await repo.savePrecheck(report);
  const res = await call(app, 'POST', '/probe', { address: USDT });
  assert.equal(res.status, 422);
});

async function run(): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      fail++;
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
