/**
 * The deployed database holds the live shops' data. A laptop pointed at it
 * (DB_TARGET=deployed) can use the app normally — sign in, read, even save —
 * but anything that changes tables or rewrites data in bulk must name the
 * database it is about to touch:
 *
 *   npm run db:migrate -- --confirm=swarnay_erp
 *
 * so it can never happen just because someone forgot what their .env points at.
 * The production server itself sets DATABASE_URL, not DB_TARGET, and is
 * governed by the NODE_ENV=production rules in config/env.ts instead.
 */
import { isProtectedDatabase, dbTarget } from '../config/env.js';
import { databaseTarget } from './pool.js';

export function confirmFlag(): string {
  return `--confirm=${databaseTarget().database}`;
}

/** True when this command line carries --confirm=<the database it is connected to>. */
export function isConfirmed(): boolean {
  return process.argv.includes(confirmFlag());
}

export function assertMayChange(action: string): void {
  if (!isProtectedDatabase || isConfirmed()) return;
  const { host, database } = databaseTarget();
  throw new Error(
    `Refusing to ${action}: DB_TARGET=${dbTarget} is the deployed database (${host}/${database}), ` +
      `which holds live data. If you really mean to, run the command again with ${confirmFlag()}`,
  );
}
