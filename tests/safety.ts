import fs from 'node:fs';
import dotenv from 'dotenv';
import { env, isProtectedDatabase, resolveDatabase } from '../src/core/config/env.js';

/** host:port/database — two URLs can differ in password or options and still be the same database. */
function whereIs(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, ''))}`;
  } catch {
    return url;
  }
}

/**
 * Integration tests force-sync the schema (which can DROP columns) and insert,
 * alter and delete real rows. Before any of that, make sure they are pointed at
 * a database of their own — never the one in .env, and never the deployed
 * database. Every table lives in swarnay_schema, so a separate schema is not an
 * option: the tests need a separate database. Called from global-setup, before
 * the first query.
 */
export function assertSafeTestDatabase(): void {
  const refuse = (reason: string, fix: string): never => {
    const message =
      `\n================================================================================\n` +
      `REFUSING TO RUN THE TESTS\n` +
      `--------------------------------------------------------------------------------\n` +
      `${reason}\n\n${fix}\n` +
      `================================================================================\n`;
    console.error(message);
    throw new Error(message);
  };

  const fix =
    'Create .env.test pointing at a database used only by the tests, e.g.\n' +
    '  DB_TARGET=local                      (a Postgres on your machine), or\n' +
    '  DB_TARGET=   and   DATABASE_URL=postgres://…/swarnay_test\n' +
    '(on Supabase: create database swarnay_test; then use the same pooler URL ending in /swarnay_test)';

  if (!fs.existsSync('.env.test')) {
    refuse('There is no .env.test, so the tests would run against the database in .env.', fix);
  }

  if (isProtectedDatabase) {
    refuse('DB_TARGET=deployed — that is the live shops\' database.', fix);
  }

  if (fs.existsSync('.env')) {
    const devUrl = resolveDatabase(dotenv.parse(fs.readFileSync('.env', 'utf8'))).url;
    if (devUrl && whereIs(env.DATABASE_URL) === whereIs(devUrl)) {
      refuse(`The tests would use the development database (${whereIs(devUrl)}).`, fix);
    }
  }
}
