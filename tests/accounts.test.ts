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
 * Accounts, told as one shop's story: it opens its books, buys, sells, takes
 * a return, pays its bills, loses a piece, sends stock to its other branch,
 * counts its cash, closes a month and a year, and reconciles the bank — and
 * after every step the books still balance.
 *
 * Each run starts a fresh business, because closes are permanent and the
 * numbers in the reports are asserted exactly.
 */
describe('Accounts', { timeout: 300_000 }, () => {
  let server: Server;
  let base: string;
  let owner: string;
  let clerk: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36);
  const SHOP = `acc${run}`;
  const ids: Record<string, string> = {};
  const n = (v: unknown) => Number(v);
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  const lastMonth = (() => { const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();

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
  const code = async (path: string, body?: unknown, method?: string, as = owner) => (await call(path, body, method, as)).body.error?.code;
  const setting = (key: string, value: unknown) => ok(`/api/settings/config/${key}`, { value }, 'PUT');
  const acc = (c: string) => ids[`acc${c}`]!;
  /** The trial balance must always balance; returns its rows by code. */
  const tb = async () => {
    const t = await ok('/api/accounts/reports/trial-balance');
    expect(t.balanced).toBe(true);
    return new Map<string, Body>(t.rows.map((r: Body) => [r.code, r]));
  };
  const net = async (c: string) => n((await tb()).get(c)?.closing ?? 0);
  const voucherLines = async (voucherId: string) => (await ok(`/api/accounts/vouchers/${voucherId}`)).money as Body[];
  const side = (lines: Body[], c: string, s: 'debit' | 'credit') => lines.filter((l) => l.account_code === c).reduce((t, l) => t + n(l[s]), 0);

  beforeAll(async () => {
    tenantId = (await provisionTenant({
      code: SHOP, legalName: 'Accounts Test Jewellers', displayName: 'Accounts Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Accounts Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const users = await asPlatform(async (tx) => {
      await tx.query(`set local app.bypass_rls = 'on'`);
      const o = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [o.id]);
      // A clerk who may enter vouchers but not approve them.
      const role = await tx.one<{ id: string }>(
        `insert into role (id, tenant_id, code, name, role_type) values (gen_random_uuid(), $1, 'clerk', 'Accounts Clerk', 'staff') returning id`, [tenantId]);
      await tx.query(`insert into role_permission (id, tenant_id, role_id, permission)
                      select gen_random_uuid(), $1, $2, p from unnest(array['accounts.view', 'accounts.journal.create', 'accounts.reports.view']) p`, [tenantId, role.id]);
      const c = await tx.one<{ id: string; tv: number }>(
        `insert into app_user (id, tenant_id, email, full_name, password_hash, is_active, must_change_password)
         values (gen_random_uuid(), $1, $2, 'Clerk', 'x', true, false) returning id, token_version as tv`, [tenantId, `clerk@${SHOP}.in`]);
      await tx.query(`insert into user_role (id, tenant_id, user_id, role_id, branch_id) values (gen_random_uuid(), $1, $2, $3, null)`, [tenantId, c.id, role.id]);
      return { o, c };
    });
    main = users.o.branch;
    owner = signAccessToken({ sub: users.o.id, tenantId, tv: users.o.tv });
    clerk = signAccessToken({ sub: users.c.id, tenantId, tv: users.c.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await setting('documents.allow_backdating', true);
    const gold = (await ok('/api/master/metals')).rows.find((m: Body) => m.code === 'GOLD');
    ids.gold = gold.id;
    ids.k22 = (await ok(`/api/master/purities?metal_id=${gold.id}`)).rows.find((r: Body) => r.code === '22K').id;
    const locs = (await ok(`/api/master/locations?branch_id=${main}`)).rows;
    ids.counter = locs.find((l: Body) => l.code === 'COUNTER').id;
    ids.ring = (await ok('/api/master/items', { code: `RNG${run}`, name: `Ring ${run}`, metal_id: gold.id, tracking: 'piece', hsn_code: '7113' })).id;
    await ok('/api/master/price-rules', { code: `MK${run}`, name: 'Ring making', applies_to: 'making', basis: 'per_gram', rate: '500', slabs: [],
      slab_mode: 'whole', item_id: ids.ring, priority: 0, effective_from: '2026-01-01', is_active: true });
    ids.supplier = (await ok('/api/master/parties', { name: `Shah Bullion ${run}`, is_supplier: true, phone: '9820012345', gstin: '27ABCDE1234F1Z5' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Neha ${run}`, is_customer: true, phone: '9820054321' })).id;
    await ok('/api/master/rates', { metal_id: gold.id, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI', 'BANK', 'CARD']) ids[c] = methods.find((m: Body) => m.code === c)?.id ?? '';
    const chart = (await ok('/api/accounts/chart')).rows as Body[];
    for (const r of chart) ids[`acc${r.code}`] = r.id;
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('starts every business on a grouped, Tally-shaped chart', async () => {
    const chart = (await ok('/api/accounts/chart')).rows as Body[];
    const byCode = new Map(chart.map((r) => [r.code, r]));
    for (const g of ['G-CAP', 'G-CL', 'G-CA', 'G-CASH', 'G-BANK', 'G-SALES', 'G-DE', 'G-IE']) expect(byCode.get(g)?.is_group).toBe(true);
    expect(byCode.get('1000')?.ledger_kind).toBe('cash');
    expect(byCode.get('1010')?.ledger_kind).toBe('bank');
    expect(byCode.get('1000')?.parent_id).toBe(byCode.get('G-CASH')?.id);
    expect(byCode.get('4100')?.name).toBe('Labour & Services Income');
    // A group shows the total of what is under it, and comes before its ledgers.
    expect(chart.findIndex((r) => r.code === 'G-CASH')).toBeLessThan(chart.findIndex((r) => r.code === '1000'));
  });

  it('adds, renames, guards and removes ledgers', async () => {
    const hdfc = await ok('/api/accounts/chart', { name: `HDFC Current ${run}`, parentId: acc('G-BANK'), bankName: 'HDFC', bankAccountNumber: '50200012345', bankIfsc: 'hdfc0001234' });
    expect([hdfc.ledger_kind, hdfc.account_type, hdfc.bank_ifsc]).toEqual(['bank', 'asset', 'HDFC0001234']);
    ids.hdfc = hdfc.id;
    const pooja = await ok('/api/accounts/chart', { name: `Pooja & Prasad ${run}`, parentId: acc('G-IE') });
    expect(pooja.account_type).toBe('expense');
    expect(pooja.code).toMatch(/^\d+$/);
    ids.pooja = pooja.id;
    expect(await code('/api/accounts/chart', { name: `Pooja & Prasad ${run}`, parentId: acc('G-IE') })).toBe('account_duplicate');
    expect(await code('/api/accounts/chart', { name: 'Under a ledger', parentId: acc('5400') })).toBe('parent_not_group');
    expect(await code(`/api/accounts/chart/${acc('1000')}`, { isActive: false }, 'PATCH')).toBe('account_system');
    expect(await code(`/api/accounts/chart/${ids.pooja}`, { parentId: acc('G-CA') }, 'PATCH')).toBe('parent_type_mismatch');
    expect((await ok(`/api/accounts/chart/${ids.pooja}`, { name: `Pooja Expenses ${run}` }, 'PATCH')).name).toBe(`Pooja Expenses ${run}`);
    const spare = await ok('/api/accounts/chart', { name: `Spare ${run}`, parentId: acc('G-IE') });
    expect((await ok(`/api/accounts/chart/${spare.id}`, undefined, 'DELETE')).deleted).toBe(true);
    expect(await code(`/api/accounts/chart/${acc('5400')}`, undefined, 'DELETE')).toBe('account_system');
    // The clerk cannot touch the chart.
    expect((await call('/api/accounts/chart', { name: 'Nope', parentId: acc('G-IE') }, undefined, clerk)).status).toBe(403);
  });

  it('opens the books: ledgers, customers and grams, with the difference parked until it adds up', async () => {
    let state = await ok('/api/accounts/opening', {
      ledgers: [{ accountId: acc('3000'), credit: '1000000' }, { accountId: acc('1000'), debit: '100000' }, { accountId: ids.hdfc, debit: '300000' }],
      parties: [{ partyId: ids.customer, accountCode: '1100', debit: '25000' }],
    });
    expect(state.changed).toBe(true);
    expect(n(state.state.difference)).toBe(575000); // 10,00,000 capital against 4,25,000 of assets
    // Typed again with the real bank figure: only the change is posted.
    state = await ok('/api/accounts/opening', { ledgers: [{ accountId: acc('3000'), credit: '1000000' }, { accountId: ids.hdfc, debit: '875000' }] });
    expect(n(state.state.difference)).toBe(0);
    expect((await ok('/api/accounts/opening', { ledgers: [{ accountId: ids.hdfc, debit: '875000' }] })).changed).toBe(false);
    expect(await code('/api/accounts/opening', { ledgers: [{ accountId: acc('3900'), debit: '1' }] })).toBe('account_system');
    expect(n((await ok(`/api/pos/customers/${ids.customer}/balance`)).owed)).toBe(25000);
    await ok('/api/accounts/opening', { metals: [{ accountCode: '2100', partyId: ids.customer, metalId: ids.gold, purityId: ids.k22, weightIn: '5.000' }] });
    const metal = await ok(`/api/accounts/reports/metal-position`);
    expect(n(metal.metals.find((m: Body) => m.metalId === ids.gold).customerOwed)).toBe(5);
    const rows = await tb();
    expect(n(rows.get('3000')!.closing)).toBe(-1000000);
    expect(n(rows.get('1000')!.closing)).toBe(100000);
  });

  it('buys with a bill: stock at cost, CGST and SGST input kept apart', async () => {
    const inward = await ok('/api/purchase/inwards', {
      supplierId: ids.supplier, locationId: ids.counter,
      lines: [{ itemId: ids.ring, purityId: ids.k22, pieces: 4, grossWeight: '40.000', metalBasis: 'rupee', ratePerGram: '6900', makingRate: '400' }],
      bill: { supplierInvoiceNumber: `B-${run}`, supplierInvoiceDate: today },
    });
    ids.lot = inward.lines[0].tagging_lot_id;
    const bill = inward.bill;
    const lines = await voucherLines(bill.voucher_id);
    expect(side(lines, '1301', 'debit')).toBeCloseTo(n(bill.cgst_amount), 2);
    expect(side(lines, '1302', 'debit')).toBeCloseTo(n(bill.sgst_amount), 2);
    expect(side(lines, '1300', 'debit')).toBe(0);
    expect(n(bill.cgst_amount)).toBeGreaterThan(0);
    const pieces = (await ok('/api/tagging/pieces', { pieces: [0, 1, 2, 3].map(() => ({ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '10.000', taggingLotId: ids.lot })) })).rows;
    [ids.p1, ids.p2, ids.p3, ids.p4] = pieces.map((p: Body) => p.id);
    // Tagging pieces out of a bought lot moves no value: they were already stock.
    expect(n((await tb()).get('3900')?.closing ?? 0)).toBe(0);
    await tb();
  });

  it('sells: revenue split by metal, making and discount; GST split; the card fee booked at once', async () => {
    await ok(`/api/master/payment-methods/${ids.UPI}`, { charges_percent: '1' }, 'PATCH');
    const bill = await ok('/api/pos/checkout', {
      customerId: ids.customer, lines: [{ pieceId: ids.p1 }], discount: '1000',
      tenders: [{ paymentMethodId: ids.UPI, amount: '50000', reference: 'UPI-77' }],
    });
    ids.bill = bill.id;
    const lines = await voucherLines(bill.voucher_id);
    const revenue = ['4001', '4002', '4003', '4004', '4005'].reduce((t, c) => t + side(lines, c, 'credit'), 0) - side(lines, '4009', 'debit');
    expect(revenue).toBeCloseTo(n(bill.taxable_amount), 2);
    expect(side(lines, '4002', 'credit')).toBeCloseTo(10 * 500, 2); // making from Masters
    expect(side(lines, '4009', 'debit')).toBeCloseTo(n(bill.discount_amount), 2);
    expect(side(lines, '4000', 'credit')).toBe(0);
    expect(side(lines, '2201', 'credit')).toBeCloseTo(n(bill.cgst_amount), 2);
    expect(side(lines, '2202', 'credit')).toBeCloseTo(n(bill.sgst_amount), 2);
    expect(side(lines, '5410', 'debit')).toBeCloseTo(500, 2); // 1% of ₹50,000
    expect(side(lines, '5100', 'debit')).toBeGreaterThan(0);
    const pnl = await ok('/api/accounts/reports/profit-loss');
    expect(n(pnl.margin.making)).toBeCloseTo(5000, 2);
    expect(n(pnl.margin.cogs)).toBeGreaterThan(0);
    expect(n(pnl.grossProfit)).toBeCloseTo(n(pnl.totals.tradingIncome) - n(pnl.totals.tradingExpense), 2);
    await tb();
  });

  it('takes the piece back: every revenue part and the GST reverse in proportion', async () => {
    const detail = await ok(`/api/pos/invoices/${ids.bill}`);
    const ret = await ok('/api/pos/returns', { invoiceId: ids.bill, settlement: 'credit_note', reason: 'size',
      lines: [{ invoiceLineId: detail.lines[0].id }] });
    const lines = await voucherLines(ret.voucher_id);
    expect(side(lines, '4002', 'debit')).toBeCloseTo(5000, 2);
    expect(side(lines, '4009', 'credit')).toBeCloseTo(n(detail.discount_amount), 2);
    expect(side(lines, '2201', 'debit')).toBeCloseTo(n(detail.cgst_amount), 2);
    await tb();
  });

  it('enters expenses with GST input and TDS, payments, receipts and contra — and refuses the wrong ones', async () => {
    const rent = await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5400'), amount: '20000', gstRate: '18',
      paymentMethodId: ids.BANK, reference: 'NEFT-1', payee: 'Landlord', billNumber: 'R-OCT', narration: 'Shop rent October' });
    expect(rent.status).toBe('posted');
    expect(n(rent.amount)).toBe(23600);
    const lines = rent.lines as Body[];
    expect(lines.find((l) => l.account_code === '1301').debit).toBe('1800.0000');
    expect(await code('/api/accounts/journals', { docType: 'expense', accountId: acc('5400'), amount: '1000', paymentMethodId: ids.CASH, tdsPercent: '10' })).toBe('tds_disabled');
    await setting('accounts.tds.enabled', true);
    const ca = await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5510'), amount: '10000', paymentMethodId: ids.BANK, reference: 'NEFT-2', tdsPercent: '10' });
    expect((ca.lines as Body[]).find((l) => l.account_code === '2250').credit).toBe('1000.0000');
    const owed = await ok('/api/accounts/journals', { docType: 'expense', accountId: ids.pooja, amount: '500', payee: 'Mandir' });
    expect((owed.lines as Body[]).find((l) => l.account_code === '2040').credit).toBe('500.0000');
    await ok('/api/accounts/journals', { docType: 'payment', accountId: acc('2040'), amount: '500', paymentMethodId: ids.CASH });
    await ok('/api/accounts/journals', { docType: 'receipt', accountId: acc('4400'), amount: '1200', paymentMethodId: ids.CASH, narration: 'Scrap sold' });
    const contra = await ok('/api/accounts/journals', { docType: 'contra', fromAccountId: acc('1000'), toAccountId: ids.hdfc, amount: '30000', reference: 'Deposit slip 9' });
    expect(contra.doc_number).toMatch(/^CV-/);
    expect(await code('/api/accounts/journals', { docType: 'contra', fromAccountId: acc('1000'), toAccountId: acc('5400'), amount: '1' })).toBe('contra_not_money');
    expect(await code('/api/accounts/journals', { docType: 'payment', accountId: acc('1100'), amount: '1', paymentMethodId: ids.CASH })).toBe('account_is_control');
    expect(await code('/api/accounts/journals', { docType: 'payment', accountId: ids.hdfc, amount: '1', paymentMethodId: ids.CASH })).toBe('use_contra');
    expect(await code('/api/accounts/journals', { docType: 'journal', lines: [{ accountId: acc('5900'), debit: '10' }, { accountId: acc('1000'), credit: '9' }] })).toBe('unbalanced_voucher');
    expect(await code('/api/accounts/journals', { docType: 'journal', lines: [{ accountId: acc('G-IE'), debit: '10' }, { accountId: acc('1000'), credit: '10' }] })).toBe('account_is_group');
    expect(await code('/api/accounts/journals', { docType: 'journal', lines: [{ accountId: acc('1100'), debit: '10' }, { accountId: acc('4400'), credit: '10' }] })).toBe('party_required');
    // A journal on a control account names the party: writing off a small balance.
    await ok('/api/accounts/journals', { docType: 'journal', narration: 'Small balance written off',
      lines: [{ accountId: acc('5900'), debit: '100' }, { accountId: acc('1100'), partyId: ids.customer, credit: '100' }] });
    expect(n((await ok(`/api/pos/customers/${ids.customer}/balance`)).owed)).toBe(24900);
    // Cancelling writes the mirror; the original stays.
    const cancelled = await ok(`/api/accounts/journals/${owed.id}/cancel`, { reason: 'Entered on the wrong head' });
    expect(cancelled.status).toBe('cancelled');
    const reversed = await ok('/api/accounts/vouchers?reversedOnly=true');
    expect(reversed.rows.some((r: Body) => r.voucher_number === owed.voucher_number)).toBe(true);
    await tb();
  });

  it('holds staff expenses for approval when the shop asks, and posts them once approved', async () => {
    await setting('accounts.expense.approval_required', true);
    await setting('accounts.expense.approval_limit', 1000);
    const small = await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5470'), amount: '400', paymentMethodId: ids.CASH }, undefined, clerk);
    expect(small.status).toBe('posted');
    const big = await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5450'), amount: '5000', paymentMethodId: ids.CASH, narration: 'AC service' }, undefined, clerk);
    expect([big.status, big.voucher_id, big.needsApproval]).toEqual(['pending_approval', null, true]);
    expect((await call(`/api/accounts/journals/${big.id}/approve`, {}, undefined, clerk)).status).toBe(403);
    const watch = await ok('/api/accounts/watchlist');
    expect(watch.flags.some((f: Body) => f.kind === 'approval')).toBe(true);
    const approved = await ok(`/api/accounts/journals/${big.id}/approve`, {});
    expect(approved.status).toBe('posted');
    expect(approved.voucher_number).toBeTruthy();
    const another = await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5450'), amount: '3000', paymentMethodId: ids.CASH }, undefined, clerk);
    expect((await ok(`/api/accounts/journals/${another.id}/reject`, { reason: 'Not ours' })).status).toBe('rejected');
    await setting('accounts.expense.approval_required', false);
  });

  it('writes stock losses, opening stock and branch transfers to the books', async () => {
    const before = await tb();
    const piece = await ok(`/api/stock/pieces/${ids.p2}`);
    await ok('/api/stock/adjustments', { reason: 'damage', note: 'Stone fell out', pieceIds: [ids.p2] });
    let after = await tb();
    expect(n(after.get('5910')!.closing) - n(before.get('5910')?.closing ?? 0)).toBeCloseTo(n(piece.cost_value), 2);
    expect(n(after.get('1200')!.closing) - n(before.get('1200')!.closing)).toBeCloseTo(-n(piece.cost_value), 2);

    const [opening] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '5.000', costValue: '36000' }] })).rows;
    ids.p5 = opening.id;
    after = await tb();
    expect(n(after.get('3900')!.closing)).toBeCloseTo(-36000, 2);

    const branch = await ok('/api/master/branches', { code: `B${run}`.slice(0, 20), name: 'Surat' });
    ids.branch2 = branch.id;
    const surat = (await ok(`/api/master/locations?branch_id=${branch.id}`)).rows.find((l: Body) => l.code === 'COUNTER').id;
    const p3 = await ok(`/api/stock/pieces/${ids.p3}`);
    const t = await ok('/api/stock/transfers', { fromLocationId: ids.counter, toLocationId: surat, pieceIds: [ids.p3] });
    const transit = await ok(`/api/accounts/reports/trial-balance?branchId=${main}`);
    expect(n(transit.rows.find((r: Body) => r.code === '1600').closing)).toBeCloseTo(n(p3.cost_value), 2);
    await ok(`/api/stock/transfers/${t.id}/receive`, {});
    const atSurat = await ok(`/api/accounts/reports/trial-balance?branchId=${branch.id}`);
    expect(n(atSurat.rows.find((r: Body) => r.code === '1200').closing)).toBeCloseTo(n(p3.cost_value), 2);
    expect(n((await tb()).get('1600')?.closing ?? 0)).toBe(0);
  });

  it('works under composition: no GST on the bill, tax accrued on turnover, input GST is cost', async () => {
    await setting('accounts.gst.registration', 'composition');
    const bill = await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: ids.p4 }], tenders: [] });
    expect(n(bill.cgst_amount) + n(bill.sgst_amount) + n(bill.igst_amount)).toBe(0);
    const lines = await voucherLines(bill.voucher_id);
    expect(side(lines, '5600', 'debit')).toBeCloseTo(n(bill.taxable_amount) * 0.01, 1);
    expect(side(lines, '2210', 'credit')).toBeCloseTo(n(bill.taxable_amount) * 0.01, 1);
    const exp = await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5430'), amount: '1000', gstRate: '18', paymentMethodId: ids.CASH });
    expect((exp.lines as Body[]).find((l) => l.account_code === '5430').debit).toBe('1180.0000');
    await setting('accounts.gst.registration', 'regular');
    await tb();
  });

  it('counts the drawer, writes the short, locks the day, and reopens it', async () => {
    const status = await ok('/api/accounts/day');
    const drawer = status.drawers[0];
    expect(drawer.account.code).toBe('1000');
    const expected = n(drawer.expected);
    expect(expected).toBeGreaterThan(0);
    expect(await code('/api/accounts/day/close', { counted: String(expected - 100) })).toBe('note_required');
    expect(await code('/api/accounts/day/close', { denominations: { 500: 1 }, counted: '600' })).toBe('validation_error');
    const closed = await ok('/api/accounts/day/close', { counted: String(expected - 100), note: 'Short by a hundred, checking CCTV' });
    const record = closed.drawers[0].record;
    expect([record.status, n(record.difference)]).toEqual(['closed', -100]);
    expect(record.difference_voucher_number).toBeTruthy();
    expect(n(closed.drawers[0].expected)).toBeCloseTo(expected - 100, 2);
    expect(await code('/api/accounts/journals', { docType: 'expense', accountId: acc('5470'), amount: '50', paymentMethodId: ids.CASH })).toBe('day_closed');
    await ok(`/api/accounts/day/${record.id}/reopen`, { reason: 'A late bill came in' });
    await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5470'), amount: '50', paymentMethodId: ids.CASH });
    expect(n((await tb()).get('5920')!.closing)).toBe(100);
  });

  it('closes last month: GST set off into one payable, the month locks, and reopens with a reason', async () => {
    const date = `${lastMonth}-15`;
    await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5480'), amount: '1000', gstRate: '18', paymentMethodId: ids.BANK, reference: 'NEFT-T', docDate: date });
    const before = await tb();
    const closed = await ok('/api/accounts/periods/close-month', { month: lastMonth });
    expect(closed.gst.length).toBeGreaterThan(0);
    const after = await tb();
    // Up to that month's end only ₹180 of input GST existed: it is carried forward and the input ledgers cleared to that date.
    expect(n(after.get('1309')!.closing)).toBeCloseTo(180, 2);
    expect(n(after.get('1301')!.closing)).toBeCloseTo(n(before.get('1301')!.closing) - 90, 2);
    expect(await code('/api/accounts/journals', { docType: 'expense', accountId: acc('5470'), amount: '10', paymentMethodId: ids.CASH, docDate: date })).toBe('period_closed');
    expect(await code('/api/accounts/periods/close-month', { month: lastMonth })).toBe('period_closed');
    expect(await code('/api/accounts/periods/close-month', { month: today.slice(0, 7) })).toBe('month_not_over');
    const periods = await ok('/api/accounts/periods');
    const row = periods.months.find((m: Body) => m.start === `${lastMonth}-01`);
    expect(row.status).toBe('closed');
    await ok(`/api/accounts/periods/${row.record.id}/reopen`, { reason: 'Late bill' });
    await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5470'), amount: '10', paymentMethodId: ids.CASH, docDate: date });
    await tb();
  });

  it('closes a finished financial year: profit to capital, books still balance, the year locks', async () => {
    const fyEnd = `${Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)}-03-31`;
    await ok('/api/accounts/journals', { docType: 'expense', accountId: acc('5490'), amount: '2500', paymentMethodId: ids.BANK, reference: 'T', docDate: fyEnd.replace('-31', '-15') });
    expect(await code('/api/accounts/periods/close-year', { date: fyEnd })).toBe('months_open');
    const capitalBefore = await net('3000');
    const result = await ok('/api/accounts/periods/close-year', { date: fyEnd, closeOpenMonths: true });
    expect(result.monthsClosed.length).toBe(12);
    expect(n(result.pnl.profit)).toBeCloseTo(-2500, 2);
    expect(await net('3000')).toBeCloseTo(capitalBefore + 2500, 2); // a loss reduces capital (a debit)
    // That year's profit & loss still reads as it was; its expense ledger is now clear.
    const pnl = await ok(`/api/accounts/reports/profit-loss?from=${fyEnd.slice(0, 4)}-03-01&to=${fyEnd}`);
    expect(n(pnl.netProfit)).toBeCloseTo(-2500, 2);
    const bs = await ok(`/api/accounts/reports/balance-sheet?asOn=${fyEnd}`);
    expect(bs.balanced).toBe(true);
    expect(n(bs.profitAndLoss)).toBe(0);
    expect(await code('/api/accounts/journals', { docType: 'expense', accountId: acc('5470'), amount: '10', paymentMethodId: ids.CASH, docDate: fyEnd })).toBe('period_closed');
  });

  it('reads every report from the same ledger, and they agree', async () => {
    const bs = await ok('/api/accounts/reports/balance-sheet');
    expect(bs.balanced).toBe(true);
    const ledger = await ok(`/api/accounts/reports/ledger?accountId=${acc('1000')}&from=2020-01-01`);
    expect(n(ledger.closing)).toBeCloseTo(await net('1000'), 2);
    const rows = await tb();
    const hdfc = (await ok('/api/accounts/chart')).rows.find((r: Body) => r.id === ids.hdfc).code;
    const bank = n(rows.get('1010')?.closing ?? 0) + n(rows.get(hdfc)!.closing);
    const group = await ok(`/api/accounts/reports/ledger?accountId=${acc('G-BANK')}&from=2020-01-01`);
    expect(n(group.closing)).toBeCloseTo(bank, 2);
    const party = await ok(`/api/accounts/reports/party?partyId=${ids.customer}&from=2020-01-01`);
    expect(party.lines.length).toBeGreaterThan(2);
    const age = await ok('/api/accounts/reports/ageing?kind=receivable');
    expect(age.rows.find((r: Body) => r.partyId === ids.customer)).toBeTruthy();
    const pay = await ok('/api/accounts/reports/ageing?kind=payable');
    expect(n(pay.totals.total)).toBeGreaterThan(0);
    const gst = await ok(`/api/accounts/reports/gst?from=${today.slice(0, 7)}-01&to=${today}`);
    expect(n(gst.sales.bills)).toBeGreaterThan(0);
    expect(gst.hsn.length).toBeGreaterThan(0);
    const forecast = await ok('/api/accounts/reports/forecast?days=30');
    expect(forecast.series.length).toBe(31);
    expect(forecast.items.some((i: Body) => i.kind === 'supplier')).toBe(true);
    const desk = await ok('/api/accounts/desk');
    expect(n(desk.money.total)).toBeCloseTo(n(rows.get('1000')!.closing) + bank, 2);
    expect(desk.trend.length).toBe(14);
    const book = await ok(`/api/accounts/vouchers?from=${today}&to=${today}`);
    expect(book.rows.some((r: Body) => n(r.amount) > 0)).toBe(true); // metal-only vouchers (grams, no rupees) carry 0
    // The old reports now total every matching entry, not just the page shown.
    const metal = await ok('/api/accounts/metal-ledger?limit=1');
    expect(metal.rows.length).toBe(1);
    expect(metal.total).toBeGreaterThan(1);
  });

  it('reconciles the bank: imports the statement, matches it, and explains the difference', async () => {
    const recon0 = await ok(`/api/accounts/bank/reconciliation?accountId=${ids.hdfc}&from=2020-01-01`);
    const deposit = recon0.entries.find((e: Body) => n(e.debit) === 30000);
    expect(deposit).toBeTruthy();
    const imported = await ok('/api/accounts/bank/statement', { accountId: ids.hdfc, rows: [
      { date: today, description: 'CASH DEP SLIP 9', reference: 'Deposit slip 9', deposit: '30000', balance: '905000' },
      { date: today, description: 'SMS CHARGES', withdrawal: '17.70', balance: '904982.30' },
    ] });
    expect([imported.added, imported.autoMatched]).toEqual([2, 1]);
    expect((await ok('/api/accounts/bank/statement', { accountId: ids.hdfc, rows: [{ date: today, description: 'SMS CHARGES', withdrawal: '17.70' }] })).skipped).toBe(1);
    const recon = await ok(`/api/accounts/bank/reconciliation?accountId=${ids.hdfc}&from=2020-01-01`);
    const charge = recon.lines.find((l: Body) => l.description === 'SMS CHARGES');
    expect(charge.status).toBe('unmatched');
    expect(await code(`/api/accounts/bank/lines/${charge.id}/match`, { entryId: deposit.id })).toBe('already_matched');
    await ok(`/api/accounts/bank/lines/${charge.id}/ignore`, { note: 'Booked next month' });
    expect(await code('/api/accounts/bank/statement', { accountId: acc('1000'), rows: [{ date: today, deposit: '1' }] })).toBe('not_bank');
  });

  it('exports to Tally only when switched on, and only what is new', async () => {
    expect(await code('/api/accounts/tally/export', {})).toBe('tally_disabled');
    await setting('accounts.tally.enabled', true);
    const first = await ok('/api/accounts/tally/export', { from: '2020-01-01', to: today, onlyNew: true, markExported: true });
    expect(first.vouchers).toBeGreaterThan(5);
    expect(first.xml).toContain('<VOUCHER VCHTYPE="Sales"');
    expect(first.xml).toContain(`<LEDGER NAME="Neha ${run}"`);
    expect((await ok('/api/accounts/tally/status')).pending).toBe(0);
    const again = await ok('/api/accounts/tally/export', { from: '2020-01-01', to: today, onlyNew: true });
    expect(again.vouchers).toBe(0);
  });
});
