import { ethers } from 'ethers';
import { CURRENT, OFFICIAL_TOKENS, SIM_BUY_AMOUNT_BOT } from './config.js';
import {
  getAddressInfo,
  getTokenCounters,
  getTokenInfo,
} from './blockscout.js';
import {
  buySimV2,
  getBlockNumber,
  getEip1967Impl,
  getRuntimeBytecode,
  getTotalSupply,
  v2Quote,
} from './rpc.js';
import { scanBytecode, staticChecks } from './static.js';
import { fakeTokenChecks, matchFakeToken } from './fake.js';
import { concentrationChecks, holderConcentration } from './holders.js';
import { findLiquidity, liquidityChecks } from './lpLock.js';
import { aggregate } from './verdict.js';
import type { Check, PreCheckReport } from './types.js';

export async function preCheck(tokenAddress: string): Promise<PreCheckReport> {
  const token = ethers.getAddress(tokenAddress);
  const block = await getBlockNumber();

  const [addrInfo, tokenInfo, counters, code] = await Promise.all([
    getAddressInfo(token),
    getTokenInfo(token),
    getTokenCounters(token),
    getRuntimeBytecode(token),
  ]);

  const meta = {
    address: token,
    name: tokenInfo?.name ?? '',
    symbol: tokenInfo?.symbol ?? '',
    decimals: Number(tokenInfo?.decimals ?? 18),
    totalSupply: null as string | null,
    isContract: addrInfo.is_contract,
    isVerified: addrInfo.is_verified,
    isScamFlagged: addrInfo.is_scam,
  };
  const onChainSupply = await getTotalSupply(token).catch(() => null);
  const explorerSupply =
    tokenInfo?.totalSupply != null && tokenInfo.totalSupply !== ''
      ? String(tokenInfo.totalSupply)
      : null;
  meta.totalSupply = onChainSupply?.toString() ?? explorerSupply;

  const checks: Check[] = [];

  // explorer flags
  if (addrInfo.is_scam) {
    checks.push({
      id: 'scam-flag',
      title: 'Explorer scam flag',
      severity: 'danger',
      passed: false,
      detail: 'address is flagged as scam by the block explorer',
      source: 'scan.botchain.ai',
    });
  }
  checks.push({
    id: 'verified',
    title: 'Source verified',
    severity: 'info',
    passed: meta.isVerified,
    detail: meta.isVerified
      ? 'contract source verified on explorer'
      : 'contract source NOT verified — logic cannot be reviewed',
    source: 'scan.botchain.ai',
  });
  if (counters.holders != null) {
    checks.push({
      id: 'holders',
      title: 'Holder count',
      severity: 'info',
      passed: null,
      detail: `${counters.holders} holders, ${counters.transfers ?? '?'} transfers`,
      source: 'scan.botchain.ai',
    });
  }

  // static analysis (scan impl bytecode when proxied)
  const scan = scanBytecode(code);
  const impl = meta.isContract ? await getEip1967Impl(token) : null;
  scan.isProxy = !!impl;
  if (impl) {
    const implCode = await getRuntimeBytecode(impl);
    const implScan = scanBytecode(implCode);
    scan.findings = implScan.findings;
    scan.ownable = implScan.ownable;
    scan.minimalProxy = scan.minimalProxy || implScan.minimalProxy;
  }
  checks.push(...staticChecks(scan, impl));

  // fake token
  const fakeMatch = matchFakeToken(meta);
  checks.push(...fakeTokenChecks(fakeMatch, meta.isVerified));

  // liquidity + lock
  const liq = await findLiquidity(token);
  checks.push(...liquidityChecks(liq));

  // concentration (exclude discovered pools)
  const totalSupply = meta.totalSupply ? BigInt(meta.totalSupply) : null;
  const concentration = await holderConcentration(
    token,
    totalSupply,
    liq.pairs.map((p) => p.pair),
  );
  checks.push(...concentrationChecks(concentration));

  // buy-side quote + simulation (V2 only for now)
  let quoteOk = false;
  let quoteBlocked = false;
  let quote: PreCheckReport['quote'] = null;
  const WBOT = CURRENT.wrap;
  const USDT = CURRENT.usdt;
  if (liq.pairs.length) {
    // buy input: BOT via WBOT normally; USDT when the token IS WBOT (wrap has no swap)
    const wb = token.toLowerCase() === WBOT.toLowerCase();
    const input = wb ? USDT : WBOT;
    const inputAmount = wb ? 1_000_000n : SIM_BUY_AMOUNT_BOT; // 1 USDT or 0.01 BOT
    const out = await v2Quote(input, token, inputAmount);
    if (out != null && out > 0n) {
      quote = {
        venue: 'v2',
        path: [input, token],
        amountIn: inputAmount.toString(),
        amountOut: out.toString(),
      };
      if (wb) {
        // ERC20-input sim needs a USDT storage override — this RPC ignores them
        quoteOk = true;
        checks.push({
          id: 'buy-quote',
          title: 'Buy quote (view only)',
          severity: 'info',
          passed: null,
          detail: `1 USDT buys ${ethers.formatUnits(out, meta.decimals)} ${meta.symbol}; state-override sim unavailable for ERC20 input`,
          source: 'BDEX V2 router getAmountsOut',
        });
      } else {
        const sim = await buySimV2(token);
        if (sim.ok) {
          quoteOk = true;
          quote.amountOut = sim.amountOut ?? quote.amountOut;
          checks.push({
            id: 'buy-sim',
            title: 'Buy simulation',
            severity: 'info',
            passed: true,
            detail: `0.01 BOT buys ${ethers.formatUnits(quote.amountOut, meta.decimals)} ${meta.symbol} (simulated)`,
            source: 'eth_call state-override sim',
          });
        } else {
          quoteBlocked = true;
          checks.push({
            id: 'buy-sim',
            title: 'Buy simulation',
            severity: 'danger',
            passed: false,
            detail: `simulated buy reverted: ${sim.revertReason}`,
            source: 'eth_call state-override sim',
          });
        }
      }
    } else {
      checks.push({
        id: 'quote',
        title: 'Buy quote',
        severity: 'danger',
        passed: false,
        detail: 'router getAmountsOut reverted or returned 0 — cannot price a buy',
        source: 'BDEX V2 router',
      });
    }
  }

  // official registry tokens: keep findings visible but don't count as rug risks
  const isOfficial = OFFICIAL_TOKENS.some((t) => t.address.toLowerCase() === token.toLowerCase());
  if (isOfficial) {
    for (const c of checks) {
      if (c.severity === 'danger') c.severity = 'warn';
    }
    checks.push({
      id: 'official',
      title: 'Official token',
      severity: 'info',
      passed: true,
      detail: 'in the official BOT Chain token registry (dev-docs)',
      source: 'official token registry',
    });
  }

  const report = aggregate({
    block,
    token: meta,
    checks,
    hasPair: liq.pairs.length > 0,
    quoteOk,
    quoteBlocked,
  });
  report.quote = quote;
  return report;
}
