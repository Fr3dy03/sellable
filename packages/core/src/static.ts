import { ethers } from 'ethers';
import type { Check, Severity } from './types.js';

/** function signatures whose presence is a red flag on a tradeable token */
export const RISKY_FUNCTIONS: { sig: string; id: string; severity: Severity; note: string }[] = [
  { sig: 'mint(address,uint256)', id: 'mint', severity: 'danger', note: 'owner can mint new supply (inflation rug)' },
  { sig: 'mint(uint256)', id: 'mint', severity: 'danger', note: 'owner can mint new supply (inflation rug)' },
  { sig: 'setBlacklist(address,bool)', id: 'blacklist', severity: 'danger', note: 'owner can blacklist wallets from selling' },
  { sig: 'blacklist(address)', id: 'blacklist', severity: 'danger', note: 'blacklist mechanism present' },
  { sig: 'isBlacklisted(address)', id: 'blacklist', severity: 'warn', note: 'blacklist lookup present' },
  { sig: 'pause()', id: 'pause', severity: 'danger', note: 'trading can be paused by owner' },
  { sig: 'setTradingEnabled(bool)', id: 'trading-gate', severity: 'danger', note: 'owner can gate trading (honeypot pattern)' },
  { sig: 'enableTrading()', id: 'trading-gate', severity: 'warn', note: 'manual trading switch' },
  { sig: 'tradingEnabled()', id: 'trading-gate', severity: 'info', note: 'trading status flag' },
  { sig: 'setPair(address)', id: 'pair-gate', severity: 'danger', note: 'owner can set pair address (classic sell-gate pattern)' },
  { sig: 'setMinAmount(uint256)', id: 'min-amount', severity: 'warn', note: 'minimum transfer amount can be raised' },
  { sig: 'setMaxTxAmount(uint256)', id: 'max-tx', severity: 'info', note: 'max tx amount control' },
  { sig: 'excludeFromFee(address)', id: 'fee-exempt', severity: 'info', note: 'fee exemptions exist (owners may trade free)' },
  { sig: 'setFee(uint256)', id: 'set-fee', severity: 'warn', note: 'fees can be changed by owner' },
  { sig: 'setBuyFee(uint256)', id: 'set-fee', severity: 'warn', note: 'buy fee can be changed by owner' },
  { sig: 'setSellFee(uint256)', id: 'set-fee', severity: 'warn', note: 'sell fee can be changed by owner' },
  { sig: 'manualSwap()', id: 'manual-swap', severity: 'info', note: 'manual fee swap function' },
  { sig: 'rescueTokens(address,uint256,address)', id: 'rescue', severity: 'warn', note: 'owner can pull arbitrary tokens' },
];

const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

export interface StaticScanResult {
  isContract: boolean;
  isProxy: boolean;
  minimalProxy: boolean;
  findings: { id: string; severity: Severity; detail: string }[];
  ownable: boolean;
  codeSize: number;
}

function selector(sig: string): string {
  return ethers.id(sig).slice(0, 10).toLowerCase();
}

/** Pure bytecode analysis — no RPC. */
export function scanBytecode(code: string): StaticScanResult {
  const clean = (code || '0x').toLowerCase().replace(/^0x/, '');
  const isContract = clean.length > 2;
  const minimalProxy = clean.includes(EIP1167_PREFIX) && clean.includes(EIP1167_SUFFIX);
  const seen = new Set<string>();
  const findings: StaticScanResult['findings'] = [];
  for (const rf of RISKY_FUNCTIONS) {
    if (seen.has(rf.id)) continue;
    if (clean.includes(selector(rf.sig).slice(2))) {
      seen.add(rf.id);
      findings.push({ id: rf.id, severity: rf.severity, detail: rf.note });
    }
  }
  const ownable = clean.includes(selector('owner()').slice(2));
  return { isContract, isProxy: false, minimalProxy, findings, ownable, codeSize: clean.length / 2 };
}

export function staticChecks(scan: StaticScanResult, proxyImpl: string | null): Check[] {
  const checks: Check[] = [];
  checks.push({
    id: 'is-contract',
    title: 'Contract code present',
    severity: 'info',
    passed: scan.isContract,
    detail: scan.isContract ? `${scan.codeSize} bytes of runtime code` : 'address has no code',
    source: 'eth_getCode',
  });
  if (scan.minimalProxy || proxyImpl) {
    checks.push({
      id: 'proxy',
      title: 'Upgradeable / proxy token',
      severity: 'warn',
      passed: false,
      detail: proxyImpl
        ? `EIP-1967 proxy → impl ${proxyImpl} (logic can change)`
        : 'minimal proxy (EIP-1167) detected',
      source: 'eth_getStorageAt / bytecode',
    });
  }
  for (const f of scan.findings) {
    checks.push({
      id: `fn-${f.id}`,
      title: `Risky function: ${f.id}`,
      severity: f.severity,
      passed: false,
      detail: f.detail,
      source: 'bytecode selector scan',
    });
  }
  if (scan.ownable) {
    checks.push({
      id: 'ownable',
      title: 'Owner privileges (Ownable)',
      severity: 'info',
      passed: null,
      detail: 'contract exposes owner() — check what the owner can do above',
      source: 'bytecode selector scan',
    });
  }
  return checks;
}
