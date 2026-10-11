/**
 * `npm run db:migrate` — makes the database match the code.
 *
 * Every table is declared in a `*.schema.ts` file and lives in ONE schema,
 * `swarnay_schema`. This command compares the declarations with the real
 * database, lists every difference, then fixes it: it creates swarnay_schema
 * and any missing table, column, index, key or policy, and — with --force —
 * also removes what the code no longer wants, including other copies of the
 * tables (`public`, `app`, `app_test`, …) left from before the schema was fixed.
 *
 *   npm run db:migrate                          -- show the changes, then apply the safe ones
 *   npm run db:migrate -- --dry-run             -- only show the changes, touch nothing
 *   npm run db:migrate -- --force               -- also apply BLOCKED changes (they delete data)
 *   npm run db:migrate -- --force --keep-data-from=app
 *                                               -- first move that copy's tables (rows and all)
 *                                                  into an empty swarnay_schema, then the rest
 *
 * Each change is labelled:
 *
 *   SAFE     adds something new (a table, a column, an index). Always applied.
 *   CAREFUL  adds a rule existing rows must follow (a foreign key, a unique
 *            constraint). Applied, but can fail if old rows break the rule —
 *            the error says which change, so fix the data and run again.
 *   BLOCKED  would delete or rewrite data (dropping a column, changing a type,
 *            removing another copy of the tables). Never applied unless you
 *            pass --force. Read the reason first.
 *
 * Other copies are removed a few tables per transaction (one huge transaction
 * runs a small server out of locks); everything else — moving a kept copy in
 * and every schema change — is one transaction. Each step can be repeated, so
 * if a run stops part way, run the same command again.
 *
 * The server also runs the SAFE part on every start (SCHEMA_SYNC_MODE=safe), so
 * day to day you rarely need this. Use it to check before a deploy, and in
 * production, where the server is not allowed to change tables by itself.
 *
 * From a laptop pointed at the deployed database (DB_TARGET=deployed), applying
 * also needs --confirm=<database name>; the dry run never does.
 */
import '../bootstrap.js';
import { pool, closePool, checkConnection, databaseTarget } from '../core/db/pool.js';
import { planSchema, syncSchema } from '../core/db/schema/sync.js';
import {
  adoptCopy, clearEmptyAppSchema, dropEmptyPublic, dropSchema, findOtherCopies, isSupabase, notOwnedIn,
  removeCopy, rowsIn, type SchemaCopy,
} from '../core/db/schema/copies.js';
import { APP_SCHEMA } from '../core/db/search-path.js';
import { confirmFlag, isConfirmed } from '../core/db/protected.js';
import { isProtectedDatabase } from '../core/config/env.js';
import { buildStamp } from '../core/util/version.js';

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);
const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const LABEL = { safe: 'SAFE   ', warn: 'CAREFUL', destructive: 'BLOCKED' } as const;
const num = (n: number): string => n.toLocaleString('en-IN');

/**
 * Each copy with its row count (null when this role cannot read it) and the
 * tables this role does not own. Counting needs RLS bypassed, in a read-only
 * transaction.
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
  const keepFrom = arg('keep-data-from');

  await checkConnection();
  const { database, host } = databaseTarget();
  const supabase = await isSupabase(pool);
  const copies = await describe(await findOtherCopies(pool));

  if (keepFrom && !copies.some((c) => c.schema === keepFrom)) {
    console.error(`\n--keep-data-from=${keepFrom}: there is no copy of the tables in "${keepFrom}". ` +
      `Copies here: ${copies.map((c) => c.schema).join(', ') || 'none'}.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nDatabase "${database}" on ${host} — every table belongs in "${APP_SCHEMA}".`);

  // 1. Other copies of the tables.
  if (copies.length) {
    console.log('\nOther copies of the tables (the app never reads them):\n');
    for (const copy of copies) {
      const size = `${copy.tables} tables, ${copy.rows === null ? 'rows unreadable by this role' : `${num(copy.rows)} rows`}`;
      if (copy.schema === keepFrom) {
        console.log(`  KEEP     move "${copy.schema}" into ${APP_SCHEMA} — ${size} kept`);
      } else if (copy.schema === 'public') {
        console.log(`  BLOCKED  drop the app's tables from public — ${size}${supabase ? ' (public itself stays: Supabase needs it)' : ''}`);
      } else {
        console.log(`  BLOCKED  drop schema ${copy.schema} — ${size}`);
      }
      if (copy.notOwned.length) {
        console.log(`           ↳ ${copy.notOwned.length} table(s) belong to another role (${copy.notOwned.slice(0, 3).join(', ')}${copy.notOwned.length > 3 ? ', …' : ''}) — ` +
          'removing this copy will fail unless it runs as their owner');
      }
    }
  }

  // 2. Differences between the code and swarnay_schema (or the copy about to become it).
  const changes = await planSchema(pool, keepFrom ?? APP_SCHEMA);
  if (changes.length) {
    console.log(`\n${changes.length} difference(s) between the code and ${keepFrom ? `"${keepFrom}" once it is moved` : APP_SCHEMA}:\n`);
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

  if (isProtectedDatabase && !isConfirmed()) {
    console.log('\nThis is the deployed database (DB_TARGET=deployed) — the live shops\' data. Nothing was changed.');
    console.log(`To apply these changes to it, run again with: npm run db:migrate -- ${process.argv.slice(2).join(' ')} ${confirmFlag()}\n`);
    process.exitCode = 1;
    return;
  }

  // 3. Apply. Other copies go first, a few tables per transaction (one huge
  // transaction runs a small server out of locks); then one transaction moves
  // the kept copy in and brings swarnay_schema up to date. Every step can be
  // repeated, so if anything stops part way, run the same command again.
  console.log(force ? '\nApplying ALL changes, including blocked ones (--force)…\n' : '\nApplying…\n');
  const removed: string[] = [];
  const say = (lines: string[]): string[] => {
    for (const line of lines) console.log(`  ${line}`);
    return lines;
  };
  if (force) {
    for (const copy of copies) if (copy.schema !== keepFrom) removed.push(...say(await removeCopy(pool, copy.schema)));
    if (keepFrom !== 'public') removed.push(...say(await dropEmptyPublic(pool)));
  }
  if (keepFrom) removed.push(...say(await clearEmptyAppSchema(pool)));

  const result = await syncSchema(pool, force ? 'force' : 'safe', buildStamp(), {
    alreadyDone: removed,
    prepare: async (client) => (keepFrom ? adoptCopy(client, keepFrom) : []),
  });

  // The copy that was moved in is empty now; with --force it goes too.
  if (force && keepFrom) say(keepFrom === 'public' ? await dropEmptyPublic(pool) : await dropSchema(pool, keepFrom));

  // 4. Say what happened.
  console.log(`\n  ${result.applied.length} applied · ${result.blocked.length} blocked · ${result.skipped.length} failed  (${result.durationMs}ms)\n`);
  if (result.skipped.length > 0) {
    console.log('Some changes failed — the log above says why. Fix the data and run again.\n');
    process.exitCode = 1;
  }
  const copiesLeft = force ? [] : copies.filter((c) => c.schema !== keepFrom);
  if (result.blocked.length > 0 || copiesLeft.length > 0) {
    console.log('Blocked changes were left alone. Either change the schema file, or, once you are sure');
    console.log('the data can go, run: npm run db:migrate -- --force\n');
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closePool);
