import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { MemoryRepo } from '@sellable/db';
import { createApp as createApi } from '../src/server.js';
const createApp = (repo: MemoryRepo) => createApi(repo, { requireProbeAuth: false, checkRpc: async () => 123 });

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

test('health distinguishes RPC failure from storage failure', async () => {
  const rpcDown = createApi(new MemoryRepo(), { checkRpc: async () => { throw new Error('RPC unavailable'); } });
  const response = await call(rpcDown, 'GET', '/health');
  assert.equal(response.status, 503);
  const health = await response.json() as { db: boolean; rpc: boolean; block: number | null };
  assert.equal(health.db, true);
  assert.equal(health.rpc, false);
  assert.equal(health.block, null);
  const repo = new MemoryRepo();
  repo.ping = async () => false;
  const storageDown = await call(createApp(repo), 'GET', '/health');
  const storageHealth = await storageDown.json() as { db: boolean; rpc: boolean; block: number };
  assert.equal(storageDown.status, 503);
  assert.equal(storageHealth.db, false);
  assert.equal(storageHealth.rpc, true);
  assert.equal(storageHealth.block, 123);
});

test('live pre-check of USDT, then cached read', async () => {
  if (process.env.RUN_LIVE_TESTS !== 'true') return;
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

test('malformed JSON shapes are rejected without a server error', async () => {
  const app = createApp(new MemoryRepo());
  for (const body of [{ address: 42 }, ['address'], { address: {} }]) {
    for (const route of ['/check', '/probe']) {
      assert.equal((await call(app, 'POST', route, body)).status, 400);
    }
  }
  const res = await app.request('/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
  assert.equal(res.status, 400);
});

test('probe authorization gates spending and handles incorrect credentials', async () => {
  const previous = { key: process.env.PROBE_API_KEY, enabled: process.env.PROBE_ENABLED };
  try {
    process.env.PROBE_API_KEY = 'test-operator-secret';
    process.env.PROBE_ENABLED = 'false';
    const app = createApp(new MemoryRepo());
    assert.equal((await call(app, 'POST', '/probe', { address: USDT })).status, 503);
    process.env.PROBE_ENABLED = 'true';
    assert.equal((await call(app, 'POST', '/probe', { address: USDT })).status, 401);
    const request = (key: string) => app.request('/probe', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ address: USDT }) });
    assert.equal((await request('wrong-secret')).status, 401);
    assert.equal((await request('test-operator-secret')).status, 202);
  } finally {
    if (previous.key === undefined) delete process.env.PROBE_API_KEY; else process.env.PROBE_API_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.PROBE_ENABLED; else process.env.PROBE_ENABLED = previous.enabled;
  }
});

test('unhealthy database makes health fail and large bodies are rejected', async () => {
  const repo = new MemoryRepo();
  repo.ping = async () => false;
  const app = createApp(repo);
  assert.equal((await call(app, 'GET', '/health')).status, 503);
  assert.equal((await call(app, 'POST', '/check', { address: 'x'.repeat(5000) })).status, 413);
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
