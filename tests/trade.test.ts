import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

const SHOP = 'tradetest';
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Purchase & POS', { timeout: 300_000 }, () => {
  let server: Server;
  let base: string;
  let owner: string;
  let sales: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36).toUpperCase();
  const ids: Record<string, string> = {};

  async function call(path: string, body?: unknown, as = owner, method?: string) {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${as}`, 'x-branch-id': main },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  }
  const ok = async (path: string, body?: unknown, as = owner) => {
    const r = await call(path, body, as);
    if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const balance = async (itemId: string, locationId = ids.counter) => (await ok(`/api/stock/balances?itemId=${itemId}&locationId=${locationId}`)).rows[0] ?? { quantity: '0', net_weight: '0' };
  const n = (v: unknown) => Number(v);

  beforeAll(async () => {
    const existing = await asPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from tenant where code = $1`, [SHOP]));
    tenantId = existing?.id ?? (await provisionTenant({
      code: SHOP, legalName: 'Trade Test Jewellers', displayName: 'Trade Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Trade Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const users = await asPlatform(async (tx) => {
      const o = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [o.id]);
      const s = await tx.one<{ id: string; tv: number }>(
        `insert into app_user (id, tenant_id, email, full_name, password_hash, is_active, must_change_password)
         values (gen_random_uuid(), $1, $2, 'Counter Sales', 'x', true, false) returning id, token_version as tv`, [tenantId, `sales.${run.toLowerCase()}@${SHOP}.in`]);
      // Counter staff: a named staff role that may bill but not cancel or approve discounts, at the main branch.
      const role = await tx.one<{ id: string }>(
        `with found as (select id from role where tenant_id = $1 and code = 'counter_sales' and deleted_at is null),
              made as (insert into role (id, tenant_id, code, name, role_type)
                       select gen_random_uuid(), $1, 'counter_sales', 'Counter Sales', 'staff' where not exists (select 1 from found)
                       returning id)
         select id from found union all select id from made`, [tenantId]);
      await tx.query(`insert into role_permission (id, tenant_id, role_id, permission)
                      select gen_random_uuid(), $1, $2, p from unnest(array['pos.view', 'pos.create']) p
                      on conflict (tenant_id, role_id, permission) do nothing`, [tenantId, role.id]);
      await tx.query(`insert into user_role (id, tenant_id, user_id, role_id, branch_id)
                      values (gen_random_uuid(), $1, $2, $3, (select id from branch where tenant_id = $1 and code = 'MAIN'))`, [tenantId, s.id, role.id]);
      return { o, s };
    });
    main = users.o.branch;
    owner = signAccessToken({ sub: users.o.id, tenantId, tv: users.o.tv });
    sales = signAccessToken({ sub: users.s.id, tenantId, tv: users.s.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const gold = (await ok('/api/master/metals')).rows.find((m: Body) => m.code === 'GOLD');
    ids.gold = gold.id;
    ids.k22 = (await ok(`/api/master/purities?metal_id=${gold.id}`)).rows.find((r: Body) => r.code === '22K').id;
    const locs = (await ok(`/api/master/locations?branch_id=${main}`)).rows;
    ids.counter = locs.find((l: Body) => l.code === 'COUNTER').id;
    ids.vault = locs.find((l: Body) => l.code === 'VAULT').id;
    ids.ring = (await ok('/api/master/items', { code: `RNG${run}`, name: `Ring ${run}`, metal_id: gold.id, tracking: 'piece', hsn_code: '7113' })).id;
    await ok('/api/master/price-rules', { code: `MK${run}`, name: 'Ring making', applies_to: 'making', basis: 'per_gram', rate: '500', slabs: [],
      slab_mode: 'whole', item_id: ids.ring, priority: 0, effective_from: '2026-01-01', is_active: true });
    ids.bulk = (await ok('/api/master/items', { code: `BLK${run}`, name: `Bullion ${run}`, metal_id: gold.id, tracking: 'lot', nature: 'raw_metal', hsn_code: '7108' })).id;
    ids.supplier = (await ok('/api/master/parties', { name: `Shah Bullion ${run}`, is_supplier: true, phone: '9820012345', gstin: '27ABCDE1234F1Z5' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Neha ${run}`, is_customer: true, phone: '9820054321' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Ravi ${run}`, is_customer: true, phone: '9820054322' })).id;
    await ok('/api/master/rates', { metal_id: gold.id, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const code of ['CASH', 'UPI', 'BANK', 'ADVANCE']) ids[code] = methods.find((m: Body) => m.code === code).id;
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('receives goods with the bill: stock up, pieces wait in Tagging, supplier owed rupees + GST', async () => {
    const inward = await ok('/api/purchase/inwards', {
      supplierId: ids.supplier, locationId: ids.counter, referenceNumber: 'CH-1',
      lines: [
        { itemId: ids.ring, purityId: ids.k22, pieces: 12, grossWeight: '84.500', metalBasis: 'rupee', ratePerGram: '6900', makingRate: '400' },
        { itemId: ids.bulk, purityId: ids.k22, grossWeight: '100.000', metalBasis: 'rupee', ratePerGram: '6800' },
      ],
      bill: { supplierInvoiceNumber: `B-${run}`, supplierInvoiceDate: new Date().toISOString().slice(0, 10) },
    });
    ids.inward = inward.id;
    expect(inward.status).toBe('posted');
    expect(inward.bill.supplier_invoice_number).toBe(`B-${run}`);
    const ringLine = inward.lines.find((l: Body) => l.item_id === ids.ring);
    ids.ringLine = ringLine.id; ids.bulkLine = inward.lines.find((l: Body) => l.item_id === ids.bulk).id;
    ids.lot = ringLine.tagging_lot_id;
    expect(n(ringLine.cost_value)).toBe(84.5 * 6900 + 84.5 * 400); // 616,850
    expect(n((await balance(ids.ring)).quantity)).toBe(12);
    expect(n((await balance(ids.bulk)).net_weight)).toBe(100);

    const owed = await ok(`/api/purchase/suppliers/${ids.supplier}/balance`);
    expect(n(owed.rupees)).toBeCloseTo((616850 + 680000) * 1.03, 2);
    const dup = await call('/api/purchase/bills', { supplierId: ids.supplier, inwardIds: [inward.id], supplierInvoiceNumber: `B-${run}`, supplierInvoiceDate: '2026-09-01' });
    expect(dup.body.error.code).toBe('bill_duplicate');
    const missingRate = await call('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter,
      lines: [{ itemId: ids.ring, purityId: ids.k22, pieces: 1, grossWeight: '5', metalBasis: 'rupee' }] });
    expect(missingRate.body.error.code).toBe('rate_required');
    const noPieces = await call('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter,
      lines: [{ itemId: ids.ring, purityId: ids.k22, grossWeight: '5', metalBasis: 'rupee', ratePerGram: '6900' }] });
    expect(noPieces.body.error.code).toBe('pieces_required');
  });

  it('buys gold-for-gold: fine metal owed at the touch, valued at today’s buying rate', async () => {
    const inward = await ok('/api/purchase/inwards', {
      supplierId: ids.supplier, locationId: ids.vault,
      lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '50.000', metalBasis: 'fine', touchPercent: '92' }],
    });
    expect(n(inward.lines[0].fine_owed)).toBe(46);
    expect(n(inward.lines[0].rate_per_gram)).toBe(6800);
    const owed = await ok(`/api/purchase/suppliers/${ids.supplier}/balance`);
    expect(n(owed.metals[0].fine)).toBe(46);
    expect(owed.unbilled.map((u: Body) => u.id)).toContain(inward.id);
  });

  it('tags pieces from the lot: cost by weight, purchase history, and no more than arrived', async () => {
    const res = await ok('/api/tagging/pieces', { pieces: [
      { itemId: ids.ring, purityId: ids.k22, locationId: ids.vault, grossWeight: '7.000', taggingLotId: ids.lot },
      { itemId: ids.ring, purityId: ids.k22, locationId: ids.vault, grossWeight: '7.000', taggingLotId: ids.lot },
    ] });
    const [a, b] = res.rows;
    ids.pieceA = a.id; ids.pieceB = b.id;
    expect(a.location_id).toBe(ids.counter); // the lot's location wins
    expect(n(a.cost_value)).toBeCloseTo(616850 * 7 / 84.5, 1);
    const detail = await ok(`/api/stock/pieces/${a.id}`);
    expect(detail.movements.map((m: Body) => m.reason)).toEqual(['purchase']);
    expect(n((await balance(ids.ring)).quantity)).toBe(12);
    const tooHeavy = await call('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '80', taggingLotId: ids.lot }] });
    expect(tooHeavy.body.error.message).toMatch(/more than the 70\.500 g still untagged/);
  });

  it('returns goods to the supplier on the bought terms, and closes the lot with a difference', async () => {
    const before = n((await ok(`/api/purchase/suppliers/${ids.supplier}/balance`)).rupees);
    const ret = await ok('/api/purchase/returns', { goodsReceiptId: ids.inward, reason: 'quality', pieceIds: [ids.pieceB], lines: [
      { goodsReceiptLineId: ids.ringLine, pieces: 2, grossWeight: '14.000' },
    ] });
    expect(ret.status).toBe('posted');
    expect((await ok(`/api/stock/pieces/${ids.pieceB}`)).status).toBe('written_off');
    const after = n((await ok(`/api/purchase/suppliers/${ids.supplier}/balance`)).rupees);
    expect(before - after).toBeCloseTo(n(ret.total_amount), 2);
    expect(n((await balance(ids.ring)).quantity)).toBe(9);

    const lots = (await ok('/api/purchase/lots')).rows;
    const lot = lots.find((l: Body) => l.id === ids.lot);
    expect(lot.pieces_expected - lot.pieces_tagged).toBe(8);
    await ok(`/api/purchase/lots/${ids.lot}/close`, { note: 'Tagged the rest as opening by mistake' });
    expect(n((await balance(ids.ring)).quantity)).toBe(1); // only piece A is left
  });

  it('settles with the supplier: rate fix, metal back, and payments with their rules', async () => {
    const fix = await ok('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'rate_fix', metalId: ids.gold, fineWeight: '10.000', ratePerGram: '7300' });
    expect(n(fix.amount)).toBe(73000);
    const tooMuch = await call('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'rate_fix', metalId: ids.gold, fineWeight: '100', ratePerGram: '7300' });
    expect(tooMuch.body.error.code).toBe('metal_exceeds_owed');
    const metal = await ok('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'metal', itemId: ids.bulk, purityId: ids.k22, locationId: ids.counter, netWeight: '20.000' });
    expect(n(metal.fine_weight)).toBeCloseTo(18.32, 3);
    expect(n((await balance(ids.bulk)).net_weight)).toBe(80);
    const owed = await ok(`/api/purchase/suppliers/${ids.supplier}/balance`);
    expect(n(owed.metals[0].fine)).toBeCloseTo(46 - 10 - 18.32, 3);

    const noRef = await call('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'payment', amount: '10000', paymentMethodId: ids.BANK });
    expect(noRef.body.error.code).toBe('reference_required');
    const overCash = await call('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'payment', amount: '250000', paymentMethodId: ids.CASH });
    expect(overCash.body.error.code).toBe('payment_limit');
    await ok('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'payment', amount: '10000', paymentMethodId: ids.BANK, reference: 'UTR123' });
    expect(n((await ok(`/api/purchase/suppliers/${ids.supplier}/balance`)).rupees)).toBeCloseTo(n(owed.rupees) - 10000, 2);
  });

  it('cancels an inward only while nothing from it was used', async () => {
    const used = await call(`/api/purchase/inwards/${ids.inward}/cancel`, { reason: 'Entered twice' });
    expect(used.body.error.code).toBe('inward_billed');
    const spare = await ok('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.vault,
      lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '5.000', metalBasis: 'rupee', ratePerGram: '6800' }] });
    const before = n((await balance(ids.bulk, ids.vault)).net_weight);
    await ok(`/api/purchase/inwards/${spare.id}/cancel`, { reason: 'Entered twice' });
    expect(n((await balance(ids.bulk, ids.vault)).net_weight)).toBe(before - 5);
  });

  it('bills at the counter: priced from Masters, split tenders, balance on the customer', async () => {
    const bill = await ok('/api/pos/checkout', {
      customerId: ids.customer,
      lines: [{ pieceId: ids.pieceA }, { itemId: ids.bulk, purityId: ids.k22, grossWeight: '5.000' }],
      tenders: [{ paymentMethodId: ids.CASH, amount: '20000' }, { paymentMethodId: ids.UPI, amount: '30000', reference: 'UPI1' }],
    }, sales);
    ids.bill = bill.id;
    expect(bill.status).toBe('posted');
    expect(n(bill.lines[0].rate_per_gram)).toBe(7000);
    expect(n(bill.lines[0].making_amount)).toBe(7 * 500);
    expect(n(bill.cgst_amount)).toBeCloseTo(n(bill.sgst_amount), 1);
    expect(n(bill.total_amount) % 1).toBe(0); // rounded to the rupee
    expect(n(bill.balance_amount)).toBe(n(bill.total_amount) - 50000);
    expect((await ok(`/api/stock/pieces/${ids.pieceA}`)).status).toBe('sold');
    expect(n((await balance(ids.bulk)).net_weight)).toBe(75);
    const again = await call('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: ids.pieceA }], tenders: [] }, sales);
    expect(again.body.error.code).toBe('piece_not_in_stock');
    const owed = await ok(`/api/pos/customers/${ids.customer}/balance`);
    expect(n(owed.owed)).toBe(n(bill.balance_amount));
  });

  it('asks for approval above the counter discount limit, PAN at ₹2 lakh, and refuses cash of ₹2 lakh', async () => {
    const [p] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '40.000' }] })).rows;
    const line = [{ pieceId: p.id }];
    const needs = await call('/api/pos/checkout', { customerId: ids.customer2, lines: line, tenders: [], discount: '15000' }, sales);
    expect(needs.body.error.code).toBe('discount_approval_required');
    const wrong = await call('/api/pos/checkout', { customerId: ids.customer2, lines: line, tenders: [], discount: '15000',
      approver: { identifier: `owner@${SHOP}.in`, password: 'nope' } }, sales);
    expect(wrong.body.error.code).toBe('approver_invalid');
    const pan = await call('/api/pos/checkout', { customerId: ids.customer2, lines: line, tenders: [], discount: '15000',
      approver: { identifier: `owner@${SHOP}.in`, password: 'owner-pass-1' } }, sales);
    expect(pan.body.error.code).toBe('pan_required');
    const cash = await call('/api/pos/checkout', { customerId: ids.customer2, lines: line, pan: 'ABCDE1234F',
      tenders: [{ paymentMethodId: ids.CASH, amount: '199999' }, { paymentMethodId: ids.CASH, amount: '1000' }] }, sales);
    expect(cash.body.error.code).toBe('cash_limit');
    const done = await ok('/api/pos/checkout', { customerId: ids.customer2, lines: line, discount: '15000', pan: 'ABCDE1234F',
      approver: { identifier: `owner@${SHOP}.in`, password: 'owner-pass-1' }, tenders: [{ paymentMethodId: ids.BANK, amount: '100000', reference: 'NEFT9' }] }, sales);
    expect(done.approved_by_name).toBe('Trade Owner');
    expect(n(done.discount_amount)).toBe(15000);
    expect(done.customer_pan).toBe('ABCDE1234F');
    ids.bigBill = done.id; ids.bigPiece = p.id;
  });

  it('receives money: oldest bills first, the rest as advance, then spends the advance on a bill', async () => {
    const owed = n((await ok(`/api/pos/customers/${ids.customer}/balance`)).owed);
    const r = await ok('/api/pos/receipts', { customerId: ids.customer, amount: String(owed + 5000), paymentMethodId: ids.UPI, reference: 'UPI2' });
    expect(r.allocations).toHaveLength(1);
    expect(n(r.advance_amount)).toBe(5000);
    const bal = await ok(`/api/pos/customers/${ids.customer}/balance`);
    expect([n(bal.owed), n(bal.advance)]).toEqual([0, 5000]);
    const tooMuch = await call('/api/pos/checkout', { customerId: ids.customer, lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.000' }],
      tenders: [{ paymentMethodId: ids.ADVANCE, amount: '6000' }] });
    expect(tooMuch.body.error.code).toBe('advance_exceeds');
    await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '0.500' }],
      tenders: [{ paymentMethodId: ids.ADVANCE, amount: '3000' }] });
    expect(n((await ok(`/api/pos/customers/${ids.customer}/balance`)).advance)).toBe(2000);
  });

  it('takes a piece back as a credit note (exchange); the bill can no longer be cancelled', async () => {
    const bill = await ok(`/api/pos/invoices/${ids.bigBill}`);
    const owedBefore = n((await ok(`/api/pos/customers/${ids.customer2}/balance`)).owed);
    const ret = await ok('/api/pos/returns', { invoiceId: ids.bigBill, lines: [{ invoiceLineId: bill.lines[0].id }], settlement: 'credit_note', deduction: '1000', reason: 'size' });
    expect(n(ret.adjusted_amount)).toBe(owedBefore); // first clears what was owed on the bill
    expect(n(ret.refund_amount)).toBeCloseTo(n(bill.lines[0].line_total) - 1000 - owedBefore, 0);
    expect((await ok(`/api/stock/pieces/${ids.bigPiece}`)).status).toBe('in_stock');
    const twice = await call('/api/pos/returns', { invoiceId: ids.bigBill, lines: [{ invoiceLineId: bill.lines[0].id }], settlement: 'credit_note' });
    expect(twice.body.error.code).toBe('already_returned');
    const cancel = await call(`/api/pos/invoices/${ids.bigBill}/cancel`, { reason: 'Mistake' });
    expect(cancel.body.error.code).toBe('invoice_returned');
    const bal = await ok(`/api/pos/customers/${ids.customer2}/balance`);
    expect([n(bal.owed), n(bal.advance)]).toEqual([0, n(ret.refund_amount)]);
  });

  it('sends pieces on approval: only that customer can be billed them; returns go back on the shelf', async () => {
    const [x, y] = (await ok('/api/tagging/pieces', { pieces: [
      { itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '4.000' },
      { itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '5.000' }] })).rows;
    const due = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
    const memo = await ok('/api/pos/memos', { customerId: ids.customer, pieceIds: [x.id, y.id], dueDate: due });
    expect((await ok(`/api/stock/pieces/${x.id}`)).status).toBe('on_memo');
    const other = await call('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: x.id }], tenders: [] });
    expect(other.body.error.message).toMatch(/out on approval with another customer/);
    await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: x.id }], tenders: [] });
    const back = await ok(`/api/pos/memos/${memo.id}/return`, { pieceIds: [y.id] });
    expect(back.status).toBe('closed');
    expect((await ok(`/api/stock/pieces/${y.id}`)).status).toBe('in_stock');
  });

  it('cancels a bill entered by mistake: stock and books reverse, the piece is back', async () => {
    const [p] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '3.000' }] })).rows;
    const bill = await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: p.id }], tenders: [] });
    const denied = await call(`/api/pos/invoices/${bill.id}/cancel`, { reason: 'Wrong piece' }, sales);
    expect(denied.status).toBe(403);
    await ok(`/api/pos/invoices/${bill.id}/cancel`, { reason: 'Wrong piece' });
    expect((await ok(`/api/stock/pieces/${p.id}`)).status).toBe('in_stock');
  });

  it('closes a purchase lot by itself once every piece and gram is tagged', async () => {
    const inward = await ok('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter,
      lines: [{ itemId: ids.ring, purityId: ids.k22, pieces: 2, grossWeight: '9.000', metalBasis: 'rupee', ratePerGram: '6900' }] });
    const lotId = inward.lines[0].tagging_lot_id;
    const open = async () => (await ok('/api/purchase/lots')).rows.some((l: Body) => l.id === lotId);
    await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '4.000', taggingLotId: lotId }] });
    expect(await open()).toBe(true);
    const [last] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '5.000', taggingLotId: lotId }] })).rows;
    expect(await open()).toBe(false);
    expect(n(last.cost_value)).toBeCloseTo(9 * 6900 - Math.round(4 * 6900 * 100) / 100, 2); // the last piece takes what is left
  });

  it('prices from the tag first, then Formulas; discount comes off making and wastage; the quote is the bill', async () => {
    const tagTerms = { makingBasis: 'flat', makingRate: '3000', wastagePercent: '5' };
    const [p] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '10.000', ...tagTerms }] })).rows;
    const line = [{ pieceId: p.id }];
    const q = await ok('/api/pos/quote', { customerId: ids.customer, lines: line }, sales);
    expect(q.lines[0]).toMatchObject({ makingSource: 'tag', wastageSource: 'tag' });
    expect(n(q.lines[0].makingAmount)).toBe(3000);
    expect(n(q.lines[0].wastageWeightG)).toBe(0.5);
    expect(n(q.lines[0].wastageAmount)).toBe(3500); // 0.5 g at ₹7,000
    expect(n(q.totals.discountable)).toBe(6500);
    expect((await call('/api/pos/quote', { lines: line, discount: '6600' }, sales)).body.error.code).toBe('discount_exceeds_charges');

    // A blank tag hands the piece back to the formula; nothing falls back to the item.
    await ok(`/api/stock/pieces/${p.id}/pricing`, { makingBasis: null, makingRate: null, wastagePercent: null });
    const byFormula = (await ok('/api/pos/quote', { lines: line }, sales)).lines[0];
    expect(byFormula).toMatchObject({ makingSource: 'formula', wastageSource: 'none' });
    expect(n(byFormula.makingAmount)).toBe(5000);
    const bad = await call(`/api/stock/pieces/${p.id}/pricing`, { makingBasis: 'percent', makingRate: '150', wastagePercent: null });
    expect(bad.body.error.code).toBe('tag_pricing_invalid');

    // Within the free limit (10% of ₹6,500) no approval; the saved bill is exactly the quote.
    await ok(`/api/stock/pieces/${p.id}/pricing`, tagTerms);
    const quoted = await ok('/api/pos/quote', { customerId: ids.customer, lines: line, discount: '600' }, sales);
    expect(n(quoted.lines[0].discountAmount)).toBe(600);
    const bill = await ok('/api/pos/checkout', { customerId: ids.customer, lines: line, discount: '600', tenders: [] }, sales);
    expect(n(bill.total_amount)).toBe(n(quoted.totals.grand));
    expect(n(bill.lines[0].wastage_amount)).toBe(3500);
    expect(n(bill.lines[0].discount_amount)).toBe(600);

    // No tag making and no formula: ₹0 and a warning, not a guess.
    const bulk = await ok('/api/pos/quote', { lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.000' }] }, sales);
    expect(n(bulk.lines[0].makingAmount)).toBe(0);
    expect(bulk.warnings.join(' ')).toMatch(/making is ₹0/);

    // A formula linked on Categories is that category's making, and only theirs.
    const rule = await ok('/api/master/price-rules', { code: `CT${run}`, name: 'Bangle making', applies_to: 'making', basis: 'per_gram', rate: '900',
      slabs: [], slab_mode: 'whole', priority: 0, effective_from: '2026-01-01', is_active: true });
    const cat = await ok('/api/master/categories', { code: `BG${run}`, name: `Bangles ${run}`, making_rule_id: rule.id });
    const bangle = await ok('/api/master/items', { code: `BGL${run}`, name: `Bangle wire ${run}`, metal_id: ids.gold, tracking: 'lot', hsn_code: '7113', category_id: cat.id });
    const linked = await ok('/api/pos/quote', { lines: [{ itemId: bangle.id, purityId: ids.k22, grossWeight: '2.000' }, { itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.000' }] }, sales);
    expect(n(linked.lines[0].makingAmount)).toBe(1800);
    expect(n(linked.lines[1].makingAmount)).toBe(0);
    // Lines sold by weight keep their own item whatever order they are on the bill.
    const reversed = await ok('/api/pos/quote', { lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.000' }, { itemId: bangle.id, purityId: ids.k22, grossWeight: '2.000' }] }, sales);
    expect(reversed.lines.map((l: Body) => n(l.makingAmount))).toEqual([0, 1800]);
    expect(reversed.lines[1].description).toBe(`Bangle wire ${run}`);
  });

  it('values metal on the weight chosen in Calculation Settings, and rounds the total as set', async () => {
    const put = (key: string, value: unknown) => call(`/api/settings/config/${key}`, { value }, owner, 'PUT');
    const purities = (await ok(`/api/master/purities?metal_id=${ids.gold}`)).rows;
    const k24 = purities.find((r: Body) => r.code === '24K');
    const k22Fineness = purities.find((r: Body) => r.code === '22K').fineness_percent;
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: k24.id, rate_per_gram: '7600', buying_rate_per_gram: '7400' });
    const line = [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '10.000' }];
    try {
      expect((await put('pricing.metal_value_basis', 'fine')).status).toBe(200);
      const fine = (await ok('/api/pos/quote', { lines: line }, sales)).lines[0];
      expect(fine.metalOn).toBe('fine');
      expect(n(fine.metalWeightG)).toBeCloseTo(10 * n(k22Fineness) / 100, 3);
      expect(n(fine.ratePerGram)).toBeCloseTo(7600 * 100 / n(k24.fineness_percent), 2); // the 24K rate brought to 100%
      expect((await put('pricing.metal_value_basis', 'weight')).status).toBe(400);     // only net, fine or gross
      await put('pricing.metal_value_basis', 'net');
      expect(n((await ok('/api/pos/quote', { lines: line }, sales)).lines[0].metalAmount)).toBe(70000);

      await put('pricing.rounding.invoice_total', 'nearest_10');
      const q = await ok('/api/pos/quote', { lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.237' }] }, sales);
      expect(n(q.totals.grand) % 10).toBe(0);
      expect(n(q.totals.grand) - n(q.totals.roundOff)).toBeCloseTo(n(q.lines[0].lineTotal), 2);
    } finally {
      await put('pricing.metal_value_basis', 'net');
      await put('pricing.rounding.invoice_total', 'nearest_1');
    }
  });

  it('buys directly: goods and bill in one step, kept apart from inwards, cancelled together', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const line = [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '10.000', metalBasis: 'rupee', ratePerGram: '6800' }];
    const owed = async () => n((await ok(`/api/purchase/suppliers/${ids.supplier}/balance`)).rupees);
    const stock = async () => n((await balance(ids.bulk)).net_weight);
    const [owedBefore, stockBefore] = [await owed(), await stock()];

    const noBill = await call('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter, direct: true, lines: line });
    expect(noBill.body.error.code).toBe('bill_required');

    const buy = await ok('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter, direct: true, lines: line,
      bill: { supplierInvoiceNumber: `D-${run}`, supplierInvoiceDate: today } });
    expect(buy.is_direct).toBe(true);
    expect(buy.bill.supplier_invoice_number).toBe(`D-${run}`);
    expect(await stock()).toBe(stockBefore + 10);
    expect(await owed()).toBeCloseTo(owedBefore + 68000 * 1.03, 2);

    // The same bill twice is refused, and nothing is received.
    const again = await call('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter, direct: true, lines: line,
      bill: { supplierInvoiceNumber: `D-${run}`, supplierInvoiceDate: today } });
    expect(again.body.error.code).toBe('bill_duplicate');
    expect(await stock()).toBe(stockBefore + 10);

    const direct = (await ok(`/api/purchase/inwards?direct=true&search=D-${run}`)).rows;
    expect(direct.map((r: Body) => r.id)).toEqual([buy.id]);
    expect((await ok('/api/purchase/inwards?direct=false&limit=200')).rows.some((r: Body) => r.id === buy.id)).toBe(false);
    expect((await ok(`/api/purchase/suppliers/${ids.supplier}/balance`)).unbilled.some((u: Body) => u.id === buy.id)).toBe(false);

    // Its bill cannot be cancelled alone; cancelling the purchase undoes goods and bill together.
    expect((await call(`/api/purchase/bills/${buy.bill.id}/cancel`, { reason: 'wrong' })).body.error.code).toBe('bill_is_direct');
    const cancelled = await ok(`/api/purchase/inwards/${buy.id}/cancel`, { reason: 'Entered twice' });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.purchase_invoice_id).toBe(buy.bill.id); // the record keeps its bill
    expect((await ok(`/api/purchase/bills?search=D-${run}`)).rows[0].status).toBe('cancelled');
    expect(await stock()).toBe(stockBefore);
    expect(await owed()).toBeCloseTo(owedBefore, 2);
  });

  it('covers the counter’s edge cases: walk-in, daily cash, price moved, refunds, memo bills, hallmark, shop date', async () => {
    const tag = async (grams: string, extra: Record<string, unknown> = {}) =>
      (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: grams, ...extra }] })).rows[0];
    const grandOf = async (pieceId: string, customerId?: string) =>
      (await ok('/api/pos/quote', { customerId, lines: [{ pieceId }] }, sales)).totals.grand as string;
    const shopToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());

    // Walk-in: no name, paid in full, under ₹2 lakh.
    const small = await tag('2.000');
    const smallGrand = await grandOf(small.id);
    const unpaid = await call('/api/pos/checkout', { lines: [{ pieceId: small.id }], tenders: [{ paymentMethodId: ids.CASH, amount: '100' }] }, sales);
    expect(unpaid.body.error.code).toBe('walk_in_unpaid');
    const walkIn = await ok('/api/pos/checkout', { lines: [{ pieceId: small.id }], tenders: [{ paymentMethodId: ids.CASH, amount: smallGrand }], expectedTotal: smallGrand }, sales);
    expect(walkIn.customer_name).toBe('Walk-in Customer');
    expect(walkIn.doc_date.slice(0, 10)).toBe(shopToday); // dated by the shop's day, not UTC
    const big = await tag('30.000');
    expect((await call('/api/pos/checkout', { lines: [{ pieceId: big.id }], tenders: [] }, sales)).body.error.code).toBe('walk_in_not_allowed');

    // Returns: a walk-in is refunded, and a refund needs a way to pay it.
    const back = { invoiceId: walkIn.id, lines: [{ invoiceLineId: walkIn.lines[0].id }] };
    expect((await call('/api/pos/returns', { ...back, settlement: 'credit_note' })).body.error.code).toBe('walk_in_not_allowed');
    expect((await call('/api/pos/returns', { ...back, settlement: 'refund' })).body.error.code).toBe('refund_method_required');
    expect((await ok('/api/pos/returns', { ...back, settlement: 'refund', refundPaymentMethodId: ids.CASH })).refund_amount).toBeDefined();
    const walkInId = walkIn.customer_id;
    expect((await call('/api/pos/receipts', { customerId: walkInId, amount: '100', paymentMethodId: ids.CASH }, sales)).body.error.code).toBe('walk_in_not_allowed');

    // The counter showed one price; Masters moved it — refused, with the new total.
    const moved = await call('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: big.id }], tenders: [], expectedTotal: '1.00', pan: 'ABCDE1234F' }, sales);
    expect(moved.body.error.code).toBe('price_changed');
    expect(n(moved.body.error.details.total)).toBe(n(await grandOf(big.id, ids.customer)));

    // s.269ST: cash from one person in a day, across bills and receipts, stays under ₹2 lakh.
    const buyer = (await ok('/api/master/parties', { name: `Cash Buyer ${run}`, is_customer: true, pan: 'ABCDE1234F' })).id;
    const first = await tag('20.000');
    const firstGrand = await grandOf(first.id, buyer);
    await ok('/api/pos/checkout', { customerId: buyer, lines: [{ pieceId: first.id }], tenders: [{ paymentMethodId: ids.CASH, amount: firstGrand }] }, sales);
    const second = await tag('10.000');
    const secondCash = await call('/api/pos/checkout', { customerId: buyer, lines: [{ pieceId: second.id }], tenders: [{ paymentMethodId: ids.CASH, amount: await grandOf(second.id, buyer) }] }, sales);
    expect(secondCash.body.error.code).toBe('cash_limit');
    expect(secondCash.body.error.message).toMatch(/already paid .* in cash today/);
    expect((await call('/api/pos/receipts', { customerId: buyer, amount: '60000', paymentMethodId: ids.CASH }, sales)).body.error.code).toBe('cash_limit');
    await ok('/api/pos/checkout', { customerId: buyer, lines: [{ pieceId: second.id }], tenders: [{ paymentMethodId: ids.UPI, amount: await grandOf(second.id, buyer), reference: 'UPI7' }] }, sales);

    // A bill made from an approval memo that closed it: cancelling opens the memo again and the piece is back on it.
    const onMemo = await tag('3.000');
    const memo = await ok('/api/pos/memos', { customerId: ids.customer2, pieceIds: [onMemo.id], dueDate: shopToday }, sales);
    const memoBill = await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: onMemo.id }], tenders: [] }, sales);
    expect((await ok(`/api/pos/memos/${memo.id}`)).status).toBe('closed');
    await ok(`/api/pos/invoices/${memoBill.id}/cancel`, { reason: 'Wrong customer' });
    expect((await ok(`/api/pos/memos/${memo.id}`)).status).toBe('open');
    expect((await ok(`/api/stock/pieces/${onMemo.id}`)).status).toBe('on_memo');
    await ok(`/api/pos/memos/${memo.id}/return`, { pieceIds: [onMemo.id] }, sales);

    // Hallmark rule from Formulas: charged on pieces with a HUID, not on those without.
    await ok('/api/master/price-rules', { code: `HM${run}`, name: 'Hallmarking', applies_to: 'hallmark', basis: 'flat', rate: '45', slabs: [],
      slab_mode: 'whole', item_id: ids.ring, priority: 0, effective_from: '2026-01-01', is_active: true });
    const huid = run.slice(-6);
    const marked = await tag('4.000', { huid });
    const plain = await tag('4.000');
    const hq = await ok('/api/pos/quote', { lines: [{ pieceId: marked.id }, { pieceId: plain.id }] }, sales);
    expect(hq.lines.map((l: Body) => n(l.hallmarkAmount))).toEqual([45, 0]);
  });

  it('takes a whole bill back so nothing is left owing, round-off included, and lists it as returned', async () => {
    const [piece] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '7.333' }] })).rows;
    const bill = await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: piece.id }], tenders: [] }, sales);
    expect(Number(bill.round_off)).not.toBe(0);                     // the case that used to leave paise owing
    const ret = await ok('/api/pos/returns', { invoiceId: bill.id, lines: [{ invoiceLineId: bill.lines[0].id }], settlement: 'credit_note' });
    expect(Number(ret.total_amount)).toBe(Number(bill.total_amount)); // the bill's own total comes back
    const listed = (await ok(`/api/pos/invoices?search=${encodeURIComponent(bill.doc_number)}`)).rows[0];
    expect(Number(listed.balance_amount)).toBe(0);
    expect(listed.returned).toBe('full');
    expect((await ok('/api/pos/invoices?due=true&limit=200')).rows.some((r: { id: string }) => r.id === bill.id)).toBe(false);
    const inList = (await ok(`/api/pos/returns?search=${encodeURIComponent(ret.doc_number)}`)).rows[0];
    expect(inList.invoice_number).toBe(bill.doc_number);
    expect(inList.invoice_id).toBe(bill.id);
  });

  it('checks supplier bills: the same number in any case is refused, an unregistered supplier charges no GST', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const line = [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.000', metalBasis: 'rupee', ratePerGram: '6800' }];
    const buy = (supplierId: string, number: string) => call('/api/purchase/inwards', { supplierId, locationId: ids.counter, direct: true, lines: line,
      bill: { supplierInvoiceNumber: number, supplierInvoiceDate: today } });
    const firstBuy = await buy(ids.supplier, `Case-${run}`);
    expect(firstBuy.status).toBe(201);
    expect((await buy(ids.supplier, `CASE-${run}`)).body.error.code).toBe('bill_duplicate');
    const local = (await ok('/api/master/parties', { name: `Local Karigar ${run}`, is_supplier: true })).id;
    const unregistered = await buy(local, `L-${run}`);
    expect(n(unregistered.body.bill.cgst_amount) + n(unregistered.body.bill.sgst_amount) + n(unregistered.body.bill.igst_amount)).toBe(0);
    expect(n(firstBuy.body.bill.total_amount)).toBeCloseTo(6800 * 1.03, 2);
  });

  it('prints what it saves: receipts and supplier payments open with the shop and the party; blank supplier bill takes our number', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    // No numbered bill from the seller: our purchase number stands in.
    const noNumber = await ok('/api/purchase/inwards', { supplierId: ids.supplier, locationId: ids.counter, direct: true,
      lines: [{ itemId: ids.bulk, purityId: ids.k22, grossWeight: '1.000', metalBasis: 'rupee', ratePerGram: '6800' }], bill: { supplierInvoiceDate: today } });
    expect(noNumber.bill.supplier_invoice_number).toBe(noNumber.bill.doc_number);

    // An order is checked like the goods: a purity of another metal is refused.
    const silver = (await ok('/api/master/metals')).rows.find((m: Body) => m.code === 'SILVER');
    const silverItem = (await ok('/api/master/items', { code: `SLV${run}`, name: `Silver Bowl ${run}`, metal_id: silver.id, tracking: 'piece', hsn_code: '7114' })).id;
    const wrong = await call('/api/purchase/orders', { supplierId: ids.supplier, lines: [{ itemId: silverItem, purityId: ids.k22, grossWeight: '5.000' }] });
    expect(wrong.body.error.code).toBe('purity_metal_mismatch');

    const receipt = await ok('/api/pos/receipts', { customerId: ids.customer, amount: '500', paymentMethodId: ids.UPI, reference: 'UPI-R1' }, sales);
    const printed = await ok(`/api/pos/receipts/${receipt.id}`);
    expect(printed).toMatchObject({ doc_number: receipt.doc_number, method_name: expect.any(String), branch_name: expect.any(String), customer_name: `Neha ${run}` });

    const paid = await ok('/api/purchase/settlements', { supplierId: ids.supplier, kind: 'payment', amount: '1000', paymentMethodId: ids.BANK, reference: 'NEFT-P1' });
    const voucher = await ok(`/api/purchase/settlements/${paid.id}`);
    expect(voucher).toMatchObject({ doc_number: paid.doc_number, supplier_gstin: '27ABCDE1234F1Z5', reference: 'NEFT-P1', branch_name: expect.any(String) });
  });

  it('keeps the books balanced and stock equal to its journal', async () => {
    const books = await asPlatform((tx) => tx.one<{ debit: string; credit: string }>(
      `select sum(debit)::text as debit, sum(credit)::text as credit from ledger_entry where tenant_id = $1`, [tenantId]));
    expect(books.debit).toBe(books.credit);
    const snapshot = () => asPlatform((tx) => tx.query(
      `select item_id, purity_id, location_id, quantity, net_weight, value from stock_balance
        where tenant_id = $1 and (quantity <> 0 or net_weight <> 0) order by 1, 2, 3`, [tenantId]));
    const before = await snapshot();
    await ok('/api/stock/balances/rebuild', {});
    expect(await snapshot()).toEqual(before);
  });
});
