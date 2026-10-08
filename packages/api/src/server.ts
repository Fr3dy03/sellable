import { Hono } from 'hono';
import { ethers } from 'ethers';
import { preCheck, DISCLAIMER, CURRENT } from '@sellable/core';
import type { Repo } from '@sellable/db';

interface CheckBody {
  address?: string;
  refresh?: boolean;
}

export function createApp(repo: Repo): Hono {
  const app = new Hono();

  app.get('/health', async (c) => {
    let db = false;
    try {
      db = await repo.ping();
    } catch {
      db = false;
    }
    return c.json({ ok: true, chainId: CURRENT.chainId, db, stage: 'phase-1', network: process.env.CHAIN_ENV || 'mainnet' });
  });

  app.post('/check', async (c) => {
    let body: CheckBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const address = body.address?.trim();
    if (!address || !ethers.isAddress(address)) {
      return c.json({ error: 'address required (0x...)' }, 400);
    }
    const checksummed = ethers.getAddress(address);

    if (!body.refresh) {
      const cached = await repo.latestPrecheck(checksummed);
      if (cached) return c.json({ cached: true, report: cached });
    }

    try {
      const report = await preCheck(checksummed);
      await repo.savePrecheck(report);
      return c.json({ cached: false, report });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
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
    let body: CheckBody;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const address = body.address?.trim();
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
      { queued, address: ethers.getAddress(address), hint: 'run the probe worker (npm run probe -- --loop)' },
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
