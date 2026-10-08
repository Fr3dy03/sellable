export const CHAIN = {
  mainnet: {
    chainId: 677,
    rpc: process.env.MAINNET_RPC || 'https://rpc.botchain.ai',
    ws: 'wss://ws-rpc.botchain.ai',
    explorer: 'https://scan.botchain.ai',
    api: 'https://scan.botchain.ai/api',
    apiV2: 'https://scan.botchain.ai/api/v2',
  },
  testnet: {
    chainId: 968,
    rpc: process.env.TESTNET_RPC || 'https://rpc.bohr.life',
    explorer: 'https://scan.bohr.life',
    api: 'https://scan.bohr.life/api',
    apiV2: 'https://scan.bohr.life/api/v2',
  },
} as const;

export const GECKO = {
  base: 'https://api.geckoterminal.com/api/v2',
  network: 'bot-chain',
} as const;

/** Official BDEX contracts (mainnet, verified in dev-docs /docs/DEX/contract-addresses). */
export const DEX = {
  v2Factory: '0x117115f3B72C8d1989178089A67D0C26f8EE0AA3',
  v2Router: '0x1414eD29FdFD322c3c0a830330ed982E2D629e76',
  v3Factory: '0x1C51c173323ec11BB4e3C4fD2314c225Dc4b5419',
  v3Quoter: '0x034A705b36067cff99ABf5C662Be881cBd8d0176',
  v3SwapRouter: '0x07032d47A1b9f8460cBeE9dC17c1d3E438693929',
} as const;

export const DEX_TESTNET = {
  v2Factory: '0x65b8e98ceA190d8c28B3e4716402027f634d15a3',
  v2Router: '0xD6425a02f0845B8D99e349C34D2E7A576E177345',
} as const;

/** Official liquidity lockers (dev-docs /docs/Liquidity-Locker/contract-addresses). */
export const LOCKERS = [
  { address: '0x82Cb7Cd6Ad9cE3a1f1Fc1821AD7dCAb87C3d7663', name: 'BDexV2Locker' },
  { address: '0x32685b8Db1559D6651fcdB8a22D11cC44d3B952b', name: 'BDexV3LiquidityLocker' },
] as const;

/** Tokens attackers impersonate. Verified against dev-docs common-token list. */
export const OFFICIAL_TOKENS = [
  {
    address: '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C',
    name: 'Tether USD',
    symbol: 'USDT',
    decimals: 6,
  },
  {
    address: '0xD5452816194a3784dBa983426cCe7c122F4abd30',
    name: 'Wrapped BOT',
    symbol: 'WBOT',
    decimals: 18,
  },
] as const;

/** Official infra addresses — never flag these as suspicious contracts. */
export const OFFICIAL_CONTRACTS = new Set<string>(
  [
    DEX.v2Factory,
    DEX.v2Router,
    DEX.v3Factory,
    DEX.v3Quoter,
    DEX.v3SwapRouter,
    ...LOCKERS.map((l) => l.address),
    ...OFFICIAL_TOKENS.map((t) => t.address),
  ].map((a) => a.toLowerCase()),
);

export const SIM_BUY_AMOUNT_BOT = 10n ** 16n; // 0.01 BOT
export const HOLDERS_TOP_N = 10;
export const HOLDERS_MAX_PAGES = 4;

/** Wrap token — same address on both chains (verified: testnet router.WETH()). */
export const WRAP_TOKEN = '0xD5452816194a3784dBa983426cCe7c122F4abd30';

/** CHAIN_ENV=testnet switches the whole stack (analyzer, probe, API) to Bohr. */
export const IS_TESTNET = (process.env.CHAIN_ENV || 'mainnet') === 'testnet';

export const CURRENT = IS_TESTNET
  ? {
      chainId: CHAIN.testnet.chainId,
      rpc: CHAIN.testnet.rpc,
      api: CHAIN.testnet.api,
      apiV2: CHAIN.testnet.apiV2,
      explorer: CHAIN.testnet.explorer,
      dex: DEX_TESTNET,
      lockers: [] as readonly { address: string; name: string }[],
      wrap: WRAP_TOKEN,
      usdt: OFFICIAL_TOKENS[0].address,
    }
  : {
      chainId: CHAIN.mainnet.chainId,
      rpc: CHAIN.mainnet.rpc,
      api: CHAIN.mainnet.api,
      apiV2: CHAIN.mainnet.apiV2,
      explorer: CHAIN.mainnet.explorer,
      dex: DEX,
      lockers: LOCKERS,
      wrap: WRAP_TOKEN,
      usdt: OFFICIAL_TOKENS[0].address,
    };
