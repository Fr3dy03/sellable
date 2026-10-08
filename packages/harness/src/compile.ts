import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.join(here, '..', 'contracts');
const artifactsDir = path.join(here, '..', 'artifacts');

async function main(): Promise<void> {
  // solc is an optional devDependency (large binary download)
  let solc: { compile: (input: string) => string; version: () => string };
  try {
    const mod = (await import('solc')) as unknown as {
      default?: { compile: (input: string) => string; version: () => string };
      compile?: (input: string) => string;
      version?: () => string;
    };
    solc = (mod.default ?? mod) as typeof solc;
  } catch {
    console.error('solc not installed — run: npm install -w @sellable/harness');
    process.exit(1);
  }
  if (typeof solc.compile !== 'function') {
    console.error('solc module does not expose compile()');
    process.exit(1);
  }

  const sources: Record<string, { content: string }> = {};
  for (const f of fs.readdirSync(contractsDir)) {
    if (f.endsWith('.sol')) {
      sources[f] = { content: fs.readFileSync(path.join(contractsDir, f), 'utf8') };
    }
  }

  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
    },
  };

  const out = JSON.parse(solc.compile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: Record<
      string,
      Record<
        string,
        { abi: unknown[]; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }
      >
    >;
  };

  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length) {
    for (const e of errors) console.error(e.formattedMessage);
    process.exit(1);
  }

  const artifacts: Record<string, { abi: unknown[]; bytecode: string; deployedBytecode: string }> = {};
  for (const file of Object.keys(out.contracts)) {
    for (const name of Object.keys(out.contracts[file])) {
      const c = out.contracts[file][name];
      artifacts[name] = {
        abi: c.abi,
        bytecode: '0x' + c.evm.bytecode.object,
        deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      };
    }
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const outFile = path.join(artifactsDir, 'harness.json');
  fs.writeFileSync(outFile, JSON.stringify(artifacts, null, 2));
  console.log(`solc ${solc.version()} -> ${Object.keys(artifacts).length} contracts: ${Object.keys(artifacts).join(', ')}`);
  console.log(`wrote ${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
