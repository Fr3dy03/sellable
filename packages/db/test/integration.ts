import assert from 'node:assert/strict';
import pg from 'pg';
import { CURRENT } from '@sellable/core';
import { PgRepo } from '../src/pg.js';
import { openProbeGuard } from '../../probe/src/safety.js';

// Run only against an explicitly named disposable database, after migrations.
const url = process.env.TEST_DB_URL;
if (!url || url !== process.env.DB_URL) throw new Error('Set TEST_DB_URL=DB_URL to a migrated disposable test database');
const client = new pg.Client({ connectionString: url });
await client.connect();
const repo = new PgRepo(url);
let guard: Awaited<ReturnType<typeof openProbeGuard>> | undefined;
try {
  assert.equal(await repo.ping(), true);
  await client.query('TRUNCATE probe_jobs, probe_budget_reservations');
  guard = await openProbeGuard(url);
  await assert.rejects(openProbeGuard(url), /already running/);
  assert.equal(await guard.reserve('0xtest', 60n, 100n), true);
  assert.equal(await guard.reserve('0xtest', 60n, 100n), false);
  await guard.close();
  guard = await openProbeGuard(url);
  assert.equal(await guard.reserve('0xtest', 41n, 100n), false, 'reservation survives worker restart');
  assert.equal(await guard.reserve('0xtest', 40n, 100n), true);
  const address = '0x0000000000000000000000000000000000000001';
  const enqueues = await Promise.all(Array.from({ length: 5 }, () => repo.enqueueProbe(address, 'integration')));
  assert.equal(enqueues.filter(Boolean).length, 1);
  const jobs = await Promise.all([repo.nextProbeJob(), repo.nextProbeJob()]);
  assert.equal(jobs.filter(Boolean).length, 1);
  await client.query('UPDATE deployment_network SET chain_id = $1', [CURRENT.chainId === 677 ? 968 : 677]);
  await assert.rejects(repo.ping(), /network mismatch/);
  console.log('Postgres integration passed: exclusive worker, durable budget, concurrent queue, network isolation');
} finally {
  await client.query('UPDATE deployment_network SET chain_id = $1', [CURRENT.chainId]);
  await client.query('TRUNCATE probe_jobs, probe_budget_reservations');
  await guard?.close();
  await repo.close();
  await client.end();
}
