/**
 * Running an import: stage the file, match its columns, check every row, bring
 * the good ones in, and take them back out again if asked.
 *
 * The super admin does this for a shop from the console. A file can be tens of
 * thousands of rows, so checking, importing and undoing run as jobs in the
 * background and the console polls the batch for progress. Each job works in
 * chunks, each chunk one transaction in which the records are written and the
 * rows are marked — so a row marked imported always has its record, and a job
 * cut short by a restart carries on from the first row not yet marked.
 *
 * A chunk that fails is rolled back and tried again one row at a time, so one
 * bad row costs only itself: it is marked failed with the reason, and the rest
 * go in.
 */
import type { Tx } from '../../core/db/client.js';
import { asPlatform, asTenant } from '../../core/db/client.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { newId } from '../../core/util/id.js';
import { logger } from '../../core/util/logger.js';
import { lockReason } from '../accounts/ledger.service.js';
import { audit } from '../platform/platform-auth.service.js';
import { ENTITIES, entityFor } from './entities/index.js';
import { Lookups } from './lookups.js';
import { hasErrors, mapRow, suggestMapping } from './mapping.js';
import { DATE_FORMATS, WEIGHT_UNITS, normKey } from './normalize.js';
import type { CommitResult, EntityDef, ImportedRow, Issue, JobContext, LookupKind, Mapping, PreparedRow, ValueMap } from './types.js';

export const MAX_ROWS_PER_CALL = 1000;
export const MAX_ROWS_PER_BATCH = 200_000;
const MAX_COLUMNS = 300;
const MAX_CELL = 2000;

export interface BatchRow {
  id: string; entity: string; title: string; status: string;
  source_name: string | null; source_format: string | null; source_system: string | null; sheet_name: string | null;
  columns: string[]; mapping: Mapping; value_map: ValueMap; options: Record<string, unknown>;
  row_count: number; valid_count: number; invalid_count: number; warning_count: number; skipped_count: number;
  imported_count: number; failed_count: number; undone_count: number; progress: number;
  validation: Record<string, unknown> | null; result: Record<string, unknown> | null; error: string | null;
  validated_at: string | null; started_at: string | null; finished_at: string | null; undone_at: string | null;
  operator_id: string; operator_name: string | null; created_at: string; updated_at: string;
}

interface Operator { id: string; name: string | null; ip?: string }

/* ================================================================ jobs */

type JobKind = 'validate' | 'import' | 'undo';
/** Jobs running in this process, by batch. A batch marked running with no job here was cut short by a restart. */
const jobs = new Map<string, { kind: JobKind; tenantId: string; stop: boolean }>();
/** One job per business at a time: an import's order matters, and two at once would only fight over the same rows. */
const busyTenants = new Map<string, string>();

const RUNNING = new Set(['validating', 'importing', 'undoing']);

export const isRunning = (batchId: string) => jobs.has(batchId);

/* ============================================================== access */

async function tenantExists(tenantId: string): Promise<{ code: string; display_name: string }> {
  const t = await asPlatform((tx) => tx.maybeOne<{ code: string; display_name: string }>(
    `select code, display_name from tenant where id = $1 and deleted_at is null`, [tenantId]));
  if (!t) throw new NotFoundError('Tenant', tenantId);
  return t;
}

async function loadBatch(tx: Tx, batchId: string, lock = false): Promise<BatchRow> {
  const b = await tx.maybeOne<BatchRow>(`select * from import_batch where id = $1${lock ? ' for update' : ''}`, [batchId]);
  if (!b) throw new NotFoundError('Import', batchId);
  return b;
}

const entityOf = (b: BatchRow): EntityDef => {
  const e = entityFor(b.entity);
  if (!e) throw new BusinessRuleError(`This import is for "${b.entity}", which is no longer offered.`, 'import_kind_unknown');
  return e;
};

/**
 * What the console shows of a batch: the row, whether a job is on it now, and whether one was cut short.
 *
 * `job` must be read BEFORE the row. A job lets go of its batch only after its last write has
 * committed, so a job seen as gone means the row read afterwards is final. Read the other way
 * round, a job finishing in between pairs a stale "validating" row with running: false.
 */
type JobState = { kind: JobKind; stop: boolean } | undefined;
function present(b: BatchRow, job: JobState) {
  return { ...b, running: Boolean(job), stopping: job?.stop ?? false, interrupted: RUNNING.has(b.status) && !job };
}
const jobState = (batchId: string): JobState => {
  const job = jobs.get(batchId);
  return job ? { kind: job.kind, stop: job.stop } : undefined;
};

/* ============================================================== batches */

export async function listBatches(tenantId: string, q: { entity?: string; limit?: number; offset?: number }) {
  await tenantExists(tenantId);
  const live = new Map([...jobs].map(([id]) => [id, jobState(id)]));
  return asTenant(tenantId, async (tx) => {
    const params: unknown[] = [];
    let where = '';
    if (q.entity) { params.push(q.entity); where = `where entity = $1`; }
    const rows = await tx.query<BatchRow>(
      `select id, entity, title, status, source_name, source_format, source_system, row_count, valid_count, invalid_count,
              warning_count, skipped_count, imported_count, failed_count, undone_count, progress, error, operator_name,
              validated_at, started_at, finished_at, undone_at, created_at, updated_at
         from import_batch ${where} order by created_at desc limit ${Number(q.limit ?? 100)} offset ${Number(q.offset ?? 0)}`, params);
    // What has been brought over so far, kind by kind, for the console's checklist.
    const done = await tx.query<{ entity: string; imported: number; batches: number }>(
      `select entity, coalesce(sum(imported_count) filter (where status <> 'undone'), 0)::int as imported, count(*)::int as batches
         from import_batch group by entity`);
    return { rows: rows.map((r) => present(r, live.get(r.id))), progress: Object.fromEntries(done.map((d) => [d.entity, { imported: d.imported, batches: d.batches }])) };
  });
}

export async function batchDetail(tenantId: string, batchId: string) {
  await tenantExists(tenantId);
  const job = jobState(batchId);
  return asTenant(tenantId, async (tx) => {
    const b = await loadBatch(tx, batchId);
    const counts = await tx.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from import_row where batch_id = $1 group by status`, [batchId]);
    const sample = await tx.query<{ row_number: number; data: Record<string, unknown> }>(
      `select row_number, data from import_row where batch_id = $1 order by row_number limit 5`, [batchId]);
    return { ...present(b, job), statusCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])), sample };
  });
}

export interface CreateBatchInput {
  entity: string; title?: string; sourceName?: string; sourceFormat?: string; sourceSystem?: string; sheetName?: string;
  columns: string[]; options?: Record<string, unknown>;
}

export async function createBatch(tenantId: string, op: Operator, input: CreateBatchInput) {
  const tenant = await tenantExists(tenantId);
  const entity = entityFor(input.entity);
  if (!entity) throw new ValidationError(`"${input.entity}" is not something that can be imported.`);
  const columns = input.columns.map((c) => String(c ?? '').trim());
  if (!columns.length) throw new ValidationError('The file has no columns.');
  if (columns.length > MAX_COLUMNS) throw new ValidationError(`The file has ${columns.length} columns; at most ${MAX_COLUMNS} can be read.`);
  const dupes = columns.filter((c, i) => c && columns.indexOf(c) !== i);
  if (dupes.length) throw new ValidationError(`Two columns share the heading "${dupes[0]}". Rename one of them in the file.`);
  if (columns.some((c) => !c)) throw new ValidationError('A column has no heading. Give every column a heading in the first row.');
  const options = parseOptions(entity, input.options ?? {});
  const mapping = suggestMapping(entity, columns);
  const title = input.title?.trim() || `${entity.label}${input.sourceName ? ` from ${input.sourceName}` : ''}`;

  const batch = await asTenant(tenantId, (tx) => tx.one<BatchRow>(
    `insert into import_batch (id, tenant_id, entity, title, source_name, source_format, source_system, sheet_name, columns,
                               mapping, options, operator_id, operator_name)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
    [newId(), tenantId, entity.key, title.slice(0, 200), input.sourceName ?? null, input.sourceFormat ?? null,
     input.sourceSystem?.trim() || null, input.sheetName ?? null, JSON.stringify(columns), JSON.stringify(mapping),
     JSON.stringify(options), op.id, op.name]));
  await asPlatform((tx) => audit(tx, op.id, 'import.create', {
    tenantId, targetType: 'import_batch', targetId: batch.id, ip: op.ip,
    changes: { entity: entity.key, title, source: input.sourceName, tenant: tenant.code },
  }));
  return present(batch, undefined);
}

function parseOptions(entity: EntityDef, raw: Record<string, unknown>): Record<string, unknown> {
  const parsed = entity.options.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new ValidationError(`Option ${issue.path.join('.')}: ${issue.message}`,
      parsed.error.issues.map((i) => ({ field: `options.${i.path.join('.')}`, message: i.message })));
  }
  return parsed.data;
}

/** A row's cells, trimmed to what the import can use. */
function cleanCells(data: Record<string, unknown>): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(data).slice(0, MAX_COLUMNS)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v).slice(0, MAX_CELL);
  }
  return out;
}

export async function appendRows(tenantId: string, batchId: string, rows: Record<string, unknown>[], firstRow: number) {
  await tenantExists(tenantId);
  return asTenant(tenantId, async (tx) => {
    const b = await loadBatch(tx, batchId, true);
    if (!['draft', 'validated'].includes(b.status)) {
      throw new BusinessRuleError('Rows can only be added before the import starts.', 'import_locked');
    }
    if (b.row_count + rows.length > MAX_ROWS_PER_BATCH) {
      throw new BusinessRuleError(`One import takes at most ${MAX_ROWS_PER_BATCH.toLocaleString('en-IN')} rows. Split the file.`, 'import_too_large');
    }
    // Sending the same chunk twice (a retry after a dropped connection) replaces it rather than doubling it.
    await tx.query(
      `insert into import_row (id, tenant_id, batch_id, row_number, data)
       select gen_random_uuid(), $1, $2, x.n, x.d
         from jsonb_to_recordset($3::jsonb) as x(n int, d jsonb)
       on conflict (tenant_id, batch_id, row_number) do update set data = excluded.data, status = 'pending', messages = '[]'::jsonb, updated_at = now()`,
      [tenantId, batchId, JSON.stringify(rows.map((r, i) => ({ n: firstRow + i, d: cleanCells(r) })))]);
    const counted = await tx.one<{ n: number }>(`select count(*)::int as n from import_row where batch_id = $1`, [batchId]);
    await tx.query(`update import_batch set row_count = $2, status = 'draft', updated_at = now() where id = $1`, [batchId, counted.n]);
    return { received: rows.length, rowCount: counted.n };
  });
}

export interface UpdateBatchInput { title?: string; sourceSystem?: string | null; mapping?: Mapping; valueMap?: ValueMap; options?: Record<string, unknown> }

export async function updateBatch(tenantId: string, batchId: string, patch: UpdateBatchInput) {
  await tenantExists(tenantId);
  return asTenant(tenantId, async (tx) => {
    const b = await loadBatch(tx, batchId, true);
    if (jobs.has(batchId)) throw new BusinessRuleError('Wait for the running job to finish.', 'import_busy');
    const entity = entityOf(b);
    const changesData = patch.mapping !== undefined || patch.valueMap !== undefined || patch.options !== undefined;
    if (changesData && (b.imported_count > 0 || ['importing', 'imported', 'partial', 'undoing', 'undone'].includes(b.status))) {
      throw new BusinessRuleError('Rows have been imported from this file, so its matching and options are fixed. Undo it to change them, or fix single rows.', 'import_locked');
    }
    const sets: string[] = [];
    const params: unknown[] = [batchId];
    const set = (col: string, value: unknown) => { params.push(value); sets.push(`${col} = $${params.length}`); };
    if (patch.title !== undefined) set('title', patch.title.trim().slice(0, 200) || b.title);
    if (patch.sourceSystem !== undefined) set('source_system', patch.sourceSystem?.trim() || null);
    if (patch.mapping !== undefined) set('mapping', JSON.stringify(checkMapping(entity, b.columns, patch.mapping)));
    if (patch.valueMap !== undefined) set('value_map', JSON.stringify(checkValueMap(entity, patch.valueMap)));
    if (patch.options !== undefined) set('options', JSON.stringify(parseOptions(entity, { ...b.options, ...patch.options })));
    if (changesData) { sets.push(`status = 'draft'`, `validation = null`, `validated_at = null`); }
    if (!sets.length) return present(b, undefined);
    const updated = await tx.one<BatchRow>(`update import_batch set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, params);
    return present(updated, undefined);
  });
}

function checkMapping(entity: EntityDef, columns: string[], mapping: Mapping): Mapping {
  const out: Mapping = {};
  for (const [key, entry] of Object.entries(mapping)) {
    const field = entity.fields.find((f) => f.key === key);
    if (!field) throw new ValidationError(`"${key}" is not a field of ${entity.label}.`);
    if (!entry || (!entry.column && !entry.constant)) continue;
    if (entry.column && !columns.includes(entry.column)) throw new ValidationError(`The file has no column "${entry.column}".`);
    if (entry.unit && !WEIGHT_UNITS.includes(entry.unit)) throw new ValidationError(`"${entry.unit}" is not a weight unit.`);
    if (entry.format && !DATE_FORMATS.includes(entry.format)) throw new ValidationError(`"${entry.format}" is not a date format.`);
    out[key] = {
      ...(entry.column ? { column: entry.column } : { constant: String(entry.constant).slice(0, 500) }),
      ...(entry.unit ? { unit: entry.unit } : {}), ...(entry.format ? { format: entry.format } : {}), ...(entry.negate ? { negate: true } : {}),
    };
  }
  return out;
}

function checkValueMap(entity: EntityDef, valueMap: ValueMap): ValueMap {
  const out: ValueMap = {};
  for (const [field, values] of Object.entries(valueMap)) {
    if (!entity.fields.some((f) => f.key === field)) throw new ValidationError(`"${field}" is not a field of ${entity.label}.`);
    const clean = Object.fromEntries(Object.entries(values ?? {}).filter(([, to]) => typeof to === 'string' && to.trim()).map(([from, to]) => [normKey(from), to.trim()]));
    if (Object.keys(clean).length) out[field] = clean;
  }
  return out;
}

export async function listRows(tenantId: string, batchId: string, q: { status?: string; search?: string; level?: string; limit?: number; offset?: number }) {
  await tenantExists(tenantId);
  return asTenant(tenantId, async (tx) => {
    await loadBatch(tx, batchId);
    const clauses = ['batch_id = $1'];
    const params: unknown[] = [batchId];
    if (q.status) {
      params.push(q.status.split(','));
      clauses.push(`status = any($${params.length}::text[])`);
    }
    if (q.level === 'warning') clauses.push(`messages @> '[{"level":"warning"}]'`);
    if (q.search) {
      params.push(`%${q.search}%`);
      clauses.push(`(label ilike $${params.length} or data::text ilike $${params.length} or messages::text ilike $${params.length})`);
    }
    const where = clauses.join(' and ');
    const [rows, total] = await Promise.all([
      tx.query(
        `select id, row_number, data, status, action, messages, label, target_table, target_id, skip_requested, imported_at
           from import_row where ${where} order by row_number limit ${Number(q.limit ?? 50)} offset ${Number(q.offset ?? 0)}`, params),
      tx.one<{ n: number }>(`select count(*)::int as n from import_row where ${where}`, params),
    ]);
    return { rows, total: total.n, limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0) };
  });
}

/** Fixes a row's cells, or leaves it out. The file then needs checking again before it is imported. */
export async function editRow(tenantId: string, batchId: string, rowNumber: number, input: { data?: Record<string, unknown>; skip?: boolean }) {
  await tenantExists(tenantId);
  return asTenant(tenantId, async (tx) => {
    const b = await loadBatch(tx, batchId, true);
    if (jobs.has(batchId)) throw new BusinessRuleError('Wait for the running job to finish.', 'import_busy');
    if (['undoing', 'undone'].includes(b.status)) throw new BusinessRuleError('This import has been undone.', 'import_locked');
    const row = await tx.maybeOne<{ id: string; status: string; data: Record<string, unknown> }>(
      `select id, status, data from import_row where batch_id = $1 and row_number = $2 for update`, [batchId, rowNumber]);
    if (!row) throw new NotFoundError('Row', String(rowNumber));
    if (['imported', 'undone'].includes(row.status)) throw new BusinessRuleError('This row is already imported. Change the record itself in the shop.', 'row_imported');
    const data = input.data ? cleanCells({ ...row.data, ...input.data }) : row.data;
    const skip = input.skip ?? false;
    const updated = await tx.one(
      `update import_row set data = $2, skip_requested = $3, status = $4, messages = $5, action = null, updated_at = now()
        where id = $1 returning id, row_number, data, status, action, messages, label, skip_requested`,
      [row.id, JSON.stringify(data), skip, skip ? 'skipped' : 'pending',
       JSON.stringify(skip ? [{ level: 'warning', message: 'Left out by the operator.' }] : [])]);
    await tx.query(
      `update import_batch set status = case when imported_count > 0 then 'partial' else 'draft' end, updated_at = now() where id = $1`, [batchId]);
    await refreshCounts(tx, batchId);
    return updated;
  });
}

/** Removes a staged file. One with rows already imported is undone instead, so its history stays. */
export async function deleteBatch(tenantId: string, batchId: string, op: Operator) {
  await tenantExists(tenantId);
  const b = await asTenant(tenantId, async (tx) => {
    const batch = await loadBatch(tx, batchId, true);
    if (jobs.has(batchId)) throw new BusinessRuleError('Wait for the running job to finish.', 'import_busy');
    if (batch.imported_count > 0 || ['importing', 'imported', 'partial', 'undoing', 'undone'].includes(batch.status)) {
      throw new BusinessRuleError('Rows from this file were imported. Undo the import instead — it keeps the record of what was done.', 'import_locked');
    }
    await tx.query(`delete from import_batch where id = $1`, [batchId]);
    return batch;
  });
  await asPlatform((tx) => audit(tx, op.id, 'import.delete', {
    tenantId, targetType: 'import_batch', targetId: batchId, ip: op.ip, changes: { entity: b.entity, title: b.title, rows: b.row_count },
  }));
}

/** Lists the shop's own records for the value panel: which purity "22CT" means, which ledger "Cash A/c" is. */
export async function choices(tenantId: string, kind: LookupKind, search?: string) {
  await tenantExists(tenantId);
  return asTenant(tenantId, async (tx) => {
    const like = search ? `%${search}%` : null;
    const q = (sql: string, params: unknown[] = []) => tx.query<{ id: string; label: string; hint: string | null }>(sql, params);
    switch (kind) {
      case 'metal': return q(`select id, name as label, code as hint from metal where is_active order by sort_order`);
      case 'purity': return q(`select p.id, m.name || ' ' || p.code as label, p.fineness_percent::text || '%' as hint
                                 from purity p join metal m on m.id = p.metal_id where p.is_active order by m.sort_order, p.sort_order`);
      case 'category': return q(`select id, name as label, code as hint from item_category where ($1::text is null or name ilike $1 or code ilike $1) order by name limit 500`, [like]);
      case 'item': return q(`select id, name as label, code as hint from item where deleted_at is null and ($1::text is null or name ilike $1 or code ilike $1) order by name limit 200`, [like]);
      case 'branch': return q(`select id, name as label, code as hint from branch where deleted_at is null and is_active order by code`);
      case 'location': return q(`select l.id, b.code || ' · ' || l.name as label, l.kind as hint from stock_location l join branch b on b.id = l.branch_id
                                  where l.deleted_at is null and l.is_active and l.kind <> 'transit' order by b.code, l.name`);
      case 'party': return q(`select id, name as label, code || coalesce(' · ' || phone, '') as hint from party
                                where deleted_at is null and code <> 'WALKIN' and ($1::text is null or name ilike $1 or code ilike $1 or phone ilike $1)
                                order by name limit 200`, [like]);
      case 'karigar': return q(`select id, name as label, code as hint from karigar where deleted_at is null and ($1::text is null or name ilike $1 or code ilike $1) order by name limit 200`, [like]);
      case 'plan': return q(`select id, name as label, code as hint from scheme_plan where deleted_at is null order by name`);
      case 'account': return q(`select a.id, a.name as label, a.code || coalesce(' · ' || g.name, '') as hint from account a left join account g on g.id = a.parent_id
                                  where a.deleted_at is null and not a.is_group and ($1::text is null or a.name ilike $1 or a.code ilike $1) order by a.code limit 500`, [like]);
    }
  });
}

/* ============================================================ running jobs */

async function setBatch(tenantId: string, batchId: string, sets: Record<string, unknown>) {
  const keys = Object.keys(sets);
  await asTenant(tenantId, (tx) => tx.query(
    `update import_batch set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`,
    [batchId, ...keys.map((k) => { const v = sets[k]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; })]));
}

async function refreshCounts(tx: Tx, batchId: string) {
  await tx.query(
    `update import_batch b set
        row_count = c.total, valid_count = c.valid, invalid_count = c.invalid, skipped_count = c.skipped,
        imported_count = c.imported, failed_count = c.failed, undone_count = c.undone, warning_count = c.warnings, updated_at = now()
       from (select count(*)::int as total,
                    count(*) filter (where status = 'valid')::int as valid,
                    count(*) filter (where status = 'invalid')::int as invalid,
                    count(*) filter (where status = 'skipped')::int as skipped,
                    count(*) filter (where status = 'imported')::int as imported,
                    count(*) filter (where status = 'failed')::int as failed,
                    count(*) filter (where status = 'undone')::int as undone,
                    count(*) filter (where messages @> '[{"level":"warning"}]' and status not in ('invalid', 'failed'))::int as warnings
               from import_row where batch_id = $1) c
      where b.id = $1`, [batchId]);
}

/** The context a job's rows are read and written with. */
async function makeContext(tx: Tx, b: BatchRow, entity: EntityDef, mode: 'validate' | 'commit') {
  const today = await businessDate(tx);
  const unknown = new Map<string, Map<string, { count: number; rows: number[] }>>();
  const created = new Map<string, Set<string>>();
  const totals = new Map<string, Decimal>();
  const ctx: JobContext = {
    tenantId: tx.context.tenantId, batchId: b.id, title: b.title, mode, options: b.options,
    asOf: (b.options.asOf as string | undefined) ?? today, today,
    lookups: await Lookups.load(tx, entity.needs),
    seen: new Map(), memo: new Map(),
    unknown(field, value, rowNumber) {
      const byValue = unknown.get(field) ?? new Map();
      const hit = byValue.get(value) ?? { count: 0, rows: [] };
      hit.count += 1;
      if (hit.rows.length < 5 && rowNumber) hit.rows.push(rowNumber);
      byValue.set(value, hit);
      unknown.set(field, byValue);
    },
    willCreate(kind, key) { created.set(kind, (created.get(kind) ?? new Set()).add(key)); },
    total(key, value) { totals.set(key, add(totals.get(key) ?? '0', value)); },
  };
  if (ctx.asOf > today) throw new BusinessRuleError(`The cut-over date ${ctx.asOf} is in the future.`, 'import_as_of_future');
  const summary = () => ({
    unknown: [...unknown].flatMap(([field, values]) => {
      const def = entity.fields.find((f) => f.key === field);
      return [...values].sort((a, b) => b[1].count - a[1].count).slice(0, 200).map(([value, v]) => ({
        field, label: def?.label ?? field, lookup: def?.lookup ?? (def?.type === 'enum' ? 'enum' : null), value, count: v.count, rows: v.rows,
      }));
    }),
    willCreate: Object.fromEntries([...created].map(([k, v]) => [k, v.size])),
    totals: Object.fromEntries(totals),
  });
  return { ctx, summary };
}

const friendly = (error: unknown): string => {
  const e = error as { code?: string; message?: string; constraint?: string; detail?: string };
  if (error instanceof BusinessRuleError || error instanceof ValidationError || error instanceof NotFoundError) return e.message!;
  if (e.code === '23505') return `Something with the same code or number already exists${e.constraint ? ` (${e.constraint})` : ''}.`;
  if (e.code === '23503') return 'It points at a record that does not exist.';
  if (e.code === '23514') return `A value is outside what is allowed${e.constraint ? ` (${e.constraint})` : ''}.`;
  if (e.code === '23502') return `A required value is missing${e.detail ? `: ${e.detail}` : ''}.`;
  if (e.code === '22P02' || e.code === '22003') return 'A number or date in the row could not be stored.';
  return e.message ?? String(error);
};

/** Writes a chunk's outcome onto its rows in one statement. */
async function markRows(tx: Tx, updates: Array<{
  id: string; status: string; action?: string | null; messages: Issue[]; label?: string | null;
  target_table?: string | null; target_id?: string | null; before?: unknown; after?: unknown; imported?: boolean;
}>) {
  if (!updates.length) return;
  await tx.query(
    `update import_row r set status = x.status, action = x.action, messages = coalesce(x.messages, '[]'::jsonb), label = coalesce(x.label, r.label),
            target_table = coalesce(x.target_table, r.target_table), target_id = coalesce(x.target_id, r.target_id),
            before = coalesce(x.before, r.before), after = coalesce(x.after, r.after),
            imported_at = case when x.imported then now() else r.imported_at end, updated_at = now()
       from jsonb_to_recordset($1::jsonb) as x(id uuid, status text, action text, messages jsonb, label text, target_table text,
                                               target_id uuid, before jsonb, after jsonb, imported boolean)
      where r.id = x.id`,
    [JSON.stringify(updates.map((u) => ({ ...u, action: u.action ?? null, label: u.label ?? null, before: u.before ?? null, after: u.after ?? null, imported: u.imported ?? false })))]);
}

function claim(tenantId: string, batchId: string, kind: JobKind) {
  if (jobs.has(batchId)) throw new BusinessRuleError('Something is already running on this import.', 'import_busy');
  const other = busyTenants.get(tenantId);
  if (other) throw new BusinessRuleError('Another import for this business is running. Wait for it to finish — imports go in one at a time.', 'import_busy');
  jobs.set(batchId, { kind, tenantId, stop: false });
  busyTenants.set(tenantId, batchId);
}
function release(tenantId: string, batchId: string) {
  jobs.delete(batchId);
  if (busyTenants.get(tenantId) === batchId) busyTenants.delete(tenantId);
}

/** Asks an import to stop after the chunk in hand. What went in stays; the rest can be imported later. */
export function stopJob(batchId: string) {
  const job = jobs.get(batchId);
  if (!job) throw new BusinessRuleError('Nothing is running on this import.', 'import_not_running');
  job.stop = true;
}

/* -------------------------------------------------------------- checking */

export async function startValidation(tenantId: string, batchId: string, op: Operator) {
  await tenantExists(tenantId);
  const b = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
  if (['undoing', 'undone'].includes(b.status)) {
    throw new BusinessRuleError(b.status === 'undone' ? 'This import has been undone.' : 'This import is being undone; finish the undo first.', 'import_locked');
  }
  if (b.row_count === 0) throw new BusinessRuleError('The file has no rows yet.', 'import_empty');
  claim(tenantId, batchId, 'validate');
  void runValidation(tenantId, batchId, op).finally(() => release(tenantId, batchId));
  return batchDetail(tenantId, batchId);
}

async function runValidation(tenantId: string, batchId: string, op: Operator) {
  try {
    const b = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
    const entity = entityOf(b);
    await setBatch(tenantId, batchId, { status: 'validating', progress: 0, error: null });
    let prepared: Awaited<ReturnType<typeof makeContext>> | null = null;
    let after = 0;
    let done = 0;
    for (;;) {
      const finished = await asTenant(tenantId, async (tx) => {
        prepared ??= await makeContext(tx, b, entity, 'validate');
        const { ctx } = prepared;
        if (done === 0 && entity.posts) {
          const branch = ctx.lookups.mainBranch() ?? (await tx.maybeOne<{ id: string }>(`select id from branch where is_active and deleted_at is null limit 1`));
          const locked = branch ? await lockReason(tx, branch.id, ctx.asOf, 'opening') : null;
          if (locked) throw new BusinessRuleError(`${locked.message} Pick another cut-over date in the options.`, locked.code);
        }
        const rows = await tx.query<{ id: string; row_number: number; data: Record<string, unknown>; skip_requested: boolean }>(
          `select id, row_number, data, skip_requested from import_row
            where batch_id = $1 and row_number > $2 and status not in ('imported', 'undone')
            order by row_number limit ${entity.chunk}`, [batchId, after]);
        if (!rows.length) return true;
        after = rows[rows.length - 1]!.row_number;
        const live = rows.filter((r) => !r.skip_requested);
        // Checking never writes: whatever a kind does while preparing is rolled back before the rows are marked.
        await tx.query('savepoint import_check');
        const results = await entity.prepare(tx, live.map((r) => mapRow(entity, r, b.mapping, b.value_map)), ctx);
        await tx.query('rollback to savepoint import_check');
        await markRows(tx, [
          ...rows.filter((r) => r.skip_requested).map((r) => ({ id: r.id, status: 'skipped', messages: [{ level: 'warning' as const, message: 'Left out by the operator.' }] })),
          ...results.map((p) => ({
            id: p.row.id, action: p.action, label: p.label ?? null, messages: p.issues,
            status: hasErrors(p.issues) ? 'invalid' : p.action === 'skip' ? 'skipped' : 'valid',
          })),
        ]);
        done += rows.length;
        await tx.query(`update import_batch set progress = $2, updated_at = now() where id = $1`, [batchId, done]);
        return false;
      });
      if (finished) break;
    }
    await asTenant(tenantId, async (tx) => {
      await refreshCounts(tx, batchId);
      const imported = await tx.one<{ n: number }>(`select count(*)::int as n from import_row where batch_id = $1 and status = 'imported'`, [batchId]);
      const summary = prepared ? (prepared as { summary: () => Record<string, unknown> }).summary() : {};
      await tx.query(
        `update import_batch set status = $2, validation = $3, validated_at = now(), progress = $4, updated_at = now() where id = $1`,
        [batchId, imported.n > 0 ? 'partial' : 'validated', JSON.stringify(summary), done]);
    });
  } catch (error) {
    logger.error({ err: error, batchId, tenantId }, 'Import check failed');
    await setBatch(tenantId, batchId, { status: 'draft', error: friendly(error) })
      .catch((e) => logger.error({ err: e, batchId }, 'Could not record why the import check stopped'));
  }
  void op;
}

/* ------------------------------------------------------------- importing */

export async function startImport(tenantId: string, batchId: string, op: Operator, input: { leaveOutInvalid?: boolean }) {
  const tenant = await tenantExists(tenantId);
  const b = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
  const interrupted = b.status === 'importing' && !jobs.has(batchId);
  if (!['validated', 'partial'].includes(b.status) && !interrupted) {
    throw new BusinessRuleError(b.status === 'draft'
      ? 'Check the file first — the matching or the rows have changed since it was last checked.'
      : `This import is ${b.status}.`, 'import_not_ready');
  }
  const pending = await asTenant(tenantId, (tx) => tx.one<{ pending: number; invalid: number; valid: number }>(
    `select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'invalid')::int as invalid,
            count(*) filter (where status = 'valid')::int as valid from import_row where batch_id = $1`, [batchId]));
  if (pending.pending) throw new BusinessRuleError(`${pending.pending} row(s) were changed since the check. Check the file again first.`, 'import_not_ready');
  if (!pending.valid) throw new BusinessRuleError('There are no good rows left to import.', 'import_empty');
  if (pending.invalid && !input.leaveOutInvalid) {
    throw new BusinessRuleError(`${pending.invalid} row(s) have errors. Fix them, or confirm they should be left out.`, 'import_has_errors', { invalid: pending.invalid });
  }
  claim(tenantId, batchId, 'import');
  await asPlatform((tx) => audit(tx, op.id, 'import.start', {
    tenantId, targetType: 'import_batch', targetId: batchId, ip: op.ip,
    changes: { entity: b.entity, title: b.title, rows: pending.valid, leftOut: pending.invalid, tenant: tenant.code },
  }));
  void runImport(tenantId, batchId, op).finally(() => release(tenantId, batchId));
  return batchDetail(tenantId, batchId);
}

async function runImport(tenantId: string, batchId: string, op: Operator) {
  const job = jobs.get(batchId)!;
  const started = Date.now();
  try {
    const b = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
    const entity = entityOf(b);
    await setBatch(tenantId, batchId, { status: 'importing', progress: 0, error: null, started_at: new Date(), finished_at: null });
    let prepared: Awaited<ReturnType<typeof makeContext>> | null = null;
    let done = 0;
    let after = 0;
    let stopped = false;

    for (;;) {
      if (job.stop) { stopped = true; break; }
      const rows = await asTenant(tenantId, (tx) => tx.query<{ id: string; row_number: number; data: Record<string, unknown> }>(
        `select id, row_number, data from import_row where batch_id = $1 and status = 'valid' and row_number > $2
          order by row_number limit ${entity.chunk}`, [batchId, after]));
      if (!rows.length) break;
      after = rows[rows.length - 1]!.row_number;
      if (!prepared) prepared = await asTenant(tenantId, (tx) => makeContext(tx, b, entity, 'commit'));
      const { ctx } = prepared;
      const seen = new Map(ctx.seen);
      const memo = new Map(ctx.memo);
      try {
        await asTenant(tenantId, async (tx) => {
          await importChunk(tx, entity, b, ctx, rows);
          done += rows.length;
          await tx.query(`update import_batch set progress = $2, updated_at = now() where id = $1`, [batchId, done]);
        });
      } catch (error) {
        // The chunk is rolled back whole. What the job remembered from it is gone too, so forget it and go row by row.
        logger.warn({ err: error, batchId }, 'Import chunk failed; retrying row by row');
        ctx.seen = seen; ctx.memo = memo;
        await asTenant(tenantId, async (tx) => {
          ctx.lookups = await Lookups.load(tx, entity.needs);
          for (const row of rows) {
            const keepSeen = new Map(ctx.seen);
            const keepMemo = new Map(ctx.memo);
            await tx.query('savepoint import_row');
            try {
              await importChunk(tx, entity, b, ctx, [row]);
              await tx.query('release savepoint import_row');
            } catch (rowError) {
              await tx.query('rollback to savepoint import_row');
              ctx.seen = keepSeen; ctx.memo = keepMemo;
              ctx.lookups = await Lookups.load(tx, entity.needs);
              await markRows(tx, [{ id: row.id, status: 'failed', messages: [{ level: 'error', message: friendly(rowError) }] }]);
            }
          }
          done += rows.length;
          await tx.query(`update import_batch set progress = $2, updated_at = now() where id = $1`, [batchId, done]);
        });
      }
    }

    const notes = !stopped && entity.finish && prepared
      ? await asTenant(tenantId, (tx) => entity.finish!(tx, (prepared as { ctx: JobContext }).ctx))
      : [];
    await asTenant(tenantId, async (tx) => {
      await refreshCounts(tx, batchId);
      const c = await tx.one<{ imported_count: number; failed_count: number; valid_count: number; invalid_count: number }>(
        `select imported_count, failed_count, valid_count, invalid_count from import_batch where id = $1`, [batchId]);
      const summary = prepared ? (prepared as { summary: () => Record<string, unknown> }).summary() : {};
      const vouchers = await tx.one<{ n: number }>(`select count(*)::int as n from voucher where source_type = 'data_import' and source_id = $1 and reverses_voucher_id is null`, [batchId]);
      await tx.query(
        `update import_batch set status = $2, finished_at = now(), result = $3, updated_at = now() where id = $1`,
        [batchId, c.failed_count || c.valid_count || c.invalid_count || stopped ? 'partial' : 'imported',
         JSON.stringify({ ...summary, notes, stopped, vouchers: vouchers.n, seconds: Math.round((Date.now() - started) / 1000) })]);
    });
    const final = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
    await asPlatform((tx) => audit(tx, op.id, 'import.finish', {
      tenantId, targetType: 'import_batch', targetId: batchId, ip: op.ip,
      changes: { entity: b.entity, imported: final.imported_count, failed: final.failed_count, stopped },
    }));
  } catch (error) {
    logger.error({ err: error, batchId, tenantId }, 'Import failed');
    await asTenant(tenantId, async (tx) => {
      await refreshCounts(tx, batchId);
      await tx.query(`update import_batch set status = case when imported_count > 0 then 'partial' else 'validated' end,
                             error = $2, finished_at = now(), updated_at = now() where id = $1`, [batchId, friendly(error)]);
    }).catch(() => undefined);
  }
}

/** Reads, re-checks and saves one chunk, and marks every row with what became of it. */
async function importChunk(tx: Tx, entity: EntityDef, b: BatchRow, ctx: JobContext, rows: Array<{ id: string; row_number: number; data: Record<string, unknown> }>) {
  // Checked again against the shop as it is now: someone may have added a customer since the check.
  const prepared = await entity.prepare(tx, rows.map((r) => mapRow(entity, r, b.mapping, b.value_map)), ctx);
  const bad = prepared.filter((p) => hasErrors(p.issues));
  const skipped = prepared.filter((p) => !hasErrors(p.issues) && p.action === 'skip');
  const good = prepared.filter((p) => !hasErrors(p.issues) && p.action !== 'skip');
  const results = good.length ? await entity.commit(tx, good, ctx) : [];
  const byRow = new Map(results.map((r) => [r.rowId, r]));
  const preparedFor = new Map<string, PreparedRow>(prepared.map((p) => [p.row.id, p]));
  const mark = (p: PreparedRow, r: CommitResult | undefined) => {
    const messages = [...p.issues.filter((i) => i.level === 'warning'), ...(r?.issues ?? [])];
    if (!r) return { id: p.row.id, status: 'failed', messages: [...messages, { level: 'error' as const, message: 'Not saved.' }], label: p.label };
    if (!r.ok) return { id: p.row.id, status: 'failed', messages, label: p.label };
    return {
      id: p.row.id, status: r.action === 'skip' ? 'skipped' : 'imported', action: r.action ?? p.action, messages, label: p.label,
      target_table: r.targetTable ?? null, target_id: r.targetId ?? null, before: r.before ?? null, after: r.after ?? null, imported: r.action !== 'skip',
    };
  };
  await markRows(tx, [
    ...bad.map((p) => ({ id: p.row.id, status: 'failed', messages: p.issues, label: p.label })),
    ...skipped.map((p) => ({ id: p.row.id, status: 'skipped', action: 'skip', messages: p.issues, label: p.label })),
    ...good.map((p) => mark(preparedFor.get(p.row.id)!, byRow.get(p.row.id))),
  ]);
}

/* -------------------------------------------------------------- undoing */

export async function startUndo(tenantId: string, batchId: string, op: Operator, reason: string) {
  const tenant = await tenantExists(tenantId);
  const b = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
  const interrupted = b.status === 'undoing' && !jobs.has(batchId);
  if (!['imported', 'partial'].includes(b.status) && !interrupted) {
    throw new BusinessRuleError(b.status === 'undone' ? 'This import has already been undone.' : 'Nothing from this file has been imported.', 'import_not_imported');
  }
  if (b.imported_count === 0 && !interrupted) throw new BusinessRuleError('Nothing from this file has been imported.', 'import_not_imported');
  const entity = entityOf(b);
  // Anything that would make the undo leave the books half-done is found before a single row is touched.
  if (entity.canUndo) {
    const why = await asTenant(tenantId, async (tx) => entity.canUndo!(tx, await importedRows(tx, batchId), { batchId }));
    if (why) throw new BusinessRuleError(why, 'import_in_use');
  }
  claim(tenantId, batchId, 'undo');
  await asPlatform((tx) => audit(tx, op.id, 'import.undo', {
    tenantId, targetType: 'import_batch', targetId: batchId, ip: op.ip, changes: { entity: b.entity, title: b.title, reason, tenant: tenant.code },
  }));
  void runUndo(tenantId, batchId, reason).finally(() => release(tenantId, batchId));
  return batchDetail(tenantId, batchId);
}

const importedRows = (tx: Tx, batchId: string) => tx.query<ImportedRow>(
  `select id, row_number, action, target_table, target_id, before, after from import_row
    where batch_id = $1 and status = 'imported' order by row_number desc`, [batchId]);

async function runUndo(tenantId: string, batchId: string, reason: string) {
  try {
    const b = await asTenant(tenantId, (tx) => loadBatch(tx, batchId));
    const entity = entityOf(b);
    await setBatch(tenantId, batchId, { status: 'undoing', progress: 0, error: null });
    const kept: Array<{ rowNumber: number; message: string }> = [];
    if (entity.posts) {
      // Postings come back out together or not at all: half a reversal would leave the books worse than either.
      await asTenant(tenantId, async (tx) => {
        const rows = await importedRows(tx, batchId);
        const why = entity.canUndo ? await entity.canUndo(tx, rows, { batchId }) : null;
        if (why) throw new BusinessRuleError(why, 'import_in_use');
        const out = await entity.undo(tx, rows, { batchId, reason });
        await tx.query(`update import_row set status = 'undone', updated_at = now() where id = any($1::uuid[])`, [out.undone]);
        await tx.query(`update import_batch set progress = $2 where id = $1`, [batchId, rows.length]);
      });
    } else {
      // Masters come out a chunk at a time; a record in use since stays and says why.
      let done = 0;
      for (;;) {
        const more = await asTenant(tenantId, async (tx) => {
          const rows = await tx.query<ImportedRow>(
            `select id, row_number, action, target_table, target_id, before, after from import_row
              where batch_id = $1 and status = 'imported' and not (messages @> '[{"undo":"kept"}]')
              order by row_number desc limit ${entity.chunk}`, [batchId]);
          if (!rows.length) return false;
          const out = await entity.undo(tx, rows, { batchId, reason });
          await tx.query(`update import_row set status = 'undone', updated_at = now() where id = any($1::uuid[])`, [out.undone]);
          for (const k of out.kept) {
            const row = rows.find((r) => r.id === k.rowId)!;
            kept.push({ rowNumber: row.row_number, message: k.message });
            await tx.query(
              `update import_row set messages = messages || $2::jsonb, updated_at = now() where id = $1`,
              [k.rowId, JSON.stringify([{ level: 'warning', message: `Undo: ${k.message}`, undo: 'kept' }])]);
          }
          done += rows.length;
          await tx.query(`update import_batch set progress = $2 where id = $1`, [batchId, done]);
          return true;
        });
        if (!more) break;
      }
    }
    await asTenant(tenantId, async (tx) => {
      await refreshCounts(tx, batchId);
      await tx.query(
        `update import_batch set status = 'undone', undone_at = now(), result = coalesce(result, '{}'::jsonb) || $2::jsonb, updated_at = now() where id = $1`,
        [batchId, JSON.stringify({ undo: { reason, kept: kept.slice(0, 500), keptCount: kept.length } })]);
    });
  } catch (error) {
    logger.error({ err: error, batchId, tenantId }, 'Import undo failed');
    await asTenant(tenantId, async (tx) => {
      await refreshCounts(tx, batchId);
      await tx.query(`update import_batch set status = case when imported_count > 0 then 'partial' else 'undone' end, error = $2, updated_at = now() where id = $1`,
        [batchId, `Undo stopped: ${friendly(error)}`]);
    }).catch(() => undefined);
  }
}

/* ============================================================== catalogue */

/** Every kind of import with its fields, for the console's picker, matching screen and sample files. */
export function importKinds() {
  return ENTITIES.map((e) => ({
    key: e.key, label: e.label, group: e.group, order: e.order, description: e.description, posts: e.posts,
    fields: e.fields.map((f) => ({
      key: f.key, label: f.label, type: f.type, required: f.required === true, soft: f.soft === true,
      description: f.description ?? null, example: f.example ?? null, lookup: f.lookup ?? null,
      options: f.options?.map((o) => ({ value: o.value, label: o.label })) ?? null,
    })),
    requireOneOf: e.requireOneOf ?? [],
    options: e.optionHelp.map((o) => ({ ...o, ...optionInput(e, o.key) })),
    defaults: e.options.parse({}),
  }));
}

/** How the console asks for an option: a tick, a choice from a list, a date, a branch or a stock location. */
function optionInput(e: EntityDef, key: string): { input: 'boolean' | 'choice' | 'date' | 'branch' | 'location' | 'text'; choices?: string[] } {
  if (key === 'asOf') return { input: 'date' };
  if (key === 'defaultBranchId') return { input: 'branch' };
  if (key === 'locationId') return { input: 'location' };
  type Node = { def?: { type?: string; innerType?: Node; entries?: Record<string, string> }; options?: string[] };
  let node = (e.options as unknown as { shape?: Record<string, Node> }).shape?.[key];
  while (node?.def?.innerType && ['default', 'optional', 'nullable'].includes(node.def.type ?? '')) node = node.def.innerType;
  if (node?.def?.type === 'boolean') return { input: 'boolean' };
  if (node?.def?.type === 'enum') return { input: 'choice', choices: node.options ?? Object.values(node.def.entries ?? {}) };
  return { input: 'text' };
}
