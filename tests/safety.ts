import fs from 'node:fs';
import dotenv from 'dotenv';
import { env } from '../src/core/config/env.js';

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
 * a database of their own — never the one in .env, which is the real
 * swarnay_erp. Called from global-setup, before the first query.
 */
export function assertSafeTestDatabase(): void {
  const refuse = (reason: string): never => {
    const message =
      `\n================================================================================\n` +
      `REFUSING TO RUN THE TESTS\n` +
      `--------------------------------------------------------------------------------\n` +
      `${reason}\n\n` +
      'Create .env.test with DATABASE_URL pointing at a database used only by the tests,\n' +
      'e.g. a Postgres on your machine: DATABASE_URL=postgres://postgres:postgres@localhost:5432/swarnay_test\n' +
      `================================================================================\n`;
    console.error(message);
    throw new Error(message);
  };

  if (!fs.existsSync('.env.test')) {
    refuse('There is no .env.test, so the tests would run against the database in .env.');
  }

  if (fs.existsSync('.env')) {
    const devUrl = dotenv.parse(fs.readFileSync('.env', 'utf8')).DATABASE_URL;
    if (devUrl && whereIs(env.DATABASE_URL) === whereIs(devUrl)) {
      refuse(`The tests would use the real database (${whereIs(devUrl)}).`);
    }
  }
}
