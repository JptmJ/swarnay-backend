/**
 * The report engine: a report's settings in, one database query out.
 *
 * A report is a data set plus a choice of columns (a list), or of groupings and
 * totals (a summary), with filters, a period, a branch and a sort. Everything
 * is checked against the data set's own fields, values travel as parameters,
 * and the totals are worked out in the database over every matching row — the
 * page on screen never decides a total.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError, ForbiddenError, ValidationError } from '../../core/errors/app-error.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { hasPermission } from '../identity/permissions.js';
import { CATEGORY_PERMISSION, COST_PERMISSION, datasetByKey, type Agg, type DatasetDef, type FieldDef, type FieldType } from './datasets.js';

export const RANGE_PRESETS = ['today', 'yesterday', 'this_week', 'last_week', 'this_month', 'last_month', 'this_quarter', 'last_quarter',
  'this_fy', 'last_fy', 'last_7', 'last_30', 'last_90', 'last_365', 'all', 'custom'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const FILTER_OPS = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'contains', 'not_contains', 'starts', 'empty', 'not_empty'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
export const BUCKETS = ['day', 'week', 'month', 'quarter', 'year', 'weekday'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const AGGS: Agg[] = ['sum', 'count', 'avg', 'min', 'max', 'count_distinct'];

export interface ReportFilter { field: string; op: FilterOp; value?: unknown }
export interface ReportMeasure { field: string; agg: Agg }
export interface ReportSpec {
  dataset: string;
  /** List mode: the columns shown. */
  columns?: string[];
  /** Summary mode: up to two groupings, a date field may carry a bucket (`date:month`). */
  groupBy?: string[];
  measures?: ReportMeasure[];
  filters?: ReportFilter[];
  /** Filters on a summary's totals, e.g. only groups over ₹1 lakh. */
  having?: { key: string; op: FilterOp; value?: unknown }[];
  range?: { preset?: RangePreset; from?: string; to?: string };
  branchId?: string | null;
  sort?: { key: string; dir: 'asc' | 'desc' }[];
  /** Top N groups or rows. */
  limit?: number;
  compare?: boolean;
  chart?: 'table' | 'bar' | 'line' | 'donut' | 'area';
}

export interface ResultColumn { key: string; label: string; type: FieldType; role: 'dimension' | 'measure' | 'column'; sensitive?: boolean }
export interface ReportResult {
  dataset: { key: string; label: string };
  mode: 'list' | 'summary';
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  totals: Record<string, unknown>;
  previousTotals?: Record<string, unknown>;
  rowCount: number;
  truncated: boolean;
  page: { offset: number; limit: number };
  range: { preset: RangePreset; from: string; to: string; label: string; previous?: { from: string; to: string } } | null;
  ms: number;
}

const SETTINGS = {
  fyStartMonth: CONFIG.accFyStartMonth, valuationRate: CONFIG.accMetalRate,
  pageSize: CONFIG.reportsPageSize, exportMax: CONFIG.reportsExportMax, defaultRange: CONFIG.reportsDefaultRange,
};
export const engineSettings = (tx: Tx) => getConfigMany(tx, SETTINGS);

/** The shop's today and its timezone, in one round trip. */
async function shopClock(tx: Tx): Promise<{ today: string; tz: string }> {
  return tx.one<{ today: string; tz: string }>(
    `select (now() at time zone timezone)::date::text as today, timezone as tz from tenant where id = $1`, [tx.context.tenantId]);
}

/* ----------------------------------------------------------------- dates */

const iso = (d: Date) => d.toISOString().slice(0, 10);
const at = (iso_: string) => new Date(`${iso_}T00:00:00Z`);
const plusDays = (s: string, n: number) => { const d = at(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const monthStart = (s: string) => `${s.slice(0, 7)}-01`;
const monthEnd = (s: string) => { const d = at(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(0); return iso(d); };
const addMonths = (s: string, n: number) => { const d = at(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };

export function resolveRange(today: string, fyStartMonth: number, range?: ReportSpec['range'], fallback: RangePreset = 'this_month') {
  const preset: RangePreset = range?.preset ?? (range?.from || range?.to ? 'custom' : fallback);
  const fyStart = (() => { const y = Number(today.slice(0, 4)); const m = Number(today.slice(5, 7));
    return `${m >= fyStartMonth ? y : y - 1}-${String(fyStartMonth).padStart(2, '0')}-01`; })();
  const qStart = (() => { const offset = (Number(today.slice(5, 7)) - fyStartMonth + 12) % 3; return addMonths(today, -offset); })();
  const dow = (at(today).getUTCDay() + 6) % 7; // Monday = 0
  let from: string; let to: string; let label: string;
  switch (preset) {
    case 'today': from = to = today; label = 'Today'; break;
    case 'yesterday': from = to = plusDays(today, -1); label = 'Yesterday'; break;
    case 'this_week': from = plusDays(today, -dow); to = today; label = 'This week'; break;
    case 'last_week': from = plusDays(today, -dow - 7); to = plusDays(today, -dow - 1); label = 'Last week'; break;
    case 'this_month': from = monthStart(today); to = today; label = 'This month'; break;
    case 'last_month': from = addMonths(today, -1); to = monthEnd(from); label = 'Last month'; break;
    case 'this_quarter': from = qStart; to = today; label = 'This quarter'; break;
    case 'last_quarter': from = addMonths(qStart, -3); to = plusDays(qStart, -1); label = 'Last quarter'; break;
    case 'this_fy': from = fyStart; to = today; label = 'This financial year'; break;
    case 'last_fy': { const d = at(fyStart); d.setUTCFullYear(d.getUTCFullYear() - 1); from = iso(d); to = plusDays(fyStart, -1); label = 'Last financial year'; break; }
    case 'last_7': from = plusDays(today, -6); to = today; label = 'Last 7 days'; break;
    case 'last_30': from = plusDays(today, -29); to = today; label = 'Last 30 days'; break;
    case 'last_90': from = plusDays(today, -89); to = today; label = 'Last 90 days'; break;
    case 'last_365': from = plusDays(today, -364); to = today; label = 'Last 12 months'; break;
    case 'all': from = '2000-01-01'; to = today; label = 'All time'; break;
    default: {
      from = range?.from ?? monthStart(today); to = range?.to ?? today;
      if (from > to) throw new ValidationError('The start date is after the end date.');
      label = `${from} to ${to}`;
    }
  }
  const days = Math.round((at(to).getTime() - at(from).getTime()) / 86400000) + 1;
  const previous = { from: plusDays(from, -days), to: plusDays(from, -1) };
  // Calendar months and years compare with the same calendar period before.
  if (preset === 'this_month' || preset === 'last_month') { previous.from = addMonths(from, -1); previous.to = plusDays(from, -1); }
  return { preset, from, to, label, previous };
}

/* ----------------------------------------------------------------- query */

class Sql {
  params: unknown[] = [];
  private tokens = new Map<string, string>();
  constructor(private tokenValues: Record<string, unknown>) {}
  p(v: unknown) { this.params.push(v); return `$${this.params.length}`; }
  t(sql: string) {
    return sql.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
      if (!(name in this.tokenValues)) throw new Error(`Unknown token ${name}`);
      if (!this.tokens.has(name)) this.tokens.set(name, this.p(this.tokenValues[name]));
      return this.tokens.get(name)!;
    });
  }
}

const NUMERIC: FieldType[] = ['int', 'number', 'money', 'weight', 'percent'];
const isNumeric = (f: FieldDef) => NUMERIC.includes(f.type);
const ident = (key: string) => `"${key.replace(/"/g, '')}"`;

/** The fields this person may see in a data set. */
export function visibleFields(tx: Tx, ds: DatasetDef): FieldDef[] {
  const cost = hasPermission(tx.context.permissions, COST_PERMISSION);
  return ds.fields.filter((f) => !f.sensitive || cost);
}

export function datasetFor(tx: Tx, key: string): DatasetDef {
  const ds = datasetByKey.get(key);
  if (!ds) throw new ValidationError(`There is no data set called ${key}.`);
  const perm = CATEGORY_PERMISSION[ds.category];
  if (perm && !hasPermission(tx.context.permissions, perm)) {
    throw new ForbiddenError(`You do not have access to ${ds.label} reports.`);
  }
  return ds;
}

function fieldOf(ds: DatasetDef, fields: Map<string, FieldDef>, key: string): FieldDef {
  const f = fields.get(key);
  if (!f) {
    if (ds.fields.some((x) => x.key === key)) throw new ForbiddenError('Cost and margin need the “see cost” permission.');
    throw new ValidationError(`${ds.label} has no field “${key}”.`);
  }
  return f;
}

function bucketSql(sql: string, bucket: Bucket): string {
  switch (bucket) {
    case 'day': return `(${sql})::date`;
    case 'week': return `date_trunc('week', ${sql})::date`;
    case 'month': return `to_char(${sql}, 'YYYY-MM')`;
    case 'quarter': return `to_char(${sql}, 'YYYY-"Q"Q')`;
    case 'year': return `to_char(${sql}, 'YYYY')`;
    case 'weekday': return `to_char(${sql}, 'ID-Dy')`;
  }
}

function resolveValue(v: unknown, today: string): unknown {
  if (typeof v !== 'string' || !v.startsWith('@')) return v;
  const month = Number(today.slice(5, 7));
  switch (v) {
    case '@today': return today;
    case '@month_start': return `${today.slice(0, 7)}-01`;
    case '@this_month': return month;
    case '@next_month': return (month % 12) + 1;
    default: return v;
  }
}

function castFor(type: FieldType): string {
  if (NUMERIC.includes(type)) return '::numeric';
  if (type === 'date' || type === 'datetime') return '::date';
  if (type === 'bool') return '::boolean';
  return '::text';
}

/** One condition. `expr` is a fixed SQL fragment; only values become parameters. */
function condition(q: Sql, expr: string, type: FieldType, op: FilterOp, raw: unknown, today: string, label: string): string {
  const value = resolveValue(raw, today);
  const cast = castFor(type);
  const one = (v: unknown) => {
    if (v === undefined || v === null || v === '') throw new ValidationError(`Give a value for “${label}”.`);
    return `${q.p(v)}${cast}`;
  };
  const list = () => {
    const arr = Array.isArray(value) ? value : [value];
    if (!arr.length) throw new ValidationError(`Choose at least one value for “${label}”.`);
    return `${q.p(arr.map((x) => resolveValue(x, today)))}${cast}[]`;
  };
  switch (op) {
    case 'eq': return `${expr} = ${one(value)}`;
    case 'neq': return `${expr} is distinct from ${one(value)}`;
    case 'in': return `${expr} = any(${list()})`;
    case 'not_in': return `not (${expr} = any(${list()}))`;
    case 'gt': return `${expr} > ${one(value)}`;
    case 'gte': return `${expr} >= ${one(value)}`;
    case 'lt': return `${expr} < ${one(value)}`;
    case 'lte': return `${expr} <= ${one(value)}`;
    case 'between': {
      if (!Array.isArray(value) || value.length !== 2) throw new ValidationError(`“${label}” between needs two values.`);
      return `${expr} between ${one(value[0])} and ${one(value[1])}`;
    }
    case 'contains': return `(${expr})::text ilike ${q.p(`%${String(value ?? '')}%`)}`;
    case 'not_contains': return `(${expr})::text not ilike ${q.p(`%${String(value ?? '')}%`)}`;
    case 'starts': return `(${expr})::text ilike ${q.p(`${String(value ?? '')}%`)}`;
    case 'empty': return `(${expr} is null or (${expr})::text = '')`;
    case 'not_empty': return `(${expr} is not null and (${expr})::text <> '')`;
  }
}

interface Built {
  mode: 'list' | 'summary';
  columns: ResultColumn[];
  select: string[];
  totalSelect: string[];
  groupExprs: string[];
  orderBy: string;
}

/** Works out the shape of the report: its columns, its totals and its order. */
function shape(ds: DatasetDef, fields: Map<string, FieldDef>, spec: ReportSpec): Built {
  const summary = (spec.groupBy?.length ?? 0) > 0 || (spec.measures?.length ?? 0) > 0;
  const columns: ResultColumn[] = []; const select: string[] = []; const totalSelect: string[] = []; const groupExprs: string[] = [];
  const total = (f: FieldDef, key: string, agg: Agg = f.agg ?? 'sum') => {
    if (f.ratio) totalSelect.push(`round(sum(${f.ratio.num}) * ${f.ratio.scale ?? 1} / nullif(sum(${f.ratio.den}), 0), 2) as ${ident(key)}`);
    else if (agg === 'count') totalSelect.push(`count(${f.sql}) as ${ident(key)}`);
    else if (agg === 'count_distinct') totalSelect.push(`count(distinct ${f.sql}) as ${ident(key)}`);
    else totalSelect.push(`${agg === 'avg' ? `round(avg(${f.sql}), 2)` : `${agg}(${f.sql})`} as ${ident(key)}`);
  };

  if (!summary) {
    const keys = spec.columns?.length ? spec.columns : ds.defaultColumns.filter((k) => fields.has(k));
    if (keys.length > 40) throw new ValidationError('Choose at most 40 columns.');
    for (const key of keys) {
      const f = fieldOf(ds, fields, key);
      columns.push({ key, label: f.label, type: f.type, role: 'column', sensitive: !!f.sensitive });
      select.push(`${f.sql} as ${ident(key)}`);
      if (isNumeric(f)) total(f, key);
    }
    totalSelect.push('count(*)::int as "__rows"');
  } else {
    const groups = spec.groupBy ?? [];
    if (groups.length > 2) throw new ValidationError('Group by at most two things.');
    groups.forEach((g, i) => {
      const [key, bucket] = g.split(':') as [string, Bucket | undefined];
      const f = fieldOf(ds, fields, key);
      if (bucket && !BUCKETS.includes(bucket)) throw new ValidationError(`“${bucket}” is not a way to group dates.`);
      if (bucket && f.type !== 'date' && f.type !== 'datetime') throw new ValidationError(`${f.label} is not a date.`);
      if (!bucket && !f.dim) throw new ValidationError(`${ds.label} cannot be grouped by ${f.label}.`);
      const expr = bucket ? bucketSql(f.sql, bucket) : f.sql;
      const outKey = bucket ? `${key}_${bucket}` : key;
      columns.push({ key: outKey, label: bucket ? `${f.label} (${bucket})` : f.label, type: bucket && bucket !== 'day' ? 'text' : f.type, role: 'dimension' });
      select.push(`${expr} as ${ident(outKey)}`);
      groupExprs.push(String(i + 1));
    });
    const measures = spec.measures?.length ? spec.measures : [{ field: '*', agg: 'count' as Agg }];
    if (measures.length > 12) throw new ValidationError('Choose at most 12 totals.');
    for (const m of measures) {
      if (!AGGS.includes(m.agg)) throw new ValidationError(`“${m.agg}” is not a kind of total.`);
      if (m.field === '*') {
        columns.push({ key: 'count', label: 'Count', type: 'int', role: 'measure' });
        select.push('count(*)::int as "count"'); totalSelect.push('count(*)::int as "count"');
        continue;
      }
      const f = fieldOf(ds, fields, m.field);
      if (!isNumeric(f) && !['count', 'count_distinct'].includes(m.agg)) throw new ValidationError(`${f.label} can only be counted.`);
      const key = f.ratio ? f.key : `${m.agg}_${f.key}`;
      const label = f.ratio ? f.label : `${f.label}${m.agg === 'sum' ? '' : ` (${{ count: 'count', avg: 'average', min: 'lowest', max: 'highest', count_distinct: 'different', sum: '' }[m.agg]})`}`;
      columns.push({ key, label, type: m.agg === 'count' || m.agg === 'count_distinct' ? 'int' : f.type, role: 'measure', sensitive: !!f.sensitive });
      const expr = f.ratio ? `round(sum(${f.ratio.num}) * ${f.ratio.scale ?? 1} / nullif(sum(${f.ratio.den}), 0), 2)`
        : m.agg === 'count' ? `count(${f.sql})::int` : m.agg === 'count_distinct' ? `count(distinct ${f.sql})::int`
        : m.agg === 'avg' ? `round(avg(${f.sql}), 2)` : `${m.agg}(${f.sql})`;
      select.push(`${expr} as ${ident(key)}`);
      totalSelect.push(`${expr} as ${ident(key)}`);
    }
  }

  const outKeys = new Set(columns.map((c) => c.key));
  const sort = (spec.sort ?? []).filter((s) => outKeys.has(s.key));
  if (!sort.length) {
    const firstMeasure = columns.find((c) => c.role === 'measure');
    const dateDim = columns.find((c) => c.role === 'dimension' && /_(day|week|month|quarter|year|weekday)$/.test(c.key));
    if (summary && dateDim) sort.push({ key: dateDim.key, dir: 'asc' });
    else if (summary && firstMeasure) sort.push({ key: firstMeasure.key, dir: 'desc' });
    else if (ds.defaultSort && outKeys.has(ds.defaultSort.key)) sort.push(ds.defaultSort);
    else if (columns[0]) sort.push({ key: columns[0].key, dir: 'asc' });
  }
  const orderBy = sort.map((s) => `${ident(s.key)} ${s.dir === 'asc' ? 'asc' : 'desc'} nulls last`).join(', ');
  return { mode: summary ? 'summary' : 'list', columns, select, totalSelect, groupExprs, orderBy };
}

function whereFor(q: Sql, ds: DatasetDef, fields: Map<string, FieldDef>, spec: ReportSpec, today: string): string {
  const conds: string[] = [];
  if (ds.where) conds.push(`(${q.t(ds.where)})`);
  const dateField = ds.dateField ? fields.get(ds.dateField) ?? ds.fields.find((f) => f.key === ds.dateField) : undefined;
  if (dateField && (ds.dateMode ?? 'within') === 'within') {
    conds.push(ds.dateWhere ? `(${ds.dateWhere.within})` : `(${q.t(dateField.sql)}) between {{from}}::date and {{to}}::date`);
  }
  if (dateField && ds.dateMode === 'upto') conds.push(ds.dateWhere ? `(${ds.dateWhere.upto})` : `(${q.t(dateField.sql)}) <= {{to}}::date`);
  if (spec.branchId && ds.branchSql) conds.push(`${ds.branchSql} = ${q.p(spec.branchId)}`);
  for (const f of spec.filters ?? []) {
    if (!FILTER_OPS.includes(f.op)) throw new ValidationError(`“${f.op}” is not a filter.`);
    const field = fieldOf(ds, fields, f.field);
    conds.push(`(${condition(q, q.t(field.sql), field.type, f.op, f.value, today, field.label)})`);
  }
  return conds.length ? `where ${q.t(conds.join(' and '))}` : '';
}

async function execute(tx: Tx, ds: DatasetDef, fields: Map<string, FieldDef>, spec: ReportSpec, built: Built,
  tokens: Record<string, unknown>, today: string, page: { offset: number; limit: number }, withRows = true) {
  const q = new Sql(tokens);
  const withSql = ds.with ? `with ${q.t(ds.with)} ` : '';
  const from = q.t(ds.from);
  const where = whereFor(q, ds, fields, spec, today);
  const select = built.select.map((s) => q.t(s));
  const totalSelect = built.totalSelect.map((s) => q.t(s));
  const having = (spec.having ?? []).map((h) => {
    const col = built.columns.find((c) => c.key === h.key && c.role === 'measure');
    if (!col) throw new ValidationError(`“${h.key}” is not one of this report’s totals.`);
    const idx = built.columns.indexOf(col);
    const sel = built.select[idx]!;
    return condition(q, q.t(sel.slice(0, sel.lastIndexOf(' as '))), col.type, h.op, h.value, today, col.label);
  });
  const group = built.groupExprs.length ? `group by ${built.groupExprs.join(', ')}` : '';
  const havingSql = having.length ? `having ${having.join(' and ')}` : '';
  const base = `${withSql}select ${select.join(', ')} from ${from} ${where} ${group} ${havingSql}`;
  const rowsSql = `${base} order by ${built.orderBy} limit ${page.limit} offset ${page.offset}`;
  const dimSelect = select.slice(0, built.groupExprs.length);
  const totalsOf = (extra: string) => (built.mode === 'summary' && built.groupExprs.length
    ? `${withSql}select ${extra}${totalSelect.join(', ')}, (select count(*) from (select ${dimSelect.join(', ')} from ${from} ${where} ${group} ${havingSql}) g)::int as "__rows" from ${from} ${where}`
    : `${withSql}select ${extra}${totalSelect.join(', ')}${built.mode === 'summary' ? ', 1::int as "__rows"' : ''} from ${from} ${where}`);
  // Postgres wants every parameter used: carry any the totals do not need as a throwaway column.
  const used = new Set([...totalsOf('').matchAll(/\$(\d+)\b/g)].map((m) => Number(m[1])));
  const unused = q.params.map((_, i) => i + 1).filter((i) => !used.has(i));
  const totalsSql = totalsOf(unused.map((i) => `$${i}::text as "__p${i}", `).join(''));
  const [rows, totals] = await Promise.all([
    withRows ? tx.query<Record<string, unknown>>(rowsSql, q.params) : Promise.resolve([]),
    tx.one<Record<string, unknown>>(totalsSql, q.params),
  ]);
  return { rows, totals };
}

export interface RunOptions { offset?: number; limit?: number; export?: boolean }

/** Runs one report. */
export async function runReport(tx: Tx, spec: ReportSpec, opts: RunOptions = {}): Promise<ReportResult> {
  const started = Date.now();
  const ds = datasetFor(tx, spec.dataset);
  const fields = new Map(visibleFields(tx, ds).map((f) => [f.key, f]));
  const s = await engineSettings(tx);
  const { today, tz } = await shopClock(tx);
  const usesDates = (ds.dateMode ?? 'within') !== 'none' || /\{\{(from|to)\}\}/.test(ds.from + (ds.with ?? ''));
  const range = resolveRange(today, s.fyStartMonth, spec.range, s.defaultRange as RangePreset);
  const tokens = { from: range.from, to: range.to, today, tz, rate_basis: s.valuationRate };
  const built = shape(ds, fields, spec);
  const cap = opts.export ? s.exportMax : s.pageSize;
  const limit = Math.min(spec.limit ?? opts.limit ?? cap, cap);
  const offset = spec.limit ? 0 : Math.max(0, opts.offset ?? 0);
  const { rows, totals } = await execute(tx, ds, fields, spec, built, tokens, today, { offset, limit });
  const rowCount = Number(totals.__rows ?? rows.length);
  for (const k of Object.keys(totals)) if (k.startsWith('__')) delete totals[k];

  let previousTotals: Record<string, unknown> | undefined;
  if (spec.compare && usesDates) {
    const prevTokens = { ...tokens, from: range.previous.from, to: range.previous.to };
    const prev = await execute(tx, ds, fields, spec, built, prevTokens, today, { offset: 0, limit: 5000 }, built.mode === 'summary');
    previousTotals = prev.totals;
    for (const k of Object.keys(previousTotals)) if (k.startsWith('__')) delete previousTotals[k];
    if (built.mode === 'summary') {
      const dims = built.columns.filter((c) => c.role === 'dimension').map((c) => c.key);
      const measures = built.columns.filter((c) => c.role === 'measure').map((c) => c.key);
      const keyOf = (r: Record<string, unknown>) => dims.map((d) => String(r[d] ?? '')).join('\u0001');
      const before = new Map(prev.rows.map((r) => [keyOf(r), r]));
      for (const r of rows) {
        const p = before.get(keyOf(r));
        for (const m of measures) r[`prev_${m}`] = p?.[m] ?? null;
      }
    }
  }
  return {
    dataset: { key: ds.key, label: ds.label },
    mode: built.mode,
    columns: built.columns,
    rows, totals, previousTotals,
    rowCount,
    truncated: built.mode === 'list' ? offset + rows.length < rowCount : rowCount > rows.length && !spec.limit,
    page: { offset, limit },
    range: usesDates ? { preset: range.preset, from: range.from, to: range.to, label: range.label, previous: spec.compare ? range.previous : undefined } : null,
    ms: Date.now() - started,
  };
}

/** Distinct values of a field, for filter pickers. */
export async function fieldValues(tx: Tx, datasetKey: string, fieldKey: string, search?: string) {
  const ds = datasetFor(tx, datasetKey);
  const fields = new Map(visibleFields(tx, ds).map((f) => [f.key, f]));
  const f = fieldOf(ds, fields, fieldKey);
  if (!f.dim) throw new BusinessRuleError(`${f.label} has no list of values.`, 'not_a_dimension');
  if (f.options) return f.options.filter((o) => !search || o.toLowerCase().includes(search.toLowerCase())).map((v) => ({ value: v, count: null }));
  const s = await engineSettings(tx);
  const { today, tz } = await shopClock(tx);
  const range = resolveRange(today, s.fyStartMonth, { preset: 'all' });
  const q = new Sql({ from: range.from, to: range.to, today, tz, rate_basis: s.valuationRate });
  const withSql = ds.with ? `with ${q.t(ds.with)} ` : '';
  const expr = q.t(f.sql);
  const conds = [ds.where ? q.t(ds.where) : null, search ? `(${expr})::text ilike ${q.p(`%${search}%`)}` : null].filter(Boolean);
  return tx.query<{ value: string; count: number }>(
    `${withSql}select ${expr} as value, count(*)::int as count from ${q.t(ds.from)} ${conds.length ? `where ${conds.join(' and ')}` : ''}
      group by 1 having ${expr} is not null order by 2 desc limit 60`, q.params);
}
