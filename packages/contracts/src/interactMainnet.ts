import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

// Load keys via Node --env-file. No key material is written to the public journal.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deployment = JSON.parse(fs.readFileSync(path.join(root, 'deployments', 'bot-mainnet.json'), 'utf8'));
const artifact = JSON.parse(fs.readFileSync(path.join(root, 'artifacts', 'SellableVerdictRegistry.json'), 'utf8'));
const reportPath = path.join(root, 'deployments', 'bot-mainnet.interactions.json');
const planPath = path.join(root, 'deployments', 'bot-mainnet.interaction-plan.json');
const request = new ethers.FetchRequest('https://rpc.botchain.ai');
request.timeout = 20_000;
const provider = new ethers.JsonRpcProvider(request, 677);
const broadcast = process.argv.includes('--broadcast');
const iface = new ethers.Interface(artifact.abi);
const fundingTarget = ethers.parseEther('0.001');

async function main() {
  if (BigInt(await provider.send('eth_chainId', [])) !== 677n) throw new Error('Wrong network');
  if (ethers.keccak256(await provider.getCode(deployment.address)) !== deployment.runtimeBytecodeHash) throw new Error('Registry bytecode mismatch');
  const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
  if (deployer.address !== deployment.deployer) throw new Error('Unexpected deployer');
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice;
  if (!gasPrice || gasPrice > ethers.parseUnits('50', 'gwei')) throw new Error('Gas price unavailable or above cap');
  const specs = [
    { method: 'owner', args: [] },
    { method: 'publisher', args: [] },
    { method: 'getLatest', args: ['0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C'] },
  ];
  const actions = [];
  let deployerRequired = 0n;
  for (let i = 0; i < 3; i++) {
    const wallet = new ethers.Wallet(process.env[`INTERACTION_WALLET_${i + 1}_PRIVATE_KEY`]!, provider);
    if (wallet.address !== process.env[`INTERACTION_WALLET_${i + 1}_ADDRESS`]) throw new Error('Wallet address mismatch');
    const balance = await provider.getBalance(wallet.address);
    const topUp = balance < fundingTarget ? fundingTarget - balance : 0n;
    const data = iface.encodeFunctionData(specs[i].method, specs[i].args);
    await provider.call({ from: wallet.address, to: deployment.address, data });
    const estimated = await provider.estimateGas({ from: wallet.address, to: deployment.address, data });
    const gasLimit = estimated * 120n / 100n;
    if (gasLimit * gasPrice > (balance + topUp)) throw new Error('Interaction exceeds wallet funding target');
    if (topUp > 0n) deployerRequired += topUp + 21_000n * gasPrice;
    actions.push({ wallet, topUp, data, gasLimit, method: specs[i].method });
  }
  if (new Set(actions.map((a) => a.wallet.address)).size !== 3) throw new Error('Interaction wallets must be distinct');
  const deployerBalance = await provider.getBalance(deployer.address);
  const plan = {
    chainId: 677, contract: deployment.address, deployer: deployer.address,
    gasPriceGwei: ethers.formatUnits(gasPrice, 'gwei'),
    deployerBalanceBOT: ethers.formatEther(deployerBalance),
    requiredDeployerBOT: ethers.formatEther(deployerRequired),
    shortfallBOT: ethers.formatEther(deployerRequired > deployerBalance ? deployerRequired - deployerBalance : 0n),
    wallets: actions.map((a) => ({ address: a.wallet.address, fundingBOT: ethers.formatEther(a.topUp), method: a.method, gasLimit: a.gasLimit.toString() })),
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify(plan, null, 2));
  if (!broadcast) return;
  if (deployerBalance < deployerRequired) throw new Error('Insufficient deployer funds; no transactions sent');
  if (fs.existsSync(reportPath)) throw new Error('Interaction journal already exists; reconcile its transaction hashes before attempting another run');
  for (const wallet of [deployer, ...actions.map((a) => a.wallet)]) {
    if (await provider.getTransactionCount(wallet.address, 'latest') !== await provider.getTransactionCount(wallet.address, 'pending')) throw new Error('Wallet has pending transactions; reconcile first');
  }
  const journal: { chainId: number; contract: string; transactions: Record<string, unknown>[]; completedAt?: string } = { chainId: 677, contract: deployment.address, transactions: [] };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(journal, null, 2) + '\n');
  fs.writeFileSync(reportPath, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx' });
  const send = async (wallet: ethers.Wallet, tx: ethers.TransactionRequest, purpose: string) => {
    const nonce = await provider.getTransactionCount(wallet.address, 'pending');
    const signed = await wallet.signTransaction({ ...tx, nonce, chainId: 677, gasPrice, type: 0 });
    const hash = ethers.keccak256(signed);
    const record: Record<string, unknown> = { hash, from: wallet.address, to: tx.to, purpose, nonce, state: 'prepared' };
    journal.transactions.push(record); save();
    const response = await provider.broadcastTransaction(signed);
    record.state = 'broadcast'; save(); console.log(`${purpose}: ${hash}`);
    const receipt = await response.wait(3);
    if (!receipt || receipt.status !== 1) throw new Error(`Transaction failed or receipt unknown: ${hash}`);
    record.state = 'confirmed'; record.blockNumber = receipt.blockNumber;
    record.gasUsed = receipt.gasUsed.toString(); record.costBOT = ethers.formatEther(receipt.gasUsed * receipt.gasPrice); save();
  };
  for (const action of actions) {
    if (action.topUp > 0n) await send(deployer, { to: action.wallet.address, value: action.topUp, gasLimit: 21_000n }, 'fund interaction wallet');
    await send(action.wallet, { to: deployment.address, data: action.data, value: 0n, gasLimit: action.gasLimit }, `${action.method}()`);
  }
  journal.completedAt = new Date().toISOString(); save();
  console.log(`Completed: ${reportPath}`);
}
main().catch((err) => { console.error(err instanceof Error ? err.message : 'Interaction failed'); process.exitCode = 1; }).finally(() => provider.destroy());
