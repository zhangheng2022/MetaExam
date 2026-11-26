import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';

export const MAINTENANCE_LOCK = 184427;
export const maintenanceMarker = (home: string) => path.join(home, 'maintenance.json');
export function upgradePending(home: string): boolean {
  try {
    statSync(path.join(home, '../upgrade-pending.json'));
    return true;
  } catch (error) {
    // Permission and filesystem errors must not silently reopen business traffic.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

/** pg-pool's locked onConnect hook runs before a connection is exposed to callers. */
export async function enterRuntime(client: Client, home: string) {
  if (existsSync(maintenanceMarker(home))) throw new Error('MAINTENANCE_REQUIRED');
  const result = await client.query<{ locked: boolean }>(
    'SELECT pg_try_advisory_lock_shared($1) AS locked',
    [MAINTENANCE_LOCK],
  );
  if (!result.rows[0]?.locked || existsSync(maintenanceMarker(home)))
    throw new Error('MAINTENANCE_REQUIRED');
  // Retained for this connection's lifetime, including filesystem work between queries.
}
