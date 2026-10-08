export type TxResult =
  | { ok: true; txHash: string | null; received?: bigint }
  | { ok: false; txHash?: string | null; reason: string };

export interface ProbeDeps {
  amountInWei: bigint;
  buySlippageBps: number;
  /** fair expected token out for a BOT buy */
  quoteBuy(token: string, amountIn: bigint): Promise<bigint | null>;
  /** fair expected BOT out for selling `tokens` */
  quoteSell(token: string, tokens: bigint): Promise<bigint | null>;
  /** probe wallet token balance */
  balanceOf(token: string): Promise<bigint>;
  buy(token: string, amountIn: bigint, minOut: bigint): Promise<TxResult>;
  approve(token: string, amount: bigint): Promise<TxResult>;
  sell(token: string, amount: bigint, minOut: bigint): Promise<TxResult>;
  /** cumulative gas spend so far in this probe (wei) */
  gasSpent(): Promise<bigint>;
}

export type ProbeVerdict = 'SELLABLE' | 'HIGH_TAX' | 'HONEYPOT' | 'INCONCLUSIVE';

export interface ProbeOutcome {
  verdict: ProbeVerdict;
  buyOk: boolean;
  sellOk: boolean;
  amountInWei: string;
  buyReceived: string | null;
  sellReceived: string | null;
  fairBuyOut: string | null;
  fairSellOut: string | null;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  lossBps: number | null;
  buyTx: string | null;
  approveTx: string | null;
  sellTx: string | null;
  gasSpentWei: string | null;
  revertReason: string | null;
}
