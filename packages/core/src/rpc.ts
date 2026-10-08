import { ethers } from 'ethers';
import { CURRENT, SIM_BUY_AMOUNT_BOT } from './config.js';

let provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(CURRENT.rpc, CURRENT.chainId, {
      staticNetwork: true,
    });
  }
  return provider;
}

export async function getBlockNumber(): Promise<number> {
  return getProvider().getBlockNumber();
}

export async function getRuntimeBytecode(address: string): Promise<string> {
  return getProvider().getCode(address, 'latest');
}

/** EIP-1967 implementation slot. */
const EIP1967_IMPL_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

export async function getEip1967Impl(address: string): Promise<string | null> {
  try {
    const raw = await getProvider().getStorage(address, EIP1967_IMPL_SLOT);
    if (raw && BigInt(raw) !== 0n) return ethers.getAddress('0x' + raw.slice(-40));
    return null;
  } catch {
    return null;
  }
}

/** Call a view function, returning raw hex result or null on revert. */
export async function tryCall(to: string, data: string): Promise<string | null> {
  try {
    return await getProvider().call({ to, data });
  } catch {
    return null;
  }
}

/** Extract a revert reason from an ethers error, best effort. */
export function revertReason(err: unknown): string {
  const e = err as {
    shortMessage?: string;
    message?: string;
    info?: { error?: { message?: string } };
    error?: { message?: string };
  };
  const raw =
    e?.info?.error?.message || e?.error?.message || e?.shortMessage || e?.message || String(err);
  const m = raw.match(/reverted with reason string '([^']+)'/) || raw.match(/execution reverted:?\s*(.*)$/i);
  return (m?.[1] || raw).slice(0, 200);
}

export interface BuySimResult {
  ok: boolean;
  amountOut: string | null;
  revertReason: string | null;
}

/**
 * Buy simulation against BDEX V2: eth_call swapExactETHForTokens funded purely
 * by an account-balance state override. Verified working against rpc.botchain.ai
 * (storage state overrides are ignored by this node — do not rely on them).
 */
export async function buySimV2(tokenOut: string, amountIn: bigint = SIM_BUY_AMOUNT_BOT): Promise<BuySimResult> {
  const router = CURRENT.dex.v2Router;
  const wbot = CURRENT.wrap;
  // deterministic throwaway account — always zero balance, funded by state override
  const simFrom = ethers.getAddress('0x' + ethers.id('sellable-buy-sim').slice(2, 42));
  const iface = new ethers.Interface([
    'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  ]);
  const data = iface.encodeFunctionData('swapExactETHForTokens', [
    0n,
    [wbot, tokenOut],
    simFrom,
    Math.floor(Date.now() / 1000) + 600,
  ]);
  try {
    const res = await getProvider().send('eth_call', [
      { from: simFrom, to: router, value: ethers.toBeHex(amountIn), data },
      'latest',
      { [simFrom]: { balance: ethers.toBeHex(amountIn) } },
    ]);
    const [amounts] = iface.decodeFunctionResult('swapExactETHForTokens', res);
    return { ok: true, amountOut: amounts[amounts.length - 1].toString(), revertReason: null };
  } catch (err) {
    return { ok: false, amountOut: null, revertReason: revertReason(err) };
  }
}

const V2_ROUTER_IFACE = new ethers.Interface([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
]);

/** View quote (no state override needed). Returns out amount or null. */
export async function v2Quote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<bigint | null> {
  const data = V2_ROUTER_IFACE.encodeFunctionData('getAmountsOut', [amountIn, [tokenIn, tokenOut]]);
  const res = await tryCall(CURRENT.dex.v2Router, data);
  if (!res) return null;
  try {
    const [amounts] = V2_ROUTER_IFACE.decodeFunctionResult('getAmountsOut', res);
    return amounts[amounts.length - 1] as bigint;
  } catch {
    return null;
  }
}

const FACTORY_IFACE = new ethers.Interface([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);

export async function getV2Pair(tokenA: string, tokenB: string): Promise<string | null> {
  const data = FACTORY_IFACE.encodeFunctionData('getPair', [tokenA, tokenB]);
  const res = await tryCall(CURRENT.dex.v2Factory, data);
  if (!res) return null;
  try {
    const [pair] = FACTORY_IFACE.decodeFunctionResult('getPair', res);
    if (BigInt(pair) === 0n) return null;
    return ethers.getAddress(pair);
  } catch {
    return null;
  }
}

const ERC20_IFACE = new ethers.Interface([
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

export async function getTotalSupply(token: string): Promise<bigint | null> {
  try {
    const res = await getProvider().call({
      to: token,
      data: ERC20_IFACE.encodeFunctionData('totalSupply'),
    });
    const [ts] = ERC20_IFACE.decodeFunctionResult('totalSupply', res) as unknown as [bigint];
    return ts;
  } catch {
    return null;
  }
}

const PAIR_IFACE = new ethers.Interface([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

export interface Reserves {
  tokenReserve: bigint;
  quoteReserve: bigint;
}

export async function pairReserves(pair: string, token: string): Promise<Reserves | null> {
  try {
    const [reserves, token0] = await Promise.all([
      getProvider().call({ to: pair, data: PAIR_IFACE.encodeFunctionData('getReserves') }),
      getProvider().call({ to: pair, data: PAIR_IFACE.encodeFunctionData('token0') }),
    ]);
    const [r0, r1] = PAIR_IFACE.decodeFunctionResult('getReserves', reserves) as unknown as [bigint, bigint, number];
    const [t0] = PAIR_IFACE.decodeFunctionResult('token0', token0) as unknown as [string];
    const tokenIs0 = t0.toLowerCase() === token.toLowerCase();
    return { tokenReserve: tokenIs0 ? r0 : r1, quoteReserve: tokenIs0 ? r1 : r0 };
  } catch {
    return null;
  }
}

export async function pairTotalSupply(pair: string): Promise<bigint | null> {
  try {
    const res = await getProvider().call({ to: pair, data: PAIR_IFACE.encodeFunctionData('totalSupply') });
    const [ts] = PAIR_IFACE.decodeFunctionResult('totalSupply', res) as unknown as [bigint];
    return ts;
  } catch {
    return null;
  }
}

export async function pairBalanceOf(pair: string, owner: string): Promise<bigint | null> {
  try {
    const res = await getProvider().call({
      to: pair,
      data: PAIR_IFACE.encodeFunctionData('balanceOf', [owner]),
    });
    const [b] = PAIR_IFACE.decodeFunctionResult('balanceOf', res) as unknown as [bigint];
    return b;
  } catch {
    return null;
  }
}
