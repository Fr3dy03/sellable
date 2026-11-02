import pg from 'pg';
import { CURRENT } from '@sellable/core';

export const MAX_TX_GAS = 500_000n;
export const MAX_GAS_PRICE = 50_000_000_000n; // 50 gwei; fixed maximum, never auto-bumped
export const MAX_PROBE_GAS_COST = 4n * MAX_TX_GAS * MAX_GAS_PRICE;

/** Dedicated direct Postgres connection: session locks need session affinity. */
export async function openProbeGuard(connectionString: string) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10_000 });
  client.on('error', () => {
    console.error('Probe safety connection lost; stopping worker. Reserved budgets remain charged.');
    process.exit(1);
  });
  await client.connect();
  const network = await client.query('SELECT chain_id FROM deployment_network WHERE singleton = true');
  if (Number(network.rows[0]?.chain_id) !== CURRENT.chainId) {
    await client.end();
    throw new Error('Probe safety database network mismatch');
  }
  const lock = await client.query('SELECT pg_try_advisory_lock(677969, $1) AS locked', [CURRENT.chainId]);
  if (!lock.rows[0]?.locked) {
    await client.end();
    throw new Error('Another probe worker is already running for this network');
  }
  return {
    async reserve(address: string, amount: bigint, dailyBudget: bigint): Promise<boolean> {
      const result = await client.query(
        `INSERT INTO probe_budget_reservations (chain_id, address, reserved_wei)
         SELECT $1, $2, $3::numeric WHERE $3::numeric + COALESCE((
           SELECT SUM(reserved_wei) FROM probe_budget_reservations
           WHERE chain_id = $1 AND created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
         ), 0) <= $4::numeric RETURNING id`,
        [CURRENT.chainId, address.toLowerCase(), amount.toString(), dailyBudget.toString()],
      );
      return !!result.rowCount;
    },
    close: () => client.end(),
  };
}
