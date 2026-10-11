/**
 * Postgres extensions the schema relies on, and where they live.
 *
 * pg_trgm provides `gin_trgm_ops`, used by the fuzzy-search indexes on party
 * and stock_piece. Indexes find it through the search_path, so it must live in
 * Supabase's `extensions` schema or, on plain Postgres, in swarnay_schema — not
 * in `public` or an old copy that is about to be dropped (dropping that schema
 * would take the extension and every index built on it along).
 */
import type { PoolClient } from 'pg';
import { logger } from '../../util/logger.js';
import { APP_SCHEMA } from '../search-path.js';
import { quoteIdent as q } from './sql.js';

const REQUIRED = ['pg_trgm'];

/** Supabase's `extensions` schema when there is one, otherwise swarnay_schema. */
export async function extensionHome(client: PoolClient): Promise<string> {
  const { rows } = await client.query(`select 1 from pg_namespace where nspname = 'extensions'`);
  return rows.length ? 'extensions' : APP_SCHEMA;
}

async function attempt(client: PoolClient, sql: string): Promise<string | null> {
  await client.query('savepoint extension_step');
  try {
    await client.query(sql);
    await client.query('release savepoint extension_step');
    return null;
  } catch (error) {
    await client.query('rollback to savepoint extension_step');
    return (error as Error).message;
  }
}

/**
 * Installs a required extension that is missing. One that is already
 * installed stays where it is — wherever that is — because the sync names its
 * operator classes with their schema (qualifiedOpclass below). Moving it is
 * usually impossible anyway: Postgres creates a trusted extension's functions
 * as the superuser, so not even the role that installed it may move them.
 * Never fatal: without pg_trgm only the search indexes fail, and the sync
 * reports those itself.
 */
export async function ensureExtensions(client: PoolClient): Promise<string[]> {
  const home = await extensionHome(client);
  const done: string[] = [];
  for (const name of REQUIRED) {
    const { rows } = await client.query<{ schema: string; usable: boolean; me: string }>(
      `select n.nspname as schema, has_schema_privilege(n.nspname, 'USAGE') as usable, current_user as me
         from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = $1`,
      [name],
    );
    if (rows[0] && !rows[0].usable) {
      // Otherwise every index using it fails with "operator class does not exist".
      logger.warn(
        { extension: name, schema: rows[0].schema },
        `Extension ${name} lives in "${rows[0].schema}", which this role may not use — ask the database owner to run: ` +
          `grant usage on schema ${q(rows[0].schema)} to ${q(rows[0].me)}`,
      );
    }
    if (rows.length) continue;
    const sql = `create extension if not exists ${q(name)} with schema ${q(home)}`;
    const error = await attempt(client, sql);
    if (error) logger.warn({ extension: name, error }, `Could not install extension ${name} — ask the database owner to run: ${sql}`);
    else done.push(`installed extension ${name} in ${home}`);
  }
  return done;
}

/**
 * An operator class such as gin_trgm_ops, named with the schema its extension
 * lives in when that schema is not on the search_path (pg_trgm installed in
 * `public` by a plain `create extension`). Unknown classes are left as they are
 * and fail with Postgres's own message.
 */
export async function qualifiedOpclass(client: PoolClient, opclass: string, method = 'btree'): Promise<string> {
  const { rows } = await client.query<{ schema: string }>(
    `select n.nspname as schema
       from pg_opclass o
       join pg_namespace n on n.oid = o.opcnamespace
       join pg_am a on a.oid = o.opcmethod
      where o.opcname = $1 and a.amname = $2
      order by (n.nspname in ('pg_catalog', $3, 'extensions')) desc
      limit 1`,
    [opclass, method, APP_SCHEMA],
  );
  const schema = rows[0]?.schema;
  return !schema || ['pg_catalog', APP_SCHEMA, 'extensions'].includes(schema) ? opclass : `${q(schema)}.${opclass}`;
}

/**
 * Moves every extension out of a schema that is about to be dropped. One that
 * cannot be moved stops the whole operation rather than being dropped with it.
 */
export async function moveExtensionsOut(client: PoolClient, schema: string): Promise<string[]> {
  const home = await extensionHome(client);
  const { rows } = await client.query<{ name: string; relocatable: boolean }>(
    `select e.extname as name, e.extrelocatable as relocatable
       from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = $1`,
    [schema],
  );
  const done: string[] = [];
  for (const ext of rows) {
    if (!ext.relocatable) {
      throw new Error(`Extension ${ext.name} lives in "${schema}" and cannot be moved automatically. Move or drop it by hand, then run again.`);
    }
    const sql = `alter extension ${q(ext.name)} set schema ${q(home)}`;
    try {
      await client.query(sql);
    } catch (error) {
      throw new Error(
        `Extension ${ext.name} lives in "${schema}", which is about to be dropped, and this role cannot move it ` +
          `(${(error as Error).message}). Ask a superuser to run: ${sql} — then run again.`,
      );
    }
    done.push(`moved extension ${ext.name} from ${schema} to ${home}`);
  }
  return done;
}
