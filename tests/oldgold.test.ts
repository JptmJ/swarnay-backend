import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

const SHOP = 'oldgoldtest';
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Old Gold', { timeout: 300_000 }, () => {
  let server: Server;
  let base: string;
  let owner: string;
  let tenantId: string;
  let main: string;
  const run = Date.now().toString(36).toUpperCase();
  const ids: Record<string, string> = {};
  const n = (v: unknown) => Number(v);

  async function call(path: string, body?: unknown, method?: string) {
    const res = await fetch(`${base}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}`, 'x-branch-id': main },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  }
  const ok = async (path: string, body?: unknown) => {
    const r = await call(path, body);
    if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const code = async (path: string, body: unknown) => (await call(path, body)).body.error?.code;
  const setting = (key: string, value: unknown) => call(`/api/settings/config/${key}`, { value }, 'PUT');
  const DEFAULTS: [string, unknown][] = [
    ['oldgold.valuation_basis', 'fine'], ['oldgold.rate_source', 'buying'], ['oldgold.rate_margin_percent', 0], ['oldgold.melting_loss_percent', 0],
    ['oldgold.loss_editable', true], ['oldgold.allow_estimate', true], ['oldgold.buyback_enabled', true], ['oldgold.cash_payout_limit', 10000],
    ['oldgold.own.enabled', false], ['oldgold.own.loss_percent', 0], ['oldgold.own.rate_source', 'selling'], ['oldgold.kyc_required', 'buyback'],
    ['oldgold.kyc_min_value', 0], ['oldgold.hold_days', 0],
  ];
  const chain = (extra: Record<string, unknown> = {}) => ({ description: 'Old chain', metalId: ids.gold, grossWeight: '10.000', stoneWeight: '0.500',
    dirtWeight: '0.500', testMethod: 'xrf', testedPurityPercent: '91.600', ...extra });
  const pureBuy = 7400 * 100 / 99.9; // 24K buying rate brought to 100%
  const oldGoldStock = async () => (await ok('/api/oldgold/stock')).metals.find((m: Body) => m.metal_id === ids.gold) ?? { fine_weight: '0' };

  beforeAll(async () => {
    const existing = await asPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from tenant where code = $1`, [SHOP]));
    tenantId = existing?.id ?? (await provisionTenant({
      code: SHOP, legalName: 'Old Gold Test Jewellers', displayName: 'Old Gold Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Old Gold Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const o = await asPlatform(async (tx) => {
      const u = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [u.id]);
      return u;
    });
    main = o.branch;
    owner = signAccessToken({ sub: o.id, tenantId, tv: o.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const metals = (await ok('/api/master/metals')).rows;
    ids.gold = metals.find((m: Body) => m.code === 'GOLD').id;
    ids.silver = metals.find((m: Body) => m.code === 'SILVER').id;
    const purities = (await ok(`/api/master/purities?metal_id=${ids.gold}`)).rows;
    ids.k22 = purities.find((r: Body) => r.code === '22K').id;
    ids.k24 = purities.find((r: Body) => r.code === '24K').id;
    ids.counter = (await ok(`/api/master/locations?branch_id=${main}`)).rows.find((l: Body) => l.code === 'COUNTER').id;
    ids.ring = (await ok('/api/master/items', { code: `OGR${run}`, name: `Ring ${run}`, metal_id: ids.gold, tracking: 'piece', hsn_code: '7113' })).id;
    ids.bar = (await ok('/api/master/items', { code: `BAR${run}`, name: `Fine Bar ${run}`, metal_id: ids.gold, tracking: 'lot', nature: 'raw_metal', hsn_code: '7108' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Meena ${run}`, is_customer: true, phone: '9820011111' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Arjun ${run}`, is_customer: true, phone: '9820022222' })).id;
    ids.refiner = (await ok('/api/master/parties', { name: `MMTC Refinery ${run}`, is_supplier: true, gstin: '27ABCDE1234F1Z5' })).id;
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k24, rate_per_gram: '7600', buying_rate_per_gram: '7400' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI', 'BANK', 'ADVANCE']) ids[c] = methods.find((m: Body) => m.code === c).id;
    for (const [k, v] of DEFAULTS) await setting(k, v);
  });

  afterAll(async () => {
    for (const [k, v] of DEFAULTS) await setting(k, v);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('values old gold the way the settings say: fine or purity basis, loss, margin, estimates', async () => {
    const quote = async (extra: Record<string, unknown> = {}) => (await ok('/api/oldgold/quote', { lines: [chain(extra)] })).lines[0];
    let q = await quote();
    expect(n(q.netWeight)).toBe(9);
    expect(n(q.fineWeight)).toBeCloseTo(8.244, 3);                  // 9 g × 91.6%
    expect(n(q.value)).toBeCloseTo(8.244 * Number(pureBuy.toFixed(2)), 2);

    await setting('oldgold.melting_loss_percent', 2);
    const shown = await ok('/api/oldgold/settings');                  // what the desk and counter read
    expect(n(shown.loss)).toBe(2);
    expect(shown.valuation).toBe('fine');
    expect(shown.registerColumns).toContain('fine');
    q = await quote();
    expect(n(q.lossWeight)).toBeCloseTo(0.165, 3);                   // 2% of 8.244 g
    expect(n(q.fineWeight)).toBeCloseTo(8.079, 3);
    expect(n((await quote({ lossPercent: '1' })).lossPercent)).toBe(1); // staff may change it
    await setting('oldgold.loss_editable', false);
    expect(n((await quote({ lossPercent: '1' })).lossPercent)).toBe(2); // …unless the settings say no

    await setting('oldgold.valuation_basis', 'purity');
    q = await quote();
    expect(n(q.ratePerGram)).toBe(6800);                            // 22K buying rate, the nearest purity at or below 91.6%
    expect(n(q.value)).toBeCloseTo(9 * 0.98 * 6800, 2);
    await setting('oldgold.rate_margin_percent', 1);
    expect(n((await quote()).ratePerGram)).toBe(6732);
    expect(await code('/api/oldgold/quote', { lines: [chain({ testedPurityPercent: '80' })] })).toBe('rate_required'); // nothing priced at or below 80%

    await setting('oldgold.allow_estimate', false);
    expect(await code('/api/oldgold/quote', { lines: [chain({ testMethod: 'estimate' })] })).toBe('estimate_not_allowed');
    for (const [k, v] of DEFAULTS) await setting(k, v);
    expect(await code('/api/oldgold/quote', { lines: [chain({ metalId: ids.silver, testedPurityPercent: '92.5' })] })).toBe('rate_required');
  });

  it('takes old gold in exchange: stock up as old gold, value on the customer’s account to spend on a bill', async () => {
    const before = n((await oldGoldStock()).fine_weight);
    const intake = await ok('/api/oldgold/intakes', { customerId: ids.customer, settlement: 'exchange', lines: [chain()] });
    ids.exchange = intake.id;
    expect(intake.status).toBe('posted');
    expect(n(intake.credit_amount)).toBe(n(intake.net_value));
    expect(n((await oldGoldStock()).fine_weight)).toBeCloseTo(before + 8.244, 3);
    expect(n((await ok(`/api/pos/customers/${ids.customer}/balance`)).advance)).toBeCloseTo(n(intake.net_value), 2);

    const walkIn = await call('/api/pos/checkout', { lines: [], tenders: [] }); // makes sure the walk-in party exists
    expect(walkIn.status).toBe(400);
    const walkInId = (await ok('/api/master/parties?search=Walk-in')).rows.find((p: Body) => p.code === 'WALKIN')?.id;
    if (walkInId) expect(await code('/api/oldgold/intakes', { customerId: walkInId, settlement: 'exchange', lines: [chain()] })).toBe('walk_in_not_allowed');
  });

  it('buys back for money: identity, PAN at ₹2 lakh, the daily cash limit and switching buyback off', async () => {
    const buy = (extra: Record<string, unknown>) => call('/api/oldgold/intakes', { customerId: ids.customer2, settlement: 'buyback', lines: [chain()], ...extra });
    expect((await buy({ payout: { paymentMethodId: ids.CASH } })).body.error.code).toBe('id_proof_required');
    const idProof = { type: 'aadhaar', number: '1234 5678 9012' };
    expect((await buy({ idProof, payout: { paymentMethodId: ids.CASH } })).body.error.code).toBe('cash_limit'); // ~₹61,000 > ₹10,000 cash
    const paid = await ok('/api/oldgold/intakes', { customerId: ids.customer2, settlement: 'buyback', idProof, lines: [chain()],
      payout: { paymentMethodId: ids.BANK, reference: `NEFT${run}` } });
    expect(n(paid.paid_out_amount)).toBe(n(paid.net_value));
    expect(paid.payouts).toHaveLength(1);
    expect(n((await ok(`/api/pos/customers/${ids.customer2}/balance`)).advance)).toBe(0);
    expect(await code(`/api/oldgold/intakes/${paid.id}/cancel`, { reason: 'Entered twice' })).toBe('intake_paid_out');

    const heavy = chain({ grossWeight: '40.000' });
    expect((await call('/api/oldgold/intakes', { customerId: ids.customer2, settlement: 'buyback', idProof, lines: [heavy],
      payout: { paymentMethodId: ids.BANK, reference: 'NEFT2' } })).body.error.code).toBe('pan_required');
    await setting('oldgold.buyback_enabled', false);
    expect((await buy({ idProof, payout: { paymentMethodId: ids.BANK, reference: 'NEFT3' } })).body.error.code).toBe('buyback_disabled');
    await setting('oldgold.buyback_enabled', true);
  });

  it('pays out part of an exchange credit later, never more than is left or already spent', async () => {
    const intake = await ok('/api/oldgold/intakes', { customerId: ids.customer2, settlement: 'exchange', lines: [chain({ grossWeight: '3.000', stoneWeight: '0', dirtWeight: '0' })],
      idProof: { type: 'pan', number: 'ABCDE1234F' } });
    const part = await ok(`/api/oldgold/intakes/${intake.id}/payout`, { paymentMethodId: ids.CASH, amount: '5000' });
    expect(n(part.paid_out_amount)).toBe(5000);
    expect(await code(`/api/oldgold/intakes/${intake.id}/payout`, { paymentMethodId: ids.CASH, amount: '5001' })).toBe('cash_limit'); // ₹5,000 + ₹5,001 > ₹10,000 today
    expect(await code(`/api/oldgold/intakes/${intake.id}/payout`, { paymentMethodId: ids.BANK, reference: 'N1', amount: '999999' })).toBe('payout_exceeds');
  });

  it('cancels an exchange only while its credit is unspent; spending it at the counter is a normal tender', async () => {
    const spent = await ok('/api/oldgold/intakes', { customerId: ids.customer, settlement: 'exchange', lines: [chain({ grossWeight: '2.000', stoneWeight: '0', dirtWeight: '0' })] });
    const [piece] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '20.000' }] })).rows;
    const quote = await ok('/api/pos/quote', { customerId: ids.customer, lines: [{ pieceId: piece.id }] });
    const credit = n((await ok(`/api/pos/customers/${ids.customer}/balance`)).advance);
    const bill = await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: piece.id }],
      tenders: [{ paymentMethodId: ids.ADVANCE, amount: credit.toFixed(2) }, { paymentMethodId: ids.UPI, amount: (n(quote.totals.grand) - credit).toFixed(2), reference: 'U1' }] });
    expect(n(bill.balance_amount)).toBe(0);
    expect(await code(`/api/oldgold/intakes/${spent.id}/cancel`, { reason: 'Mistake' })).toBe('credit_used');
  });

  it('takes old gold on a bill at the counter: walk-in within the bill, a named customer keeps any excess; cancelling the bill hands it back', async () => {
    const tag = async (grams: string) => (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: grams }] })).rows[0];
    const small = chain({ grossWeight: '2.000', stoneWeight: '0', dirtWeight: '0' });

    const p1 = await tag('10.000');
    const grand = n((await ok('/api/pos/quote', { lines: [{ pieceId: p1.id }] })).totals.grand);
    const og = (await ok('/api/oldgold/quote', { lines: [small] })).totals.value;
    const walk = await ok('/api/pos/checkout', { lines: [{ pieceId: p1.id }], oldGold: { lines: [small] },
      tenders: [{ paymentMethodId: ids.CASH, amount: (grand - n(og)).toFixed(0) }] });
    expect(walk.customer_name).toBe('Walk-in Customer');
    const ogPay = walk.payments.find((p: Body) => p.mode === 'old_gold');
    expect(n(ogPay.amount)).toBeCloseTo(n(og), 2);
    expect(ogPay.reference).toMatch(/^OG/);

    const p2 = await tag('1.000');
    const big = chain({ grossWeight: '30.000', stoneWeight: '0', dirtWeight: '0' });
    expect(await code('/api/pos/checkout', { lines: [{ pieceId: p2.id }], oldGold: { lines: [big] }, tenders: [] })).toBe('old_gold_exceeds');

    const before = n((await ok(`/api/pos/customers/${ids.customer2}/balance`)).advance);
    const named = await ok('/api/pos/checkout', { customerId: ids.customer2, lines: [{ pieceId: p2.id }], oldGold: { lines: [big] }, tenders: [], pan: 'ABCDE1234F' });
    expect(n(named.balance_amount)).toBe(0);
    const bigValue = n((await ok('/api/oldgold/quote', { lines: [big] })).totals.value);
    expect(n((await ok(`/api/pos/customers/${ids.customer2}/balance`)).advance)).toBeCloseTo(before + bigValue - n(named.total_amount), 2);

    const stockBefore = n((await oldGoldStock()).fine_weight);
    await ok(`/api/pos/invoices/${walk.id}/cancel`, { reason: 'Customer changed mind' });
    const intake = (await ok(`/api/oldgold/intakes?search=${ogPay.reference}`)).rows[0];
    expect(intake.status).toBe('cancelled');
    expect(n((await oldGoldStock()).fine_weight)).toBeCloseTo(stockBefore - 1.832, 3);
    expect(await code(`/api/oldgold/intakes/${(await ok(`/api/oldgold/intakes?search=${named.payments.find((p: Body) => p.mode === 'old_gold').reference}`)).rows[0].id}/cancel`, { reason: 'x mistake' })).toBe('intake_on_bill');
  });

  it('applies own-jewellery terms to a piece this shop sold, once', async () => {
    const [piece] = (await ok('/api/tagging/pieces', { pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '5.000' }] })).rows;
    const own = { description: 'Our ring', grossWeight: '5.000', testMethod: 'hallmark', ownPiece: piece.tag_number };
    expect(await code('/api/oldgold/quote', { lines: [own] })).toBe('own_terms_off');
    await setting('oldgold.own.enabled', true);
    await setting('oldgold.melting_loss_percent', 3);
    expect(await code('/api/oldgold/quote', { lines: [own] })).toBe('own_piece_not_sold');
    await ok('/api/pos/checkout', { customerId: ids.customer, lines: [{ pieceId: piece.id }], tenders: [] });
    const q = (await ok('/api/oldgold/quote', { lines: [own] })).lines[0];
    expect(n(q.purityPercent)).toBeCloseTo(91.6, 3);   // from the piece
    expect(n(q.lossPercent)).toBe(0);                  // own terms, not the 3% for outside gold
    expect(n(q.ratePerGram)).toBeCloseTo(7600 * 100 / 99.9, 1); // selling rate
    await ok('/api/oldgold/intakes', { customerId: ids.customer, settlement: 'exchange', lines: [own] });
    expect(await code('/api/oldgold/quote', { lines: [own] })).toBe('own_piece_repeated');
    await setting('oldgold.own.enabled', false);
    await setting('oldgold.melting_loss_percent', 0);
  });

  it('melts in-house with the hold period, one metal at a time; a melted intake cannot be cancelled; a batch can be undone', async () => {
    const stock = await ok('/api/oldgold/stock');
    const lines = stock.articles.filter((a: Body) => a.metal_id === ids.gold).slice(0, 2);
    const ids_ = lines.map((a: Body) => a.id);
    const fineIn = lines.reduce((s: number, a: Body) => s + n(a.fine_weight), 0);
    const output = { outputItemId: ids.bar, outputPurityId: ids.k24, outputWeight: (fineIn / 0.995 - 0.05).toFixed(3), assayPercent: '99.5', locationId: ids.counter };

    await setting('oldgold.hold_days', 7);
    expect(await code('/api/oldgold/melt-batches', { kind: 'melt', itemIds: ids_, output })).toBe('on_hold');
    await setting('oldgold.hold_days', 0);
    expect(await code('/api/oldgold/melt-batches', { kind: 'melt', itemIds: ids_ })).toBe('output_required');

    const batch = await ok('/api/oldgold/melt-batches', { kind: 'melt', itemIds: ids_, output });
    expect(batch.status).toBe('melted');
    expect(n(batch.input_fine_weight)).toBeCloseTo(fineIn, 3);
    expect(n(batch.loss_fine_weight)).toBeCloseTo(fineIn - n(batch.output_fine_weight), 3);
    expect(n((await ok(`/api/stock/balances?itemId=${ids.bar}&locationId=${ids.counter}`)).rows[0].net_weight)).toBeCloseTo(n(output.outputWeight), 3);
    expect(await code('/api/oldgold/melt-batches', { kind: 'melt', itemIds: ids_, output })).toBe('already_melted');
    const intakeId = (await ok(`/api/oldgold/intakes?search=${lines[0].voucher_number}`)).rows[0].id;
    expect(await code(`/api/oldgold/intakes/${intakeId}/cancel`, { reason: 'Mistake here' })).toBe('intake_melted');

    await ok(`/api/oldgold/melt-batches/${batch.id}/cancel`, { reason: 'Wrong batch' });
    expect((await ok('/api/oldgold/stock')).articles.some((a: Body) => a.id === ids_[0])).toBe(true);
  });

  it('sends old gold to a refiner and receives fine gold, owing the refining charge', async () => {
    const articles = (await ok('/api/oldgold/stock')).articles.filter((a: Body) => a.metal_id === ids.gold);
    const fineIn = articles.reduce((s: number, a: Body) => s + n(a.fine_weight), 0);
    const sent = await ok('/api/oldgold/melt-batches', { kind: 'refine', itemIds: articles.map((a: Body) => a.id), refinerId: ids.refiner });
    expect(sent.status).toBe('sent');
    expect((await ok('/api/oldgold/stock')).atRefiner.some((b: Body) => b.id === sent.id)).toBe(true);
    expect(n((await oldGoldStock()).fine_weight)).toBe(0);
    const got = await ok(`/api/oldgold/melt-batches/${sent.id}/receive`, { outputItemId: ids.bar, outputPurityId: ids.k24,
      outputWeight: (fineIn * 0.99 / 0.999).toFixed(3), refiningCharge: '1500', certificateNumber: `ASSAY-${run}` });
    expect(got.status).toBe('received');
    expect(n(got.loss_fine_weight)).toBeGreaterThan(0);
    expect(n((await ok(`/api/purchase/suppliers/${ids.refiner}/balance`)).rupees)).toBe(1500);
    expect(await code(`/api/oldgold/melt-batches/${sent.id}/receive`, { outputItemId: ids.bar, outputPurityId: ids.k24, outputWeight: '1' })).toBe('not_sent');
  });

  it('keeps a register, the books balanced and stock equal to its journal', async () => {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const reg = await ok(`/api/oldgold/register?from=${today}&to=${today}`);
    expect(reg.rows.length).toBeGreaterThan(3);
    expect(reg.rows[0]).toMatchObject({ customer: expect.any(String), voucher: expect.stringMatching(/^OG/), fine: expect.anything() });
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
