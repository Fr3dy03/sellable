import assert from 'node:assert/strict';
import { runProbe } from '../src/engine.js';
import type { ProbeDeps, TxResult } from '../src/types.js';

const AMOUNT_IN = 10n ** 16n; // 0.01 BOT

function baseDeps(over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    amountInWei: AMOUNT_IN,
    buySlippageBps: 1000,
    quoteBuy: async () => 1000n,
    quoteSell: async () => AMOUNT_IN,
    balanceOf: async () => 990n,
    buy: async (): Promise<TxResult> => ({ ok: true, txHash: '0xbuy' }),
    approve: async (): Promise<TxResult> => ({ ok: true, txHash: '0xappr' }),
    sell: async (): Promise<TxResult> => ({ ok: true, txHash: '0xsell', received: AMOUNT_IN }),
    gasSpent: async () => 10n ** 14n,
    ...over,
  };
}

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];
const test = (name: string, fn: Fn) => tests.push({ name, fn });

test('clean token: low round-trip loss → SELLABLE', async () => {
  const fairSell = 9_900_000_000_000_000n; // 0.0099 BOT
  const sellOut = 9_750_000_000_000_000n; // 0.00975 → 250 bps loss
  const r = await runProbe('0xtoken', baseDeps({
    quoteSell: async () => fairSell,
    sell: async () => ({ ok: true, txHash: '0xsell', received: sellOut }),
  }));
  assert.equal(r.verdict, 'SELLABLE');
  assert.equal(r.buyOk, true);
  assert.equal(r.sellOk, true);
  assert.equal(r.lossBps, 250);
  assert.equal(r.buyTaxBps, 100); // (1000-990)/1000
  assert.equal(r.sellTaxBps, Math.floor(Number((fairSell - sellOut) * 10000n / fairSell)));
  assert.ok(r.gasSpentWei);
});

test('sell reverts → HONEYPOT', async () => {
  const r = await runProbe(
    '0xtoken',
    baseDeps({ sell: async () => ({ ok: false, reason: 'SELL BLOCKED' }) }),
  );
  assert.equal(r.verdict, 'HONEYPOT');
  assert.equal(r.sellOk, false);
  assert.match(r.revertReason ?? '', /SELL BLOCKED/);
  assert.equal(r.sellTx, null);
});

test('buy reverts → INCONCLUSIVE (buy leg failed)', async () => {
  const r = await runProbe(
    '0xtoken',
    baseDeps({ buy: async () => ({ ok: false, reason: 'uniswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT' }) }),
  );
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.equal(r.buyOk, false);
  assert.match(r.revertReason ?? '', /INSUFFICIENT_OUTPUT/);
});

test('no quote → INCONCLUSIVE without spending', async () => {
  let bought = false;
  const r = await runProbe(
    '0xtoken',
    baseDeps({
      quoteBuy: async () => null,
      buy: async () => {
        bought = true;
        return { ok: true, txHash: '0x' };
      },
    }),
  );
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.equal(bought, false);
  assert.match(r.revertReason ?? '', /no buy quote/);
});

test('approve reverts → INCONCLUSIVE (stuck before sell)', async () => {
  const r = await runProbe(
    '0xtoken',
    baseDeps({ approve: async () => ({ ok: false, reason: 'approve: USDT REVERT' }) }),
  );
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.revertReason ?? '', /approve/);
});

test('buy yields 0 tokens → INCONCLUSIVE', async () => {
  const r = await runProbe('0xtoken', baseDeps({ balanceOf: async () => 0n }));
  assert.equal(r.verdict, 'INCONCLUSIVE');
  assert.match(r.revertReason ?? '', /0 tokens/);
});

test('moderate tax: 30% loss → HIGH_TAX', async () => {
  const r = await runProbe(
    '0xtoken',
    baseDeps({
      balanceOf: async () => 990n,
      sell: async () => ({ ok: true, txHash: '0xsell', received: (AMOUNT_IN * 70n) / 100n }),
    }),
  );
  assert.equal(r.verdict, 'HIGH_TAX');
  assert.equal(r.lossBps, 3000);
});

test('extortionate tax: 70% loss → HONEYPOT', async () => {
  const r = await runProbe(
    '0xtoken',
    baseDeps({
      balanceOf: async () => 990n,
      sell: async () => ({ ok: true, txHash: '0xsell', received: (AMOUNT_IN * 30n) / 100n }),
    }),
  );
  assert.equal(r.verdict, 'HONEYPOT');
  assert.equal(r.lossBps, 7000);
});

test('negative price move clamps tax to 0', async () => {
  const r = await runProbe(
    '0xtoken',
    baseDeps({
      quoteBuy: async () => 1000n, // fair 1000
      balanceOf: async () => 1200n, // got MORE than fair (price dipped)
      quoteSell: async () => AMOUNT_IN,
      sell: async () => ({ ok: true, txHash: '0xsell', received: AMOUNT_IN }),
    }),
  );
  assert.equal(r.buyTaxBps, 0);
  assert.equal(r.verdict, 'SELLABLE');
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
