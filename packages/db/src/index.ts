import { MemoryRepo } from './memory.js';
import { FileRepo } from './file.js';
import { PgRepo } from './pg.js';

export * from './types.js';
export { MemoryRepo } from './memory.js';
export { FileRepo } from './file.js';
export { PgRepo } from './pg.js';

/**
 * Store selection (defaults read env, callers may override):
 *   DB_URL   → Postgres (production)
 *   DB_FILE  → JSON file shared by API + probe worker (local multi-process dev)
 *   neither  → in-process memory (tests / single process)
 */
export function makeRepo(
  dbUrl: string | undefined = process.env.DB_URL,
  dbFile: string | undefined = process.env.DB_FILE,
): import('./types.js').Repo {
  if (dbUrl && dbUrl.trim()) return new PgRepo(dbUrl.trim());
  if (dbFile && dbFile.trim()) return new FileRepo(dbFile.trim());
  return new MemoryRepo();
}
