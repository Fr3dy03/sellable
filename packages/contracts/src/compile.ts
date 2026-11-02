import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const solcModule = (await import('solc')) as unknown as {
  default?: { compile: (input: string) => string; version: () => string };
  compile?: (input: string) => string;
  version?: () => string;
};
const solc = solcModule.default ?? solcModule;
if (typeof solc.compile !== 'function' || typeof solc.version !== 'function') {
  throw new Error('solc module does not expose compile() and version().');
}

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceFile = path.join(here, '..', 'contracts', 'SellableVerdictRegistry.sol');
const artifactsDir = path.join(here, '..', 'artifacts');
const artifactFile = path.join(artifactsDir, 'SellableVerdictRegistry.json');

const input = {
  language: 'Solidity',
  sources: { 'SellableVerdictRegistry.sol': { content: fs.readFileSync(sourceFile, 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'paris',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};
const output = JSON.parse(solc.compile(JSON.stringify(input))) as {
  errors?: { severity: string; formattedMessage: string }[];
  contracts?: Record<string, Record<string, {
    abi: ethers.InterfaceAbi;
    evm: { bytecode: { object: string }; deployedBytecode: { object: string } };
  }>>;
};
const errors = (output.errors ?? []).filter((e) => e.severity === 'error');
if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
const compiled = output.contracts?.['SellableVerdictRegistry.sol']?.SellableVerdictRegistry;
if (!compiled?.evm.bytecode.object) throw new Error('Compiler did not produce deployment bytecode.');

fs.mkdirSync(artifactsDir, { recursive: true });
fs.writeFileSync(artifactFile, `${JSON.stringify({
  abi: compiled.abi,
  bytecode: `0x${compiled.evm.bytecode.object}`,
  deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
  compiler: solc.version(),
}, null, 2)}\n`);
console.log(`solc ${solc.version()} compiled SellableVerdictRegistry`);
console.log(`wrote ${artifactFile}`);
