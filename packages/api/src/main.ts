import { serve } from '@hono/node-server';
import { makeRepo } from '@sellable/db';
import { createApp } from './server.js';

const port = Number(process.env.PORT || 8787);
const repo = makeRepo(process.env.DB_URL);
const app = createApp(repo);

serve({ fetch: app.fetch, port }, () => {
  const kind = process.env.DB_URL ? 'postgres' : process.env.DB_FILE ? `file ${process.env.DB_FILE}` : 'memory';
  console.log(`sellable api listening on :${port} (repo: ${kind}, chain env: ${process.env.CHAIN_ENV || 'mainnet'})`);
});

const shutdown = async (): Promise<void> => {
  await repo.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
