import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';
import { DATASETS } from '../src/modules/reports/datasets.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Reports on a fresh business with real trade in it: every ready report and
 * every field of every data set must run, the figures must agree with the
 * documents they come from, and people see only what they are allowed to.
 */
describe('Reports', { timeout: 300_000 }, () => {
  let server: Server;
  let base: string;
  let owner: string;
  let viewer: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36);
  const SHOP = `rep${run}`;
  const ids: Record<string, string> = {};
  const n = (v: unknown) => Number(v);
  const bills: Body[] = [];

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
  const report = (spec: Body, extra: Body = {}, as = owner) => ok('/api/reports/run', { spec, ...extra }, undefined, as);

  beforeAll(async () => {
    tenantId = (await provisionTenant({
      code: SHOP, legalName: 'Reports Test Jewellers', displayName: 'Reports Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Reports Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const users = await asPlatform(async (tx) => {
      await tx.query(`set local app.bypass_rls = 'on'`);
      const o = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [o.id]);
      // A viewer who may see sales reports, without cost, and cannot design or manage alerts.
      const role = await tx.one<{ id: string }>(
        `insert into role (id, tenant_id, code, name, role_type) values (gen_random_uuid(), $1, 'viewer', 'Report Viewer', 'staff') returning id`, [tenantId]);
      await tx.query(`insert into role_permission (id, tenant_id, role_id, permission)
                      select gen_random_uuid(), $1, $2, p from unnest(array['reports.view', 'reports.sales.view']) p`, [tenantId, role.id]);
      const v = await tx.one<{ id: string; tv: number }>(
        `insert into app_user (id, tenant_id, email, full_name, password_hash, is_active, must_change_password)
         values (gen_random_uuid(), $1, $2, 'Viewer', 'x', true, false) returning id, token_version as tv`, [tenantId, `viewer@${SHOP}.in`]);
      await tx.query(`insert into user_role (id, tenant_id, user_id, role_id, branch_id) values (gen_random_uuid(), $1, $2, $3, null)`, [tenantId, v.id, role.id]);
      return { o, v };
    });
    main = users.o.branch;
    ids.owner = users.o.id; ids.viewer = users.v.id;
    owner = signAccessToken({ sub: users.o.id, tenantId, tv: users.o.tv });
    viewer = signAccessToken({ sub: users.v.id, tenantId, tv: users.v.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Some real trade: a purchase, tagging, three bills, a return, old gold.
    const gold = (await ok('/api/master/metals')).rows.find((m: Body) => m.code === 'GOLD');
    ids.gold = gold.id;
    ids.k22 = (await ok(`/api/master/purities?metal_id=${gold.id}`)).rows.find((r: Body) => r.code === '22K').id;
    ids.counter = (await ok(`/api/master/locations?branch_id=${main}`)).rows.find((l: Body) => l.code === 'COUNTER').id;
    ids.ring = (await ok('/api/master/items', { code: `RNG${run}`, name: `Ring ${run}`, metal_id: gold.id, tracking: 'piece', hsn_code: '7113' })).id;
    await ok('/api/master/price-rules', { code: `MK${run}`, name: 'Ring making', applies_to: 'making', basis: 'per_gram', rate: '500', slabs: [],
      slab_mode: 'whole', item_id: ids.ring, priority: 0, effective_from: '2026-01-01', is_active: true });
    ids.supplier = (await ok('/api/master/parties', { name: `Shah ${run}`, is_supplier: true, phone: '9820012345', gstin: '27ABCDE1234F1Z5' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Neha ${run}`, is_customer: true, phone: '9820054321', city: 'Surat' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Ravi ${run}`, is_customer: true, phone: '9820054322', city: 'Pune' })).id;
    await ok('/api/master/rates', { metal_id: gold.id, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI']) ids[c] = methods.find((m: Body) => m.code === c).id;
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const inward = await ok('/api/purchase/inwards', {
      supplierId: ids.supplier, locationId: ids.counter,
      lines: [{ itemId: ids.ring, purityId: ids.k22, pieces: 5, grossWeight: '50.000', metalBasis: 'rupee', ratePerGram: '6900', makingRate: '400' }],
      bill: { supplierInvoiceNumber: `B-${run}`, supplierInvoiceDate: today },
    });
    const pieces = (await ok('/api/tagging/pieces', { pieces: [0, 1, 2, 3, 4].map(() => ({ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '10.000', taggingLotId: inward.lines[0].tagging_lot_id })) })).rows;
    ids.pieces = pieces.map((p: Body) => p.id).join(',');
    bills.push(await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: pieces[0].id }], tenders: [{ paymentMethodId: ids.UPI, amount: '40000', reference: 'U1' }] }));
    bills.push(await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: pieces[1].id }], discount: '300', tenders: [{ paymentMethodId: ids.CASH, amount: '20000' }] }));
    bills.push(await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: pieces[2].id }], tenders: [] }));
    const detail = await ok(`/api/pos/invoices/${bills[0]!.id}`);
    await ok('/api/pos/returns', { invoiceId: bills[0]!.id, settlement: 'credit_note', reason: 'size', lines: [{ invoiceLineId: detail.lines[0].id }] });
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('opens with the categories and ready reports this person may see', async () => {
    const o = await ok('/api/reports');
    expect(o.reports.length).toBeGreaterThan(60);
    expect(o.categories.map((c: Body) => c.key)).toEqual(expect.arrayContaining(['sales', 'stock', 'purchase', 'girvi', 'customers', 'compliance', 'accounts']));
    expect(o.canDesign).toBe(true);
    const v = await ok('/api/reports', undefined, undefined, viewer);
    expect(v.categories.map((c: Body) => c.key)).toEqual(['sales']);
    expect(v.reports.every((r: Body) => r.category === 'sales')).toBe(true);
    expect(v.canSeeCost).toBe(false);
  });

  it('runs every ready report', async () => {
    const o = await ok('/api/reports');
    const failures: string[] = [];
    for (const r of o.reports.filter((x: Body) => x.spec)) {
      const res = await call('/api/reports/run', { ref: `cat:${r.key}` });
      if (res.status !== 200) failures.push(`${r.key}: ${JSON.stringify(res.body)}`);
    }
    expect(failures).toEqual([]);
    const linked = await call('/api/reports/run', { ref: 'cat:acc-pnl' });
    expect(linked.body.error.code).toBe('report_is_link');
  });

  it('runs every field of every data set, as a column and as a grouping', async () => {
    const sets = await ok('/api/reports/datasets');
    expect(sets.length).toBe(DATASETS.length);
    const failures: string[] = [];
    for (const d of sets) {
      const all = await call('/api/reports/run', { spec: { dataset: d.key, columns: d.fields.map((f: Body) => f.key), range: { preset: 'all' } } });
      if (all.status !== 200) failures.push(`${d.key} columns: ${JSON.stringify(all.body)}`);
      for (const f of d.fields.filter((x: Body) => x.dim)) {
        const g = await call('/api/reports/run', { spec: { dataset: d.key, groupBy: [f.type === 'date' ? `${f.key}:month` : f.key],
          measures: [{ field: '*', agg: 'count' }, ...d.fields.filter((x: Body) => ['money', 'weight'].includes(x.type)).slice(0, 2).map((x: Body) => ({ field: x.key, agg: 'sum' }))],
          range: { preset: 'all' } } });
        if (g.status !== 200) failures.push(`${d.key} by ${f.key}: ${JSON.stringify(g.body)}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('agrees with the bills it comes from', async () => {
    const totalOfBills = bills.reduce((s, b) => s + n(b.total_amount), 0);
    const register = await ok('/api/reports/run', { ref: 'cat:sales-register' });
    expect(register.rowCount).toBe(3);
    expect(n(register.totals.total)).toBeCloseTo(totalOfBills, 2);
    expect(n(register.totals.balance)).toBeCloseTo(bills.reduce((s, b) => s + n(b.balance_amount), 0) - n(bills[0]!.balance_amount), 0);
    const lines = await report({ dataset: 'sales_lines', measures: [{ field: 'taxable', agg: 'sum' }, { field: 'discount', agg: 'sum' }, { field: 'pieces', agg: 'sum' }] });
    expect(n(lines.totals.sum_taxable)).toBeCloseTo(bills.reduce((s, b) => s + n(b.taxable_amount), 0), 2);
    expect(n(lines.totals.sum_discount)).toBeCloseTo(300, 2);
    expect(n(lines.totals.sum_pieces)).toBe(3);
    const byCustomer = await report({ dataset: 'sales_bills', groupBy: ['customer'], measures: [{ field: '*', agg: 'count' }, { field: 'total', agg: 'sum' }] });
    expect(byCustomer.rows.find((r: Body) => r.customer === `Neha ${run}`).count).toBe(2);
    expect(byCustomer.rowCount).toBe(2);
    const modes = await ok('/api/reports/run', { ref: 'cat:sales-by-mode' });
    expect(n(modes.rows.find((r: Body) => /UPI/i.test(r.mode)).sum_amount)).toBeCloseTo(40000, 2);
    const stock = await report({ dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_stock' }], measures: [{ field: 'pieces', agg: 'sum' }] });
    expect(n(stock.totals.sum_pieces)).toBe(3); // 5 tagged, 3 sold, 1 returned
    const purchases = await ok('/api/reports/run', { ref: 'cat:purchase-register' });
    expect(n(purchases.totals.net_weight)).toBeCloseTo(50, 3);
    const returns = await ok('/api/reports/run', { ref: 'cat:sales-returns' });
    expect(returns.rowCount).toBe(1);
    const customers = await ok('/api/reports/run', { ref: 'cat:customers-top' });
    expect(customers.rows[0].customer).toMatch(/Neha|Ravi/);
    const position = await ok('/api/reports/run', { ref: 'cat:stock-movement-summary' });
    const ring = position.rows.find((r: Body) => r.item === `Ring ${run}`);
    expect(n(ring.sum_closing)).toBeCloseTo(n(ring.sum_opening) + n(ring.sum_in) - n(ring.sum_out), 3);
  });

  it('filters, groups by date, compares, sorts, limits and pages', async () => {
    const eq = await report({ dataset: 'sales_bills', filters: [{ field: 'customer', op: 'eq', value: `Ravi ${run}` }] });
    expect(eq.rowCount).toBe(1);
    const inList = await report({ dataset: 'sales_bills', filters: [{ field: 'customer', op: 'in', value: [`Ravi ${run}`, `Neha ${run}`] }] });
    expect(inList.rowCount).toBe(3);
    const between = await report({ dataset: 'sales_bills', filters: [{ field: 'total', op: 'between', value: [1, 1e9] }] });
    expect(between.rowCount).toBe(3);
    const contains = await report({ dataset: 'sales_bills', filters: [{ field: 'customer_city', op: 'contains', value: 'sur' }] });
    expect(contains.rowCount).toBe(2);
    const empty = await report({ dataset: 'sales_bills', filters: [{ field: 'customer_pan', op: 'empty' }] });
    expect(empty.rowCount).toBe(3);
    const monthly = await report({ dataset: 'sales_bills', groupBy: ['date:month'], measures: [{ field: 'total', agg: 'sum' }], compare: true, range: { preset: 'this_month' } });
    expect(monthly.rows.length).toBe(1);
    expect(monthly.rows[0]).toHaveProperty('prev_sum_total');
    expect(monthly.previousTotals).toBeTruthy();
    expect(monthly.range.previous).toBeTruthy();
    const having = await report({ dataset: 'sales_bills', groupBy: ['customer'], measures: [{ field: '*', agg: 'count' }], having: [{ key: 'count', op: 'gte', value: 2 }] });
    expect(having.rows.map((r: Body) => r.customer)).toEqual([`Neha ${run}`]);
    const top = await report({ dataset: 'sales_bills', columns: ['bill', 'total'], sort: [{ key: 'total', dir: 'asc' }], limit: 1 });
    expect(top.rows.length).toBe(1);
    expect(n(top.totals.total)).toBeGreaterThan(n(top.rows[0].total)); // totals still cover every row
    const page = await ok('/api/reports/run', { spec: { dataset: 'sales_bills', columns: ['bill'] }, limit: 2, offset: 2 });
    expect([page.rows.length, page.rowCount, page.truncated]).toEqual([1, 3, false]);
    const ratio = await report({ dataset: 'sales_bills', groupBy: ['salesperson'], measures: [{ field: 'discount_percent', agg: 'sum' }] });
    expect(n(ratio.totals.discount_percent)).toBeGreaterThan(0);
    expect(n(ratio.totals.discount_percent)).toBeLessThan(5);
  });

  it('refuses what a data set does not have, and keeps cost from those who may not see it', async () => {
    expect((await call('/api/reports/run', { spec: { dataset: 'sales_bills', columns: ['nope'] } })).status).toBe(400);
    expect((await call('/api/reports/run', { spec: { dataset: 'nope' } })).status).toBe(400);
    expect((await call('/api/reports/run', { spec: { dataset: 'sales_bills', groupBy: ['total'] } })).status).toBe(400);
    expect((await call('/api/reports/run', { spec: { dataset: 'sales_bills', filters: [{ field: 'customer', op: 'eq' }] } })).status).toBe(400);
    // A value that looks like SQL is only ever a value.
    const inj = await report({ dataset: 'sales_bills', filters: [{ field: 'customer', op: 'eq', value: `x'; drop table party; --` }] });
    expect(inj.rowCount).toBe(0);
    expect((await call('/api/reports/run', { spec: { dataset: 'sales_lines', columns: ['margin'] } }, undefined, viewer)).status).toBe(403);
    expect((await call('/api/reports/run', { spec: { dataset: 'stock_pieces' } }, undefined, viewer)).status).toBe(403);
    expect((await call('/api/reports/run', { spec: { dataset: 'sales_bills' } }, undefined, viewer)).status).toBe(403); // cannot design
    const changed = await call('/api/reports/run', { ref: 'cat:sales-register', spec: { dataset: 'sales_bills', columns: ['bill', 'total'] } }, undefined, viewer);
    expect(changed.status).toBe(200); // but may change a ready report
    const fields = (await ok('/api/reports/datasets', undefined, undefined, viewer))[0].fields.map((f: Body) => f.key);
    expect(fields).not.toContain('margin');
  });

  it('saves, shares, pins and lists recent runs', async () => {
    const view = await ok('/api/reports/views', { name: 'Surat sales', baseKey: 'sales-register',
      spec: { dataset: 'sales_bills', columns: ['bill', 'customer', 'total'], filters: [{ field: 'customer_city', op: 'eq', value: 'Surat' }] } });
    expect(view.category).toBe('sales');
    const ran = await ok('/api/reports/run', { ref: `view:${view.id}` });
    expect([ran.name, ran.rowCount]).toEqual(['Surat sales', 2]);
    expect((await ok('/api/reports', undefined, undefined, viewer)).views.length).toBe(0);
    await ok(`/api/reports/views/${view.id}`, { name: 'Surat sales', spec: view.spec, isShared: true }, 'PUT');
    expect((await ok('/api/reports', undefined, undefined, viewer)).views.map((v: Body) => v.name)).toContain('Surat sales');
    expect((await call('/api/reports/views', { name: 'x', spec: { dataset: 'sales_bills', columns: ['nope'] } })).status).toBe(400);
    await ok('/api/reports/pins', { refs: ['cat:sales-today', `view:${view.id}`, 'cat:sales-today'] }, 'PUT');
    const o = await ok('/api/reports');
    expect(o.pins).toEqual(['cat:sales-today', `view:${view.id}`]);
    expect(o.recent.length).toBeGreaterThan(5);
    await ok(`/api/reports/views/${view.id}`, undefined, 'DELETE');
    expect((await ok('/api/reports')).pins).toEqual(['cat:sales-today']);
    const values = await ok('/api/reports/datasets/sales_bills/values/customer_city');
    expect(values.map((v: Body) => v.value)).toEqual(expect.arrayContaining(['Surat', 'Pune']));
  });

  it('raises an alert once when a figure crosses its limit, and delivers schedules to the inbox', async () => {
    const spec = { dataset: 'sales_bills', range: { preset: 'today' }, measures: [{ field: 'total', agg: 'sum' }] };
    const alert = await ok('/api/reports/alerts', { name: 'Sales crossed ₹1', spec, measureKey: 'sum_total', op: 'gt', threshold: 1, frequency: 'daily' });
    const checked = await ok(`/api/reports/alerts/${alert.id}/check`, {});
    expect(checked.last_state).toBe('triggered');
    await ok(`/api/reports/alerts/${alert.id}/check`, {});
    let box = await ok('/api/reports/inbox');
    expect(box.rows.filter((r: Body) => r.kind === 'alert').length).toBe(1); // not twice
    expect(box.rows[0].body).toMatch(/above 1/);
    const quiet = await ok('/api/reports/alerts', { name: 'Never', spec, measureKey: 'sum_total', op: 'gt', threshold: 1e12, frequency: 'hourly' });
    expect((await ok(`/api/reports/alerts/${quiet.id}/check`, {})).last_state).toBe('ok');
    expect((await call('/api/reports/alerts', { name: 'Grouped', spec: { ...spec, groupBy: ['customer'] }, measureKey: 'sum_total', op: 'gt', threshold: 1, frequency: 'daily' })).status).toBe(400);
    expect((await call('/api/reports/alerts', undefined, undefined, viewer)).status).toBe(403);

    const sched = await ok('/api/reports/schedules', { name: 'Evening sales', ref: 'cat:sales-today', frequency: 'daily', atTime: '20:00', recipientIds: [ids.owner, ids.viewer] });
    expect(new Date(sched.next_run_at).getTime()).toBeGreaterThan(Date.now());
    const sent = await ok(`/api/reports/schedules/${sched.id}/send`, {});
    expect(sent.delivered).toBe(2);
    box = await ok('/api/reports/inbox');
    const item = box.rows.find((r: Body) => r.kind === 'schedule');
    expect(item.snapshot.rows.length).toBe(3);
    const viewerBox = await ok('/api/reports/inbox', undefined, undefined, viewer);
    expect(viewerBox.unread).toBe(1);
    // The stock report cannot be sent to someone who may not see stock.
    const stockSched = await ok('/api/reports/schedules', { name: 'Stock', ref: 'cat:stock-summary', frequency: 'weekly', day: 1, atTime: '09:00', recipientIds: [ids.viewer] });
    expect((await ok(`/api/reports/schedules/${stockSched.id}/send`, {})).delivered).toBe(0);
    expect((await call('/api/reports/schedules', { name: 'Bad', ref: 'cat:sales-today', frequency: 'weekly', atTime: '09:00' })).status).toBe(400);

    // Due work runs when the inbox opens.
    const before = (await ok('/api/reports/inbox')).rows.length;
    await asPlatform(async (tx) => {
      await tx.query(`set local app.bypass_rls = 'on'`);
      await tx.query(`update report_schedule set next_run_at = now() - interval '1 minute' where id = $1`, [sched.id]);
    });
    const after = await ok('/api/reports/inbox');
    expect(after.rows.length).toBe(before + 1);
    await ok('/api/reports/inbox/all/read', {});
    expect((await ok('/api/reports/inbox')).unread).toBe(0);
  });
});
