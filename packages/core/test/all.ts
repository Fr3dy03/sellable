import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { scanBytecode, staticChecks } from '../src/static.js';
import { matchFakeToken, similarity, fakeTokenChecks } from '../src/fake.js';
import { aggregate } from '../src/verdict.js';
import { concentrationChecks } from '../src/holders.js';
import type { TokenMeta } from '../src/types.js';

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];
const test = (name: string, fn: Fn) => tests.push({ name, fn });

const sel = (sig: string) => ethers.id(sig).slice(2, 10);

const META: TokenMeta = {
  address: '0x0000000000000000000000000000000000000001',
  name: 'Foo',
  symbol: 'FOO',
  decimals: 18,
  totalSupply: '1000000000000000000000000',
  isContract: true,
  isVerified: false,
  isScamFlagged: false,
};

test('detects risky function selectors in bytecode', () => {
  const code = '0x6080' + sel('mint(address,uint256)') + sel('setBlacklist(address,bool)') + sel('owner()') + 'ff';
  const scan = scanBytecode(code);
  const ids = scan.findings.map((f) => f.id);
  assert.ok(ids.includes('mint'));
  assert.ok(ids.includes('blacklist'));
  assert.equal(scan.ownable, true);
  const checks = staticChecks(scan, null);
  assert.ok(checks.some((c) => c.id === 'fn-mint' && c.severity === 'danger'));
  assert.ok(checks.some((c) => c.id === 'is-contract' && c.passed === true));
});

test('clean bytecode yields no risky findings', () => {
  const scan = scanBytecode('0x6080604052' + '12345678'.repeat(8));
  assert.equal(scan.findings.length, 0);
});

test('empty code = not a contract', () => {
  const scan = scanBytecode('0x');
  assert.equal(scan.isContract, false);
  const checks = staticChecks(scan, null);
  assert.ok(checks.some((c) => c.id === 'is-contract' && c.passed === false));
});

test('minimal proxy (EIP-1167) detected', () => {
  const impl = '1111111111111111111111111111111111111111';
  const code = '0x363d3d373d3d3d363d73' + impl + '5af43d82803e903d91602b57fd5bf3';
  const scan = scanBytecode(code);
  assert.equal(scan.minimalProxy, true);
  assert.ok(staticChecks(scan, null).some((c) => c.id === 'proxy'));
});

test('proxy impl triggers proxy check', () => {
  const checks = staticChecks(scanBytecode('0x6080'), '0x2222222222222222222222222222222222222222');
  assert.ok(checks.some((c) => c.id === 'proxy' && c.severity === 'warn'));
});

test('levenshtein similarity sanity', () => {
  assert.equal(similarity('USDT', 'USDT'), 1);
  assert.ok(similarity('USDT', 'BUSDT') >= 0.6 && similarity('USDT', 'BUSDT') < 1);
  assert.ok(similarity('USDT', 'WBOT') < 0.5);
  assert.equal(similarity('', 'USDT'), 0);
});

test('fake USDT with wrong decimals flagged as exact impersonation', () => {
  const m = matchFakeToken({ ...META, name: 'Tether USD', symbol: 'USDT', decimals: 18 });
  assert.ok(m);
  assert.equal(m.impersonates, 'USDT');
  assert.equal(m.kind, 'exact');
  assert.equal(m.decimalsMismatch, true);
  assert.equal(fakeTokenChecks(m, false)[0].severity, 'danger');
});

test('real official addresses never flag as fake', () => {
  assert.equal(
    matchFakeToken({
      address: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
      name: 'Tether USD',
      symbol: 'USDT',
      decimals: 6,
      isVerified: true,
    }),
    null,
  );
  assert.equal(
    matchFakeToken({ ...META, name: 'Foo', symbol: 'FOO', decimals: 18, isVerified: false }),
    null,
  );
});

test('verdict aggregation: contract missing → NOT_A_CONTRACT', () => {
  const r = aggregate({
    block: 1,
    token: { ...META, isContract: false },
    checks: [],
    quoteOk: false,
    quoteBlocked: false,
    hasPair: false,
  });
  assert.equal(r.verdict, 'NOT_A_CONTRACT');
  assert.equal(r.sellable, 'not-run');
  assert.equal(r.stage, 'pre-check');
});

test('verdict aggregation: no pair → NO_LIQUIDITY', () => {
  const r = aggregate({
    block: 1,
    token: META,
    checks: [],
    hasPair: false,
    quoteOk: false,
    quoteBlocked: false,
  });
  assert.equal(r.verdict, 'NO_LIQUIDITY');
});

test('verdict aggregation: pair but no price → UNKNOWN', () => {
  const r = aggregate({
    block: 1,
    token: META,
    checks: [],
    hasPair: true,
    quoteOk: false,
    quoteBlocked: false,
  });
  assert.equal(r.verdict, 'UNKNOWN');
});

test('verdict aggregation: reverted sim → BUY_BLOCKED', () => {
  const r = aggregate({
    block: 1,
    token: META,
    checks: [],
    hasPair: true,
    quoteOk: false,
    quoteBlocked: true,
  });
  assert.equal(r.verdict, 'BUY_BLOCKED');
});

test('verdict aggregation: passing sim → QUOTE_OK, risks collected', () => {
  const r = aggregate({
    block: 1,
    token: META,
    checks: [
      { id: 'a', title: 't', severity: 'danger', passed: false, detail: '', source: 's' },
      { id: 'b', title: 't', severity: 'warn', passed: false, detail: '', source: 's' },
      { id: 'c', title: 't', severity: 'info', passed: true, detail: '', source: 's' },
    ],
    quoteOk: true,
    quoteBlocked: false,
    hasPair: true,
  });
  assert.equal(r.verdict, 'QUOTE_OK');
  assert.deepEqual(r.risks, ['a']);
});

test('concentration severity thresholds', () => {
  const safe = concentrationChecks({ top10SharePct: 30, top1: null, sampleSize: 10 });
  const warn = concentrationChecks({ top10SharePct: 60, top1: null, sampleSize: 10 });
  const danger = concentrationChecks({ top10SharePct: 90, top1: null, sampleSize: 10 });
  assert.equal(safe[0].severity, 'info');
  assert.equal(warn[0].severity, 'warn');
  assert.equal(danger[0].severity, 'danger');
  assert.equal(concentrationChecks({ top10SharePct: null, top1: null, sampleSize: 0 })[0].passed, null);
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
