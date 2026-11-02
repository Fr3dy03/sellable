import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { CHAIN } from '@sellable/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const artifactFile = path.join(here, '..', 'artifacts', 'SellableVerdictRegistry.json');
const deploymentsDir = path.join(here, '..', 'deployments');

async function main(): Promise<void> {
  const isMainnet = process.argv.includes('--network=mainnet');
  const chain = isMainnet ? CHAIN.mainnet : CHAIN.testnet;
  const networkName = isMainnet ? 'bot-mainnet' : 'bohr-testnet';
  const broadcast = process.argv.includes('--broadcast');
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('DEPLOYER_PRIVATE_KEY is required. Deployment defaults to a dry run.');
  }

  // Always rebuild from the checked-out source; never broadcast stale artifacts.
  await import('./compile.js');
  const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8')) as {
    abi: ethers.InterfaceAbi;
    bytecode: string;
    compiler: string;
  };

  const provider = new ethers.JsonRpcProvider(chain.rpc, chain.chainId);
  const normalizedKey = /^[0-9a-fA-F]{64}$/.test(privateKey) ? `0x${privateKey}` : privateKey;
  const wallet = new ethers.Wallet(normalizedKey, provider);
  const expectedDeployer = process.argv.find((arg) => arg.startsWith('--expected-deployer='))?.split('=')[1];
  if (expectedDeployer && ethers.getAddress(expectedDeployer) !== wallet.address) throw new Error('Unexpected deployer wallet');
  const network = await provider.getNetwork();
  const actualChain = BigInt(await provider.send('eth_chainId', []));
  if (actualChain !== BigInt(chain.chainId)) {
    throw new Error(`Wrong chain: expected ${chain.chainId}, got ${actualChain}`);
  }
  const publisher = process.env.SELLABLE_REGISTRY_PUBLISHER_ADDRESS
    ? ethers.getAddress(process.env.SELLABLE_REGISTRY_PUBLISHER_ADDRESS)
    : wallet.address;
  const balance = await provider.getBalance(wallet.address);
  if (publisher === ethers.ZeroAddress) throw new Error('Publisher cannot be the zero address');

  console.log(`solc ${artifact.compiler}`);
  console.log(`SellableVerdictRegistry target ${networkName} (${network.chainId})`);
  console.log(`deployer ${wallet.address} · publisher ${publisher} · balance ${ethers.formatEther(balance)} BOT`);
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const request = await factory.getDeployTransaction(publisher);
  const gas = await provider.estimateGas({ ...request, from: wallet.address });
  const fee = await provider.getFeeData();
  if (!fee.gasPrice || fee.gasPrice > ethers.parseUnits('50', 'gwei')) throw new Error('Gas price unavailable or above 50 gwei cap');
  const bufferedGas = gas * 120n / 100n;
  const affordableGas = balance / fee.gasPrice;
  const gasLimit = affordableGas < bufferedGas ? affordableGas : bufferedGas;
  const maxCost = gasLimit * fee.gasPrice;
  console.log(`maximum deployment cost ${ethers.formatEther(maxCost)} BOT`);
  console.log(`estimated gas ${gas}; mode ${broadcast ? 'broadcast' : 'dry-run'}`);
  if (!broadcast) return;
  if (gasLimit < gas) throw new Error('Deployer balance below estimated deployment cost');
  const targetFile = path.join(deploymentsDir, `${networkName}.json`);
  if (fs.existsSync(targetFile)) throw new Error(`Deployment record already exists: ${targetFile}. Review it before deploying again.`);
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const pendingFile = path.join(deploymentsDir, `${networkName}.pending.json`);
  const nonce = await provider.getTransactionCount(wallet.address, 'pending');
  const pending = {
    chainId: chain.chainId, deployer: wallet.address, publisher, nonce,
    expectedAddress: ethers.getCreateAddress({ from: wallet.address, nonce }),
    creationBytecodeHash: ethers.keccak256(artifact.bytecode),
    startedAt: new Date().toISOString(), transactionHash: null as string | null,
  };
  // Exclusive journal prevents retries from deploying twice after an interrupted broadcast.
  fs.writeFileSync(pendingFile, `${JSON.stringify(pending, null, 2)}\n`, { flag: 'wx' });
  const registry = await factory.deploy(publisher, { nonce, gasLimit, gasPrice: fee.gasPrice, type: 0 });
  const tx = registry.deploymentTransaction();
  if (!tx) throw new Error('Missing deployment transaction');
  pending.transactionHash = tx.hash;
  fs.writeFileSync(pendingFile, `${JSON.stringify(pending, null, 2)}\n`);
  console.log(`broadcast transaction ${tx.hash}`);
  await registry.waitForDeployment();
  const address = await registry.getAddress();
  const receipt = await tx.wait(3);
  if (!receipt || receipt.status !== 1) throw new Error('Deployment transaction did not succeed.');
  const code = await provider.getCode(address);
  const expectedRuntime = (artifact as typeof artifact & { deployedBytecode: string }).deployedBytecode;
  if (!expectedRuntime || code.toLowerCase() !== expectedRuntime.toLowerCase()) throw new Error('Deployed runtime bytecode mismatch');
  const deployed = new ethers.Contract(address, artifact.abi, provider);
  if (await deployed.owner() !== wallet.address || await deployed.publisher() !== publisher) throw new Error('Deployed registry authority mismatch');

  const deployment = {
    contract: 'SellableVerdictRegistry',
    address,
    chainId: Number(network.chainId),
    network: networkName,
    rpc: new URL(chain.rpc).origin,
    explorer: chain.explorer,
    deployer: wallet.address,
    owner: wallet.address,
    publisher,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
    compiler: artifact.compiler,
    creationBytecodeHash: ethers.keccak256(artifact.bytecode),
    runtimeBytecodeHash: ethers.keccak256(code),
    gasUsed: receipt.gasUsed.toString(),
    gasPriceWei: receipt.gasPrice.toString(),
    deploymentCostBOT: ethers.formatEther(receipt.gasUsed * receipt.gasPrice),
    confirmations: 3,
  };
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const outputFile = targetFile;
  fs.writeFileSync(outputFile, `${JSON.stringify(deployment, null, 2)}\n`);
  fs.unlinkSync(pendingFile);
  console.log(`deployed ${address}`);
  console.log(`transaction ${receipt.hash}`);
  console.log(`wrote ${outputFile}`);
  provider.destroy();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
