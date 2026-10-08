import { preCheck, summaryLine, type PreCheckReport } from '@sellable/core';

const ICON: Record<string, string> = { info: '·', warn: '!', danger: 'X', null: '?' };

function print(r: PreCheckReport): void {
  console.log(`\n=== SELLABLE pre-check · block ${r.block} · chain ${r.chainId} ===`);
  console.log(summaryLine(r));
  console.log(
    `${r.token.symbol} ${r.token.address} · decimals ${r.token.decimals}` +
      ` · verified=${r.token.isVerified} · supply=${r.token.totalSupply ?? '?'}`,
  );
  if (r.quote) {
    console.log(
      `quote: venue ${r.quote.venue} · path ${r.quote.path.join(' -> ')}` +
        ` · out ${r.quote.amountOut} (raw)`,
    );
  }
  console.log('');
  for (const c of r.checks) {
    const mark = ICON[String(c.severity)] ?? '·';
    const ok = c.passed === null ? '~' : c.passed ? '+' : '-';
    console.log(` [${mark}${ok}] ${c.title}: ${c.detail}  (${c.source})`);
  }
  console.log(`\n risks: ${r.risks.length ? r.risks.join(', ') : 'none'}`);
  console.log(` sellable: ${r.sellable} — ${r.disclaimer}\n`);
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg || arg === '-h' || arg === '--help') {
    console.log('usage: npm run check -- <tokenAddress>');
    process.exit(1);
  }
  try {
    print(await preCheck(arg));
  } catch (err) {
    console.error('pre-check failed:', err instanceof Error ? err.message : err);
    process.exit(2);
  }
}

main();
