import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * The Dashboard on a fresh business with real trade: every figure must agree
 * with the report or the books it stands for, people see only the figures
 * their role allows, and layouts fall back from mine to my role's to everyone's.
 */
describe('Dashboard', { timeout: 300_000 }, () => {
  let server: Server;
  let base: string;
  let owner: string;
  let viewer: string;
  let outsider: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36);
  const SHOP = `dsh${run}`;
  const ids: Record<string, string> = {};
  const n = (v: unknown) => Number(v);
  const bills: Body[] = [];
  let today = '';

  async function call(path: string, body?: unknown, method?: string, as = owner) {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}`, 'x-branch-id': main },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  }
  const ok = async (path: string, body?: unknown, method?: string, as = owner) => {
    const r = await call(path, body, method, as);
    if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const report = async (spec: Body) => (await ok('/api/reports/run', { spec })) as Body;
  const addDays = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);

  beforeAll(async () => {
    tenantId = (await provisionTenant({
      code: SHOP, legalName: 'Dashboard Test Jewellers', displayName: 'Dashboard Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Dashboard Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const users = await asPlatform(async (tx) => {
      await tx.query(`set local app.bypass_rls = 'on'`);
      const o = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [o.id]);
      const person = async (code: string, perms: string[]) => {
        const role = await tx.one<{ id: string }>(
          `insert into role (id, tenant_id, code, name, role_type) values (gen_random_uuid(), $1, $2, $2, 'staff') returning id`, [tenantId, code]);
        await tx.query(`insert into role_permission (id, tenant_id, role_id, permission) select gen_random_uuid(), $1, $2, p from unnest($3::text[]) p`,
          [tenantId, role.id, perms]);
        const u = await tx.one<{ id: string; tv: number }>(
          `insert into app_user (id, tenant_id, email, full_name, password_hash, is_active, must_change_password)
           values (gen_random_uuid(), $1, $2, $3, 'x', true, false) returning id, token_version as tv`, [tenantId, `${code}@${SHOP}.in`, code]);
        await tx.query(`insert into user_role (id, tenant_id, user_id, role_id, branch_id) values (gen_random_uuid(), $1, $2, $3, null)`, [tenantId, u.id, role.id]);
        return u;
      };
      // A counter role: the Dashboard and sales figures only. And someone with no Dashboard at all.
      const v = await person('counter', ['dashboard.view', 'reports.view', 'reports.sales.view']);
      const x = await person('nodash', ['reports.view', 'reports.sales.view']);
      return { o, v, x };
    });
    main = users.o.branch;
    owner = signAccessToken({ sub: users.o.id, tenantId, tv: users.o.tv });
    viewer = signAccessToken({ sub: users.v.id, tenantId, tv: users.v.tv });
    outsider = signAccessToken({ sub: users.x.id, tenantId, tv: users.x.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Trade: a purchase, five tagged rings, three bills (UPI, cash with a discount, credit), a return,
    // an old-gold exchange and an order promised for tomorrow.
    const gold = (await ok('/api/master/metals')).rows.find((m: Body) => m.code === 'GOLD');
    ids.gold = gold.id;
    ids.k22 = (await ok(`/api/master/purities?metal_id=${gold.id}`)).rows.find((r: Body) => r.code === '22K').id;
    ids.counter = (await ok(`/api/master/locations?branch_id=${main}`)).rows.find((l: Body) => l.code === 'COUNTER').id;
    ids.cat = (await ok('/api/master/categories', { code: `RC${run}`, name: `Rings ${run}`, hsn_code: '7113' })).id;
    ids.ring = (await ok('/api/master/items', { code: `RNG${run}`, name: `Ring ${run}`, metal_id: gold.id, category_id: ids.cat, tracking: 'piece', hsn_code: '7113' })).id;
    await ok('/api/master/price-rules', { code: `MK${run}`, name: 'Ring making', applies_to: 'making', basis: 'per_gram', rate: '500', slabs: [],
      slab_mode: 'whole', item_id: ids.ring, priority: 0, effective_from: '2026-01-01', is_active: true });
    ids.supplier = (await ok('/api/master/parties', { name: `Shah ${run}`, is_supplier: true, phone: '9820012345', gstin: '27ABCDE1234F1Z5' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Neha ${run}`, is_customer: true, phone: '9820054321', city: 'Surat' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Ravi ${run}`, is_customer: true, phone: '9820054322', city: 'Pune' })).id;
    await ok('/api/master/rates', { metal_id: gold.id, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI']) ids[c] = methods.find((m: Body) => m.code === c).id;
    today = (await ok('/api/dashboard/summary?widgets=kpi_todays_sales')).today;
    const inward = await ok('/api/purchase/inwards', {
      supplierId: ids.supplier, locationId: ids.counter,
      lines: [{ itemId: ids.ring, purityId: ids.k22, pieces: 5, grossWeight: '50.000', metalBasis: 'rupee', ratePerGram: '6900', makingRate: '400' }],
      bill: { supplierInvoiceNumber: `B-${run}`, supplierInvoiceDate: today },
    });
    const pieces = (await ok('/api/tagging/pieces', { pieces: [0, 1, 2, 3, 4].map(() => ({ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '10.000', taggingLotId: inward.lines[0].tagging_lot_id })) })).rows;
    bills.push(await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: pieces[0].id }], tenders: [{ paymentMethodId: ids.UPI, amount: '40000', reference: 'U1' }] }));
    bills.push(await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: pieces[1].id }], discount: '300', tenders: [{ paymentMethodId: ids.CASH, amount: '20000' }] }));
    bills.push(await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: pieces[2].id }], tenders: [] }));
    const detail = await ok(`/api/pos/invoices/${bills[0]!.id}`);
    await ok('/api/pos/returns', { invoiceId: bills[0]!.id, settlement: 'credit_note', reason: 'size', lines: [{ invoiceLineId: detail.lines[0].id }] });
    ids.intake = (await ok('/api/oldgold/intakes', { customerId: ids.customer, settlement: 'exchange', lines: [{ description: 'Old chain', metalId: ids.gold,
      grossWeight: '10.000', stoneWeight: '0.500', dirtWeight: '0.500', testMethod: 'xrf', testedPurityPercent: '91.600' }] })).id;
    ids.order = (await ok('/api/orders', { orderType: 'custom', customerId: ids.customer2, expectedDeliveryDate: addDays(today, 1),
      lines: [{ title: 'Chain', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '10.000' }] })).id;
  }, 300_000);

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('shows each headline figure exactly as the matching report or the books', async () => {
    const s = await ok('/api/dashboard/summary');
    const k = s.kpis;
    expect(s.date).toBe(today);

    const sales = (await report({ dataset: 'sales_bills', range: { preset: 'today' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], measures: [{ field: 'total', agg: 'sum' }] })).totals;
    expect(n(k.kpi_todays_sales.amount)).toBeCloseTo(n(sales.sum_total), 2);
    expect(k.kpi_todays_sales.count).toBe(3);
    expect(k.kpi_todays_sales.series).toHaveLength(7);
    expect(n(k.kpi_todays_sales.series[6])).toBeCloseTo(n(sales.sum_total), 2);

    const stock = (await report({ dataset: 'stock_balances', measures: [{ field: 'value', agg: 'sum' }, { field: 'net_weight', agg: 'sum' }] })).totals;
    expect(n(k.kpi_stock_value.value)).toBeCloseTo(n(stock.sum_value), 2);
    expect(k.kpi_stock_value.pieces).toBe(3);                         // 5 tagged, 3 sold, 1 back

    expect(k.kpi_total_customers.total).toBe(2);
    expect(k.kpi_total_customers.newMonth).toBe(2);

    expect(k.kpi_pending_orders.count).toBe(1);
    expect(k.kpi_pending_orders.soon).toBe(1);
    expect(k.kpi_new_orders_week.count).toBe(1);

    const og = (await report({ dataset: 'old_gold', range: { preset: 'today' }, measures: [{ field: 'fine_weight', agg: 'sum' }, { field: 'value', agg: 'sum' }] })).totals;
    expect(k.kpi_old_gold_today.count).toBe(1);
    expect(n(k.kpi_old_gold_today.fine)).toBeCloseTo(n(og.sum_fine_weight), 3);
    expect(n(k.kpi_old_gold_today.value)).toBeCloseTo(n(og.sum_value), 2);

    const owed = (await report({ dataset: 'customers', measures: [{ field: 'owed', agg: 'sum' }] })).totals;
    expect(n(k.kpi_receivables.amount)).toBeCloseTo(n(owed.sum_owed), 2);
    expect(k.kpi_receivables.moves).toHaveLength(7);

    const desk = await ok('/api/accounts/desk');
    expect(n(k.kpi_cash_bank.cash) + n(k.kpi_cash_bank.bank)).toBeCloseTo(n(desk.money.total), 2);

    const pnl = await ok(`/api/accounts/reports/profit-loss?from=${today.slice(0, 8)}01&to=${today}`);
    expect(n(k.kpi_month_profit.grossProfit)).toBeCloseTo(n(pnl.grossProfit), 2);
    expect(k.kpi_girvi.count).toBe(0);
  });

  it('works out only the figures asked for, for another day or another branch', async () => {
    const one = await ok('/api/dashboard/summary?widgets=kpi_todays_sales');
    expect(Object.keys(one.kpis)).toEqual(['kpi_todays_sales']);
    const tomorrow = await ok(`/api/dashboard/summary?widgets=kpi_todays_sales&date=${addDays(today, 1)}`);
    expect(tomorrow.kpis.kpi_todays_sales.count).toBe(0);
    expect(n(tomorrow.kpis.kpi_todays_sales.prev)).toBeCloseTo(n(one.kpis.kpi_todays_sales.amount), 2);
    const elsewhere = await ok('/api/dashboard/summary?widgets=kpi_todays_sales,kpi_stock_value&branchId=00000000-0000-4000-8000-000000000000');
    expect(elsewhere.kpis.kpi_todays_sales.count).toBe(0);
    expect(n(elsewhere.kpis.kpi_stock_value.value)).toBe(0);
    const here = await ok(`/api/dashboard/summary?widgets=kpi_todays_sales&branchId=${main}`);
    expect(here.kpis.kpi_todays_sales.count).toBe(3);
  });

  it('draws the charts from the same figures as Reports', async () => {
    const c = (await ok('/api/dashboard/charts?days=30')).charts;
    const from = addDays(today, -29);
    expect(c.chart_sales_trend).toHaveLength(30);
    expect(c.chart_sales_trend[29].date).toBe(today);
    expect(c.chart_sales_trend[29].bills).toBe(3);

    const byCat = await report({ dataset: 'sales_lines', range: { preset: 'custom', from, to: today }, groupBy: ['category'], measures: [{ field: 'line_total', agg: 'sum' }] });
    expect(c.chart_category_sales).toHaveLength(byCat.rows.length);
    expect(n(c.chart_category_sales[0].value)).toBeCloseTo(n(byCat.totals.sum_line_total), 2);

    const byMode = await report({ dataset: 'sales_payments', range: { preset: 'custom', from, to: today }, groupBy: ['mode'], measures: [{ field: 'amount', agg: 'sum' }] });
    const total = (rows: Body[]) => rows.reduce((t, r) => t + n(r.value ?? r.sum_amount), 0);
    expect(total(c.chart_payment_split)).toBeCloseTo(total(byMode.rows), 2);

    expect(c.chart_city_customers.map((r: Body) => r.label).sort()).toEqual(['Pune', 'Surat']);
    expect(c.chart_stock_ageing.map((r: Body) => r.label)).toEqual(['0–30 days', '31–90 days', '91–180 days', '181–365 days', 'Over 365 days']);
    expect(c.chart_stock_ageing[0].pieces).toBe(3);

    const week = await ok('/api/dashboard/charts?days=7&widgets=chart_sales_trend');
    expect(Object.keys(week.charts)).toEqual(['chart_sales_trend']);
    expect(week.charts.chart_sales_trend).toHaveLength(7);
    expect((await call('/api/dashboard/charts?days=12')).status).toBe(400);
  });

  it('lists what needs attention, with limits and switches from the settings', async () => {
    const a = (await ok('/api/dashboard/alerts')).alerts;
    const keys = a.map((x: Body) => x.key);
    expect(keys).toEqual(expect.arrayContaining(['orders_due', 'no_huid', 'tags_unprinted']));
    expect(keys).not.toContain('rate_not_set');                       // today's rate was entered
    expect(a.find((x: Body) => x.key === 'no_huid').count).toBe(3);
    expect(a.find((x: Body) => x.key === 'orders_due').link.report).toBe('cat:orders-open');
    const order = { danger: 0, warning: 1, info: 2 } as Record<string, number>;
    expect(a.map((x: Body) => order[x.severity])).toEqual([...a.map((x: Body) => order[x.severity])].sort());

    // Low stock: the rings category sold today and has 3 pieces left; a limit of 5 flags it.
    await ok('/api/settings/config/dashboard.low_stock_pieces', { value: 5 }, 'PUT');
    await ok('/api/settings/config/dashboard.alerts_off', { value: ['orders_due'] }, 'PUT');
    const b = (await ok('/api/dashboard/alerts')).alerts;
    expect(b.map((x: Body) => x.key)).not.toContain('orders_due');
    const low = b.find((x: Body) => x.key === 'low_stock');
    expect(low.description).toContain(`Rings ${run} (3)`);
    expect((await call('/api/settings/config/dashboard.age_buckets', { value: '90, 30' }, 'PUT')).status).toBe(400);
    await ok('/api/settings/config/dashboard.alerts_off', { value: [] }, 'PUT');

    // Tomorrow, the order promised for tomorrow is due today; the day after, it is late.
    const late = (await ok(`/api/dashboard/alerts?date=${addDays(today, 2)}`)).alerts;
    expect(late.find((x: Body) => x.key === 'orders_late').count).toBe(1);
  });

  it('shows the day’s activity from every module, limited to what the person may see', async () => {
    const all = (await ok('/api/dashboard/activity')).items;
    const titles = all.map((x: Body) => x.title).join(' | ');
    for (const b of bills) expect(titles).toContain(b.doc_number);
    expect(all.some((x: Body) => x.kind === 'order')).toBe(true);
    expect(all.some((x: Body) => x.module === 'oldgold')).toBe(true);
    expect(all.some((x: Body) => x.module === 'purchase')).toBe(true);
    expect([...all].sort((p: Body, q: Body) => (p.at === q.at ? (p.id < q.id ? 1 : -1) : p.at < q.at ? 1 : -1)).map((x: Body) => x.id)).toEqual(all.map((x: Body) => x.id));

    const theirs = (await ok('/api/dashboard/activity', undefined, undefined, viewer)).items;
    expect(theirs.length).toBeGreaterThan(0);
    expect(theirs.every((x: Body) => x.module === 'pos')).toBe(true);
  });

  it('gives each role only its own figures, and no Dashboard without the permission', async () => {
    const s = await ok('/api/dashboard/summary', undefined, undefined, viewer);
    expect(Object.keys(s.kpis)).toEqual(['kpi_todays_sales']);
    const c = await ok('/api/dashboard/charts', undefined, undefined, viewer);
    expect(Object.keys(c.charts).sort()).toEqual(['chart_category_sales', 'chart_payment_split', 'chart_sales_trend']);
    const a = (await ok('/api/dashboard/alerts', undefined, undefined, viewer)).alerts;
    expect(a.every((x: Body) => ['unpaid_bills', 'rate_not_set', 'report_alerts'].includes(x.key))).toBe(true);
    expect((await call('/api/dashboard/summary', undefined, undefined, outsider)).status).toBe(403);
    expect((await call('/api/dashboard/layout/defaults', undefined, undefined, viewer)).status).toBe(403);
  });

  it('keeps my layout, falls back to my role’s and then everyone’s, and lists my pinned reports', async () => {
    await ok('/api/reports/pins', { refs: ['cat:sales-today'] }, 'PUT', viewer);
    let v = await ok('/api/dashboard/layout', undefined, undefined, viewer);
    expect(v.source).toBe('built_in');
    expect(v.layout).toBeNull();
    expect(v.pins).toEqual([{ ref: 'cat:sales-today', name: 'Today’s sales', description: expect.any(String) }]);
    expect(v.rules.weightUnit).toBe('g');
    expect(v.canManageDefaults).toBe(false);

    const layout = (ids: string[]) => ({ widgets: ids.map((id, i) => ({ id, visible: true, order: i + 1 })), settings: { salesTrendDays: 7 } });
    await ok('/api/dashboard/layout/defaults/*', layout(['kpi_todays_sales']), 'PUT');
    expect((await ok('/api/dashboard/layout', undefined, undefined, viewer)).source).toBe('everyone');
    const roles = await ok('/api/dashboard/layout/defaults/counter', layout(['kpi_todays_sales', 'report_cat:sales-today']), 'PUT');
    expect(roles.find((r: Body) => r.code === 'counter').has_default).toBe(true);
    v = await ok('/api/dashboard/layout', undefined, undefined, viewer);
    expect(v.source).toBe('role');
    expect(v.layout.widgets.map((w: Body) => w.id)).toEqual(['kpi_todays_sales', 'report_cat:sales-today']);

    await ok('/api/dashboard/layout', layout(['chart_sales_trend', 'kpi_todays_sales']), 'PUT', viewer);
    v = await ok('/api/dashboard/layout', undefined, undefined, viewer);
    expect(v.source).toBe('mine');
    expect(v.layout.settings.salesTrendDays).toBe(7);
    expect((await ok('/api/dashboard/layout', undefined, 'DELETE', viewer)).source).toBe('role');
    await ok('/api/dashboard/layout/defaults/counter', undefined, 'DELETE');
    expect((await ok('/api/dashboard/layout', undefined, undefined, viewer)).source).toBe('everyone');

    expect((await call('/api/dashboard/layout', { widgets: [{ id: 'drop table', visible: true, order: 1 }] }, 'PUT')).status).toBe(400);
    expect((await call('/api/dashboard/layout/defaults/nobody', layout(['kpi_todays_sales']), 'PUT')).body.error.message).toContain('no role');
  });
});
