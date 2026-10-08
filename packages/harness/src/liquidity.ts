import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { CHAIN, DEX_TESTNET, getProvider } from '@sellable/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesFile = path.join(here, '..', 'fixtures', 'harness.json');

const ROUTER_ABI = [
  'function WETH() view returns (address)',
  'function addLiquidityETH(address token, uint amountTokenDesired, uint amountTokenMin, uint amountETHMin, address to, uint deadline) payable returns (uint amountToken, uint amountETH, uint liquidity)',
];
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function setPair(address)',
];
const FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address pair)'];

const TOKEN_AMOUNT = 400_000n * 10n ** 18n; // 400k tokens per pool
const ETH_AMOUNT = ethers.parseEther('0.4'); // 0.4 tBOT per pool

async function main(): Promise<void> {
  const pk = process.env.DEPLOYER_PRIVATE_KEY;
  if (!pk) {
    console.error('DEPLOYER_PRIVATE_KEY not set');
    process.exit(1);
  }
  const fixture = JSON.parse(fs.readFileSync(fixturesFile, 'utf8')) as {
    tokens: Record<string, string>;
    deployer: string;
  };

  const provider = getProvider();
  const wallet = new ethers.Wallet(pk, provider);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(CHAIN.testnet.chainId)) {
    console.error(`wrong network: connected chainId ${network.chainId} — set CHAIN_ENV=testnet`);
    process.exit(1);
  }

  const router = new ethers.Contract(DEX_TESTNET.v2Router, ROUTER_ABI, wallet);
  const factory = new ethers.Contract(DEX_TESTNET.v2Factory, FACTORY_ABI, wallet);
  const wrap: string = await router.WETH();
  console.log(`router ${DEX_TESTNET.v2Router} · wrap ${wrap}`);
  console.log(`deployer ${wallet.address} · ${ethers.formatEther(await provider.getBalance(wallet.address))} tBOT\n`);

  const targets = ['BenignToken', 'TaxToken', 'HoneypotToken'];
  const pairs: Record<string, string> = {};

  for (const name of targets) {
    const tokenAddr = fixture.tokens[name];
    if (!tokenAddr) {
      console.log(`${name}: not in fixture, skip`);
      continue;
    }
    process.stdout.write(`${name}: approving + addLiquidityETH ... `);
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const approveTx = await token.approve(DEX_TESTNET.v2Router, TOKEN_AMOUNT);
    await approveTx.wait();
    const deadline = Math.floor(Date.now() / 1000) + 600;
    const tx = await router.addLiquidityETH(
      tokenAddr,
      TOKEN_AMOUNT,
      0n,
      0n,
      wallet.address,
      deadline,
      { value: ETH_AMOUNT },
    );
    const receipt = await tx.wait();
    if (receipt.status !== 1) {
      console.log('FAILED');
      continue;
    }
    const pair: string = await factory.getPair(tokenAddr, wrap);
    pairs[name] = pair;
    console.log(`pair ${pair}`);
  }

  // arm the honeypot gate against the real pair
  if (pairs.HoneypotToken) {
    process.stdout.write('HoneypotToken: arming setPair(gated) ... ');
    const honeypot = new ethers.Contract(fixture.tokens.HoneypotToken, ERC20_ABI, wallet);
    const tx = await honeypot.setPair(pairs.HoneypotToken);
    await tx.wait();
    console.log('armed — sells to pair now revert');
  }

  // seed the probe wallet with tBOT from the deployer
  let probeWallet = process.env.PROBE_PRIVATE_KEY;
  if (!probeWallet) {
    const fresh = ethers.Wallet.createRandom();
    probeWallet = fresh.privateKey;
    console.log(`\ncreated probe wallet ${fresh.address} — sending 2 tBOT ...`);
    const sendTx = await wallet.sendTransaction({ to: fresh.address, value: ethers.parseEther('2') });
    await sendTx.wait();
    console.log('sent. probe key (set as PROBE_PRIVATE_KEY):');
    console.log(probeWallet);
  }

  const out = { ...fixture, pairs, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fixturesFile, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${fixturesFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
