import fs from 'node:fs';
import { ethers } from 'ethers';

const deployment = JSON.parse(fs.readFileSync('packages/contracts/deployments/bot-mainnet.json', 'utf8'));
const previous = JSON.parse(fs.readFileSync('packages/contracts/deployments/bot-mainnet.interactions.json', 'utf8'));
const output = 'packages/contracts/deployments/bot-mainnet.additional-calls.json';
const provider = new ethers.JsonRpcProvider('https://rpc.botchain.ai', 677);
const iface = new ethers.Interface(['function owner() view returns (address)', 'function publisher() view returns (address)']);
async function main() {
  if (BigInt(await provider.send('eth_chainId', [])) !== 677n) throw new Error('Wrong chain');
  if (ethers.keccak256(await provider.getCode(deployment.address)) !== deployment.runtimeBytecodeHash) throw new Error('Registry bytecode mismatch');
  const originals = previous.transactions.filter((t: { to: string }) => t.to === deployment.address);
  if (originals.length !== 3) throw new Error('Expected exactly three original calls');
  for (const original of originals) {
    const receipt = await provider.getTransactionReceipt(original.hash);
    if (!receipt || receipt.status !== 1) throw new Error('Original call missing');
  }
  if (fs.existsSync(output)) throw new Error('Additional-call journal exists; reconcile before retry');
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (!gasPrice || gasPrice > ethers.parseUnits('20', 'gwei')) throw new Error('Gas exceeds planned 20 gwei cap');
  const actions = [];
  for (let i = 1; i <= 2; i++) {
    const wallet = new ethers.Wallet(process.env[`INTERACTION_WALLET_${i}_PRIVATE_KEY`]!, provider);
    if (wallet.address !== process.env[`INTERACTION_WALLET_${i}_ADDRESS`]) throw new Error('Unexpected wallet');
    const method = i === 1 ? 'publisher' : 'owner';
    const data = iface.encodeFunctionData(method);
    await provider.call({ from: wallet.address, to: deployment.address, data });
    const estimated = await provider.estimateGas({ from: wallet.address, to: deployment.address, data });
    const balance = await provider.getBalance(wallet.address);
    const nonce = await provider.getTransactionCount(wallet.address, 'latest');
    if (nonce !== await provider.getTransactionCount(wallet.address, 'pending')) throw new Error('Pending transaction found');
    const affordable = balance / gasPrice;
    const buffered = estimated * 110n / 100n;
    const gasLimit = affordable < buffered ? affordable : buffered;
    if (gasLimit < estimated) throw new Error('Insufficient wallet balance');
    actions.push({ wallet, data, gasLimit, nonce, method });
    console.log(JSON.stringify({ wallet: wallet.address, method, balanceBOT: ethers.formatEther(balance), maxFeeBOT: ethers.formatEther(gasLimit * gasPrice) }));
  }
  const journal: { contract: string; chainId: number; transactions: Record<string, unknown>[]; completedAt?: string } = { contract: deployment.address, chainId: 677, transactions: [] };
  const save = () => fs.writeFileSync(output, JSON.stringify(journal, null, 2) + '\n');
  fs.writeFileSync(output, JSON.stringify(journal, null, 2) + '\n', { flag: 'wx' });
  for (const action of actions) {
    const signed = await action.wallet.signTransaction({ to: deployment.address, data: action.data, value: 0n, gasLimit: action.gasLimit, gasPrice, nonce: action.nonce, chainId: 677, type: 0 });
    const hash = ethers.keccak256(signed);
    const record: Record<string, unknown> = { hash, from: action.wallet.address, to: deployment.address, method: action.method, nonce: action.nonce, state: 'prepared' };
    journal.transactions.push(record); save();
    const response = await provider.broadcastTransaction(signed);
    record.state = 'broadcast'; save(); console.log(`${action.method}(): ${hash}`);
    const receipt = await response.wait(3);
    if (!receipt || receipt.status !== 1) throw new Error('Transaction failed or receipt unknown');
    record.state = 'confirmed'; record.blockNumber = receipt.blockNumber;
    record.feeBOT = ethers.formatEther(receipt.gasUsed * receipt.gasPrice); save();
  }
  journal.completedAt = new Date().toISOString(); save();
  console.log('Five contract calls completed across three wallets.');
}
main().catch((err) => { console.error(err instanceof Error ? err.message : 'Call failed'); process.exitCode = 1; }).finally(() => provider.destroy());
