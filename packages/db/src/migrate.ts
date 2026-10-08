import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

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
    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      await client.query(sql);
      console.log(`applied ${file}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
