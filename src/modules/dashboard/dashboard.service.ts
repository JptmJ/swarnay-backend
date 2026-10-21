/**
 * The Dashboard: the day's figures, charts, what needs attention and what
 * happened, for one date and one branch (or every branch).
 *
 * Every figure is read live and defined the same way as the matching report,
 * so the Dashboard and Reports never disagree. Each figure, chart and warning
 * needs the same permission as its kind of report: a salesperson without stock
 * reports sees no stock figure here either. The screen asks only for what it
 * shows, and each part is one query.
 */
import type { Tx } from '../../core/db/client.js';
import { ForbiddenError, ValidationError } from '../../core/errors/app-error.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { repo } from '../../core/db/repository.js';
import { hasPermission } from '../identity/permissions.js';
import { CATEGORY_PERMISSION } from '../reports/datasets.js';
import { catalogReports } from '../reports/reports.service.js';
import { profitAndLoss, SOURCE_MODULE, SOURCE_NUMBER_SQL } from '../accounts/reports.service.js';
import { SOURCE_LABELS } from '../accounts/close.service.js';

const RULES = {
  refreshSeconds: CONFIG.dashboardRefreshSeconds, orderDueDays: CONFIG.dashboardOrderDueDays, karigarDays: CONFIG.dashboardKarigarDays,
  lowStockPieces: CONFIG.dashboardLowStockPieces, unpaidDays: CONFIG.dashboardUnpaidDays, ageBuckets: CONFIG.dashboardAgeBuckets,
  alertsOff: CONFIG.dashboardAlertsOff, weightUnit: CONFIG.dashboardWeightUnit,
};
export const dashboardRules = (tx: Tx) => getConfigMany(tx, RULES);

const P = CATEGORY_PERMISSION;
/** What each figure and chart needs: the permission of its kind of report. */
export const WIDGET_PERMISSION: Record<string, string> = {
  kpi_stock_value: P.stock!, kpi_todays_sales: P.sales!, kpi_total_customers: P.customers!, kpi_pending_orders: P.orders!,
  kpi_old_gold_today: P.oldgold!, kpi_scheme_due: P.schemes!, kpi_receivables: P.customers!, kpi_new_orders_week: P.orders!,
  kpi_cash_bank: P.accounts!, kpi_girvi: P.girvi!, kpi_month_profit: P.profit!,
  chart_sales_trend: P.sales!, chart_category_sales: P.sales!, chart_city_customers: P.customers!, chart_payment_split: P.sales!,
  chart_stock_ageing: P.stock!,
};
export const KPI_KEYS = Object.keys(WIDGET_PERMISSION).filter((k) => k.startsWith('kpi_'));
export const CHART_KEYS = Object.keys(WIDGET_PERMISSION).filter((k) => k.startsWith('chart_'));

const can = (tx: Tx, perm: string | undefined) => !perm || hasPermission(tx.context.permissions, perm);
const B = (col: string) => `($2::uuid is null or ${col} = $2::uuid)`;

interface Scope { date?: string; branchId?: string | null }

async function clock(tx: Tx): Promise<{ today: string; tz: string }> {
  return tx.one(`select (now() at time zone timezone)::date::text as today, timezone as tz from tenant where id = $1`, [tx.context.tenantId]);
}

/** Only what was asked for and is allowed; nothing asked means everything allowed. */
function wanted(tx: Tx, keys: string[], asked?: string[]): string[] {
  return keys.filter((k) => (!asked?.length || asked.includes(k)) && can(tx, WIDGET_PERMISSION[k]));
}

/** Postgres refuses parameters it cannot type, so every parameter is used once, harmlessly. */
const typed = (types: string[]) => types.map((t, i) => `$${i + 1}::${t} as "__p${i + 1}"`).join(', ');

/* ---------------------------------------------------------------- figures */

const KPI_SQL: Record<string, string> = {
  kpi_stock_value: `select json_build_object(
      'value', coalesce(sum(sb.value), 0)::text,
      'gold', coalesce(sum(sb.net_weight) filter (where m.code = 'GOLD'), 0)::text,
      'silver', coalesce(sum(sb.net_weight) filter (where m.code = 'SILVER'), 0)::text,
      'fine', coalesce(sum(sb.fine_weight), 0)::text,
      'pieces', (select count(*)::int from stock_piece sp join stock_location lo on lo.id = sp.location_id
                  where sp.status in ('in_stock', 'reserved') and ${B('lo.branch_id')}),
      'series', (select json_agg(coalesce(x.net, 0)::text order by d.d) from generate_series($1::date - 6, $1::date, '1 day') d(d)
                   left join (select (sm.moved_at at time zone $3)::date as day,
                                     sum(case when sm.direction = 'in' then sm.net_weight else -sm.net_weight end) as net
                                from stock_movement sm join stock_location lo on lo.id = sm.location_id
                               where sm.moved_at >= (($1::date - 6)::timestamp at time zone $3) and ${B('lo.branch_id')} group by 1) x on x.day = d.d::date))
    from stock_balance sb join item i on i.id = sb.item_id left join purity pu on pu.id = sb.purity_id
    left join metal m on m.id = coalesce(pu.metal_id, i.metal_id) join stock_location l on l.id = sb.location_id
   where ${B('l.branch_id')}`,

  kpi_todays_sales: `select json_build_object(
      'amount', coalesce(sum(s.total_amount) filter (where s.doc_date = $1::date), 0)::text,
      'count', count(*) filter (where s.doc_date = $1::date),
      'weight', coalesce(sum(s.total_net_weight) filter (where s.doc_date = $1::date), 0)::text,
      'prev', coalesce(sum(s.total_amount) filter (where s.doc_date = $1::date - 1), 0)::text,
      'series', (select json_agg(coalesce(t.v, 0)::text order by d.d) from generate_series($1::date - 6, $1::date, '1 day') d(d)
                   left join (select doc_date, sum(total_amount) as v from sales_invoice where status = 'posted' and doc_date between $1::date - 6 and $1::date
                                and ${B('branch_id')} group by doc_date) t on t.doc_date = d.d::date))
    from sales_invoice s where s.status = 'posted' and s.doc_date between $1::date - 1 and $1::date and ${B('s.branch_id')}`,

  kpi_total_customers: `select json_build_object(
      'total', count(*) filter (where p.created_at::date <= $1::date),
      'newMonth', count(*) filter (where p.created_at::date between date_trunc('month', $1::date)::date and $1::date),
      'newPrev', count(*) filter (where p.created_at::date between (date_trunc('month', $1::date) - interval '1 month')::date
                                                               and (date_trunc('month', $1::date) - interval '1 day')::date),
      'series', (select json_agg(coalesce(t.n, 0) order by g.m) from generate_series(date_trunc('month', $1::date) - interval '5 months', date_trunc('month', $1::date), '1 month') g(m)
                   left join (select date_trunc('month', created_at::date) as m, count(*) as n from party
                               where is_customer and deleted_at is null and code <> 'WALKIN' group by 1) t on t.m = g.m))
    from party p where p.is_customer and p.deleted_at is null and p.code <> 'WALKIN'`,

  kpi_pending_orders: `select json_build_object(
      'count', count(*), 'value', coalesce(sum(o.total_amount), 0)::text, 'due', coalesce(sum(o.balance_amount), 0)::text,
      'late', count(*) filter (where o.expected_delivery_date < $1::date),
      'soon', count(*) filter (where o.expected_delivery_date between $1::date and $1::date + $4::int),
      'series', (select json_agg(coalesce(t.n, 0) order by d.d) from generate_series($1::date, $1::date + 6, '1 day') d(d)
                   left join (select expected_delivery_date as dd, count(*) as n from retail_order where status = 'active' and ${B('branch_id')} group by 1) t
                     on t.dd = d.d::date))
    from retail_order o where o.status = 'active' and ${B('o.branch_id')}`,

  kpi_new_orders_week: `select json_build_object(
      'count', count(*) filter (where o.order_date between $1::date - 6 and $1::date),
      'prev', count(*) filter (where o.order_date between $1::date - 13 and $1::date - 7),
      'value', coalesce(sum(o.total_amount) filter (where o.order_date between $1::date - 6 and $1::date), 0)::text,
      'series', (select json_agg(t.n order by w.w desc) from generate_series(0, 5) w(w)
                   cross join lateral (select count(*) as n from retail_order x where x.status <> 'cancelled' and ${B('x.branch_id')}
                                         and x.order_date between $1::date - (w.w * 7 + 6) and $1::date - w.w * 7) t))
    from retail_order o where o.status <> 'cancelled' and o.order_date between $1::date - 13 and $1::date and ${B('o.branch_id')}`,

  kpi_old_gold_today: `select json_build_object(
      'count', count(distinct oi.id) filter (where oi.voucher_date = $1::date),
      'gross', coalesce(sum(og.gross_weight) filter (where oi.voucher_date = $1::date), 0)::text,
      'fine', coalesce(sum(og.fine_weight) filter (where oi.voucher_date = $1::date), 0)::text,
      'value', coalesce(sum(og.value) filter (where oi.voucher_date = $1::date), 0)::text,
      'prevFine', coalesce(sum(og.fine_weight) filter (where oi.voucher_date = $1::date - 1), 0)::text,
      'series', (select json_agg(coalesce(t.v, 0)::text order by d.d) from generate_series($1::date - 6, $1::date, '1 day') d(d)
                   left join (select x.voucher_date as day, sum(y.fine_weight) as v from old_gold_item y join old_gold_intake x on x.id = y.old_gold_intake_id
                               where x.status <> 'cancelled' and x.voucher_date between $1::date - 6 and $1::date and ${B('x.branch_id')} group by 1) t on t.day = d.d::date))
    from old_gold_item og join old_gold_intake oi on oi.id = og.old_gold_intake_id and oi.status <> 'cancelled'
   where oi.voucher_date between $1::date - 1 and $1::date and ${B('oi.branch_id')}`,

  kpi_scheme_due: `select json_build_object(
      'due', coalesce(sum(si.amount_due) filter (where si.status in ('due', 'missed') and a.status = 'active'
                       and si.due_date between date_trunc('month', $1::date)::date and (date_trunc('month', $1::date) + interval '1 month - 1 day')::date), 0)::text,
      'accounts', count(distinct si.scheme_account_id) filter (where si.status in ('due', 'missed') and a.status = 'active'
                       and si.due_date between date_trunc('month', $1::date)::date and (date_trunc('month', $1::date) + interval '1 month - 1 day')::date),
      'overdue', count(distinct si.scheme_account_id) filter (where si.status in ('due', 'missed') and a.status = 'active' and si.due_date < $1::date),
      'collected', coalesce(sum(si.amount_paid) filter (where si.paid_on between date_trunc('month', $1::date)::date and $1::date), 0)::text,
      'series', (select json_agg(coalesce(t.v, 0)::text order by d.d) from generate_series($1::date - 6, $1::date, '1 day') d(d)
                   left join (select x.paid_on as day, sum(x.amount_paid) as v from scheme_installment x join scheme_account y on y.id = x.scheme_account_id
                               where x.paid_on between $1::date - 6 and $1::date and ${B('y.branch_id')} group by 1) t on t.day = d.d::date))
    from scheme_installment si join scheme_account a on a.id = si.scheme_account_id where ${B('a.branch_id')}`,

  kpi_receivables: `select json_build_object(
      'amount', coalesce(sum(e.debit - e.credit) filter (where e.entry_date <= $1::date), 0)::text,
      'base', coalesce(sum(e.debit - e.credit) filter (where e.entry_date <= $1::date - 7), 0)::text,
      'moves', (select json_agg(coalesce(t.v, 0)::text order by d.d) from generate_series($1::date - 6, $1::date, '1 day') d(d)
                  left join (select x.entry_date as day, sum(x.debit - x.credit) as v from ledger_entry x join account y on y.id = x.account_id
                              where y.code = '1100' and x.entry_date between $1::date - 6 and $1::date and ${B('x.branch_id')} group by 1) t on t.day = d.d::date),
      'accounts', (select count(*)::int from (select x.party_id from ledger_entry x join account y on y.id = x.account_id
                     where y.code = '1100' and x.party_id is not null and x.entry_date <= $1::date and ${B('x.branch_id')}
                     group by x.party_id having sum(x.debit - x.credit) > 0.005) z))
    from ledger_entry e join account a on a.id = e.account_id where a.code = '1100' and ${B('e.branch_id')}`,

  kpi_cash_bank: `select json_build_object(
      'cash', coalesce(sum(e.debit - e.credit) filter (where a.ledger_kind = 'cash' and e.entry_date <= $1::date), 0)::text,
      'bank', coalesce(sum(e.debit - e.credit) filter (where a.ledger_kind = 'bank' and e.entry_date <= $1::date), 0)::text,
      'base', coalesce(sum(e.debit - e.credit) filter (where e.entry_date <= $1::date - 7), 0)::text,
      'moves', (select json_agg(coalesce(t.v, 0)::text order by d.d) from generate_series($1::date - 6, $1::date, '1 day') d(d)
                  left join (select x.entry_date as day, sum(x.debit - x.credit) as v from ledger_entry x join account y on y.id = x.account_id
                              where y.ledger_kind in ('cash', 'bank') and x.entry_date between $1::date - 6 and $1::date and ${B('x.branch_id')} group by 1) t on t.day = d.d::date))
    from ledger_entry e join account a on a.id = e.account_id where a.ledger_kind in ('cash', 'bank') and ${B('e.branch_id')}`,

  kpi_girvi: `select json_build_object(
      'count', count(*), 'lent', coalesce(sum(gl.principal_amount - gl.principal_repaid), 0)::text,
      'owed', coalesce(sum(gl.outstanding_amount), 0)::text, 'fine', coalesce(sum(gl.total_fine_weight), 0)::text,
      'overdue', count(*) filter (where gl.due_date < $1::date))
    from girvi_loan gl where gl.status in ('active', 'overdue') and ${B('gl.branch_id')}`,
};

export async function summary(tx: Tx, q: Scope & { widgets?: string[] }) {
  const [c, rules] = await Promise.all([clock(tx), dashboardRules(tx)]);
  const date = q.date ?? c.today;
  const keys = wanted(tx, KPI_KEYS, q.widgets);
  const sqlKeys = keys.filter((k) => KPI_SQL[k]);
  const params = [date, q.branchId ?? null, c.tz, rules.orderDueDays];
  const [row, profit] = await Promise.all([
    sqlKeys.length
      ? tx.one<Record<string, unknown>>(`select ${typed(['date', 'uuid', 'text', 'int'])}, ${sqlKeys.map((k) => `(${KPI_SQL[k]}) as "${k}"`).join(', ')}`, params)
      : Promise.resolve({} as Record<string, unknown>),
    keys.includes('kpi_month_profit') ? monthProfit(tx, date, q.branchId) : Promise.resolve(null),
  ]);
  const kpis: Record<string, unknown> = {};
  for (const k of sqlKeys) kpis[k] = row[k];
  if (profit) kpis.kpi_month_profit = profit;
  return { date, today: c.today, branchId: q.branchId ?? null, kpis };
}

async function monthProfit(tx: Tx, date: string, branchId?: string | null) {
  const from = `${date.slice(0, 8)}01`;
  const pnl = await profitAndLoss(tx, { from, to: date, branchId: branchId ?? undefined });
  return { from, to: date, grossProfit: pnl.grossProfit, netSales: pnl.margin.netSales, netProfit: pnl.netProfit, prevGrossProfit: pnl.previous.grossProfit };
}

/* ----------------------------------------------------------------- charts */

export const TREND_DAYS = [7, 30, 90] as const;

export async function charts(tx: Tx, q: Scope & { days?: number; widgets?: string[] }) {
  const [c, rules] = await Promise.all([clock(tx), dashboardRules(tx)]);
  const date = q.date ?? c.today;
  const days = TREND_DAYS.includes(q.days as 7) ? q.days! : 30;
  const keys = wanted(tx, CHART_KEYS, q.widgets);
  const from = new Date(Date.parse(`${date}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10);
  const buckets = rules.ageBuckets.split(',').map((x) => Number(x.trim()));
  const ageCase = buckets.map((b, i) => `when age <= ${b} then ${i}`).join(' ') + ` else ${buckets.length}`;
  const ageLabels = [...buckets.map((b, i) => `${i === 0 ? 0 : buckets[i - 1]! + 1}–${b} days`), `Over ${buckets[buckets.length - 1]} days`];

  const parts: Record<string, string> = {
    chart_sales_trend: `select json_agg(json_build_object('date', d.d::date, 'amount', coalesce(t.v, 0)::text, 'bills', coalesce(t.n, 0)) order by d.d)
        from generate_series($4::date, $1::date, '1 day') d(d)
        left join (select doc_date, sum(total_amount) as v, count(*) as n from sales_invoice
                    where status = 'posted' and doc_date between $4::date and $1::date and ${B('branch_id')} group by doc_date) t on t.doc_date = d.d::date`,
    chart_category_sales: `select coalesce(json_agg(json_build_object('label', label, 'value', v::text, 'weight', w::text) order by v desc), '[]') from (
        select coalesce(c.name, 'Not in a category') as label, sum(l.line_total) as v, sum(l.net_weight) as w
          from sales_invoice_line l join sales_invoice s on s.id = l.sales_invoice_id and s.status = 'posted'
          join item i on i.id = l.item_id left join item_category c on c.id = i.category_id
         where s.doc_date between $4::date and $1::date and ${B('s.branch_id')} group by 1) z`,
    chart_payment_split: `select coalesce(json_agg(json_build_object('label', label, 'value', v::text) order by v desc), '[]') from (
        select coalesce(pm.name, sp.mode) as label, sum(sp.amount) as v
          from sales_payment sp join sales_invoice s on s.id = sp.sales_invoice_id and s.status = 'posted'
          left join payment_method pm on pm.id = sp.payment_method_id
         where s.doc_date between $4::date and $1::date and ${B('s.branch_id')} group by 1) z`,
    chart_city_customers: `select coalesce(json_agg(json_build_object('label', label, 'value', n) order by n desc), '[]') from (
        select coalesce(nullif(trim(p.city), ''), 'Not given') as label, count(*)::int as n from party p
         where p.is_customer and p.deleted_at is null and p.code <> 'WALKIN' group by 1) z`,
    chart_stock_ageing: `select coalesce(json_agg(json_build_object('band', band, 'pieces', n, 'weight', w::text) order by band), '[]') from (
        select case ${ageCase} end as band, count(*)::int as n, sum(net_weight) as w from (
          select ($1::date - coalesce(sp.received_at, sp.created_at)::date) as age, sp.net_weight from stock_piece sp
            join stock_location lo on lo.id = sp.location_id where sp.status in ('in_stock', 'reserved') and ${B('lo.branch_id')}) a group by 1) z`,
  };
  const out: Record<string, unknown> = {};
  if (keys.length) {
    const row = await tx.one<Record<string, unknown>>(
      `select ${typed(['date', 'uuid', 'text', 'date'])}, ${keys.map((k) => `(${parts[k]}) as "${k}"`).join(', ')}`,
      [date, q.branchId ?? null, c.tz, from]);
    for (const k of keys) out[k] = row[k];
  }
  if (out.chart_stock_ageing) {
    const got = out.chart_stock_ageing as { band: number; pieces: number; weight: string }[];
    out.chart_stock_ageing = ageLabels.map((label, i) => ({ label, pieces: got.find((g) => g.band === i)?.pieces ?? 0, weight: got.find((g) => g.band === i)?.weight ?? '0' }));
  }
  return { date, from, days, branchId: q.branchId ?? null, charts: out };
}

/* ------------------------------------------------------------- attention */

export interface Alert {
  key: string; severity: 'danger' | 'warning' | 'info'; title: string; description: string; count: number;
  link: { module: string; tab?: string; report?: string };
}

/** Every kind of warning, what it needs, and where it leads. */
export const ALERT_KINDS: { key: string; label: string; permission?: string }[] = [
  { key: 'rate_not_set', label: 'Today’s rates not entered' },
  { key: 'orders_late', label: 'Orders past their promised date', permission: P.orders },
  { key: 'orders_due', label: 'Orders due in the next few days', permission: P.orders },
  { key: 'karigar_late', label: 'Karigar jobs not back in time', permission: P.orders },
  { key: 'low_stock', label: 'Categories running low', permission: P.stock },
  { key: 'unpaid_bills', label: 'Bills unpaid for too long', permission: P.sales },
  { key: 'girvi_overdue', label: 'Girvi loans past due', permission: P.girvi },
  { key: 'savings_missed', label: 'Savings instalments missed', permission: P.schemes },
  { key: 'no_huid', label: 'Gold pieces without HUID', permission: P.stock },
  { key: 'tags_unprinted', label: 'Tags not printed', permission: P.stock },
  { key: 'day_not_closed', label: 'Cash days left open', permission: P.accounts },
  { key: 'approvals_pending', label: 'Entries waiting for approval', permission: P.accounts },
  { key: 'report_alerts', label: 'Report alerts not yet read', permission: 'reports.view' },
];

const ALERT_SQL: Record<string, string> = {
  rate_not_set: `select json_build_object('n', case when $1::date = (now() at time zone $3)::date and exists (select 1 from metal_rate)
        and not exists (select 1 from metal_rate r where (r.effective_from at time zone $3)::date = $1::date) then 1 else 0 end)`,
  orders_late: `select json_build_object('n', count(*), 'sample', (array_agg(o.order_number || ' · ' || p.name order by o.expected_delivery_date))[1:3])
      from retail_order o join party p on p.id = o.customer_id where o.status = 'active' and o.expected_delivery_date < $1::date and ${B('o.branch_id')}`,
  orders_due: `select json_build_object('n', count(*), 'sample', (array_agg(o.order_number || ' · ' || p.name order by o.expected_delivery_date))[1:3])
      from retail_order o join party p on p.id = o.customer_id
     where o.status = 'active' and o.expected_delivery_date between $1::date and $1::date + $4::int and ${B('o.branch_id')}`,
  karigar_late: `select json_build_object('n', count(*), 'sample', (array_agg(distinct k.name))[1:3])
      from karigar_job j join karigar k on k.id = j.karigar_id
     where j.status = 'issued' and coalesce(j.due_date, j.issued_on + $5::int) < $1::date and ${B('j.branch_id')}`,
  low_stock: `select json_build_object('n', count(*), 'sample', (array_agg(c.name || ' (' || coalesce(h.n, 0)::int || ')' order by coalesce(h.n, 0)))[1:4])
      from (select distinct i.category_id from sales_invoice_line l join sales_invoice s on s.id = l.sales_invoice_id and s.status = 'posted'
              join item i on i.id = l.item_id where s.doc_date >= $1::date - 90 and i.category_id is not null and i.nature <> 'service' and ${B('s.branch_id')}) sold
      join item_category c on c.id = sold.category_id
      left join (select i.category_id, sum(sb.quantity) as n, sum(sb.net_weight) as w from stock_balance sb join item i on i.id = sb.item_id
                   join stock_location lo on lo.id = sb.location_id where ${B('lo.branch_id')} group by 1) h on h.category_id = sold.category_id
     where coalesce(h.n, 0) < $6::int and not (coalesce(h.n, 0) = 0 and coalesce(h.w, 0) > 0)`,
  unpaid_bills: `select json_build_object('n', count(*), 'amount', coalesce(sum(s.balance_amount), 0)::text)
      from sales_invoice s where s.status = 'posted' and s.balance_amount > 0 and s.doc_date < $1::date - $7::int and ${B('s.branch_id')}`,
  girvi_overdue: `select json_build_object('n', count(*), 'amount', coalesce(sum(gl.outstanding_amount), 0)::text)
      from girvi_loan gl where gl.status in ('active', 'overdue') and gl.due_date < $1::date and ${B('gl.branch_id')}`,
  savings_missed: `select json_build_object('n', count(distinct si.scheme_account_id), 'amount', coalesce(sum(si.amount_due), 0)::text)
      from scheme_installment si join scheme_account a on a.id = si.scheme_account_id
     where a.status = 'active' and si.status in ('due', 'missed') and si.due_date < $1::date and ${B('a.branch_id')}`,
  no_huid: `select json_build_object('n', count(*)) from stock_piece sp join stock_location lo on lo.id = sp.location_id
      join item i on i.id = sp.item_id left join purity pu on pu.id = sp.purity_id left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)
     where sp.status in ('in_stock', 'reserved') and m.code = 'GOLD' and coalesce(sp.huid, '') = '' and ${B('lo.branch_id')}`,
  tags_unprinted: `select json_build_object('n', count(*)) from stock_piece sp join stock_location lo on lo.id = sp.location_id
     where sp.status in ('in_stock', 'reserved') and sp.label_printed_at is null and ${B('lo.branch_id')}`,
  day_not_closed: `select json_build_object('n', count(*), 'first', min(d.business_date)::text)
      from cash_day d where d.status = 'open' and d.business_date < $1::date and ${B('d.branch_id')}`,
  approvals_pending: `select json_build_object('n', count(*)) from journal_entry where status = 'pending_approval'`,
  report_alerts: `select json_build_object('n', count(*), 'sample', (array_agg(title order by created_at desc))[1:3])
      from report_inbox where user_id = $8::uuid and kind = 'alert' and read_at is null`,
};

const money = (v: unknown) => `₹${Number(v ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const list = (v: unknown) => (Array.isArray(v) && v.length ? `: ${v.join(', ')}` : '');

function describe(key: string, r: { n: number; sample?: string[]; amount?: string; first?: string }, rules: { orderDueDays: number; unpaidDays: number; lowStockPieces: number }): Alert {
  const n = r.n;
  const s = (one: string, many: string) => (n === 1 ? one : many);
  switch (key) {
    case 'rate_not_set': return { key, severity: 'danger', count: n, title: 'Today’s rates are not entered',
      description: 'Bills and old gold are being priced at the last rates you entered. Set today’s rates in Masters.', link: { module: 'master', tab: 'rates' } };
    case 'orders_late': return { key, severity: 'danger', count: n, title: `${n} ${s('order is', 'orders are')} past the promised date`,
      description: `Call the customer or chase the karigar${list(r.sample)}.`, link: { module: 'orders', report: 'cat:orders-late' } };
    case 'orders_due': return { key, severity: 'warning', count: n, title: `${n} ${s('order is', 'orders are')} due within ${rules.orderDueDays} ${rules.orderDueDays === 1 ? 'day' : 'days'}`,
      description: `Check they are ready${list(r.sample)}.`, link: { module: 'orders', report: 'cat:orders-open' } };
    case 'karigar_late': return { key, severity: 'warning', count: n, title: `${n} karigar ${s('job is', 'jobs are')} not back in time`,
      description: `Metal is still out with the karigar${list(r.sample)}.`, link: { module: 'orders', report: 'cat:karigar-jobs-out' } };
    case 'low_stock': return { key, severity: 'warning', count: n, title: `${n} ${s('category is', 'categories are')} running low`,
      description: `Fewer than ${rules.lowStockPieces} pieces left in stock, though they sold in the last 90 days${list(r.sample)}.`, link: { module: 'stock', report: 'cat:stock-summary' } };
    case 'unpaid_bills': return { key, severity: 'warning', count: n, title: `${n} ${s('bill has', 'bills have')} been unpaid over ${rules.unpaidDays} days`,
      description: `${money(r.amount)} is still owed on them.`, link: { module: 'reports', report: 'cat:sales-credit-bills' } };
    case 'girvi_overdue': return { key, severity: 'danger', count: n, title: `${n} girvi ${s('loan is', 'loans are')} past due`,
      description: `${money(r.amount)} owed on them. Send a notice or plan the auction.`, link: { module: 'girvi', report: 'cat:girvi-overdue' } };
    case 'savings_missed': return { key, severity: 'warning', count: n, title: `${n} savings ${s('member has', 'members have')} missed an instalment`,
      description: `${money(r.amount)} not yet collected.`, link: { module: 'schemes', report: 'cat:schemes-defaulters' } };
    case 'no_huid': return { key, severity: 'info', count: n, title: `${n} gold ${s('piece has', 'pieces have')} no HUID`,
      description: 'Hallmark them before they are sold.', link: { module: 'stock', report: 'cat:stock-huid-pending' } };
    case 'tags_unprinted': return { key, severity: 'info', count: n, title: `${n} ${s('tag has', 'tags have')} not been printed`,
      description: 'Print them in Tagging so the pieces can be scanned at the counter.', link: { module: 'tagging', report: 'cat:stock-tags-unprinted' } };
    case 'day_not_closed': return { key, severity: 'warning', count: n, title: `${n} cash ${s('day was', 'days were')} not closed`,
      description: `Count the drawer and close them in Accounts, starting with ${r.first}.`, link: { module: 'accounts', tab: 'day-close' } };
    case 'approvals_pending': return { key, severity: 'info', count: n, title: `${n} ${s('entry is', 'entries are')} waiting for approval`,
      description: 'They are not in the books until someone approves them.', link: { module: 'accounts', tab: 'vouchers' } };
    default: return { key, severity: 'danger', count: n, title: `${n} report ${s('alert has', 'alerts have')} gone off`,
      description: `Read them in the Reports inbox${list(r.sample)}.`, link: { module: 'reports', tab: 'inbox' } };
  }
}

export async function alerts(tx: Tx, q: Scope) {
  const [c, rules] = await Promise.all([clock(tx), dashboardRules(tx)]);
  const date = q.date ?? c.today;
  const kinds = ALERT_KINDS.filter((k) => can(tx, k.permission) && !rules.alertsOff.includes(k.key));
  if (!kinds.length) return { date, alerts: [] as Alert[] };
  const row = await tx.one<Record<string, { n: number; sample?: string[]; amount?: string; first?: string }>>(
    `select ${typed(['date', 'uuid', 'text', 'int', 'int', 'int', 'int', 'uuid'])}, ${kinds.map((k) => `(${ALERT_SQL[k.key]}) as "${k.key}"`).join(', ')}`,
    [date, q.branchId ?? null, c.tz, rules.orderDueDays, rules.karigarDays, rules.lowStockPieces, rules.unpaidDays, tx.context.userId ?? null]);
  const order = { danger: 0, warning: 1, info: 2 };
  const found = kinds.map((k) => ({ k, r: row[k.key]! })).filter(({ r }) => r && Number(r.n) > 0)
    .map(({ k, r }) => describe(k.key, { ...r, n: Number(r.n) }, rules))
    .sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
  return { date, alerts: found };
}

/* --------------------------------------------------------------- activity */

/** Which module's documents a person may see in the feed, by their report permissions. */
const MODULE_CATEGORY: Record<string, string> = {
  pos: 'sales', purchase: 'purchase', stock: 'stock', tagging: 'stock', oldgold: 'oldgold', orders: 'orders', schemes: 'schemes', girvi: 'girvi', accounts: 'accounts',
};

export interface ActivityItem { id: string; at: string; kind: 'voucher' | 'order' | 'change'; module: string; title: string; detail: string; amount: string | null; by: string | null; cancelled?: boolean }

export async function activity(tx: Tx, q: Scope & { limit?: number }) {
  const c = await clock(tx);
  const date = q.date ?? c.today;
  const limit = Math.min(Math.max(q.limit ?? 30, 1), 300);
  const sources = Object.entries(SOURCE_MODULE).filter(([, m]) => can(tx, P[MODULE_CATEGORY[m] ?? 'accounts'])).map(([s]) => s);
  const withAccounts = can(tx, P.accounts);
  const seeOrders = can(tx, P.orders);
  const seeChanges = can(tx, 'settings.config.view');
  const [vouchers, orders, changes] = await Promise.all([
    sources.length || withAccounts ? tx.query<{ id: string; voucher_number: string; voucher_type: string; source_type: string | null; created_at: string; narration: string | null;
      source_number: string | null; by_name: string | null; amount: string; party: string | null; is_reversed: boolean; reverses: boolean }>(
      `select v.id, v.voucher_number, v.voucher_type, v.source_type, v.created_at, v.narration, ${SOURCE_NUMBER_SQL('v')} as source_number,
              u.full_name as by_name, coalesce((select sum(debit) from ledger_entry where voucher_id = v.id), 0)::text as amount,
              (select pt.name from ledger_entry e join party pt on pt.id = e.party_id where e.voucher_id = v.id limit 1) as party,
              v.is_reversed, v.reverses_voucher_id is not null as reverses
         from voucher v left join app_user u on u.id = v.created_by
        where v.voucher_date = $1::date and ${B('v.branch_id')}
          and (v.source_type = any($3::text[]) or (v.source_type is null and $4::boolean) or (v.source_type = 'journal_entry' and $4::boolean))
        order by v.created_at desc limit ${limit}`, [date, q.branchId ?? null, sources, withAccounts]) : [],
    seeOrders ? tx.query<{ id: string; order_number: string; created_at: string; customer: string; total: string; by_name: string | null; order_type: string }>(
      `select o.id, o.order_number, o.created_at, p.name as customer, o.total_amount::text as total, u.full_name as by_name, o.order_type
         from retail_order o join party p on p.id = o.customer_id left join app_user u on u.id = o.created_by
        where o.order_date = $1::date and ${B('o.branch_id')} order by o.created_at desc limit ${limit}`, [date, q.branchId ?? null]) : [],
    seeChanges ? tx.query<{ id: string; at: string; action: string; entity_table: string; by_name: string | null }>(
      `select a.id, a.at, a.action, a.entity_table, u.full_name as by_name from audit_log a left join app_user u on u.id = a.user_id
        where a.at >= ($1::date::timestamp at time zone $3) and a.at < (($1::date + 1)::timestamp at time zone $3) and ${B('a.branch_id')}
        order by a.at desc limit ${limit}`, [date, q.branchId ?? null, c.tz]) : [],
  ]);
  const items: ActivityItem[] = [
    ...vouchers.map((v) => ({
      id: v.id, at: v.created_at, kind: 'voucher' as const, module: v.source_type ? SOURCE_MODULE[v.source_type] ?? 'accounts' : 'accounts',
      title: `${v.reverses ? 'Cancelled: ' : ''}${SOURCE_LABELS[v.voucher_type] ?? v.voucher_type.replace(/_/g, ' ')} ${v.source_number ?? v.voucher_number}`,
      detail: v.party ?? v.narration ?? '', amount: v.amount, by: v.by_name, cancelled: v.is_reversed,
    })),
    ...orders.map((o) => ({
      id: o.id, at: o.created_at, kind: 'order' as const, module: 'orders', title: `${o.order_type === 'repair' ? 'Repair' : 'Order'} ${o.order_number} taken`,
      detail: o.customer, amount: o.total, by: o.by_name,
    })),
    ...changes.map((a) => ({
      id: a.id, at: a.at, kind: 'change' as const, module: 'master', title: `${a.entity_table.replace(/_/g, ' ')} ${a.action}`,
      detail: '', amount: null, by: a.by_name,
    })),
  ].map((x) => ({ ...x, at: new Date(x.at).toISOString() }))
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1)).slice(0, limit);
  return { date, items };
}

/* ----------------------------------------------------------------- layout */

export interface Layout { widgets: { id: string; visible: boolean; order: number }[]; settings: Record<string, unknown> }

function userOf(tx: Tx): string {
  if (!tx.context.userId) throw new ForbiddenError('Sign in to use the Dashboard.');
  return tx.context.userId;
}

/** The person's layout, else their role's, else everyone's; plus their pinned reports and the shop's rules. */
export async function getLayout(tx: Tx) {
  const userId = userOf(tx);
  const roles = tx.context.roles ?? [];
  const [rows, pins, rules] = await Promise.all([
    tx.query<{ user_id: string | null; role_code: string | null; widgets: Layout['widgets']; widget_settings: Record<string, unknown> }>(
      `select user_id, role_code, widgets, widget_settings from dashboard_layout where user_id = $1 or role_code = any($2::text[]) or role_code = '*'`,
      [userId, roles]),
    pinnedReports(tx, userId),
    dashboardRules(tx),
  ]);
  const mine = rows.find((r) => r.user_id === userId);
  const role = roles.map((code) => rows.find((r) => r.role_code === code)).find(Boolean);
  const all = rows.find((r) => r.role_code === '*');
  const pick = mine ?? role ?? all;
  return {
    layout: pick ? { widgets: pick.widgets, settings: pick.widget_settings } : null,
    source: mine ? 'mine' : role ? 'role' : all ? 'everyone' : 'built_in',
    pins, rules, canManageDefaults: can(tx, 'dashboard.layout.manage'),
  };
}

async function pinnedReports(tx: Tx, userId: string) {
  const pins = await tx.query<{ ref: string }>(`select ref from report_pin where user_id = $1 order by position`, [userId]);
  if (!pins.length) return [];
  const viewIds = pins.filter((p) => p.ref.startsWith('view:')).map((p) => p.ref.slice(5));
  const [ready, views] = await Promise.all([
    pins.some((p) => p.ref.startsWith('cat:')) ? catalogReports(tx) : Promise.resolve([]),
    viewIds.length ? tx.query<{ id: string; name: string }>(
      `select id, name from report_view where id = any($1::uuid[]) and deleted_at is null and (owner_id = $2 or is_shared)`, [viewIds, userId]) : Promise.resolve([]),
  ]);
  return pins.map((p) => {
    if (p.ref.startsWith('cat:')) {
      const r = ready.find((x) => `cat:${x.key}` === p.ref);
      return r && !r.link ? { ref: p.ref, name: r.name, description: r.description } : null;
    }
    const v = views.find((x) => `view:${x.id}` === p.ref);
    return v ? { ref: p.ref, name: v.name, description: null } : null;
  }).filter(Boolean) as { ref: string; name: string; description: string | null }[];
}

async function upsert(tx: Tx, where: { user_id: string } | { role_code: string }, layout: Layout) {
  const key = 'user_id' in where ? 'user_id' : 'role_code';
  const value = 'user_id' in where ? where.user_id : where.role_code;
  const existing = await tx.maybeOne<{ id: string }>(`select id from dashboard_layout where ${key} = $1`, [value]);
  const values = { ...where, widgets: JSON.stringify(layout.widgets), widget_settings: JSON.stringify(layout.settings ?? {}) };
  if (existing) await repo(tx, 'dashboard_layout').update(existing.id, values);
  else await repo(tx, 'dashboard_layout').insert(values);
}

export async function saveLayout(tx: Tx, layout: Layout) {
  await upsert(tx, { user_id: userOf(tx) }, layout);
  return { ok: true };
}

export async function resetLayout(tx: Tx) {
  await tx.query(`delete from dashboard_layout where user_id = $1`, [userOf(tx)]);
  return getLayout(tx);
}

/** The roles of this business, and which already have a default layout. '*' is everyone. */
export async function layoutDefaults(tx: Tx) {
  const rows = await tx.query<{ code: string; name: string; has_default: boolean }>(
    `select r.code, r.name, exists (select 1 from dashboard_layout d where d.role_code = r.code) as has_default
       from role r where r.deleted_at is null order by r.name`);
  const everyone = await tx.maybeOne<{ id: string }>(`select id from dashboard_layout where role_code = '*'`);
  return [{ code: '*', name: 'Everyone', has_default: !!everyone }, ...rows];
}

async function assertRole(tx: Tx, roleCode: string) {
  if (roleCode === '*') return;
  const found = await tx.maybeOne(`select 1 from role where code = $1 and deleted_at is null`, [roleCode]);
  if (!found) throw new ValidationError(`There is no role “${roleCode}” in this business.`);
}

export async function saveDefault(tx: Tx, roleCode: string, layout: Layout) {
  await assertRole(tx, roleCode);
  await upsert(tx, { role_code: roleCode }, layout);
  return layoutDefaults(tx);
}

export async function deleteDefault(tx: Tx, roleCode: string) {
  await tx.query(`delete from dashboard_layout where role_code = $1`, [roleCode]);
  return layoutDefaults(tx);
}
