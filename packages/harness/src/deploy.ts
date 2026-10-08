import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { CHAIN } from '@sellable/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactsFile = path.join(here, '..', 'artifacts', 'harness.json');
const fixturesDir = path.join(here, '..', 'fixtures');

/** Deterministic fixture token list — same addresses for every fixture deployer. */
const DEPLOY_ORDER = [
  'BenignToken',
  'HoneypotToken',
  'TaxToken',
  'BlacklistToken',
  'MintLaterToken',
  'FakeUSDT',
] as const;

async function main(): Promise<void> {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) {
    console.error('DEPLOYER_PRIVATE_KEY not set.');
    console.error('Claim tBOT on Bohr testnet first:');
    console.error('  https://dev-docs.botchain.ai/docs/Developers/claim-test-tbot-tokens/');
    console.error('then: $env:DEPLOYER_PRIVATE_KEY="0x..." ; npm run harness:deploy');
    process.exit(1);
  }
  if (!fs.existsSync(artifactsFile)) {
    console.error('artifacts missing — run: npm run harness:compile');
    process.exit(1);
  }
  const artifacts = JSON.parse(fs.readFileSync(artifactsFile, 'utf8')) as Record<
    string,
    { abi: ethers.InterfaceAbi; bytecode: string }
  >;

  const provider = new ethers.JsonRpcProvider(CHAIN.testnet.rpc, CHAIN.testnet.chainId, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(pk, provider);
  const network = await provider.getNetwork();
  console.log(`deployer ${wallet.address} on chainId ${network.chainId}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`balance: ${ethers.formatEther(balance)} tBOT`);
  if (balance === 0n) {
    console.error('zero balance — claim tBOT at dev-docs.botchain.ai before deploying.');
    process.exit(1);
  }

  const deployed: Record<string, string> = {};
  for (const name of DEPLOY_ORDER) {
    const art = artifacts[name];
    if (!art) {
      console.error(`artifact missing: ${name} (recompile)`);
      process.exit(1);
    }
    process.stdout.write(`deploying ${name} ... `);
    const factory = new ethers.ContractFactory(art.abi, art.bytecode, wallet);
    const c = await factory.deploy();
    await c.waitForDeployment();
    const addr = await c.getAddress();
    deployed[name] = addr;
    console.log(addr);
  }

  fs.mkdirSync(fixturesDir, { recursive: true });
  const fixture = {
    chainId: CHAIN.testnet.chainId,
    rpc: CHAIN.testnet.rpc,
    explorer: CHAIN.testnet.explorer,
    deployer: wallet.address,
    deployedAt: new Date().toISOString(),
    tokens: deployed,
    lastBlock: await provider.getBlockNumber(),
  };
  const outFile = path.join(fixturesDir, 'harness.json');
  fs.writeFileSync(outFile, JSON.stringify(fixture, null, 2));
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
