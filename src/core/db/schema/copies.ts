/**
 * Other copies of the application's tables, and getting rid of them.
 *
 * Every table lives in swarnay_schema. A copy anywhere else — `public` and
 * `app` from before the schema was fixed, an old `app_test` — is not part of
 * the application and the app never reads it. The server logs an error while
 * one exists. `npm run db:migrate -- --force` removes it; with
 * `--keep-data-from=<schema>` that copy's tables are first moved into
 * swarnay_schema, rows and all.
 */
import type { Pool, PoolClient } from 'pg';
import { logger } from '../../util/logger.js';
import { APP_SCHEMA } from '../search-path.js';
import { allTables } from './registry.js';
import { quoteIdent as q } from './sql.js';
import { moveExtensionsOut } from './extensions.js';

const CHANGE_LOG = '_schema_change_log';

export interface SchemaCopy {
  schema: string;
  /** How many of the application's tables this schema holds. */
  tables: number;
}

/**
 * Schemas other than swarnay_schema holding at least three of the
 * application's tables — the threshold keeps a lone table that happens to
 * share a name from counting.
 */
export async function findOtherCopies(db: Pool | PoolClient): Promise<SchemaCopy[]> {
  const { rows } = await db.query<SchemaCopy>(
    `select n.nspname as schema, count(*)::int as tables
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p')
        and c.relname = any($1::text[])
        and n.nspname <> $2
        and n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
      group by n.nspname
     having count(*) >= 3
      order by n.nspname`,
    [allTables().map((t) => t.name), APP_SCHEMA],
  );
  return rows;
}

/**
 * Logs loudly while another copy exists. It does not stop the server: those
 * rows are only unseen, and removing them is a deliberate step.
 */
export async function warnAboutOtherCopies(db: Pool | PoolClient): Promise<SchemaCopy[]> {
  const copies = await findOtherCopies(db);
  for (const copy of copies) {
    logger.error(
      { schema: copy.schema, tables: copy.tables },
      `A second copy of the application's tables exists in schema "${copy.schema}" (${copy.tables} tables). ` +
        `The app only uses "${APP_SCHEMA}", so it never sees those rows. ` +
        `Remove it with: npm run db:migrate -- --force   (or --keep-data-from=${copy.schema} to move its rows into ${APP_SCHEMA} first)`,
    );
  }
  return copies;
}

/** The application's tables in a schema: everything the registry defines, plus the sync's change log. */
export async function appTablesIn(db: Pool | PoolClient, schema: string): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p') and (c.relname = any($2::text[]) or c.relname = $3)
      order by 1`,
    [schema, allTables().map((t) => t.name), CHANGE_LOG],
  );
  return rows.map((r) => r.relname);
}

/**
 * Rows across the application's tables in a schema (the change log not
 * counted). Every table forces Row Level Security, so the caller's transaction
 * must have `app.bypass_rls = 'on'`.
 */
export async function rowsIn(client: PoolClient, schema: string): Promise<number> {
  let total = 0;
  for (const table of await appTablesIn(client, schema)) {
    if (table === CHANGE_LOG) continue;
    const { rows } = await client.query<{ n: number }>(`select count(*)::int as n from ${q(schema)}.${q(table)}`);
    total += rows[0]!.n;
  }
  return total;
}

/**
 * Tables in a schema this role does not own. Dropping or moving them would
 * fail half way through, so the plan names them up front.
 */
export async function notOwnedIn(db: Pool | PoolClient, schema: string): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind in ('r', 'p') and not pg_has_role(current_user, c.relowner, 'USAGE')
      order by 1`,
    [schema],
  );
  return rows.map((r) => r.relname);
}

/**
 * Supabase's own services (the Data API, the dashboard) expect `public` to
 * exist, so it is never dropped there. Roles are shared by every database on a
 * server, so the role alone is not proof — Supabase's `auth` schema must be in
 * this database too.
 */
export async function isSupabase(db: Pool | PoolClient): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 where exists (select 1 from pg_roles where rolname = 'supabase_admin')
                and exists (select 1 from pg_namespace where nspname = 'auth')`,
  );
  return rows.length > 0;
}

/**
 * Runs `fn` in a transaction of its own. Removing a copy is split into many of
 * these: dropping a few hundred tables — each with its indexes, keys and
 * policies — in one transaction runs out of lock slots on a small server
 * (Supabase answers "out of shared memory"). Every step can be repeated, so a
 * run that stops part way simply carries on next time.
 */
async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local app.bypass_rls = 'on'; set local lock_timeout = '30s'`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** How many tables one transaction drops. */
const TABLES_PER_TRANSACTION = 10;

async function dropTables(pool: Pool, schema: string, tables: string[]): Promise<void> {
  for (let i = 0; i < tables.length; i += TABLES_PER_TRANSACTION) {
    const batch = tables.slice(i, i + TABLES_PER_TRANSACTION);
    await inTransaction(pool, async (client) => {
      for (const table of batch) await client.query(`drop table if exists ${q(schema)}.${q(table)} cascade`);
    });
  }
}

/**
 * Removes one other copy. Its tables go a few at a time; then a schema other
 * than `public` is dropped whole, after moving out any extension living in it
 * (it would otherwise take every index built on it along).
 */
export async function removeCopy(pool: Pool, schema: string): Promise<string[]> {
  const tables = await appTablesIn(pool, schema);
  await dropTables(pool, schema, tables);
  const done = [`dropped ${tables.length} application table(s) from ${schema}`];
  if (schema !== 'public') done.push(...(await dropSchema(pool, schema)));
  return done;
}

/** Drops a schema the application no longer uses, keeping its extensions. */
export async function dropSchema(pool: Pool, schema: string): Promise<string[]> {
  return inTransaction(pool, async (client) => {
    const done = await moveExtensionsOut(client, schema);
    await client.query(`drop schema if exists ${q(schema)} cascade`);
    return [...done, `dropped schema ${schema}`];
  });
}

/**
 * Before --keep-data-from: swarnay_schema must hold no rows (a server may
 * already have created it, empty); its empty tables are dropped to make room.
 */
export async function clearEmptyAppSchema(pool: Pool): Promise<string[]> {
  const tables = await inTransaction(pool, async (client) => {
    const rows = await rowsIn(client, APP_SCHEMA);
    if (rows > 0) {
      throw new Error(
        `${APP_SCHEMA} already holds ${rows} row(s). --keep-data-from only fills an empty ${APP_SCHEMA}; ` +
          'run without it to keep what is there and remove the other copies.',
      );
    }
    return appTablesIn(client, APP_SCHEMA);
  });
  await dropTables(pool, APP_SCHEMA, tables);
  return tables.length ? [`dropped ${tables.length} empty table(s) from ${APP_SCHEMA}`] : [];
}

/**
 * Makes `from`'s copy the application's by moving its tables into
 * swarnay_schema with their rows, indexes, keys and policies — metadata only,
 * nothing is copied. Runs inside the sync's transaction, so the move and the
 * changes that bring the moved tables up to date succeed or fail together.
 */
export async function adoptCopy(client: PoolClient, from: string): Promise<string[]> {
  if ((await appTablesIn(client, APP_SCHEMA)).length) {
    throw new Error(`${APP_SCHEMA} still has tables — clearEmptyAppSchema() must run first.`);
  }
  const moving = await appTablesIn(client, from);
  for (const table of moving) await client.query(`alter table ${q(from)}.${q(table)} set schema ${q(APP_SCHEMA)}`);
  return [`moved ${moving.length} table(s) from ${from} into ${APP_SCHEMA}, rows and all`];
}

/**
 * Plain Postgres: `public` goes too once it is empty, leaving swarnay_schema as
 * the only schema. Supabase keeps it. Optional to the app, so nothing here
 * fails the migration: an extension this role cannot move, or anything else
 * left in public, just keeps it.
 */
export async function dropEmptyPublic(pool: Pool): Promise<string[]> {
  if (await isSupabase(pool)) return [];
  const { rows } = await pool.query(`select 1 from pg_namespace where nspname = 'public'`);
  if (!rows.length) return [];
  try {
    return await inTransaction(pool, async (client) => {
      const done = await moveExtensionsOut(client, 'public');
      await client.query('drop schema public'); // RESTRICT: refuses if anything else is still in it
      return [...done, 'dropped schema public (it was empty)'];
    });
  } catch (error) {
    logger.warn({ error: (error as Error).message }, 'Kept schema public: something other than the application still lives in it.');
    return [];
  }
}
