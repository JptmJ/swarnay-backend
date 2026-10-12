/**
 * The registry is the single list of every table the application expects to
 * exist. Modules call `defineTable(...)` at import time; `bootstrap.ts` imports
 * every module, so by the time the server starts the registry is complete.
 */
import type { ColumnDef, ResolvedTable, TableDef } from './types.js';
import { col } from './columns.js';

const tables = new Map<string, ResolvedTable>();

/** Columns every tenant-scoped table gets for free. */
const tenantColumns = (): Record<string, ColumnDef> => ({
  tenant_id: {
    type: 'uuid',
    notNull: true,
    references: { table: 'tenant', column: 'id', onDelete: 'restrict' },
    comment: 'Owning tenant. Enforced by Row Level Security, not just by queries.',
  },
});

/** Columns every table gets when `timestamps` is on (the default). */
const auditColumns = (): Record<string, ColumnDef> => ({
  created_at: { type: 'timestamptz', notNull: true, default: 'now()' },
  updated_at: { type: 'timestamptz', notNull: true, default: 'now()' },
  created_by: { type: 'uuid' },
  updated_by: { type: 'uuid' },
});

/**
 * `default` is raw SQL, so a string literal has to carry its own quotes:
 * `default: "'draft'"`, not `default: 'draft'`. Get it wrong and Postgres reads
 * it as a column reference and the CREATE TABLE fails — but only once the DDL
 * actually runs, which on a remote database can be minutes into a sync. This
 * catches it the moment the module is imported instead.
 */
function assertDefaultIsSql(table: string, column: string, def: ColumnDef): void {
  if (def.default === undefined) return;
  const value = def.default.trim();

  const looksLiteral = /^'.*'$/s.test(value);
  const looksNumeric = /^-?\d+(\.\d+)?$/.test(value);
  const looksCall = /\(.*\)/s.test(value);
  const isKeyword = /^(null|true|false|current_date|current_timestamp)$/i.test(value);
  const isCast = value.includes('::');

  if (looksLiteral || looksNumeric || looksCall || isKeyword || isCast) return;

  throw new Error(
    `${table}.${column}: default "${value}" is not valid SQL. ` +
      `String defaults need their own quotes — write default: "'${value}'" instead of default: '${value}'.`,
  );
}

export function defineTable(def: TableDef): ResolvedTable {
  if (tables.has(def.name)) {
    throw new Error(
      `Table "${def.name}" is defined twice (modules: ${tables.get(def.name)!.module} and ${def.module}).`,
    );
  }

  const tenantScoped = def.tenantScoped ?? true;
  const timestamps = def.timestamps ?? true;
  const softDelete = def.softDelete ?? false;

  const columns: Record<string, ColumnDef> = {
    id: def.columns.id ?? col.uuidPk(),
    ...(tenantScoped ? tenantColumns() : {}),
    ...def.columns,
    ...(timestamps ? auditColumns() : {}),
    ...(softDelete ? { deleted_at: { type: 'timestamptz' as const } } : {}),
  };

  for (const [name, column] of Object.entries(columns)) assertDefaultIsSql(def.name, name, column);

  const indexes = (def.indexes ?? []).map((i) =>
    tenantScoped && !i.global && !i.columns.includes('tenant_id')
      ? { ...i, columns: ['tenant_id', ...i.columns] }
      : i,
  );
  // Every tenant index now leads with tenant_id, so a bare (tenant_id) index is redundant unless nothing else exists.
  if (tenantScoped && indexes.length === 0) indexes.unshift({ columns: ['tenant_id'] });

  // `unique: true` on a column is shorthand for a one-column unique constraint
  // (tenant.code, platform_user.email). It used to be dropped on the floor, so
  // the database never enforced it.
  const columnUniques = Object.entries(def.columns)
    .filter(([, column]) => column.unique)
    .map(([name]) => ({ columns: [name] }));

  // Tenant-scoped uniques must include tenant_id, otherwise two tenants could
  // never both have an invoice numbered "INV-001".
  const uniques = [...(def.uniques ?? []), ...columnUniques].map((u) =>
    tenantScoped && !u.columns.includes('tenant_id')
      ? { ...u, columns: ['tenant_id', ...u.columns] }
      : u,
  );

  const resolved: ResolvedTable = {
    name: def.name,
    module: def.module,
    tenantScoped,
    timestamps,
    softDelete,
    columns,
    indexes,
    uniques,
    checks: def.checks ?? [],
    comment: def.comment,
  };

  tables.set(def.name, resolved);
  return resolved;
}

export function allTables(): ResolvedTable[] {
  return [...tables.values()];
}

export function getTable(name: string): ResolvedTable | undefined {
  return tables.get(name);
}

export function clearRegistry(): void {
  tables.clear();
}

/**
 * Orders tables so a table is always created after the tables it points at.
 * Self-references are ignored (they resolve fine within a single CREATE TABLE).
 */
export function tablesInDependencyOrder(): ResolvedTable[] {
  const all = allTables();
  const byName = new Map(all.map((t) => [t.name, t]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: ResolvedTable[] = [];

  const visit = (t: ResolvedTable, trail: string[]): void => {
    if (done.has(t.name)) return;
    if (visiting.has(t.name)) {
      // A genuine cycle between two tables. We still emit them; the FKs are
      // added as separate ALTER statements after all tables exist.
      return;
    }
    visiting.add(t.name);
    for (const column of Object.values(t.columns)) {
      const target = column.references?.table;
      if (!target || target === t.name) continue;
      const dep = byName.get(target);
      if (dep) visit(dep, [...trail, t.name]);
    }
    visiting.delete(t.name);
    done.add(t.name);
    out.push(t);
  };

  for (const t of all) visit(t, []);
  return out;
}
