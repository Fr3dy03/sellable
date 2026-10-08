import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { CHAIN, scanBytecode, matchFakeToken } from '@sellable/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesFile = path.join(here, '..', 'fixtures', 'harness.json');
const artifactsFile = path.join(here, '..', 'artifacts', 'harness.json');

const ERC20 = new ethers.Interface([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function mint(address,uint256)',
  'function setPair(address)',
  'function setBlacklist(address,bool)',
]);

const DEAD = '0x000000000000000000000000000000000000dEaD';
const PLAIN = '0x0000000000000000000000000000000000000001';
const BLACKED = '0x0000000000000000000000000000000000000002';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function callOk(
  provider: ethers.JsonRpcProvider,
  from: string,
  to: string,
  data: string,
): Promise<{ ok: boolean; reason: string }> {
  try {
    await provider.call({ from, to, data });
    return { ok: true, reason: '' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg.slice(0, 140) };
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(fixturesFile)) {
    console.error('fixtures missing — run: npm run harness:deploy');
    process.exit(1);
  }
  const fixture = JSON.parse(fs.readFileSync(fixturesFile, 'utf8')) as {
    tokens: Record<string, string>;
    deployer: string;
    chainId: number;
  };
  const artifacts = JSON.parse(fs.readFileSync(artifactsFile, 'utf8')) as Record<
    string,
    { abi: ethers.InterfaceAbi; bytecode: string }
  >;
  const provider = new ethers.JsonRpcProvider(CHAIN.testnet.rpc, CHAIN.testnet.chainId, {
    staticNetwork: true,
  });
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  const wallet = pk ? new ethers.Wallet(pk, provider) : null;
  const tokens = fixture.tokens;

  console.log(`verifying ${Object.keys(tokens).length} harness tokens on chainId ${fixture.chainId}`);
  console.log(`wallet: ${wallet ? wallet.address : 'none (static checks only)'}\n`);

  // ---- static expectations (bytecode scan, same analyzer as production) ----
  const expectDanger: Record<string, string | null> = {
    BenignToken: null, // clean control: zero danger findings
    HoneypotToken: 'pair-gate',
    BlacklistToken: 'blacklist',
    MintLaterToken: 'mint',
    TaxToken: null, // tax is behavioral, not a selector
    FakeUSDT: null, // caught by fake-token matcher instead
  };

  for (const [name, want] of Object.entries(expectDanger)) {
    const addr = tokens[name];
    const code = await provider.getCode(addr);
    const scan = scanBytecode(code);
    const dangers = scan.findings.filter((f) => f.severity === 'danger').map((f) => f.id);
    if (want) {
      check(`${name}: static danger '${want}'`, dangers.includes(want), `findings=[${dangers.join(',')}]`);
    } else if (name === 'BenignToken') {
      check(`${name}: no danger findings`, dangers.length === 0, `findings=[${dangers.join(',')}]`);
    } else {
      check(`${name}: deployed code`, scan.isContract, `${scan.codeSize} bytes`);
    }
  }

  // ---- metadata + fake matcher ----
  const meta = async (name: string) => {
    const addr = tokens[name];
    const [sym, nm, dec] = await Promise.all([
      provider.call({ to: addr, data: ERC20.encodeFunctionData('symbol') }).then(
        (r) => ERC20.decodeFunctionResult('symbol', r)[0] as string,
      ),
      provider.call({ to: addr, data: ERC20.encodeFunctionData('name') }).then(
        (r) => ERC20.decodeFunctionResult('name', r)[0] as string,
      ),
      provider.call({ to: addr, data: ERC20.encodeFunctionData('decimals') }).then(
        (r) => Number(ERC20.decodeFunctionResult('decimals', r)[0]),
      ),
    ]);
    return { address: addr, name: nm, symbol: sym, decimals: dec, isVerified: false };
  };

  const fake = await meta('FakeUSDT');
  const match = matchFakeToken(fake);
  check(
    'FakeUSDT: matcher flags USDT impersonation (wrong decimals)',
    !!match && match.impersonates === 'USDT' && match.decimalsMismatch,
    match ? `${fake.symbol}/${fake.decimals}dp, sim=${match.similarity.toFixed(2)}, kind=${match.kind}` : 'no match',
  );

  const benignMeta = await meta('BenignToken');
  check('BenignToken: matcher stays clean', matchFakeToken(benignMeta) === null, benignMeta.symbol);

  if (!wallet) {
    printSummary();
    console.log('\nno DEPLOYER_PRIVATE_KEY — behavioral checks skipped');
    process.exit(failures() ? 1 : 0);
  }

  // ---- behavioral: honeypot gate ----
  const honeypot = tokens.HoneypotToken;
  const setPairTx = await wallet.sendTransaction({
    to: honeypot,
    data: ERC20.encodeFunctionData('setPair', [DEAD]),
  });
  await setPairTx.wait();
  const toDead = await callOk(
    provider,
    wallet.address,
    honeypot,
    ERC20.encodeFunctionData('transfer', [DEAD, 10n ** 18n]),
  );
  check('HoneypotToken: transfer to gated pair address reverts', !toDead.ok, toDead.reason || 'did not revert');
  const toLive = await callOk(
    provider,
    wallet.address,
    honeypot,
    ERC20.encodeFunctionData('transfer', [PLAIN, 10n ** 18n]),
  );
  check('HoneypotToken: normal transfer still works', toLive.ok, toLive.reason);

  // ---- behavioral: 5% fee-on-transfer ----
  const tax = tokens.TaxToken;
  const amount = 1000n * 10n ** 18n;
  const before = BigInt(
    await provider.call({ to: tax, data: ERC20.encodeFunctionData('balanceOf', [DEAD]) }).then(
      (r) => ERC20.decodeFunctionResult('balanceOf', r)[0].toString(),
    ),
  );
  const taxTx = await wallet.sendTransaction({
    to: tax,
    data: ERC20.encodeFunctionData('transfer', [DEAD, amount]),
  });
  await taxTx.wait();
  const after = BigInt(
    await provider.call({ to: tax, data: ERC20.encodeFunctionData('balanceOf', [DEAD]) }).then(
      (r) => ERC20.decodeFunctionResult('balanceOf', r)[0].toString(),
    ),
  );
  const got = after - before;
  check('TaxToken: recipient receives amount - 5%', got === (amount * 9500n) / 10000n, `got ${ethers.formatEther(got)} (want ${ethers.formatEther((amount * 9500n) / 10000n)})`);

  // ---- behavioral: blacklist ----
  const bl = tokens.BlacklistToken;
  const blTx = await wallet.sendTransaction({
    to: bl,
    data: ERC20.encodeFunctionData('setBlacklist', [BLACKED, true]),
  });
  await blTx.wait();
  const blCall = await callOk(
    provider,
    wallet.address,
    bl,
    ERC20.encodeFunctionData('transfer', [BLACKED, 10n ** 18n]),
  );
  check('BlacklistToken: transfer to blacklisted address reverts', !blCall.ok, blCall.reason || 'did not revert');

  // ---- behavioral: mint access control ----
  const mintAddr = tokens.MintLaterToken;
  const mintOwner = await callOk(
    provider,
    wallet.address,
    mintAddr,
    ERC20.encodeFunctionData('mint', [wallet.address, 1n]),
  );
  check('MintLaterToken: owner mint call succeeds (simulated)', mintOwner.ok, mintOwner.reason);
  const mintStranger = await callOk(
    provider,
    DEAD,
    mintAddr,
    ERC20.encodeFunctionData('mint', [DEAD, 1n]),
  );
  check('MintLaterToken: non-owner mint reverts', !mintStranger.ok, mintStranger.reason || 'did not revert');

  // ---- behavioral: benign transfer ----
  const benignOk = await callOk(
    provider,
    wallet.address,
    tokens.BenignToken,
    ERC20.encodeFunctionData('transfer', [PLAIN, 10n ** 18n]),
  );
  check('BenignToken: transfer works', benignOk.ok, benignOk.reason);

  printSummary();
  process.exit(failures() ? 1 : 0);
}

function failures(): number {
  return results.filter((r) => !r.ok).length;
}

function printSummary(): void {
  const fail = failures();
  console.log(`\n${results.length - fail} passed, ${fail} failed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
