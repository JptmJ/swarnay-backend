import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
import { z } from 'zod';

// Load default .env first
dotenv.config();

// When running tests, override with .env.test if present
export const isTestRun = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST);
if (isTestRun) {
  dotenv.config({ path: '.env.test', override: true });
}

/**
 * Settings that used to exist and now do nothing. One left in a .env would
 * mean someone still believes it does something — so name it and stop.
 *
 *   One database:  DATABASE_URL (swarnay_erp). No DB_TARGET, no per-target URLs.
 *   One schema:    swarnay_schema, fixed in core/db/search-path.ts.
 *   One behaviour: every start brings the tables up to date; `npm run
 *                  db:migrate -- --force` is the only way anything is deleted.
 */
const RETIRED: Record<string, string> = {
  DB_TARGET: 'put the database URL in DATABASE_URL',
  DATABASE_URL_LOCAL: 'put the database URL in DATABASE_URL',
  DATABASE_URL_SUPABASE: 'put the database URL in DATABASE_URL',
  DATABASE_URL_DEPLOYED: 'put the database URL in DATABASE_URL',
  DATABASE_SSL_LOCAL: 'use DATABASE_SSL',
  DATABASE_SSL_SUPABASE: 'use DATABASE_SSL',
  DATABASE_SSL_DEPLOYED: 'use DATABASE_SSL',
  DATABASE_SCHEMA: 'every table lives in swarnay_schema',
  SCHEMA_SYNC_MODE: 'every start brings the tables up to date; deletions need npm run db:migrate -- --force',
  DB_SCHEMA_SYNC: 'every start brings the tables up to date; deletions need npm run db:migrate -- --force',
};
const retired = Object.keys(RETIRED).filter((key) => process.env[key] !== undefined);
if (retired.length) {
  const file = isTestRun ? '.env.test' : '.env';
  console.error(
    `These settings are no longer used — remove them from ${file}:\n` +
      retired.map((key) => `  - ${key}: ${RETIRED[key]}`).join('\n') +
      '\n',
  );
  process.exit(1);
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  /** The database — swarnay_erp. Everything else has a default. */
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required — put it in .env' })
    .min(1, 'DATABASE_URL is required — put it in .env'),
  DATABASE_SSL: z
    .enum(['true', 'false', 'no-verify'])
    .default('false')
    .transform((v) => (v === 'true' ? true : v === 'no-verify' ? ('no-verify' as const) : false)),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Seconds between database health checks in the log. 0 turns them off. */
  DB_HEARTBEAT_SECONDS: z.coerce.number().int().min(0).default(60),

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

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Configuration problem — the server cannot start:\n${issues}\n`);
  process.exit(1);
}

const databaseName = (() => {
  try {
    return decodeURIComponent(new URL(parsed.data.DATABASE_URL).pathname.replace(/^\//, ''));
  } catch {
    return null; // not a URL at all — node-pg reports that itself
  }
})();
if (databaseName === '') {
  console.error(
    'DATABASE_URL has no database name at the end. Add it after the port:\n' +
      '  …@aws-0-ap-south-1.pooler.supabase.com:5432/postgres   (Supabase)\n' +
      '  …@35.153.24.32:5432/swarnay_erp                       (production)\n',
  );
  process.exit(1);
}

// .env.example is committed with <…> placeholders for the secrets. A server
// started without filling them in must not run — least of all with a JWT secret
// anyone can read on GitHub.
if (parsed.data.NODE_ENV === 'production') {
  const unfilled = (['DATABASE_URL', 'JWT_SECRET'] as const).filter((key) => /<[^>]*>|change-me/.test(parsed.data[key]));
  if (unfilled.length) {
    console.error(`${unfilled.join(' and ')} still ${unfilled.length > 1 ? 'hold' : 'holds'} a placeholder — put the real value in .env.`);
    process.exit(1);
  }
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
