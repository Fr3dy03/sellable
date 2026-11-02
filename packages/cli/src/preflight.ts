import { ethers } from 'ethers';
import { CURRENT, assertChain, getProvider, v2Quote } from '@sellable/core';
import { makeRepo } from '@sellable/db';

// Read-only: no signing, queue consumption, migrations, or transactions.
async function main() {
  if (CURRENT.chainId !== 677) throw new Error('Mainnet preflight requires CHAIN_ENV=mainnet');
  if (!process.env.DB_URL) throw new Error('DB_URL is required; migrate a dedicated mainnet database first');
  await assertChain();
  const provider = getProvider();
  console.log(`RPC chain ${CURRENT.chainId}, block ${await provider.getBlockNumber()}`);
  for (const [label, address] of Object.entries({ router: CURRENT.dex.v2Router, factory: CURRENT.dex.v2Factory, wrap: CURRENT.wrap, usdt: CURRENT.usdt })) {
    if (await provider.getCode(address) === '0x') throw new Error(`${label} has no code: ${address}`);
    console.log(`${label}: ${address}`);
  }
  const router = new ethers.Contract(CURRENT.dex.v2Router, ['function WETH() view returns (address)', 'function factory() view returns (address)'], provider);
  if ((await router.WETH()).toLowerCase() !== CURRENT.wrap.toLowerCase()) throw new Error('Router wrap token mismatch');
  if ((await router.factory()).toLowerCase() !== CURRENT.dex.v2Factory.toLowerCase()) throw new Error('Router factory mismatch');
  const quote = await v2Quote(CURRENT.wrap, CURRENT.usdt, ethers.parseEther('0.02'));
  if (!quote || quote <= 0n) throw new Error('Mainnet USDT sanity quote unavailable');
  const repo = makeRepo();
  try {
    if (!(await repo.ping())) throw new Error('Database unavailable');
    console.log('Database network and readiness: OK');
  } finally { await repo.close(); }
  if (process.env.PROBE_PRIVATE_KEY) {
    const wallet = new ethers.Wallet(process.env.PROBE_PRIVATE_KEY);
    console.log(`Probe wallet ${wallet.address}: ${ethers.formatEther(await provider.getBalance(wallet.address))} BOT`);
  }
  console.log('Read-only mainnet preflight passed. No funds spent.');
  provider.destroy();
}
main().catch((error) => { console.error(error instanceof Error ? error.message : 'Preflight failed'); process.exit(1); });
