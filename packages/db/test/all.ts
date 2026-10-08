import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenMeta } from '@sellable/core';
import { FileRepo, MemoryRepo, makeRepo } from '../src/index.js';

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];
const test = (name: string, fn: Fn) => tests.push({ name, fn });

const ADDR = '0x5508c9b8CA4540B273ea7e14c4ace6778a20412b';
const ADDR2 = '0xa96746E5A95B84fE758b754C857bF0eFD08B77Ad';

const dir = mkdtempSync(join(tmpdir(), 'sellable-db-'));
const store = join(dir, 'store.json');

const meta = (address: string): TokenMeta => ({
  address,
  symbol: 'T',
  name: 'T',
  decimals: 18,
  totalSupply: '1',
  isContract: true,
  isVerified: false,
  isScamFlagged: false,
});

const probe = (address: string, costBotWei: string) => ({
  address,
  chainId: 968,
  amountInWei: '1',
  buyOk: true,
  sellOk: true,
  buyReceived: '1',
  sellReceived: '1',
  fairBuyOut: null,
  fairSellOut: null,
  buyTaxBps: 0,
  sellTaxBps: 0,
  lossBps: 0,
  buyTx: null,
  approveTx: null,
  sellTx: null,
  gasSpentWei: '1',
  costBotWei,
  costUsd: 0,
  revertReason: null,
  verdict: 'SELLABLE' as const,
  createdAt: new Date().toISOString(),
});

test('makeRepo: env defaults, DB_FILE selects FileRepo', () => {
  const prev = process.env.DB_FILE;
  process.env.DB_FILE = store;
  try {
    const repo = makeRepo(undefined, undefined);
    assert.ok(repo instanceof FileRepo);
  } finally {
    if (prev === undefined) delete process.env.DB_FILE;
    else process.env.DB_FILE = prev;
  }
});

test('FileRepo persists tokens across instances', async () => {
  const a = new FileRepo(store);
  await a.upsertToken(meta(ADDR));
  const b = new FileRepo(store);
  const got = await b.getToken(ADDR);
  assert.equal(got?.symbol, 'T');
  assert.equal(await b.getToken(ADDR2), null);
});

test('FileRepo hands jobs from producer process to consumer process', async () => {
  const producer = new FileRepo(store);
  const ok = await producer.enqueueProbe(ADDR, 'unit');
  assert.equal(ok, true);
  assert.equal(await producer.enqueueProbe(ADDR, 'dup'), false);

  const consumer = new FileRepo(store);
  const job = await consumer.nextProbeJob();
  assert.equal(job?.address, ADDR.toLowerCase());
  assert.equal(job?.status, 'running');

  await consumer.finishProbeJob(ADDR, 'done');
  const after = new FileRepo(store);
  assert.equal(await after.nextProbeJob(), null);
  assert.equal(await after.enqueueProbe(ADDR, 'rerun'), true);
});

test('FileRepo probe records and daily budget are shared', async () => {
  const b = new FileRepo(store); // constructed BEFORE the writes — must still see them
  const a = new FileRepo(store);
  await a.saveProbe(probe(ADDR, '5000000000000000'));
  await a.saveProbe(probe(ADDR2, '7000000000000000'));
  assert.equal((await b.listProbes(ADDR)).length, 1);
  assert.equal((await b.latestProbe(ADDR2))?.verdict, 'SELLABLE');
  assert.equal(await b.todayCostWei(), 12000000000000000n);
});

test('FileRepo tolerates a corrupted store file', async () => {
  const bad = join(dir, 'bad.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(bad, '{not json');
  const repo = new FileRepo(bad);
  assert.equal(await repo.ping(), true);
  await repo.enqueueProbe(ADDR2, 'ok');
  assert.equal((await new FileRepo(bad)).nextProbeJob !== undefined, true);
});

test('MemoryRepo stays the no-env default', () => {
  const prevFile = process.env.DB_FILE;
  const prevUrl = process.env.DB_URL;
  delete process.env.DB_FILE;
  delete process.env.DB_URL;
  try {
    assert.ok(makeRepo(undefined, undefined) instanceof MemoryRepo);
  } finally {
    if (prevFile !== undefined) process.env.DB_FILE = prevFile;
    if (prevUrl !== undefined) process.env.DB_URL = prevUrl;
  }
});

test('new-listing subscriptions round-trip (memory + file)', async () => {
  const m = new MemoryRepo();
  assert.equal(await m.subscribe(7, '', 'new-listing'), true);
  assert.equal(await m.subscribe(7, '', 'new-listing'), false, 'dedupes');
  const subs = await m.listSubscriptions(7);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].kind, 'new-listing');
  assert.equal(subs[0].minSeverity, 'info');
  assert.deepEqual(await m.subscribers(ADDR), [], 'not returned for token lookups');
  assert.equal(await m.unsubscribe(7, '', 'new-listing'), true);
  assert.equal(await m.unsubscribe(7, '', 'new-listing'), false);

  const file = join(dir, 'subs.json');
  const f = new FileRepo(file);
  await f.subscribe(9, '', 'new-listing');
  await f.subscribe(9, ADDR, 'token');
  const reloaded = new FileRepo(file);
  const list = await reloaded.listSubscriptions(9);
  assert.equal(list.length, 2);
  assert.equal(list.filter((s) => s.kind === 'new-listing').length, 1);
  assert.equal(list.filter((s) => s.kind === 'token').length, 1);
});

test('setMinSeverity updates every subscription of a chat and persists', async () => {
  const file = join(dir, 'sev.json');
  const f = new FileRepo(file);
  await f.subscribe(3, '', 'new-listing');
  await f.subscribe(3, ADDR, 'token');
  assert.equal(await f.setMinSeverity(3, 'danger'), 2);
  const reloaded = new FileRepo(file);
  const subs = await reloaded.listSubscriptions(3);
  assert.equal(subs.length, 2);
  assert.ok(subs.every((s) => s.minSeverity === 'danger'));
  assert.equal(await reloaded.setMinSeverity(99, 'warn'), 0, 'unknown chat → 0');
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
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
