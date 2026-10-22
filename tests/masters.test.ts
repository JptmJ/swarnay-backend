import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

const SHOP = 'masterstest';

describe('Masters', { timeout: 60_000 }, () => {
  let server: Server;
  let base: string;
  let token: string;
  let tenantId: string;
  let mainBranch: string;
  const run = Date.now().toString(36).toUpperCase();

  async function call(path: string, body?: unknown, method?: string) {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-branch-id': mainBranch },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  const patch = (path: string, body: unknown) => call(path, body, 'PATCH');

  beforeAll(async () => {
    const existing = await asPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from tenant where code = $1`, [SHOP]));
    const provisioned = existing ? null : await provisionTenant({
      code: SHOP, legalName: 'Masters Test Jewellers', displayName: 'Masters Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Masters Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    });
    tenantId = existing?.id ?? provisioned!.tenantId;
    const owner = await asPlatform((tx) => tx.one<{ id: string; tv: number; branch: string }>(
      `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
         from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]));
    mainBranch = owner.branch;
    await asPlatform(async (tx) => {
      await tx.query(`update app_user set must_change_password = false where id = $1`, [owner.id]);
      // Earlier runs change the invoice series; start each run from the standard one.
      await tx.query(`delete from numbering_series where tenant_id = $1 and branch_id is not null`, [tenantId]);
      await tx.query(`update numbering_series set prefix = 'INV-{FYS}-', padding = 5, next_number = 1, reset_period = 'financial_yearly', current_period = null
                       where tenant_id = $1 and doc_type = 'sales_invoice'`, [tenantId]);
    });
    token = signAccessToken({ sub: owner.id, tenantId, tv: owner.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('gives a new business one shared counter per document type and a head office', async () => {
    const rows = await asPlatform((tx) => tx.query<{ branch_id: string | null }>(
      `select branch_id from numbering_series where tenant_id = $1 and doc_type = 'sales_invoice'`, [tenantId]));
    expect(rows).toEqual([{ branch_id: null }]);
    const main = (await call(`/api/master/branches/${mainBranch}`)).body;
    expect(main.is_head_office).toBe(true);
  });

  it('branches: GSTIN sets the state, head office moves, the last branch stays active', async () => {
    const created = await call('/api/master/branches', {
      code: `B${run}`, name: 'Surat Boutique', gstin: '24AAACB1234C1Z5', city: 'Surat', phone: '98250 11223', is_head_office: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.state_code).toBe('24');
    expect(created.body.phone).toBe('+919825011223');
    expect((await call(`/api/master/branches/${mainBranch}`)).body.is_head_office).toBe(false);

    expect((await patch(`/api/master/branches/${created.body.id}`, { is_active: false })).status).toBe(200);
    const refused = await patch(`/api/master/branches/${mainBranch}`, { is_active: false });
    expect(refused.body.error.code).toBe('last_branch');
    await patch(`/api/master/branches/${mainBranch}`, { is_head_office: true });
  });

  it('purities: karat follows fineness and one default per metal', async () => {
    const gold = (await call('/api/master/metals?search=GOLD')).body.rows.find((m: { code: string }) => m.code === 'GOLD');
    const a = await call('/api/master/purities', { metal_id: gold.id, name: `20K ${run}`, fineness_percent: '83.300', is_default: true, default_unit: 'tola' });
    expect(a.status).toBe(201);
    expect(a.body.karat).toBe('20.00');
    expect(a.body.default_unit).toBe('tola');
    const b = await call('/api/master/purities', { metal_id: gold.id, name: `21K ${run}`, fineness_percent: '87.500', is_default: true });
    expect(b.body.is_default).toBe(true);
    expect((await call(`/api/master/purities/${a.body.id}`)).body.is_default).toBe(false);
  });

  it('rates: every purity is listed, a new rate shows with the day’s change', async () => {
    const gold = (await call('/api/master/metals?search=GOLD')).body.rows.find((m: { code: string }) => m.code === 'GOLD');
    const purity = (await call('/api/master/purities', { metal_id: gold.id, name: `19K ${run}`, fineness_percent: '79.200' })).body;
    let row = (await call('/api/master/rates/current')).body.rates.find((r: { purity_id: string }) => r.purity_id === purity.id);
    expect(row.rate_per_gram).toBeNull();

    await asPlatform((tx) => tx.query(
      `insert into metal_rate (id, tenant_id, metal_id, purity_id, rate_per_gram, effective_from)
       values (gen_random_uuid(), $1, $2, $3, 5000, now() - interval '2 days')`, [tenantId, gold.id, purity.id]));
    expect((await call('/api/master/rates', { metal_id: gold.id, purity_id: purity.id, rate_per_gram: '5100.00', buying_rate_per_gram: '4950.00' })).status).toBe(201);
    row = (await call('/api/master/rates/current')).body.rates.find((r: { purity_id: string }) => r.purity_id === purity.id);
    expect(row.rate_per_gram).toBe('5100.0000');
    expect(row.previous_rate_per_gram).toBe('5000.0000');

    const wrong = await call('/api/master/rates', { metal_id: gold.id, purity_id: purity.id, rate_per_gram: '5100.00', buying_rate_per_gram: '5200.00' });
    expect(wrong.status).toBe(400);
  });

  it('categories: sub-categories, metals and a making rule', async () => {
    const created = await call('/api/master/categories', {
      code: `c${run}`, name: 'Temple Jewellery', hsn_code: '7113', sub_categories: ['Antique', 'Nakshi'], applicable_metals: ['gold'],
    });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe(`C${run}`);
    expect(created.body.sub_categories).toEqual(['Antique', 'Nakshi']);
    expect(created.body.applicable_metals).toEqual(['GOLD']);
    const rule = (await call('/api/master/price-rules', { code: `W${run}`, name: 'Wastage 8%', applies_to: 'wastage', basis: 'percent', rate: '8' })).body;
    const refused = await patch(`/api/master/categories/${created.body.id}`, { making_rule_id: rule.id });
    expect(refused.status).toBe(400);
  });

  it('customers: code, phone and state are filled in; lists carry spend and schemes', async () => {
    const created = await call('/api/master/parties', { name: `Kavya Iyer ${run}`, is_customer: true, phone: '9876501234', gstin: '27AAACK1234C1Z5' });
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^C\d{6}$/);
    expect(created.body.phone).toBe('+919876501234');
    expect(created.body.state_code).toBe('27');
    const found = (await call(`/api/master/parties?is_customer=true&search=Kavya Iyer ${run}`)).body.rows.find((r: { id: string }) => r.id === created.body.id);
    expect(found).toMatchObject({ lifetime_spend: '0', active_schemes: 0 });
  });

  it('karigars: next code, paged by name, active orders counted', async () => {
    const created = await call('/api/master/karigars', { name: `Ramesh Soni ${run}`, speciality: 'Kundan Meena', standard_ghat_percent: '1.5' });
    expect(created.body.code).toMatch(/^K\d{4}$/);
    const page = (await call(`/api/master/karigars?search=${run}`)).body;
    expect(page.rows[0]).toMatchObject({ id: created.body.id, active_orders: 0 });
    expect(page).toHaveProperty('nextCursor');
  });

  it('bill numbers: preview is the real next number, moves only forward, per branch adds the code', async () => {
    const list = (await call('/api/master/numbering')).body.rows;
    const invoice = list.find((s: { docType: string }) => s.docType === 'sales_invoice');
    expect(invoice).toMatchObject({ prefix: 'INV', financialYearFormat: 'YY-YY', branchScope: 'shared', digitPadding: 5 });
    expect(invoice.nextNumberPreview).toMatch(/^INV-\d{2}-\d{2}-\d{5}$/);

    const moved = await patch(`/api/master/numbering/${invoice.id}`, {
      prefix: 'BILL', digitPadding: 4, lastNumber: 1200, financialYearReset: true, financialYearFormat: 'YYYY', branchScope: 'per_branch',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.nextNumberPreview).toMatch(/^BILL-MAIN-\d{4}-0001$/);
    expect(moved.body.branchScope).toBe('per_branch');

    const shared = await patch(`/api/master/numbering/${invoice.id}`, {
      prefix: 'BILL', digitPadding: 4, lastNumber: 1200, financialYearReset: true, financialYearFormat: 'YYYY', branchScope: 'shared',
    });
    expect(shared.body.nextNumberPreview).toMatch(/^BILL-\d{4}-1201$/);
    const back = await patch(`/api/master/numbering/${invoice.id}`, {
      prefix: 'BILL', digitPadding: 4, lastNumber: 5, financialYearReset: true, financialYearFormat: 'YYYY', branchScope: 'shared',
    });
    expect(back.status).toBe(400);
    const noYear = await patch(`/api/master/numbering/${invoice.id}`, {
      prefix: 'BILL', digitPadding: 4, financialYearReset: true, financialYearFormat: 'none', branchScope: 'shared',
    });
    expect(noYear.status).toBe(400);
  });

  it('print formats: six standard ones on first use; switches save one at a time', async () => {
    const rows = (await call('/api/master/document-formats')).body.rows;
    expect(rows.length).toBe(6);
    const thermal = rows.find((r: { code: string }) => r.code === 'invoice-thermal');
    const saved = await patch(`/api/master/document-formats/${thermal.id}`, { field_toggles: { showBankDetails: true }, paper_size: 'Thermal_3inch' });
    expect(saved.body.field_toggles).toMatchObject({ showBankDetails: true, showGstSplit: true });
    expect(saved.body.paper_size).toBe('Thermal_3inch');
    expect((await call('/api/master/document-formats')).body.rows.length).toBe(6);
  });

  it('import: saves good rows, names bad ones by row, and a second run updates', async () => {
    const first = await call('/api/master/import/customers', { rows: [
      { code: `IMP${run}1`, name: 'Anil Mehta', phone: '98200 11111', city: 'Pune' },
      { code: `IMP${run}2`, name: 'Bad PAN', pan: '12345' },
      { name: 'No Code Customer', phone: '98200 22222' },
      { code: `IMP${run}1`, name: 'Anil Mehta (again)', city: 'Mumbai' },
    ] });
    expect(first.body).toMatchObject({ received: 4, inserted: 2, updated: 0 });
    expect(first.body.failed.map((f: { row: number }) => f.row)).toEqual([2, 3]);

    const second = await call('/api/master/import/customers', { rows: [{ code: `IMP${run}1`, name: 'Anil Mehta', email: 'anil@x.in', city: '' }], firstRow: 10 });
    expect(second.body).toMatchObject({ inserted: 0, updated: 1, failed: [] });
    const anil = (await call(`/api/master/parties?search=IMP${run}1`)).body.rows[0];
    expect(anil).toMatchObject({ name: 'Anil Mehta', email: 'anil@x.in', city: 'Mumbai' });

    const items = await call('/api/master/import/items', { rows: [
      { code: `IT${run}`, name: 'Plain Bangle', category_code: 'NOPE' },
      { code: `IT${run}B`, name: 'Plain Chain', metal_code: 'gold', tracking: 'piece' },
    ] });
    expect(items.body.inserted).toBe(1);
    expect(items.body.failed[0].message).toMatch(/Import categories first/);
  });

  it('import: 1,000 customers in one call', async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `Bulk ${run} ${i}`, phone: `97${String(i).padStart(8, '0')}` }));
    const started = Date.now();
    const res = await call('/api/master/import/customers', { rows });
    expect(res.body).toMatchObject({ received: 1000, inserted: 1000, failed: [] });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
