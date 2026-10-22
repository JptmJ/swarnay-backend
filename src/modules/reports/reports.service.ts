/**
 * Reports: the catalogue a person may see, running a report, and everything
 * people keep — saved designs, pins, recent runs, alerts, schedules and the
 * inbox they deliver to.
 *
 * Alerts and schedules run as the person who set them up (with their
 * permissions, never more) and deliver only to people allowed to see that
 * report. They are checked by a timer on the server and, as a backstop, the
 * next time anyone in the business opens their inbox.
 */
import type { Tx } from '../../core/db/client.js';
import { asPlatform, asTenant } from '../../core/db/client.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { logger } from '../../core/util/logger.js';
import { hasPermission } from '../identity/permissions.js';
import { effectiveGrants, loadUserAccess } from '../identity/access.service.js';
import { CATEGORY_PERMISSION, DATASETS, datasetByKey } from './datasets.js';
import { CATEGORIES, catalog, type CatalogReport } from './catalog.js';
import { runReport, visibleFields, type ReportResult, type ReportSpec, type RunOptions } from './engine.js';

const SETTINGS = {
  slowDays: CONFIG.reportsSlowDays, dormantDays: CONFIG.reportsDormantDays, highValueBill: CONFIG.reportsHighValueBill,
  cashLimit: CONFIG.accWatchCash, keepDays: CONFIG.reportsInboxKeepDays, defaultRange: CONFIG.reportsDefaultRange,
  pageSize: CONFIG.reportsPageSize, exportMax: CONFIG.reportsExportMax,
};
export const reportSettings = (tx: Tx) => getConfigMany(tx, SETTINGS);

function userOf(tx: Tx): string {
  if (!tx.context.userId) throw new ForbiddenError('Sign in to use Reports.');
  return tx.context.userId;
}

const can = (tx: Tx, perm: string | undefined) => !perm || hasPermission(tx.context.permissions, perm);
/** A report is visible when its own category and its data set’s category are both allowed. */
function allowed(tx: Tx, category: string, datasetKey?: string): boolean {
  if (!can(tx, CATEGORY_PERMISSION[category])) return false;
  if (!datasetKey) return true;
  const ds = datasetByKey.get(datasetKey);
  return !!ds && can(tx, CATEGORY_PERMISSION[ds.category]);
}
const linkAllowed = (tx: Tx, r: CatalogReport) => !r.link || can(tx, r.link.module === 'accounts' ? 'accounts.view' : undefined);

export async function catalogReports(tx: Tx): Promise<CatalogReport[]> {
  const s = await reportSettings(tx);
  return catalog(s).filter((r) => allowed(tx, r.category, r.spec?.dataset) && linkAllowed(tx, r));
}

/* --------------------------------------------------------------- catalogue */

export async function overview(tx: Tx) {
  const userId = userOf(tx);
  const [reports, views, pins, recent, unread] = await Promise.all([
    catalogReports(tx),
    tx.query<{ id: string; name: string; description: string | null; category: string; base_key: string | null; spec: ReportSpec;
      owner_id: string; owner_name: string; is_shared: boolean; last_run_at: string | null; updated_at: string }>(
      `select v.id, v.name, v.description, v.category, v.base_key, v.spec, v.owner_id, u.full_name as owner_name, v.is_shared, v.last_run_at, v.updated_at
         from report_view v join app_user u on u.id = v.owner_id
        where v.deleted_at is null and (v.owner_id = $1 or v.is_shared) order by v.updated_at desc`, [userId]),
    tx.query<{ ref: string; position: number }>(`select ref, position from report_pin where user_id = $1 order by position`, [userId]),
    tx.query<{ id: string; ref: string | null; name: string; dataset: string; spec: ReportSpec; row_count: number; ms: number; created_at: string }>(
      `select id, ref, name, dataset, spec, row_count, ms, created_at from report_run where user_id = $1 order by created_at desc limit 20`, [userId]),
    tx.one<{ n: number }>(`select count(*)::int as n from report_inbox where user_id = $1 and read_at is null`, [userId]),
  ]);
  const visibleViews = views.filter((v) => allowed(tx, v.category, v.spec?.dataset));
  const counts = new Map<string, number>();
  for (const r of reports) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return {
    categories: CATEGORIES.filter((c) => counts.has(c.key)).map((c) => ({ ...c, count: counts.get(c.key) ?? 0 })),
    reports: reports.map((r) => ({ ...r, dataset: r.spec?.dataset ?? null, datasetLabel: r.spec ? datasetByKey.get(r.spec.dataset)?.label ?? null : null })),
    views: visibleViews.map((v) => ({ ...v, mine: v.owner_id === userId })),
    pins: pins.map((p) => p.ref),
    recent,
    unread: unread.n,
    canDesign: can(tx, 'reports.design'),
    canSeeCost: can(tx, 'reports.cost.view'),
  };
}

/** Every data set this person may report on, with the fields they may see. */
export function datasetsFor(tx: Tx) {
  return DATASETS.filter((d) => can(tx, CATEGORY_PERMISSION[d.category])).map((d) => ({
    key: d.key, label: d.label, description: d.description, category: d.category,
    dateField: d.dateMode === 'none' ? null : d.dateField ?? null, dateMode: d.dateMode ?? 'within',
    hasBranch: !!d.branchSql, defaultColumns: d.defaultColumns, defaultSort: d.defaultSort ?? null,
    fields: visibleFields(tx, d).map((f) => ({
      key: f.key, label: f.label, type: f.type, dim: !!f.dim, agg: f.agg ?? (f.ratio ? 'ratio' : 'sum'),
      ratio: !!f.ratio, picker: f.picker ?? null, options: f.options ?? null, sensitive: !!f.sensitive,
    })),
  }));
}

/* ------------------------------------------------------------------- run */

async function specForRef(tx: Tx, ref: string): Promise<{ spec: ReportSpec; name: string; category: string }> {
  const [kind, id] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
  if (kind === 'cat') {
    const r = (await catalogReports(tx)).find((x) => x.key === id);
    if (!r) throw new NotFoundError('That report does not exist or is not open to you.');
    if (!r.spec) throw new BusinessRuleError(`${r.name} opens in ${r.link?.module ?? 'another module'}.`, 'report_is_link');
    return { spec: r.spec, name: r.name, category: r.category };
  }
  if (kind === 'view') {
    const v = await tx.maybeOne<{ name: string; spec: ReportSpec; category: string; owner_id: string; is_shared: boolean }>(
      `select name, spec, category, owner_id, is_shared from report_view where id = $1 and deleted_at is null`, [id]);
    if (!v || (v.owner_id !== tx.context.userId && !v.is_shared)) throw new NotFoundError('That saved report does not exist or is not shared with you.');
    if (!allowed(tx, v.category, v.spec.dataset)) throw new ForbiddenError('You do not have access to that report.');
    return { spec: v.spec, name: v.name, category: v.category };
  }
  throw new ValidationError('Unknown report.');
}

export async function run(tx: Tx, input: { ref?: string; spec?: ReportSpec; name?: string } & RunOptions): Promise<ReportResult & { name: string }> {
  const userId = userOf(tx);
  if (!input.ref && !input.spec) throw new ValidationError('Choose a report to run.');
  const base = input.ref ? await specForRef(tx, input.ref) : null;
  const spec = input.spec ?? base!.spec;
  if (input.spec && !can(tx, 'reports.design') && !base) {
    // Changing a ready report is allowed for viewers; designing from nothing needs the designer permission.
    throw new ForbiddenError('You can run reports but not design new ones.');
  }
  const result = await runReport(tx, spec, input);
  const name = input.name ?? base?.name ?? `${result.dataset.label} report`;
  if (!input.offset) {
    // Logged and pruned to the last 50 in one statement.
    await tx.query(
      `with logged as (insert into report_run (id, tenant_id, user_id, ref, name, dataset, spec, row_count, ms, created_by, updated_by)
                       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $2, $2) returning id)
       delete from report_run where user_id = $2 and id in (select id from report_run where user_id = $2 order by created_at desc offset 49)`,
      [tx.context.tenantId, userId, input.ref ?? null, name, spec.dataset, JSON.stringify(spec), result.rowCount, result.ms]);
    if (input.ref?.startsWith('view:')) await tx.query(`update report_view set last_run_at = now() where id = $1`, [input.ref.slice(5)]);
  }
  return { ...result, name };
}

/* ----------------------------------------------------------- saved reports */

export async function saveView(tx: Tx, input: { id?: string; name: string; description?: string | null; spec: ReportSpec; baseKey?: string | null; isShared?: boolean }) {
  const userId = userOf(tx);
  const ds = datasetByKey.get(input.spec.dataset);
  if (!ds) throw new ValidationError('Choose a data set.');
  if (!allowed(tx, ds.category, ds.key)) throw new ForbiddenError('You do not have access to that data.');
  // Proves the design is valid (fields, filters, groupings) before it is kept.
  await runReport(tx, { ...input.spec, limit: 1 });
  const category = input.baseKey ? (await catalogReports(tx)).find((r) => r.key === input.baseKey)?.category ?? ds.category : ds.category;
  if (input.isShared && !can(tx, 'reports.share')) throw new ForbiddenError('You cannot share reports with the team.');
  if (input.id) {
    const v = await tx.maybeOne<{ owner_id: string }>(`select owner_id from report_view where id = $1 and deleted_at is null for update`, [input.id]);
    if (!v) throw new NotFoundError('That saved report does not exist.');
    if (v.owner_id !== userId && !can(tx, 'reports.share')) throw new ForbiddenError('Only the person who saved it can change it.');
    return tx.one(
      `update report_view set name = $2, description = $3, spec = $4, is_shared = $5, category = $6, updated_at = now(), updated_by = $7
        where id = $1 returning *`,
      [input.id, input.name.trim(), input.description ?? null, JSON.stringify(input.spec), !!input.isShared, category, userId]);
  }
  return tx.one(
    `insert into report_view (id, tenant_id, name, description, category, base_key, spec, owner_id, is_shared, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $7, $7) returning *`,
    [tx.context.tenantId, input.name.trim(), input.description ?? null, category, input.baseKey ?? null, JSON.stringify(input.spec), userId, !!input.isShared]);
}

export async function deleteView(tx: Tx, id: string) {
  const userId = userOf(tx);
  const v = await tx.maybeOne<{ owner_id: string }>(`select owner_id from report_view where id = $1 and deleted_at is null`, [id]);
  if (!v) throw new NotFoundError('That saved report does not exist.');
  if (v.owner_id !== userId && !can(tx, 'reports.share')) throw new ForbiddenError('Only the person who saved it can remove it.');
  await tx.query(`update report_view set deleted_at = now(), updated_by = $2 where id = $1`, [id, userId]);
  await tx.query(`delete from report_pin where ref = $1`, [`view:${id}`]);
  return { deleted: true };
}

/* ------------------------------------------------------------------- pins */

export async function setPins(tx: Tx, refs: string[]) {
  const userId = userOf(tx);
  const unique = [...new Set(refs)];
  if (unique.length > 30) throw new ValidationError('Pin at most 30 reports.');
  if (unique.some((r) => !/^(cat|view):.+$/.test(r))) throw new ValidationError('Unknown report.');
  await tx.query(`delete from report_pin where user_id = $1`, [userId]);
  if (unique.length) {
    await tx.query(
      `insert into report_pin (id, tenant_id, user_id, ref, position, created_by, updated_by)
       select gen_random_uuid(), $1, $2, x.ref, x.n, $2, $2 from unnest($3::text[]) with ordinality as x(ref, n)`,
      [tx.context.tenantId, userId, unique]);
  }
  return { pins: unique };
}

/* ------------------------------------------------------------------ inbox */

export async function inbox(tx: Tx, q: { unreadOnly?: boolean; limit?: number }) {
  const userId = userOf(tx);
  await runDue(tx.context.tenantId).catch((err) => logger.warn({ err }, 'reports: due work failed on inbox open'));
  const [rows, unread] = await Promise.all([
    tx.query(
      `select id, kind, title, body, source_id, ref, spec, snapshot, read_at, created_at from report_inbox
        where user_id = $1 ${q.unreadOnly ? 'and read_at is null' : ''} order by created_at desc limit ${Math.min(q.limit ?? 50, 200)}`, [userId]),
    tx.one<{ n: number }>(`select count(*)::int as n from report_inbox where user_id = $1 and read_at is null`, [userId]),
  ]);
  return { rows, unread: unread.n };
}

export async function markRead(tx: Tx, id: string | 'all') {
  const userId = userOf(tx);
  if (id === 'all') await tx.query(`update report_inbox set read_at = now() where user_id = $1 and read_at is null`, [userId]);
  else await tx.query(`update report_inbox set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2`, [id, userId]);
  return { ok: true };
}

/* ---------------------------------------------------------------- alerts */

export interface AlertInput {
  name: string; spec: ReportSpec; measureKey: string; op: 'gt' | 'gte' | 'lt' | 'lte'; threshold: number;
  frequency: 'hourly' | 'daily'; recipientIds?: string[]; isActive?: boolean;
}

function oneFigure(spec: ReportSpec): ReportSpec {
  if (spec.groupBy?.length) throw new ValidationError('An alert watches one figure: remove the groupings.');
  if (!spec.measures?.length) throw new ValidationError('Choose the total the alert watches.');
  return { ...spec, compare: false };
}

export async function saveAlert(tx: Tx, input: AlertInput & { id?: string }) {
  const userId = userOf(tx);
  const spec = oneFigure(input.spec);
  const test = await runReport(tx, spec);
  if (!(input.measureKey in test.totals)) throw new ValidationError('The alert must watch one of the report’s totals.');
  const params = [input.name.trim(), JSON.stringify(spec), input.measureKey, input.op, input.threshold, input.frequency,
    JSON.stringify(input.recipientIds ?? []), input.isActive ?? true, userId];
  if (input.id) {
    return tx.one(
      `update report_alert set name = $2, spec = $3, measure_key = $4, op = $5, threshold = $6, frequency = $7, recipient_ids = $8,
              is_active = $9, last_state = null, updated_at = now(), updated_by = $10 where id = $1 and deleted_at is null returning *`,
      [input.id, ...params]);
  }
  return tx.one(
    `insert into report_alert (id, tenant_id, name, spec, measure_key, op, threshold, frequency, recipient_ids, is_active, owner_id, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $10) returning *`,
    [tx.context.tenantId, ...params]);
}

export const listAlerts = (tx: Tx) => tx.query(
  `select a.*, u.full_name as owner_name from report_alert a join app_user u on u.id = a.owner_id where a.deleted_at is null order by a.created_at desc`);

export async function deleteAlert(tx: Tx, id: string) {
  await tx.query(`update report_alert set deleted_at = now(), updated_by = $2 where id = $1`, [id, userOf(tx)]);
  return { deleted: true };
}

const crosses = (v: number, op: string, t: number) => (op === 'gt' ? v > t : op === 'gte' ? v >= t : op === 'lt' ? v < t : v <= t);
const OP_WORDS: Record<string, string> = { gt: 'above', gte: 'at or above', lt: 'below', lte: 'at or below' };

/** Recipients who may actually see the data. */
async function allowedRecipients(tx: Tx, ids: string[], ownerId: string, datasetKey: string): Promise<string[]> {
  const ds = datasetByKey.get(datasetKey);
  const want = ids.length ? ids : [ownerId];
  const out: string[] = [];
  for (const id of want) {
    const access = await loadUserAccess(tx, id);
    if (!access) continue;
    const perms = new Set(effectiveGrants(access, null).permissions.concat(access.grants.flatMap((g) => g.permissions)));
    if (!ds || hasPermission(perms, CATEGORY_PERMISSION[ds.category] ?? 'reports.view')) out.push(id);
  }
  return out;
}

async function deliver(tx: Tx, users: string[], item: { kind: 'schedule' | 'alert'; title: string; body: string; sourceId: string; ref: string | null; spec: ReportSpec; snapshot: unknown }) {
  if (!users.length) return;
  await tx.query(
    `insert into report_inbox (id, tenant_id, user_id, kind, title, body, source_id, ref, spec, snapshot, created_by, updated_by)
     select gen_random_uuid(), $1, u, $2, $3, $4, $5, $6, $7, $8, u, u from unnest($9::uuid[]) as u`,
    [tx.context.tenantId, item.kind, item.title, item.body, item.sourceId, item.ref, JSON.stringify(item.spec), JSON.stringify(item.snapshot), users]);
}

/** Runs as the person who owns the alert or schedule, with their permissions. */
async function asOwner<T>(tenantId: string, ownerId: string, fn: (tx: Tx) => Promise<T>): Promise<T | null> {
  return asTenant(tenantId, async (tx) => {
    const access = await loadUserAccess(tx, ownerId);
    if (!access) return null;
    tx.context.permissions = new Set(access.grants.flatMap((g) => g.permissions));
    return fn(tx);
  }, ownerId);
}

export async function checkAlert(tx: Tx, alertId: string) {
  const a = await tx.maybeOne<{ id: string; name: string; spec: ReportSpec; measure_key: string; op: string; threshold: string;
    recipient_ids: string[]; owner_id: string; last_state: string | null }>(
    `select * from report_alert where id = $1 and deleted_at is null for update`, [alertId]);
  if (!a) throw new NotFoundError('That alert does not exist.');
  const result = await runReport(tx, a.spec);
  const value = Number(result.totals[a.measure_key] ?? 0);
  const hit = crosses(value, a.op, Number(a.threshold));
  const label = result.columns.find((c) => c.key === a.measure_key)?.label ?? a.measure_key;
  if (hit && a.last_state !== 'triggered') {
    const users = await allowedRecipients(tx, a.recipient_ids ?? [], a.owner_id, a.spec.dataset);
    await deliver(tx, users, {
      kind: 'alert', title: a.name,
      body: `${label} is ${value.toLocaleString('en-IN')} — ${OP_WORDS[a.op]} ${Number(a.threshold).toLocaleString('en-IN')}${result.range ? ` (${result.range.label})` : ''}.`,
      sourceId: a.id, ref: null, spec: a.spec, snapshot: { totals: result.totals, columns: result.columns, range: result.range },
    });
  }
  return tx.one(
    `update report_alert set last_checked_at = now(), last_value = $2, last_state = $3,
            last_triggered_at = case when $3 = 'triggered' and coalesce(last_state, 'ok') <> 'triggered' then now() else last_triggered_at end
      where id = $1 returning *`, [a.id, value, hit ? 'triggered' : 'ok']);
}

/* ------------------------------------------------------------- schedules */

export interface ScheduleInput {
  name: string; ref?: string | null; spec?: ReportSpec; frequency: 'daily' | 'weekly' | 'monthly'; day?: number | null; atTime: string;
  recipientIds?: string[]; isActive?: boolean;
}

/** The next moment a schedule is due, in the shop’s own time. */
async function nextRun(tx: Tx, frequency: string, day: number | null, atTime: string, after = 'now()'): Promise<string> {
  const r = await tx.one<{ next: string }>(
    `with t as (select timezone as tz from tenant where id = $1),
          base as (select (${after} at time zone (select tz from t))::date as today),
          days as (select (select today from base) + g as d from generate_series(0, 62) g)
     select min((d + $4::time) at time zone (select tz from t))::text as next from days
      where (d + $4::time) at time zone (select tz from t) > ${after}
        and ($2 = 'daily' or ($2 = 'weekly' and extract(isodow from d) = $3) or ($2 = 'monthly' and extract(day from d) = $3))`,
    [tx.context.tenantId, frequency, day ?? 1, atTime]);
  return r.next;
}

export async function saveSchedule(tx: Tx, input: ScheduleInput & { id?: string }) {
  const userId = userOf(tx);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.atTime)) throw new ValidationError('Give the time as HH:MM, e.g. 20:00.');
  if (input.frequency === 'weekly' && !(input.day && input.day >= 1 && input.day <= 7)) throw new ValidationError('Choose the day of the week.');
  if (input.frequency === 'monthly' && !(input.day && input.day >= 1 && input.day <= 28)) throw new ValidationError('Choose a day of the month from 1 to 28.');
  const spec = input.spec ?? (input.ref ? (await specForRef(tx, input.ref)).spec : null);
  if (!spec) throw new ValidationError('Choose the report to send.');
  await runReport(tx, { ...spec, limit: 1 });
  const next = await nextRun(tx, input.frequency, input.day ?? null, input.atTime);
  const params = [input.name.trim(), input.ref ?? null, JSON.stringify(spec), input.frequency, input.day ?? null, input.atTime,
    JSON.stringify(input.recipientIds ?? []), input.isActive ?? true, next, userId];
  if (input.id) {
    return tx.one(
      `update report_schedule set name = $2, ref = $3, spec = $4, frequency = $5, day = $6, at_time = $7, recipient_ids = $8, is_active = $9,
              next_run_at = $10, updated_at = now(), updated_by = $11 where id = $1 and deleted_at is null returning *`, [input.id, ...params]);
  }
  return tx.one(
    `insert into report_schedule (id, tenant_id, name, ref, spec, frequency, day, at_time, recipient_ids, is_active, next_run_at, owner_id, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11) returning *`, [tx.context.tenantId, ...params]);
}

export const listSchedules = (tx: Tx) => tx.query(
  `select s.*, u.full_name as owner_name from report_schedule s join app_user u on u.id = s.owner_id where s.deleted_at is null order by s.next_run_at`);

export async function deleteSchedule(tx: Tx, id: string) {
  await tx.query(`update report_schedule set deleted_at = now(), updated_by = $2 where id = $1`, [id, userOf(tx)]);
  return { deleted: true };
}

export async function sendSchedule(tx: Tx, id: string) {
  const s = await tx.maybeOne<{ id: string; name: string; ref: string | null; spec: ReportSpec; frequency: string; day: number | null; at_time: string;
    recipient_ids: string[]; owner_id: string }>(`select * from report_schedule where id = $1 and deleted_at is null for update`, [id]);
  if (!s) throw new NotFoundError('That schedule does not exist.');
  const result = await runReport(tx, { ...s.spec }, { limit: 200 });
  const users = await allowedRecipients(tx, s.recipient_ids ?? [], s.owner_id, s.spec.dataset);
  await deliver(tx, users, {
    kind: 'schedule', title: s.name,
    body: `${result.rowCount.toLocaleString('en-IN')} row(s)${result.range ? ` · ${result.range.label} (${result.range.from} to ${result.range.to})` : ''}.`,
    sourceId: s.id, ref: s.ref, spec: s.spec,
    snapshot: { columns: result.columns, rows: result.rows.slice(0, 200), totals: result.totals, rowCount: result.rowCount, range: result.range, mode: result.mode },
  });
  const next = await nextRun(tx, s.frequency, s.day, s.at_time);
  await tx.query(`update report_schedule set last_run_at = now(), next_run_at = $2 where id = $1`, [s.id, next]);
  return { delivered: users.length, nextRunAt: next };
}

/* ------------------------------------------------------------- due work */

const running = new Set<string>();

/** Everything due in one business: alerts to check and schedules to send. Safe to call often. */
export async function runDue(tenantId: string): Promise<{ alerts: number; schedules: number }> {
  if (running.has(tenantId)) return { alerts: 0, schedules: 0 };
  running.add(tenantId);
  try {
    const due = await asTenant(tenantId, async (tx) => {
      const keep = (await reportSettings(tx)).keepDays;
      await tx.query(`delete from report_inbox where created_at < now() - ($1 || ' days')::interval`, [String(keep)]);
      const [alerts, schedules] = await Promise.all([
        tx.query<{ id: string; owner_id: string }>(
          `select id, owner_id from report_alert where deleted_at is null and is_active
              and (last_checked_at is null or last_checked_at < now() - case when frequency = 'hourly' then interval '1 hour' else interval '23 hours' end)`),
        tx.query<{ id: string; owner_id: string }>(
          `select id, owner_id from report_schedule where deleted_at is null and is_active and next_run_at <= now()`),
      ]);
      return { alerts, schedules };
    });
    let a = 0; let s = 0;
    for (const x of due.alerts) {
      try { await asOwner(tenantId, x.owner_id, (tx) => checkAlert(tx, x.id)); a++; }
      catch (err) { logger.warn({ err, alert: x.id }, 'reports: alert check failed'); }
    }
    for (const x of due.schedules) {
      try { await asOwner(tenantId, x.owner_id, (tx) => sendSchedule(tx, x.id)); s++; }
      catch (err) { logger.warn({ err, schedule: x.id }, 'reports: schedule failed'); }
    }
    return { alerts: a, schedules: s };
  } finally {
    running.delete(tenantId);
  }
}

/** The server’s timer: every business with something due. */
export async function tick(): Promise<void> {
  const tenants = await asPlatform(async (tx) => {
    await tx.query(`set local app.bypass_rls = 'on'`);
    return tx.query<{ tenant_id: string }>(
      `select distinct tenant_id from report_schedule where deleted_at is null and is_active and next_run_at <= now()
       union select distinct tenant_id from report_alert where deleted_at is null and is_active
          and (last_checked_at is null or last_checked_at < now() - case when frequency = 'hourly' then interval '1 hour' else interval '23 hours' end)`);
  });
  for (const t of tenants) await runDue(t.tenant_id).catch((err) => logger.warn({ err, tenant: t.tenant_id }, 'reports: tick failed'));
}

