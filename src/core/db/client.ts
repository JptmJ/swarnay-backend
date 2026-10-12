/**
 * Every database call in the application goes through here.
 *
 * The important guarantee: a connection is handed out only inside a
 * transaction that has already had `SET LOCAL app.tenant_id` applied. `SET
 * LOCAL` is undone by COMMIT or ROLLBACK, so a connection can never go back to
 * the pool still carrying the last request's tenant. That is what makes
 * tenant leakage a structural impossibility rather than a code-review habit.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { pool } from './pool.js';
import { SET_SEARCH_PATH } from './search-path.js';
import { getContext, platformContext, requireContext, runWithContext } from '../context/request-context.js';
import type { RequestContext } from '../context/request-context.js';
import { logger } from '../util/logger.js';
import { NotFoundError } from '../errors/app-error.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} is not a valid UUID: ${value}`);
  return value;
}

export interface Tx {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]>;
  one<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T>;
  maybeOne<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null>;
  /** Escape hatch for COPY, cursors and anything else that needs the raw client. */
  raw: PoolClient;
  context: RequestContext;
}

function wrap(client: PoolClient, context: RequestContext): Tx {
  const query = async <T extends QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> => {
    const startedAt = Date.now();
    try {
      const result = await client.query<T>(text, params);
      const elapsed = Date.now() - startedAt;
      if (elapsed > 300) {
        logger.warn({ elapsed, sql: text.slice(0, 200), requestId: context.requestId }, 'Slow query');
      }
      return result.rows;
    } catch (error) {
      logger.error(
        { err: error, sql: text.slice(0, 500), params, requestId: context.requestId },
        'Query failed',
      );
      throw error;
    }
  };

  return {
    query,
    raw: client,
    context,
    async one<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T> {
      const rows = await query<T>(text, params);
      // Zero rows is the ordinary "it isn't there" case — including a row that
      // exists but belongs to another tenant, which RLS has filtered out. That
      // is a 404, not a server fault. More than one row genuinely is a bug.
      if (rows.length === 0) throw new NotFoundError('Record');
      if (rows.length > 1) throw new Error(`Expected at most 1 row, got ${rows.length}`);
      return rows[0]!;
    },
    async maybeOne<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<T | null> {
      const rows = await query<T>(text, params);
      if (rows.length > 1) throw new Error(`Expected at most 1 row, got ${rows.length}`);
      return rows[0] ?? null;
    },
  };
}

/**
 * Runs `fn` inside one database transaction, scoped to the current tenant.
 * Nested calls join the transaction already in progress rather than opening a
 * second one — so a service can call another service without either of them
 * having to know whether it is the outermost caller.
 */
const activeTx = new WeakMap<RequestContext, Tx>();

export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const context = requireContext();

  const existing = activeTx.get(context);
  if (existing) return fn(existing);

  const client = await pool.connect();
  const tenantId = assertUuid(context.tenantId, 'tenantId');

  try {
    // One round trip: open the transaction and pin the tenant onto it.
    // `tenantId` is UUID-validated above, so the literal is safe to inline.
    await client.query(
      context.bypassRls
        ? `begin; set local app.bypass_rls = 'on'; set local app.tenant_id = '${tenantId}'; ${SET_SEARCH_PATH};`
        : `begin; set local app.tenant_id = '${tenantId}'; ${SET_SEARCH_PATH};`,
    );

    const tx = wrap(client, context);
    activeTx.set(context, tx);

    const result = await fn(tx);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    activeTx.delete(context);
    client.release();
  }
}

/** Convenience for a single read that does not need an explicit transaction. */
export const query = <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T[]> =>
  transaction((tx) => tx.query<T>(text, params));

export const one = <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T> =>
  transaction((tx) => tx.one<T>(text, params));

export const maybeOne = <T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<T | null> =>
  transaction((tx) => tx.maybeOne<T>(text, params));

/**
 * Runs work that legitimately spans tenants — provisioning a new tenant,
 * a nightly job, the schema sync. Deliberately verbose to call.
 */
export function asPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const current = getContext();
  const context = platformContext(current?.requestId ?? 'platform');
  return runWithContext(context, () => transaction(fn));
}

/** Runs work for one specific tenant outside an HTTP request (jobs, seeds). */
export function asTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>, userId: string | null = null): Promise<T> {
  const context: RequestContext = {
    requestId: `job:${tenantId.slice(0, 8)}`,
    tenantId: assertUuid(tenantId, 'tenantId'),
    userId,
    branchId: null,
    roles: ['system'],
    permissions: new Set(['*']),
  };
  return runWithContext(context, () => transaction(fn));
}

/**
 * Re-scopes an open PLATFORM transaction to one tenant, on the same connection.
 * Used by provisioning, where the tenant row isn't committed yet — a separate
 * asTenant() transaction couldn't see it. repo() and RLS both see the tenant.
 */
export async function withTenant<T>(tx: Tx, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tx.context.bypassRls) throw new Error('withTenant() is only for platform transactions.');
  const id = assertUuid(tenantId, 'tenantId');
  const context: RequestContext = { ...tx.context, tenantId: id, bypassRls: false };

  await tx.raw.query(`set local app.tenant_id = '${id}'; set local app.bypass_rls = 'off';`);
  const scoped = wrap(tx.raw, context);
  activeTx.set(context, scoped);

  let ok = false;
  try {
    const result = await runWithContext(context, () => fn(scoped));
    ok = true;
    return result;
  } finally {
    activeTx.delete(context);
    // After an error the transaction is aborted and will roll back — don't mask the real error.
    if (ok) {
      await tx.raw.query(
        `set local app.tenant_id = '${assertUuid(tx.context.tenantId, 'tenantId')}'; set local app.bypass_rls = 'on';`,
      );
    }
  }
}

