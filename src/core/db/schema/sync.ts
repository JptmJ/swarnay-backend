/**
 * The thing that runs on every boot:
 *
 *   1. take a lock so two app instances never migrate at the same time
 *   2. read the live database
 *   3. compare it against what the modules declared
 *   4. apply what is safe, refuse what is not, write down what happened
 *
 * There is no setting. Every start of the server, on a laptop or in
 * production, runs it in `safe` mode; `npm run db:migrate` runs it on demand.
 *   safe   — apply everything that adds; list what would delete and leave it
 *   force  — apply everything, including drops (`npm run db:migrate -- --force`)
 *   verify — compare only, change nothing (`--dry-run`)
 */
import type { Pool, PoolClient } from 'pg';
import type { SchemaChange } from './types.js';
import { diffSchema } from './diff.js';
import { introspect } from './introspect.js';
import { allTables, getTable } from './registry.js';
import { logger } from '../../util/logger.js';
import { buildStamp } from '../../util/version.js';
import { APP_SCHEMA, SET_SEARCH_PATH } from '../search-path.js';
import { createIndexSql, indexName, quoteIdent } from './sql.js';
import { ensureExtensions, qualifiedOpclass } from './extensions.js';

export type SyncMode = 'off' | 'verify' | 'safe' | 'force';

/** Any number works; it just has to be the same in every instance of the app. */
const ADVISORY_LOCK_KEY = 8_524_113_907_001n;

export interface SyncResult {
  mode: SyncMode;
  applied: SchemaChange[];
  blocked: SchemaChange[];
  skipped: SchemaChange[];
  durationMs: number;
}

const CHANGE_LOG_DDL = `
create table if not exists _schema_change_log (
  id            bigserial primary key,
  applied_at    timestamptz not null default now(),
  kind          text        not null,
  risk          text        not null,
  table_name    text        not null,
  object_name   text,
  description   text        not null,
  statements    text[]      not null,
  app_version   text,
  duration_ms   integer
)`;

function isAllowed(change: SchemaChange, mode: SyncMode): boolean {
  if (mode === 'force') return true;
  if (change.blockedReason) return false;
  if (change.risk === 'safe') return true;
  // `warn` changes add structure without deleting data (foreign keys, unique
  // constraints, indexes). They can fail on dirty data, but they cannot destroy
  // anything, so `safe` mode attempts them and reports failures clearly.
  return change.risk === 'warn' && mode === 'safe';
}

export interface SyncOptions {
  /** Lines describing work done just before the sync (removing old copies), written to the change log with it. */
  alreadyDone?: string[];
}

export async function syncSchema(
  pool: Pool,
  mode: SyncMode,
  appVersion = buildStamp(),
  options: SyncOptions = {},
): Promise<SyncResult> {
  const startedAt = Date.now();

  if (mode === 'off') {
    logger.warn('Schema sync is off — assuming the database already matches the code.');
    return { mode, applied: [], blocked: [], skipped: [], durationMs: 0 };
  }

  const client = await pool.connect();
  try {
    // The whole sync is one transaction holding a transaction-level lock. A
    // session lock would outlive a process killed mid-sync (a dev-server
    // restart) on a pooled connection and block every later sync; this one is
    // released by the database the moment the transaction or connection ends.
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [ADVISORY_LOCK_KEY.toString()]);

    try {
      await client.query(SET_SEARCH_PATH);
      if (mode !== 'verify') {
        // The schema must exist before anything is created: with nowhere on the
        // search_path to put it, a CREATE TABLE would fail — and in the past,
        // with another schema on the path, it quietly built a second copy there.
        await client.query(`create schema if not exists ${quoteIdent(APP_SCHEMA)}`);
        const prepared = await ensureExtensions(client);
        await client.query(CHANGE_LOG_DDL);
        for (const line of prepared) logger.info(`  applied  ${line}`);
        for (const line of [...(options.alreadyDone ?? []), ...prepared]) {
          await client.query(
            `insert into _schema_change_log (kind, risk, table_name, description, statements, app_version)
             values ('prepare', 'destructive', '*', $1, '{}', $2)`,
            [line, appVersion],
          );
        }
      }

      const live = await introspect(client, APP_SCHEMA);
      const changes = diffSchema(live);
      if (mode !== 'verify') await qualifyOperatorClasses(client, changes);

      if (changes.length === 0) {
        logger.info(
          { tables: allTables().length },
          'Database matches the application model. Nothing to change.',
        );
        await client.query('commit');
        return { mode, applied: [], blocked: [], skipped: [], durationMs: Date.now() - startedAt };
      }

      if (mode === 'verify') {
        logger.error({ count: changes.length }, 'Database does not match the application model.');
        for (const c of changes) logger.error(`  [${c.risk}] ${c.description}`);
        throw new Error(
          `Schema drift detected: ${changes.length} change(s) needed. Running in "verify" mode, so nothing was applied.`,
        );
      }

      const applied: SchemaChange[] = [];
      const blocked: SchemaChange[] = [];
      const skipped: SchemaChange[] = [];

      const allowed: SchemaChange[] = [];
      for (const change of changes) {
        if (isAllowed(change, mode)) allowed.push(change);
        else blocked.push(change);
      }

      // Changes are applied in batches inside one transaction. Against a remote
      // database the round trip dominates everything else — a first-run sync of
      // ~600 changes takes a quarter of an hour one-at-a-time and under a minute
      // batched. When a batch fails it is retried one change at a time, so a
      // single bad statement still gets isolated and reported precisely.
      for (let i = 0; i < allowed.length; i += BATCH_SIZE) {
        const batch = allowed.slice(i, i + BATCH_SIZE);
        if (await applyBatch(client, batch, appVersion)) {
          applied.push(...batch);
          continue;
        }
        for (const change of batch) {
          const ok = await applyChange(client, change, appVersion);
          (ok ? applied : skipped).push(change);
        }
      }

      for (const c of applied) logger.info(`  applied  ${c.description}`);
      for (const c of skipped) logger.warn(`  failed   ${c.description}`);
      for (const c of blocked) {
        logger.warn(`  blocked  [${c.risk}] ${c.description}`);
        if (c.blockedReason) logger.warn(`           reason: ${c.blockedReason}`);
      }

      logger.info(
        { applied: applied.length, blocked: blocked.length, failed: skipped.length },
        'Schema sync finished.',
      );

      await client.query('commit');
      return { mode, applied, blocked, skipped, durationMs: Date.now() - startedAt };
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * Index definitions name operator classes bare (gin_trgm_ops). Where the
 * extension providing one lives off the search_path — pg_trgm installed into
 * `public` — the index is created with the class named by its schema instead.
 * Indexes are compared by name, so this never shows up as drift.
 */
async function qualifyOperatorClasses(client: PoolClient, changes: SchemaChange[]): Promise<void> {
  for (const change of changes) {
    if (change.kind !== 'create_index' || !change.object) continue;
    const ix = getTable(change.table)?.indexes.find((i) => indexName(change.table, i) === change.object);
    if (!ix?.opclass) continue;
    const opclass = await qualifiedOpclass(client, ix.opclass, ix.method ?? 'btree');
    if (opclass !== ix.opclass) change.sql = [createIndexSql(change.table, { ...ix, opclass })];
  }
}

/** How many changes share one transaction on the fast path. */
const BATCH_SIZE = 25;

/**
 * Applies a whole batch under one savepoint. Returns false if anything in it
 * failed, in which case the caller falls back to applying them individually.
 * Nothing is logged here — a batch failure is expected and recoverable.
 */
async function applyBatch(client: PoolClient, batch: SchemaChange[], appVersion: string): Promise<boolean> {
  if (batch.length === 0) return true;
  const startedAt = Date.now();
  try {
    await client.query('savepoint sync_batch');
    for (const change of batch) {
      for (const statement of change.sql) await client.query(statement);
    }
    // One insert for the whole batch rather than one per change.
    const values: unknown[] = [];
    const tuples = batch.map((change) => {
      const base = values.length;
      values.push(
        change.kind, change.risk, change.table, change.object ?? null,
        change.description, change.sql, appVersion,
        Math.round((Date.now() - startedAt) / batch.length),
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
    });
    await client.query(
      `insert into _schema_change_log (kind, risk, table_name, object_name, description, statements, app_version, duration_ms)
       values ${tuples.join(', ')}`,
      values,
    );
    await client.query('release savepoint sync_batch');
    return true;
  } catch {
    await client.query('rollback to savepoint sync_batch').catch(() => undefined);
    return false;
  }
}

/**
 * The slow, precise path: one change, one savepoint, and a clear log line if
 * it fails. Used to isolate whichever statement broke a batch.
 */
async function applyChange(client: PoolClient, change: SchemaChange, appVersion: string): Promise<boolean> {
  const startedAt = Date.now();
  try {
    await client.query('savepoint sync_change');
    for (const statement of change.sql) await client.query(statement);
    await client.query(
      `insert into _schema_change_log (kind, risk, table_name, object_name, description, statements, app_version, duration_ms)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        change.kind,
        change.risk,
        change.table,
        change.object ?? null,
        change.description,
        change.sql,
        appVersion,
        Date.now() - startedAt,
      ],
    );
    await client.query('release savepoint sync_change');
    return true;
  } catch (error) {
    await client.query('rollback to savepoint sync_change').catch(() => undefined);
    logger.error(
      { err: error, table: change.table, sql: change.sql },
      `Could not apply: ${change.description}`,
    );
    return false;
  }
}

/**
 * Read-only: what WOULD change. Used by `npm run db:migrate`. `schema` is the
 * one to compare — swarnay_schema, or a copy about to be moved into it.
 */
export async function planSchema(pool: Pool, schema = APP_SCHEMA): Promise<SchemaChange[]> {
  const client = await pool.connect();
  try {
    // The compared schema first on the search_path, as during the sync itself,
    // so foreign keys within it print — and compare — without a schema prefix.
    await client.query('begin read only');
    await client.query(schema === APP_SCHEMA ? SET_SEARCH_PATH : `set local search_path to ${quoteIdent(schema)}, extensions`);
    return diffSchema(await introspect(client, schema));
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}
