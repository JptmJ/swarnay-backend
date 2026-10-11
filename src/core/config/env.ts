import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
import { z } from 'zod';
import type { SyncMode } from '../db/schema/sync.js';

// Load default .env first
dotenv.config();

// When running tests, override with .env.test if present
export const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
if (isTestRun) {
  dotenv.config({ path: '.env.test', override: true });
}

/**
 * Which database this backend talks to.
 *
 * A server (production, CI) sets DATABASE_URL and DATABASE_SSL directly. A
 * developer keeps one URL per database in .env and picks one with DB_TARGET:
 *
 *   DB_TARGET=supabase
 *   DATABASE_URL_SUPABASE=…   DATABASE_SSL_SUPABASE=no-verify
 *   DATABASE_URL_DEPLOYED=…   DATABASE_SSL_DEPLOYED=false
 *
 * so switching is one word, and `DB_TARGET=deployed npm run dev` switches for a
 * single run. `deployed` holds the live shops' data, so it is protected — see
 * isProtectedDatabase below.
 */
export const DB_TARGETS = ['local', 'supabase', 'deployed'] as const;
export type DbTarget = (typeof DB_TARGETS)[number];

export function resolveDatabase(
  vars: Record<string, string | undefined>,
): { target: DbTarget | null; url?: string; ssl?: string; problem?: string } {
  const target = vars.DB_TARGET?.trim();
  if (!target) return { target: null, url: vars.DATABASE_URL, ssl: vars.DATABASE_SSL };
  if (!(DB_TARGETS as readonly string[]).includes(target)) {
    return { target: null, problem: `DB_TARGET must be one of ${DB_TARGETS.join(', ')} — got "${target}"` };
  }
  if (vars.DATABASE_URL) {
    return { target: null, problem: 'DB_TARGET and DATABASE_URL are both set — keep one (DB_TARGET picks DATABASE_URL_<TARGET>)' };
  }
  const suffix = target.toUpperCase();
  const url = vars[`DATABASE_URL_${suffix}`];
  if (!url) return { target: null, problem: `DB_TARGET=${target}, but DATABASE_URL_${suffix} is empty — add it to .env` };
  return { target: target as DbTarget, url, ssl: vars[`DATABASE_SSL_${suffix}`] };
}

const database = resolveDatabase(process.env);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  /** Paste the Postgres connection string here (or use DB_TARGET). Everything else has a default. */
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required — put it in .env, or set DB_TARGET' })
    .min(1, 'DATABASE_URL is required — put it in .env, or set DB_TARGET'),
  DATABASE_SSL: z
    .enum(['true', 'false', 'no-verify'])
    .default('false')
    .transform((v) => (v === 'true' ? true : v === 'no-verify' ? ('no-verify' as const) : false)),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Seconds between database health checks in the log. 0 turns them off. */
  DB_HEARTBEAT_SECONDS: z.coerce.number().int().min(0).default(60),

  SCHEMA_SYNC_MODE: z.enum(['off', 'verify', 'safe', 'force']).default('verify'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),

  /**
   * Web apps on OTHER origins allowed to call this API with cookies, comma
   * separated, e.g. "https://erp.swarnay.com,http://localhost:5173". Not needed
   * when the app reaches the API through its own origin (Vite proxy / rewrite).
   */
  CORS_ORIGINS: z.string().default('')
    .transform((v) => v.split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean)),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).optional(),
});

const parsed = schema.safeParse({ ...process.env, DATABASE_URL: database.url, DATABASE_SSL: database.ssl });

if (!parsed.success || database.problem) {
  const issues = [
    ...(database.problem ? [`  - DB_TARGET: ${database.problem}`] : []),
    ...(parsed.success ? [] : parsed.error.issues
      // A DB_TARGET problem already explains why there is no DATABASE_URL.
      .filter((i) => !(database.problem && i.path[0] === 'DATABASE_URL'))
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)),
  ].join('\n');
  console.error(`Configuration problem — the server cannot start:\n${issues}\n`);
  process.exit(1);
}

// Every table lives in swarnay_schema (core/db/search-path.ts); the schema is
// not configurable any more. A leftover setting would mean someone still
// believes they are reading another schema, so stop and say so.
if (process.env.DATABASE_SCHEMA) {
  console.error(
    `DATABASE_SCHEMA=${process.env.DATABASE_SCHEMA} is no longer used: every table lives in "swarnay_schema".\n` +
      `Remove DATABASE_SCHEMA from ${isTestRun ? '.env.test (tests use a database of their own now)' : '.env'}, then run npm run db:migrate.\n`,
  );
  process.exit(1);
}

// In production, server must never apply schema changes on boot.
const isDbSyncCli = process.argv.some((arg) => arg.includes('db-migrate'));
if (
  !isDbSyncCli &&
  parsed.data.NODE_ENV === 'production' &&
  (parsed.data.SCHEMA_SYNC_MODE === 'safe' || parsed.data.SCHEMA_SYNC_MODE === 'force')
) {
  console.error('Schema changes in production run only through npm run db:migrate as a deploy step.');
  process.exit(1);
}

export const env = parsed.data;
export const dbTarget: DbTarget | null = database.target;
/**
 * A developer machine pointed at the live shops' database. The app works
 * normally against it, but it never changes tables on boot (sync drops to
 * verify) and bulk scripts need --confirm=<database> — see core/db/protected.ts.
 */
export const isProtectedDatabase = dbTarget === 'deployed';
export const syncMode: SyncMode =
  isProtectedDatabase && (env.SCHEMA_SYNC_MODE === 'safe' || env.SCHEMA_SYNC_MODE === 'force')
    ? 'verify'
    : env.SCHEMA_SYNC_MODE;
export const isProduction = env.NODE_ENV === 'production';
