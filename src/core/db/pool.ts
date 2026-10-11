import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import pg from 'pg';
import { dbTarget, env, isProtectedDatabase } from '../config/env.js';
import { APP_SCHEMA } from './search-path.js';
import { logger } from '../util/logger.js';

const { Pool, types } = pg;

// Postgres `numeric` arrives as a string and stays a string. Letting node-pg
// turn it into a JS float would round money and weights invisibly.
types.setTypeParser(types.builtins.NUMERIC, (value) => value);
// `bigint` likewise — beyond 2^53 a JS number stops being exact.
types.setTypeParser(types.builtins.INT8, (value) => value);
// A `date` is a calendar day, not an instant. Left alone, node-pg turns
// 2026-09-14 into a JS Date at local midnight, which serialises to JSON as
// 2026-09-13T18:30:00Z in India — an invoice dated the day before it was
// raised. Keeping it as the plain string it already is avoids the whole class
// of bug.
types.setTypeParser(types.builtins.DATE, (value) => value);

function sslOption(): pg.ConnectionConfig['ssl'] {
  if (env.DATABASE_SSL === true) return { rejectUnauthorized: true };
  if (env.DATABASE_SSL === 'no-verify') return { rejectUnauthorized: false };
  return undefined;
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  ssl: sslOption(),
  application_name: 'swarnay',
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 30_000,
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Idle database connection errored');
});

// A connection dropped mid-request (the database restarted, the network blinked)
// fails that request only. Unheard, the error would stop the whole server.
pool.on('connect', (client) => {
  client.on('error', (error) => logger.error({ err: error }, 'Database connection dropped'));
});

/**
 * Where DATABASE_URL points, with the password left out — safe to log. When the
 * URL can't be parsed, node-pg will refuse it anyway; say so rather than guess.
 */
export function databaseTarget(): { host: string; port: string; database: string; user: string } {
  try {
    const url = new URL(env.DATABASE_URL);
    return {
      host: url.hostname,
      port: url.port || '5432',
      database: decodeURIComponent(url.pathname.replace(/^\//, '')),
      user: decodeURIComponent(url.username),
    };
  } catch {
    return { host: 'unparseable DATABASE_URL', port: '?', database: '?', user: '?' };
  }
}

export async function checkConnection(): Promise<void> {
  const target = databaseTarget();
  const started = Date.now();
  logger.info(
    { dbTarget: dbTarget ?? 'DATABASE_URL', ...target, ssl: env.DATABASE_SSL, schema: APP_SCHEMA },
    'Connecting to Postgres…',
  );

  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    logger.fatal({ err: error, ...target }, `Database NOT connected — could not reach ${target.host}:${target.port}/${target.database}`);
    throw error;
  }

  try {
    const { rows } = await client.query<{
      version: string; db: string; usr: string; addr: string | null; bypasses_rls: boolean;
    }>(
      `select version() as version, current_database() as db, current_user as usr, inet_server_addr()::text as addr,
              (select rolsuper or rolbypassrls from pg_roles where rolname = current_user) as bypasses_rls`,
    );
    const row = rows[0]!;
    logger.info(
      {
        host: target.host,
        serverAddress: row.addr,
        port: target.port,
        database: row.db,
        user: row.usr,
        schema: APP_SCHEMA,
        version: row.version.split(',')[0],
        latencyMs: Date.now() - started,
      },
      `Database connected ✔ ${row.db} on ${target.host}:${target.port}`,
    );
    if (row.bypasses_rls) {
      logger.warn(
        { user: row.usr },
        `Connected as "${row.usr}", a role that bypasses Row Level Security — tenant isolation is NOT enforced by the database. Connect as a role with rolbypassrls = false (see CLAUDE.md → Security).`,
      );
    }
    if (isProtectedDatabase) {
      logger.warn(
        `DB_TARGET=deployed — this is the LIVE shops' database. Everything you do in the app is real. ` +
          `Schema sync is verify-only; table changes need npm run db:migrate -- --confirm=${row.db}`,
      );
    }
  } finally {
    client.release();
  }
}

/**
 * Re-verifies the database on a timer so the log always says whether it is
 * still reachable: one line per check while healthy, an error when a check
 * fails, and a "restored" line when it comes back.
 */
let heartbeat: NodeJS.Timeout | null = null;

export function startDbHeartbeat(intervalSeconds: number): void {
  if (intervalSeconds <= 0 || heartbeat) return;
  const { host, port, database } = databaseTarget();
  let healthy = true;

  heartbeat = setInterval(async () => {
    const started = Date.now();
    try {
      await pool.query('select 1');
      const latencyMs = Date.now() - started;
      if (!healthy) logger.info({ database, host, latencyMs }, `Database connection restored ✔ ${database} on ${host}:${port}`);
      else logger.info({ database, host, latencyMs, poolTotal: pool.totalCount, poolIdle: pool.idleCount }, `Database verified ✔ ${database}`);
      healthy = true;
    } catch (error) {
      logger.error({ err: error, database, host }, `Database check FAILED ✘ ${database} on ${host}:${port}`);
      healthy = false;
    }
  }, intervalSeconds * 1000);
  heartbeat.unref();
}

export function stopDbHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
