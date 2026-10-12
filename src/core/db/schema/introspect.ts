/** Reads what the database actually looks like right now. */
import type { PoolClient } from 'pg';
import type { LiveSchema, LiveTable } from './types.js';

/**
 * Postgres reports types under several spellings. We normalise to exactly the
 * spellings used in `SqlType` so the diff compares like with like.
 */
export function normaliseType(dataType: string, precision: number | null, scale: number | null): string {
  const t = dataType.toLowerCase();
  switch (t) {
    case 'character varying':
    case 'varchar':
    case 'text':
      return 'text';
    case 'timestamp with time zone':
      return 'timestamptz';
    case 'timestamp without time zone':
      return 'timestamp';
    case 'boolean':
      return 'boolean';
    case 'integer':
    case 'int4':
      return 'integer';
    case 'bigint':
    case 'int8':
      return 'bigint';
    case 'numeric':
    case 'decimal':
      return precision !== null ? `numeric(${precision},${scale ?? 0})` : 'numeric';
    default:
      return t;
  }
}

/**
 * Defaults come back with casts attached (`'draft'::text`). Strip them so a
 * default we wrote as `'draft'` doesn't look like a change on every boot.
 */
export function normaliseDefault(raw: string | null): string | null {
  if (raw === null) return null;
  let value = raw.trim();
  value = value.replace(/::[a-zA-Z_ ]+(\([0-9, ]*\))?$/, '').trim();
  if (value.toLowerCase() === 'now()' || value.toLowerCase() === "('now'::text)") return 'now()';
  if (value.toLowerCase() === 'current_date') return 'current_date';
  if (value.toLowerCase() === 'current_timestamp') return 'current_timestamp';
  return value;
}

export async function introspect(client: PoolClient, schema: string): Promise<LiveSchema> {
  const live: LiveSchema = new Map();

  const tableRows = await client.query<{ table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `select c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relkind = 'r'`,
    [schema],
  );

  for (const row of tableRows.rows) {
    const table: LiveTable = {
      name: row.table_name,
      columns: new Map(),
      constraints: new Map(),
      indexes: new Map(),
      rlsEnabled: row.relrowsecurity,
      rlsForced: row.relforcerowsecurity,
      policies: new Set(),
    };
    live.set(row.table_name, table);
  }

  const columnRows = await client.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    numeric_precision: number | null;
    numeric_scale: number | null;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select table_name, column_name, data_type, numeric_precision, numeric_scale,
            is_nullable, column_default
       from information_schema.columns
      where table_schema = $1`,
    [schema],
  );

  for (const row of columnRows.rows) {
    const table = live.get(row.table_name);
    if (!table) continue;
    table.columns.set(row.column_name, {
      name: row.column_name,
      type: normaliseType(row.data_type, row.numeric_precision, row.numeric_scale),
      notNull: row.is_nullable === 'NO',
      default: normaliseDefault(row.column_default),
    });
  }

  const constraintRows = await client.query<{
    table_name: string;
    constraint_name: string;
    contype: 'p' | 'f' | 'u' | 'c';
    definition: string;
  }>(
    `select rel.relname as table_name, con.conname as constraint_name,
            con.contype, pg_get_constraintdef(con.oid) as definition
       from pg_constraint con
       join pg_class rel on rel.oid = con.conrelid
       join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = $1`,
    [schema],
  );

  for (const row of constraintRows.rows) {
    const table = live.get(row.table_name);
    if (!table) continue;
    table.constraints.set(row.constraint_name, {
      name: row.constraint_name,
      kind: row.contype,
      definition: row.definition,
    });
  }

  const indexRows = await client.query<{ tablename: string; indexname: string; indexdef: string }>(
    `select tablename, indexname, indexdef from pg_indexes where schemaname = $1`,
    [schema],
  );

  for (const row of indexRows.rows) {
    const table = live.get(row.tablename);
    if (!table) continue;
    table.indexes.set(row.indexname, {
      name: row.indexname,
      definition: row.indexdef,
      // Indexes that exist only to back a PK/UNIQUE constraint must never be
      // dropped directly — the constraint owns them.
      isConstraintBacked: table.constraints.has(row.indexname),
    });
  }

  const policyRows = await client.query<{ tablename: string; policyname: string }>(
    `select tablename, policyname from pg_policies where schemaname = $1`,
    [schema],
  );

  for (const row of policyRows.rows) {
    live.get(row.tablename)?.policies.add(row.policyname);
  }

  return live;
}
