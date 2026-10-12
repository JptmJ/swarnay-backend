import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform, asTenant } from '../src/core/db/client.js';
import { hashPassword, signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';
import { deleteTenantData } from '../src/modules/platform/demo.service.js';
import { newId } from '../src/core/util/id.js';
import { SUPER_ADMIN } from '../src/modules/platform/roles.js';
import { parseBalance, parseDate, parseNumber, parsePhone, parseWeight, purityHint, stateCodeFor } from '../src/modules/migration/normalize.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A shop moving over from its old software, the way the super admin does it:
 * messy headings, Indian number formats, Dr/Cr balances, a Tally trial
 * balance, old tag numbers, scheme members part-way through and loans still
 * out. Every file is checked, imported and — where it matters — undone, and
 * after each posting step the trial balance must still balance.
 */
describe('Data import', { timeout: 900_000 }, () => {
  let server: Server;
  let base: string;
  let operator: string;
  let owner: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36);
  const SHOP = `imp${run}`;
  const email = `import-op-${run}@swarnay.test`;
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const n = (v: unknown) => Number(v);

  async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? operator}`, 'x-branch-id': main },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  }
  const ok = async (path: string, init: { method?: string; body?: unknown; token?: string } = {}) => {
    const r = await call(path, init);
    if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const T = () => `/api/platform/tenants/${tenantId}/imports`;

  /** Waits for whatever job is running on a batch to finish, and returns the batch. */
  async function settle(batchId: string): Promise<Body> {
    for (let i = 0; i < 600; i++) {
      const b = await ok(`${T()}/${batchId}`);
      if (!b.running) return b;
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error('Job did not finish');
  }

  /** The whole flow for one file: create, send rows, optionally re-map, check. */
  async function stage(entity: string, columns: string[], rows: Array<Array<string | number>>, extra: { options?: Body; mapping?: Body; title?: string } = {}) {
    const batch = await ok(T(), { body: { entity, columns, sourceName: `${entity}.xlsx`, sourceFormat: 'xlsx', sourceSystem: 'Old Jewel Soft', options: extra.options, title: extra.title } });
    await ok(`${T()}/${batch.id}/rows`, { body: { firstRow: 2, rows: rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? '']))) } });
    if (extra.mapping) await ok(`${T()}/${batch.id}`, { method: 'PATCH', body: { mapping: { ...batch.mapping, ...extra.mapping } } });
    await ok(`${T()}/${batch.id}/validate`, { method: 'POST' });
    return settle(batch.id);
  }
  async function importBatch(batchId: string, leaveOutInvalid = false) {
    await ok(`${T()}/${batchId}/import`, { body: { leaveOutInvalid } });
    return settle(batchId);
  }
  const rowsOf = async (batchId: string, status?: string) =>
    (await ok(`${T()}/${batchId}/rows?limit=500${status ? `&status=${status}` : ''}`)).rows as Body[];

  /** The trial balance must always balance; returns closing balances by ledger code. */
  async function tb(): Promise<Map<string, number>> {
    const t = await ok('/api/accounts/reports/trial-balance', { token: owner });
    expect(t.balanced).toBe(true);
    return new Map<string, number>(t.rows.map((r: Body) => [r.code, n(r.closing)]));
  }
  const db = <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) => asTenant(tenantId, (tx) => tx.query<T>(sql, params));

  beforeAll(async () => {
    tenantId = (await provisionTenant({
      code: SHOP, legalName: 'Import Test Jewellers', displayName: 'Import Test', kind: 'retailer', stateCode: '27',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Import Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const o = await asPlatform(async (tx) => {
      await tx.query(`set local app.bypass_rls = 'on'`);
      const u = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [u.id]);
      await tx.query(
        `insert into platform_user (id, email, full_name, password_hash, role, is_active) values ($1, $2, 'Import Operator', $3, $4, true)`,
        [newId(), email, await hashPassword('operator-pass-1'), SUPER_ADMIN.code]);
      return u;
    });
    main = o.branch;
    owner = signAccessToken({ sub: o.id, tenantId, tv: o.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    operator = (await call('/api/platform/auth/login', { body: { email, password: 'operator-pass-1' } })).body.accessToken;
    // Today's board, so girvi articles can be valued and weight plans priced.
    await asTenant(tenantId, async (tx) => {
      const p = await tx.query<{ id: string; metal_id: string; code: string }>(`select id, metal_id, code from purity where code in ('22K', '24K', '18K')`);
      for (const x of p) {
        const rate = x.code === '24K' ? 12000 : x.code === '22K' ? 11000 : 9000;
        await tx.query(`insert into metal_rate (id, tenant_id, metal_id, purity_id, rate_per_gram, buying_rate_per_gram, source, effective_from)
                        values (gen_random_uuid(), $1, $2, $3, $4, $5, 'manual', now() - interval '400 days')`, [tenantId, x.metal_id, x.id, rate, rate - 300]);
      }
    });
  });

  afterAll(async () => {
    await deleteTenantData([tenantId]).catch(() => undefined);
    await asPlatform(async (tx) => {
      const op = `(select id from platform_user where email = $1)`;
      await tx.query(`delete from platform_audit_log where platform_user_id in ${op}`, [email]);
      await tx.query(`delete from platform_refresh_token where platform_user_id in ${op}`, [email]);
      await tx.query(`delete from platform_user where email = $1`, [email]);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('reads cells the way old software writes them', () => {
    expect(parseNumber('₹ 1,23,456.50 Dr')).toEqual({ ok: true, value: { value: '123456.50', side: 'Dr' } });
    expect(parseBalance('(2,500.00)')).toEqual({ ok: true, value: '-2500' });
    expect(parseBalance('12,000 Cr')).toEqual({ ok: true, value: '-12000' });
    expect(parseWeight('1 tola')).toMatchObject({ ok: true, value: '11.664' });
    expect(parseWeight('12.350 gms')).toMatchObject({ ok: true, value: '12.35' });
    expect(parseWeight('2.5', 'ct')).toMatchObject({ ok: true, value: '0.5' });
    expect(parseDate('31/03/2026')).toMatchObject({ ok: true, value: '2026-03-31' });
    expect(parseDate('5-Jan-26')).toMatchObject({ ok: true, value: '2026-01-05' });
    expect(parseDate('45383')).toMatchObject({ ok: true, value: '2024-04-01' });
    expect(parseDate('03/25/2026')).toMatchObject({ ok: true, value: '2026-03-25' }); // only makes sense month-first
    expect(parsePhone('098765 43210 / 9988776655')).toMatchObject({ ok: true, value: '+919876543210' });
    expect(parsePhone('9.87654321E9')).toMatchObject({ ok: true, value: '+919876543210' });
    expect(purityHint('22CT')).toMatchObject({ karat: 22 });
    expect(purityHint('916')).toMatchObject({ fineness: '91.6' });
    expect(stateCodeFor('Maharashtra')).toBe('27');
    expect(stateCodeFor('TN')).toBe('33');
  });

  it('lists every kind with its fields', async () => {
    const { kinds } = await ok('/api/platform/import-kinds');
    expect(kinds.map((k: Body) => k.key)).toEqual(expect.arrayContaining([
      'categories', 'items', 'customers', 'suppliers', 'karigars', 'scheme_plans', 'opening_pieces', 'opening_lots',
      'party_balances', 'metal_balances', 'karigar_balances', 'ledger_balances', 'scheme_accounts', 'girvi_loans']));
    const customers = kinds.find((k: Body) => k.key === 'customers');
    expect(customers.fields.find((f: Body) => f.key === 'name').required).toBe(true);
    expect(customers.defaults.onExisting).toBe('update');
  });

  let customerBatch: Body;
  it('brings customers over from messy headings, refusing only what cannot be saved', async () => {
    const columns = ['Cust Code', 'Customer Name', 'Mob No.', 'E-mail', 'GST No', 'State', 'DOB', 'Remarks'];
    customerBatch = await stage('customers', columns, [
      ['C000500', 'Ramesh Patel', '98765 43210', 'ramesh@example.com', '', 'Maharashtra', '12/08/1975', 'Old customer'],
      ['', 'Sunita Shah', '+91-99887-76655', 'not-an-email', '', 'Gujarat', '01-Jan-1980', ''],
      ['', 'Sunita Shah', '9988776655', '', '', '', '', 'Same person again'],
      ['', '', '9000000001', '', '', '', '', 'No name'],
      ['', 'Kavya Iyer', '9123456780', '', '27AABCK1234A1Z5', '', '', ''],
      ['', 'Anil Patel', '98765-43210', '', '', '', '', 'Shares Ramesh’s mobile'],
    ]);
    // Headings were recognised without being matched by hand.
    expect(customerBatch.mapping.name.column).toBe('Customer Name');
    expect(customerBatch.mapping.phone.column).toBe('Mob No.');
    expect(customerBatch.mapping.code.column).toBe('Cust Code');
    expect(customerBatch.status).toBe('validated');
    expect(customerBatch.valid_count).toBe(4);
    expect(customerBatch.invalid_count).toBe(2);
    const invalid = await rowsOf(customerBatch.id, 'invalid');
    expect(invalid.map((r) => r.row_number).sort()).toEqual([4, 5]);
    expect(JSON.stringify(invalid)).toMatch(/row 3/);
    const sunita = (await rowsOf(customerBatch.id)).find((r) => r.row_number === 3)!;
    expect(sunita.messages.some((m: Body) => m.level === 'warning' && /Email/.test(m.message))).toBe(true);
    const anil = (await rowsOf(customerBatch.id)).find((r) => r.row_number === 7)!;
    expect(JSON.stringify(anil.messages)).toMatch(/Shares a mobile number/);

    // Errors stop the import until they are fixed or left out.
    expect((await call(`${T()}/${customerBatch.id}/import`, { body: {} })).body.error.code).toBe('import_has_errors');
    customerBatch = await importBatch(customerBatch.id, true);
    expect(customerBatch.status).toBe('partial');
    expect(customerBatch.imported_count).toBe(4);
    const parties = await db<{ code: string; name: string; phone: string; state_code: string | null; email: string | null; date_of_birth: string | null }>(
      `select code, name, phone, state_code, email, date_of_birth::text from party where code <> 'WALKIN' order by name`);
    const ramesh = parties.find((p) => p.name === 'Ramesh Patel')!;
    expect(ramesh).toMatchObject({ code: 'C000500', phone: '+919876543210', state_code: '27', date_of_birth: '1975-08-12' });
    expect(parties.find((p) => p.name === 'Sunita Shah')).toMatchObject({ state_code: '24', email: null });
    expect(parties.find((p) => p.name === 'Kavya Iyer')!.state_code).toBe('27');
    // The party series now runs past the old codes, so the next customer added by hand cannot collide.
    const next = await ok('/api/master/parties', { token: owner, body: { name: 'Walk Later', is_customer: true } });
    expect(Number(String(next.code).slice(1))).toBeGreaterThan(500);
  });

  it('matches the same file again instead of duplicating it, and undoes cleanly', async () => {
    const columns = ['Customer Name', 'Mobile', 'City'];
    const again = await stage('customers', columns, [['Ramesh Patel', '9876543210', 'Pune'], ['Meera Joshi', '9811111111', 'Nashik']]);
    const rows = await rowsOf(again.id);
    expect(rows.find((r) => r.row_number === 2)!.action).toBe('update');
    expect(rows.find((r) => r.row_number === 3)!.action).toBe('insert');
    await importBatch(again.id);
    expect((await db(`select city from party where code = 'C000500'`))[0]!.city).toBe('Pune');

    await ok(`${T()}/${again.id}/undo`, { body: { reason: 'Wrong city column' } });
    const undone = await settle(again.id);
    expect(undone.status).toBe('undone');
    expect((await db(`select city from party where code = 'C000500'`))[0]!.city).toBeNull();
    expect(await db(`select 1 from party where name = 'Meera Joshi'`)).toHaveLength(0);
  });

  let piecesBatch: Body;
  it('takes opening stock with the old tag numbers, making items and categories on the way', async () => {
    const columns = ['Tag No', 'Item Name', 'Group', 'Tunch', 'Gross Wt', 'Net Wt', 'HUID', 'Making', 'MC Type', 'Cost'];
    piecesBatch = await stage('opening_pieces', columns, [
      ['A-1001', 'Ladies Ring', 'Rings', '22CT', '6.250', '6.050', 'ab12cd', '650', 'per gram', '62,000'],
      ['A-1002', 'Ladies Ring', 'Rings', '916', '5.100 gms', '', '', '', '', '51000'],
      ['A-1003', 'Temple Necklace', 'Necklaces', '22K', '42.5', '40.2', 'XY98ZZ', '8', '%', '4,10,000'],
      ['A-1003', 'Chain', 'Chains', '22K', '10', '', '', '', '', ''],
      ['A-1005', 'Bangle', 'Bangles', 'unknown purity', '20', '', '', '', '', ''],
    ]);
    expect(piecesBatch.valid_count).toBe(3);
    expect(piecesBatch.invalid_count).toBe(2);
    // Every shop starts with Rings and Necklaces, so only the two items are new.
    expect(piecesBatch.validation.willCreate).toEqual({ item: 2 });
    expect(piecesBatch.validation.totals.pieces).toBe('3');
    expect(piecesBatch.validation.unknown.map((u: Body) => u.value)).toContain('unknown purity');

    // The operator says what "unknown purity" meant, and the row comes good.
    const [k22] = await db<{ id: string }>(`select id from purity where code = '22K'`);
    await ok(`${T()}/${piecesBatch.id}`, { method: 'PATCH', body: { valueMap: { purity: { 'unknown purity': k22!.id } } } });
    await ok(`${T()}/${piecesBatch.id}/rows/5`, { method: 'PATCH', body: { skip: true } });
    await ok(`${T()}/${piecesBatch.id}/validate`, { method: 'POST' });
    piecesBatch = await settle(piecesBatch.id);
    expect(piecesBatch.valid_count).toBe(4);
    expect(piecesBatch.skipped_count).toBe(1);

    piecesBatch = await importBatch(piecesBatch.id);
    expect(piecesBatch.status).toBe('imported');
    const pieces = await db<{ tag_number: string; stone_weight: string; net_weight: string; huid: string | null; making_basis: string | null; status: string }>(
      `select tag_number, stone_weight, net_weight, huid, making_basis, status from stock_piece order by tag_number`);
    expect(pieces.map((p) => p.tag_number)).toEqual(['A-1001', 'A-1002', 'A-1003', 'A-1005']);
    expect(n(pieces[0]!.stone_weight)).toBeCloseTo(0.2, 3); // gross less net
    expect(pieces[0]!).toMatchObject({ huid: 'AB12CD', making_basis: 'per_gram', status: 'in_stock' });
    expect(pieces[2]!.making_basis).toBe('percent');
    const items = await db<{ name: string; tracking: string }>(`select name, tracking from item where name in ('Ladies Ring', 'Temple Necklace', 'Bangle')`);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.tracking === 'piece')).toBe(true);
    const books = await tb();
    expect(books.get('1200')).toBeCloseTo(62000 + 51000 + 410000, 2);
  });

  it('brings a Tally trial balance over in two passes: parties, then ledgers', async () => {
    const columns = ['Particulars', 'Under', 'Closing Balance'];
    const rows: Array<Array<string>> = [
      ['Ramesh Patel', 'Sundry Debtors', '25,000.00 Dr'],
      ['Sunita Shah', 'Sundry Debtors', '5,000.00 Cr'],
      ['Mumbai Bullion Traders', 'Sundry Creditors', '1,50,000.00 Cr'],
      ['Cash', 'Cash-in-Hand', '84,500.00 Dr'],
      ['HDFC Current A/c', 'Bank Accounts', '3,20,000.00 Dr'],
      ['Capital Account', 'Capital Account', '10,00,000.00 Cr'],
      ['Stock in Hand', 'Stock-in-Hand', '5,23,000.00 Dr'],
      ['Shop Deposit', 'Deposits (Asset)', '50,000.00 Dr'],
    ];
    const parties = await stage('party_balances', columns, rows, { mapping: { party: { column: 'Particulars' } } });
    expect(parties.valid_count).toBe(3);
    expect(parties.skipped_count).toBe(5);
    expect(parties.validation.willCreate).toMatchObject({ supplier: 1 });
    await importBatch(parties.id);
    let books = await tb();
    expect(books.get('1100')).toBeCloseTo(25000, 2);
    expect(books.get('2400')).toBeCloseTo(-5000, 2);
    expect(books.get('2000')).toBeCloseTo(-150000, 2);

    // The same file again changes nothing: balances are set, not added.
    const vouchersBefore = (await db(`select id from voucher where voucher_type = 'opening'`)).length;
    const repeat = await stage('party_balances', columns, rows, { mapping: { party: { column: 'Particulars' } } });
    await importBatch(repeat.id);
    expect((await db(`select id from voucher where voucher_type = 'opening'`)).length).toBe(vouchersBefore);

    const ledgers = await stage('ledger_balances', columns, rows, { mapping: { account: { column: 'Particulars' }, group: { column: 'Under' } } });
    const lrows = await rowsOf(ledgers.id);
    expect(lrows.filter((r) => r.status === 'skipped').map((r) => r.row_number).sort()).toEqual([2, 3, 4, 8]);
    expect(JSON.stringify(lrows.find((r) => r.row_number === 8)!.messages)).toMatch(/opening stock/);
    // "Deposits (Asset)" is not a group of the chart: the operator matches that ledger by hand.
    const deposit = lrows.find((r) => r.row_number === 9)!;
    expect(deposit.status).toBe('invalid');
    const [depositLedger] = await db<{ id: string }>(`select id from account where code = '1430'`);
    await ok(`${T()}/${ledgers.id}`, { method: 'PATCH', body: { valueMap: { account: { 'Shop Deposit': depositLedger!.id } } } });
    await ok(`${T()}/${ledgers.id}/validate`, { method: 'POST' });
    const checked = await settle(ledgers.id);
    expect(checked.invalid_count).toBe(0);
    await importBatch(ledgers.id);
    books = await tb();
    expect(books.get('1000')).toBeCloseTo(84500, 2);
    expect(books.get('3000')).toBeCloseTo(-1000000, 2);
    expect(books.get('1430')).toBeCloseTo(50000, 2);
    const hdfc = await db<{ code: string; parent: string }>(`select a.code, g.code as parent from account a join account g on g.id = a.parent_id where a.name = 'HDFC Current A/c'`);
    expect(hdfc[0]!.parent).toBe('G-BANK');
    expect(books.get(hdfc[0]!.code)).toBeCloseTo(320000, 2);
  });

  it('carries scheme members on from where their passbook stands', async () => {
    const plans = await stage('scheme_plans', ['Scheme Name', 'Duration', 'EMI', 'Bonus Installment'], [['Swarna 11+1', '11', '5,000', '1']]);
    await importBatch(plans.id);
    const joined = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 4); d.setUTCDate(5); return d.toISOString().slice(0, 10); })();
    const [y, m, d] = joined.split('-');
    const members = await stage('scheme_accounts', ['Member No', 'Member Name', 'Mobile', 'Scheme', 'Joining Date', 'Paid Installments', 'Total Paid'], [
      ['SN/OLD/77', 'Ramesh Patel', '9876543210', 'Swarna 11+1', `${d}/${m}/${y}`, '4', '20,000'],
      ['SN/OLD/78', 'New Member', '9000000002', 'Swarna 11+1', `${d}/${m}/${y}`, '', '15000'],
    ]);
    expect(members.valid_count).toBe(2);
    expect(members.validation.willCreate).toMatchObject({ customer: 1 });
    await importBatch(members.id);
    const accounts = await db<{ account_number: string; installments_paid: number; total_paid: string; status: string }>(
      `select account_number, installments_paid, total_paid, status from scheme_account order by account_number`);
    expect(accounts).toEqual([
      expect.objectContaining({ account_number: 'SN/OLD/77', installments_paid: 4, status: 'active' }),
      expect.objectContaining({ account_number: 'SN/OLD/78', installments_paid: 3 }),
    ]);
    expect(n(accounts[0]!.total_paid)).toBe(20000);
    expect((await tb()).get('2300')).toBeCloseTo(-35000, 2);
    // The next collection carries on from month five.
    const [acc] = await db<{ id: string }>(`select id from scheme_account where account_number = 'SN/OLD/77'`);
    const [cash] = await db<{ id: string }>(`select id from payment_method where code = 'CASH'`);
    const paid = await ok(`/api/schemes/accounts/${acc!.id}/collect`, { token: owner, body: { paymentMethodId: cash!.id } });
    expect(paid.installments).toEqual([5]);
  });

  let loansBatch: Body;
  it('brings girvi loans over with every article, interest carrying on', async () => {
    const lent = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 3); return d.toISOString().slice(0, 10); })();
    const paidTo = (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 10); })();
    loansBatch = await stage('girvi_loans', ['Loan No', 'Borrower', 'Mobile', 'Loan Date', 'Principal', 'Rate', 'Interest Paid Upto', 'Item', 'Purity', 'Gross Wt'], [
      ['G-501', 'Ramesh Patel', '9876543210', lent, '60,000', '1.5', paidTo, 'Gold bangles (pair)', '22K', '24.5'],
      ['G-501', '', '', '', '', '', '', 'Gold chain', '22K', '10.2'],
      ['G-502', 'Walk-in Borrower', '9000000003', lent, '20000', '', '', 'Ring', '22K', '4'],
    ]);
    expect(loansBatch.valid_count).toBe(3);
    loansBatch = await importBatch(loansBatch.id);
    expect(loansBatch.status).toBe('imported');
    const loans = await db<{ loan_number: string; principal_amount: string; total_gross_weight: string; status: string; articles: number; last_accrued_on: string }>(
      `select l.loan_number, l.principal_amount, l.total_gross_weight, l.status, l.last_accrued_on::text,
              (select count(*)::int from girvi_collateral c where c.girvi_loan_id = l.id) as articles
         from girvi_loan l order by loan_number`);
    expect(loans[0]).toMatchObject({ loan_number: 'G-501', articles: 2, last_accrued_on: paidTo });
    expect(n(loans[0]!.total_gross_weight)).toBeCloseTo(34.7, 3);
    expect(n(loans[0]!.principal_amount)).toBe(60000);
    expect(loans[1]!.articles).toBe(1);
    expect((await tb()).get('1400')).toBeCloseTo(80000, 2);
  });

  it('refuses an undo that would take back what happened since, and undoes whole when it can', async () => {
    // A scheme member has paid since: undoing the members would erase a real collection.
    const members = (await ok(T())).rows.find((r: Body) => r.entity === 'scheme_accounts');
    const refused = await call(`${T()}/${members.id}/undo`, { body: { reason: 'Trying' } });
    expect(refused.body.error.code).toBe('import_in_use');

    // The loans have not moved: they come out together, numbers freed, books back to where they were.
    const before = await tb();
    await ok(`${T()}/${loansBatch.id}/undo`, { body: { reason: 'Wrong rate column' } });
    const undone = await settle(loansBatch.id);
    expect(undone.status).toBe('undone');
    const after = await tb();
    expect(after.get('1400') ?? 0).toBeCloseTo(0, 2);
    expect((after.get('3900') ?? 0) - (before.get('3900') ?? 0)).toBeCloseTo(80000, 2);
    expect(await db(`select 1 from girvi_loan where loan_number = 'G-501'`)).toHaveLength(0);

    // Stock: the pieces are written off and their tags are free for a corrected file.
    await ok(`${T()}/${piecesBatch.id}/undo`, { body: { reason: 'Recount' } });
    expect((await settle(piecesBatch.id)).status).toBe('undone');
    expect(await db(`select 1 from stock_piece where tag_number = 'A-1001'`)).toHaveLength(0);
    expect((await tb()).get('1200') ?? 0).toBeCloseTo(0, 2);
  });

  it('keeps the record of every import, and only throws away a file never run', async () => {
    const list = await ok(T());
    expect(list.progress.customers.imported).toBeGreaterThan(0);
    const staged = await ok(T(), { body: { entity: 'karigars', columns: ['Name'] } });
    expect((await call(`${T()}/${staged.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`${T()}/${customerBatch.id}`, { method: 'DELETE' })).body.error.code).toBe('import_locked');
    const audit = await asPlatform((tx) => tx.query<{ action: string }>(
      `select action from platform_audit_log where target_tenant_id = $1 and action like 'import.%'`, [tenantId]));
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['import.create', 'import.start', 'import.finish', 'import.undo', 'import.delete']));
  });
});
