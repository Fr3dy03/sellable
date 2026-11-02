import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

// Publishes source code to the explorer. Run only after source-publication authorization.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deploymentFile = path.join(root, 'deployments', 'bot-mainnet.json');
const deployment = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
const input = JSON.parse(fs.readFileSync(path.join(root, 'deployments', 'bot-mainnet.standard-input.json'), 'utf8'));
const solc = (await import('solc')).default;
const output = JSON.parse(solc.compile(JSON.stringify(input)));
const runtime = output.contracts?.['SellableVerdictRegistry.sol']?.SellableVerdictRegistry?.evm?.deployedBytecode?.object;
if (!runtime || ethers.keccak256(`0x${runtime}`) !== deployment.runtimeBytecodeHash) throw new Error('Verification input does not match deployed bytecode');
const form = new FormData();
form.set('compiler_version', `v${deployment.compiler.split('.Emscripten')[0]}`);
form.set('contract_name', deployment.contract);
form.set('license_type', 'mit');
form.set('autodetect_constructor_args', 'true');
form.set('files[0]', new Blob([JSON.stringify(input)], { type: 'application/json' }), 'standard-input.json');
const response = await fetch(`https://scan.botchain.ai/api/v2/smart-contracts/${deployment.address}/verification/via/standard-input`, {
  method: 'POST', body: form, signal: AbortSignal.timeout(30_000),
});
console.log(JSON.stringify({ status: response.status, body: await response.text() }));
if (!response.ok) process.exitCode = 1;
