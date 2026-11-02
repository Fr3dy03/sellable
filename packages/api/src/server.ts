import { Hono } from 'hono';
import { ethers } from 'ethers';
import { preCheck, DISCLAIMER, CURRENT, assertChain, getBlockNumber } from '@sellable/core';
import type { Repo } from '@sellable/db';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'node:crypto';

interface CheckBody {
  address?: string;
  refresh?: boolean;
}

export function createApp(repo: Repo, options: { requireProbeAuth?: boolean; checkRpc?: () => Promise<number> } = {}): Hono {
  const app = new Hono();
  let ready: Promise<void> | undefined;
  app.use('*', async (c, next) => {
    if (process.env.NODE_ENV === 'production' && c.req.path !== '/health') {
      ready ??= Promise.all([assertChain(), repo.ping().then((ok) => { if (!ok) throw new Error('Database unavailable'); })]).then(() => {});
      try { await ready; } catch { ready = undefined; return c.json({ error: 'service not ready' }, 503); }
    }
    await next();
  });
  app.use('*', bodyLimit({ maxSize: 4096 }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 413) return c.json({ error: 'request body too large' }, 413);
    console.error('API request failed:', err.name);
    return c.json({ error: 'service temporarily unavailable' }, 503);
  });

  app.get('/health', async (c) => {
    const [database, chain] = await Promise.allSettled([
      repo.ping(),
      options.checkRpc ? options.checkRpc() : assertChain().then(() => getBlockNumber()),
    ]);
    const db = database.status === 'fulfilled' && database.value;
    const rpc = chain.status === 'fulfilled';
    const block = chain.status === 'fulfilled' ? chain.value : null;
    const ok = db && rpc;
    return c.json({ ok, chainId: CURRENT.chainId, db, rpc, block, stage: 'phase-1', network: CURRENT.chainId === 677 ? 'mainnet' : 'testnet' }, ok ? 200 : 503);
  });

  app.post('/check', async (c) => {
    let body: CheckBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (!address || !ethers.isAddress(address)) {
      return c.json({ error: 'address required (0x...)' }, 400);
    }
    const checksummed = ethers.getAddress(address);

    if (!body.refresh) {
      const cached = await repo.latestPrecheck(checksummed);
      if (cached && cached.chainId === CURRENT.chainId) {
        const age = await getBlockNumber() - cached.block;
        if (age >= 0 && age <= 300) return c.json({ cached: true, report: cached });
      }
    }

    try {
      const report = await preCheck(checksummed);
      await repo.savePrecheck(report);
      return c.json({ cached: false, report });
    } catch (err) {
      console.error('Precheck failed:', err instanceof Error ? err.name : 'unknown');
      return c.json({ error: 'scan temporarily unavailable; try again' }, 502);
    }
  });

  app.get('/tokens/:address', async (c) => {
    const address = c.req.param('address');
    if (!ethers.isAddress(address)) return c.json({ error: 'bad address' }, 400);
    const [precheck, probe] = await Promise.all([
      repo.latestPrecheck(address),
      repo.latestProbe(address),
    ]);
    if (!precheck && !probe) return c.json({ error: 'not scanned yet — POST /check first' }, 404);
    const verdict = probe ? probe.verdict : precheck!.verdict;
    return c.json({
      address: ethers.getAddress(address),
      precheck,
      probe,
      verdict,
      verdictSource: probe ? 'probe' : 'pre-check',
      disclaimer: probe ? null : DISCLAIMER,
    });
  });

  app.post('/probe', async (c) => {
    // Public callers may read reports; only operators can authorize spending.
    const secret = process.env.PROBE_API_KEY;
    if ((options.requireProbeAuth ?? (CURRENT.chainId === 677)) || process.env.NODE_ENV === 'production' || secret) {
      if (process.env.PROBE_ENABLED !== 'true' || !secret) return c.json({ error: 'live probes are disabled' }, 503);
      const supplied = Buffer.from(c.req.header('authorization') || '');
      const expected = Buffer.from(`Bearer ${secret}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return c.json({ error: 'operator authorization required' }, 401);
    }
    let body: CheckBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (!address || !ethers.isAddress(address)) {
      return c.json({ error: 'address required (0x...)' }, 400);
    }
    const precheck = await repo.latestPrecheck(address);
    if (precheck && (precheck.verdict === 'NOT_A_CONTRACT' || precheck.verdict === 'NO_LIQUIDITY')) {
      return c.json(
        { error: `not probeable: pre-check verdict is ${precheck.verdict}`, verdict: precheck.verdict },
        422,
      );
    }
    const queued = await repo.enqueueProbe(address, 'api');
    return c.json(
      { queued, address: ethers.getAddress(address) },
      queued ? 202 : 200,
    );
  });

  app.get('/probes/:address', async (c) => {
    const address = c.req.param('address');
    if (!ethers.isAddress(address)) return c.json({ error: 'bad address' }, 400);
    return c.json({ address: ethers.getAddress(address), probes: await repo.listProbes(address) });
  });

  return app;
}
