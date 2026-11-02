import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { CURRENT } from '@sellable/core';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', '..', '..', 'db', 'migrations');

async function main(): Promise<void> {
  const url = process.env.DB_URL;
  if (!url) {
    console.error('DB_URL not set — e.g. postgres://user:pass@localhost:5432/sellable');
    process.exit(1);
  }
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(677968)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const file of files) {
      const applied = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (applied.rowCount) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      console.log(`applied ${file}`);
    }
    const mixed = await client.query('SELECT 1 FROM tokens WHERE chain_id <> $1 UNION ALL SELECT 1 FROM probes WHERE chain_id <> $1 LIMIT 1', [CURRENT.chainId]);
    if (mixed.rowCount) throw new Error('Database contains another network. Create a fresh mainnet database.');
    await client.query('INSERT INTO deployment_network (singleton, chain_id) VALUES (true, $1) ON CONFLICT DO NOTHING', [CURRENT.chainId]);
    const network = await client.query('SELECT chain_id FROM deployment_network');
    if (Number(network.rows[0]?.chain_id) !== CURRENT.chainId) throw new Error('Database belongs to another chain');
    await client.query('COMMIT');
    console.log(`database ready for chain ${CURRENT.chainId}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
