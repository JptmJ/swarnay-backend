/**
 * `npm run db:migrate` — makes the database match the code.
 *
 * One database (swarnay_erp), one schema (swarnay_schema). Every table is
 * declared in a `*.schema.ts` file; this command compares those declarations
 * with the real database, lists every difference, and fixes it.
 *
 *   npm run db:migrate                -- apply everything that adds (the usual case)
 *   npm run db:migrate -- --dry-run   -- only list the differences, change nothing
 *   npm run db:migrate -- --force     -- also apply what deletes data
 *
 * You rarely need to type it: the server does the same as plain
 * `npm run db:migrate` every time it starts — on a laptop and on the server
 * alike — so deploying new code is enough to bring the tables up to date.
 * Only deletions wait for you, because they cannot be undone.
 *
 * Each change is labelled:
 *
 *   SAFE     adds something new (a table, a column, an index). Always applied.
 *   CAREFUL  adds a rule existing rows must follow (a foreign key, a unique
 *            constraint). Applied, but can fail if old rows break the rule —
 *            the error says which change, so fix the data and run again.
 *   BLOCKED  would delete or rewrite data (dropping a column or table, changing
 *            a type, removing an old copy of the tables in another schema).
 *            Applied only with --force. Read the reason first.
 *
 * If a run stops part way, run the same command again — every step can be
 * repeated.
 */
import '../bootstrap.js';
import { pool, closePool, checkConnection, databaseTarget } from '../core/db/pool.js';
import { planSchema, syncSchema } from '../core/db/schema/sync.js';
import {
  dropEmptyPublic, findOtherCopies, notOwnedIn, removeCopy, rowsIn, type SchemaCopy,
} from '../core/db/schema/copies.js';
import { APP_SCHEMA } from '../core/db/search-path.js';
import { buildStamp } from '../core/util/version.js';

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);
const LABEL = { safe: 'SAFE   ', warn: 'CAREFUL', destructive: 'BLOCKED' } as const;
const num = (n: number): string => n.toLocaleString('en-IN');

/**
 * Each old copy with its row count (null when this role cannot read it) and
 * the tables this role does not own. Counting needs RLS bypassed, in a
 * read-only transaction.
 */
async function describe(copies: SchemaCopy[]): Promise<Array<SchemaCopy & { rows: number | null; notOwned: string[] }>> {
  const client = await pool.connect();
  try {
    await client.query('begin read only');
    await client.query(`set local app.bypass_rls = 'on'`);
    const out = [];
    for (const copy of copies) {
      await client.query('savepoint count_rows');
      const rows = await rowsIn(client, copy.schema).catch(() => null);
      await client.query(rows === null ? 'rollback to savepoint count_rows' : 'release savepoint count_rows');
      out.push({ ...copy, rows, notOwned: await notOwnedIn(client, copy.schema) });
    }
    return out;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

async function main(): Promise<void> {
  const dryRun = has('dry-run');
  const force = has('force');

  await checkConnection();
  const { database, host } = databaseTarget();
  console.log(`\nDatabase "${database}" on ${host} — every table belongs in "${APP_SCHEMA}".`);

  // 1. Old copies of the tables in other schemas (public, app, …).
  const copies = await describe(await findOtherCopies(pool));
  if (copies.length) {
    console.log('\nOld copies of the tables in other schemas (the app never reads them):\n');
    for (const copy of copies) {
      const size = `${copy.tables} tables, ${copy.rows === null ? 'rows unreadable by this role' : `${num(copy.rows)} rows`}`;
      console.log(copy.schema === 'public'
        ? `  BLOCKED  drop the app's tables from public — ${size}`
        : `  BLOCKED  drop schema ${copy.schema} — ${size}`);
      if (copy.notOwned.length) {
        console.log(`           ↳ ${copy.notOwned.length} table(s) belong to another role (${copy.notOwned.slice(0, 3).join(', ')}${copy.notOwned.length > 3 ? ', …' : ''}) — ` +
          'removing this copy will fail unless it runs as their owner');
      }
    }
  }

  // 2. Differences between the code and swarnay_schema.
  const changes = await planSchema(pool);
  if (changes.length) {
    console.log(`\n${changes.length} difference(s) between the code and ${APP_SCHEMA}:\n`);
    for (const change of changes) {
      console.log(`  ${LABEL[change.risk]}  ${change.description}`);
      if (change.blockedReason) console.log(`           ↳ ${change.blockedReason}`);
    }
    if (process.env.SHOW_SQL === 'true') {
      console.log('\n--- SQL ---\n');
      for (const change of changes) for (const statement of change.sql) console.log(`${statement};`);
    }
  }

  if (!copies.length && !changes.length) {
    console.log('\n✔ The database already matches the code. Nothing to do.\n');
    return;
  }

  if (dryRun) {
    console.log('\nDry run — nothing was changed. Run without --dry-run to apply.\n');
    return;
  }

  // 3. Apply. Old copies go first, a few tables per transaction (one huge
  // transaction runs a small server out of locks); then one transaction brings
  // swarnay_schema up to date.
  console.log(force ? '\nApplying ALL changes, including blocked ones (--force)…\n' : '\nApplying…\n');
  const removed: string[] = [];
  if (force) {
    for (const copy of copies) removed.push(...(await removeCopy(pool, copy.schema)));
    removed.push(...(await dropEmptyPublic(pool)));
    for (const line of removed) console.log(`  ${line}`);
  }

  const result = await syncSchema(pool, force ? 'force' : 'safe', buildStamp(), { alreadyDone: removed });

  // 4. Say what happened.
  console.log(`\n  ${result.applied.length} applied · ${result.blocked.length} blocked · ${result.skipped.length} failed  (${result.durationMs}ms)\n`);
  if (result.skipped.length > 0) {
    console.log('Some changes failed — the log above says why. Fix the data and run again.\n');
    process.exitCode = 1;
  }
  if (result.blocked.length > 0 || (!force && copies.length > 0)) {
    console.log('Changes that delete data were left alone. Once you are sure the data can go, run:');
    console.log('  npm run db:migrate -- --force\n');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
