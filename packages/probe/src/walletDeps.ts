import { ethers } from 'ethers';
import { CURRENT, SIM_BUY_AMOUNT_BOT, getProvider, v2Quote, revertReason } from '@sellable/core';
import type { ProbeDeps, TxResult } from './types.js';

const ROUTER_IFACE = new ethers.Interface([
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] path, address to, uint deadline) payable',
  'function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline)',
]);

const ERC20_IFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
]);

export const WBOT = CURRENT.wrap;

export interface WalletDepsOptions {
  amountInWei?: bigint;
  buySlippageBps?: number;
}

/** Real on-chain deps for the probe engine (V2 swaps, native BOT input). */
export function makeWalletDeps(
  wallet: ethers.Wallet,
  opts: WalletDepsOptions = {},
): ProbeDeps {
  const provider = getProvider();
  const amountInWei = opts.amountInWei ?? SIM_BUY_AMOUNT_BOT * 2n; // 0.02 BOT default probe
  const buySlippageBps = opts.buySlippageBps ?? 1000;
  let gasSpentWei = 0n;

  const send = async (tx: () => Promise<ethers.TransactionResponse>): Promise<TxResult> => {
    try {
      const response = await tx();
      const receipt = await response.wait();
      if (!receipt) return { ok: false, txHash: response.hash, reason: 'no receipt (dropped)' };
      gasSpentWei += receipt.gasUsed * (receipt.gasPrice ?? 0n);
      if (receipt.status !== 1) {
        return { ok: false, txHash: response.hash, reason: 'reverted (on-chain)' };
      }
      return { ok: true, txHash: response.hash };
    } catch (err) {
      return { ok: false, reason: revertReason(err) };
    }
  };

  return {
    amountInWei,
    buySlippageBps,

    async quoteBuy(token, amountIn) {
      if (token.toLowerCase() === WBOT.toLowerCase()) return null;
      return v2Quote(WBOT, token, amountIn);
    },

    async quoteSell(token, tokens) {
      if (token.toLowerCase() === WBOT.toLowerCase()) return null;
      return v2Quote(token, WBOT, tokens);
    },

    async balanceOf(token) {
      const data = ERC20_IFACE.encodeFunctionData('balanceOf', [wallet.address]);
      const res = await provider.call({ to: token, data });
      return ERC20_IFACE.decodeFunctionResult('balanceOf', res)[0] as bigint;
    },

    async buy(token, amountIn, minOut) {
      const data = ROUTER_IFACE.encodeFunctionData('swapExactETHForTokensSupportingFeeOnTransferTokens', [
        minOut,
        [WBOT, token],
        wallet.address,
        Math.floor(Date.now() / 1000) + 300,
      ]);
      return send(async () => {
        const gasLimit = await provider.estimateGas({
          from: wallet.address,
          to: CURRENT.dex.v2Router,
          value: amountIn,
          data,
        });
        return wallet.sendTransaction({
          to: CURRENT.dex.v2Router,
          value: amountIn,
          data,
          gasLimit: (gasLimit * 120n) / 100n,
        });
      });
    },

    async approve(token, amount) {
      const spender = CURRENT.dex.v2Router;
      const current = await provider
        .call({ to: token, data: ERC20_IFACE.encodeFunctionData('allowance', [wallet.address, spender]) })
        .then((r) => ERC20_IFACE.decodeFunctionResult('allowance', r)[0] as bigint)
        .catch(() => 0n);
      // USDT-style tokens require resetting a non-zero allowance first
      if (current > 0n) {
        const reset = await send(() =>
          wallet.sendTransaction({
            to: token,
            data: ERC20_IFACE.encodeFunctionData('approve', [spender, 0n]),
          }),
        );
        if (!reset.ok) return reset;
      }
      return send(() =>
        wallet.sendTransaction({
          to: token,
          data: ERC20_IFACE.encodeFunctionData('approve', [spender, amount]),
        }),
      );
    },

    async sell(token, amount, minOut) {
      const data = ROUTER_IFACE.encodeFunctionData('swapExactTokensForETHSupportingFeeOnTransferTokens', [
        amount,
        minOut,
        [token, WBOT],
        wallet.address,
        Math.floor(Date.now() / 1000) + 300,
      ]);
      const before = await provider.getBalance(wallet.address);
      const result = await send(async () => {
        const gasLimit = await provider.estimateGas({ from: wallet.address, to: CURRENT.dex.v2Router, data });
        return wallet.sendTransaction({ to: CURRENT.dex.v2Router, data, gasLimit: (gasLimit * 120n) / 100n });
      });
      if (!result.ok) return result;
      const receipt = await provider.getTransactionReceipt(result.txHash!);
      if (!receipt) return { ok: true, txHash: result.txHash, received: 0n };
      const after = await provider.getBalance(wallet.address, receipt.blockNumber);
      const gasCost = receipt.gasUsed * (receipt.gasPrice ?? 0n);
      // received = balance delta + gas we paid
      const received = after - before + gasCost;
      return { ok: true, txHash: result.txHash, received: received > 0n ? received : 0n };
    },

    async gasSpent() {
      return gasSpentWei;
    },
  };
}
