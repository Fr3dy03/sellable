import { preCheck, summaryLine } from '@sellable/core';

const TOKENS = [
  { label: 'USDT (official)', address: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C', expect: 'QUOTE_OK' },
  { label: 'WBOT (official)', address: '0xD5452816194a3784dBa983426cCe7c122F4abd30', expect: 'QUOTE_OK' },
];

async function main(): Promise<void> {
  let failed = 0;
  for (const t of TOKENS) {
    process.stdout.write(`smoke: ${t.label} ... `);
    try {
      const r = await preCheck(t.address);
      const ok = r.verdict === t.expect;
      console.log(`${ok ? 'PASS' : 'FAIL'} — ${summaryLine(r)}`);
      if (!ok) failed++;
    } catch (err) {
      console.log(`FAIL — ${err instanceof Error ? err.message : err}`);
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
