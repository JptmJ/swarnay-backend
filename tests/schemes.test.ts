import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

const SHOP = 'schemestest';
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Swarna Nidhi schemes', { timeout: 300_000 }, () => {
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
  const ok = async (path: string, body?: unknown, method?: string) => {
    const r = await call(path, body, method);
    if (r.status >= 300) throw new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const code = async (path: string, body?: unknown, method?: string) => (await call(path, body, method)).body.error?.code;
  const setting = (key: string, value: unknown) => call(`/api/settings/config/${key}`, { value }, 'PUT');
  const DEFAULTS: [string, unknown][] = [
    ['schemes.bonus.accrual', 'maturity'], ['schemes.bonus.treatment', 'expense'], ['schemes.bonus.forfeit_on_missed', true],
    ['schemes.rate_source', 'selling'], ['schemes.late.rate_basis', 'today'], ['schemes.allow_advance', true],
    ['schemes.auto_mature', true], ['schemes.redemption.allow_order', true], ['schemes.redemption.allow_partial', false],
    ['schemes.closure.allowed', true], ['schemes.closure.settlement', 'ask'], ['schemes.closure.deduction_percent', 0],
    ['schemes.closure.min_months', 0], ['schemes.missed_after_days', 30],
  ];
  /** A plan, with whatever terms this test needs. */
  const plan = async (over: Body = {}) => ok('/api/schemes/plans', {
    code: `SN${run}${Math.floor(Math.random() * 9000 + 1000)}`, name: `Plan ${run}`, metal_id: ids.gold,
    tenure_months: 11, installment_amount: '5000', bonus_installments: '1', ...over,
  });
  /** An account on a plan, opened far enough back that every month is already due. */
  const monthsAgo = (m: number) => {
    const d = new Date();
    d.setMonth(d.getMonth() - m);
    return d.toISOString().slice(0, 10);
  };
  const account = async (planId: string, over: Body = {}) => ok('/api/schemes/accounts', {
    schemePlanId: planId, customerId: ids.customer, enrolledOn: monthsAgo(11), dueDay: 5, ...over,
  });
  const payAll = async (accountId: string) => {
    const detail = await ok(`/api/schemes/accounts/${accountId}`);
    for (const i of detail.installments) {
      if (i.status === 'paid' || i.status === 'waived') continue;
      await ok(`/api/schemes/accounts/${accountId}/collect`,
        { installmentIds: [i.id], paymentMethodId: ids.BANK, reference: `NEFT${i.installment_number}` });
    }
    return ok(`/api/schemes/accounts/${accountId}/refresh`, {});
  };
  const balance = async (customerId: string) => n((await ok(`/api/pos/customers/${customerId}/balance`)).advance);

  beforeAll(async () => {
    const existing = await asPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from tenant where code = $1`, [SHOP]));
    tenantId = existing?.id ?? (await provisionTenant({
      code: SHOP, legalName: 'Schemes Test Jewellers', displayName: 'Schemes Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Schemes Owner', password: 'owner-pass-1' },
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
    const purities = (await ok(`/api/master/purities?metal_id=${ids.gold}`)).rows;
    ids.k22 = purities.find((r: Body) => r.code === '22K').id;
    ids.counter = (await ok(`/api/master/locations?branch_id=${main}`)).rows.find((l: Body) => l.code === 'COUNTER').id;
    ids.ring = (await ok('/api/master/items', { code: `SNR${run}`, name: `Ring ${run}`, metal_id: ids.gold, tracking: 'piece', hsn_code: '7113' })).id;
    ids.customer = (await ok('/api/master/parties', { name: `Anita ${run}`, is_customer: true, phone: '9840011111' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Deepa ${run}`, is_customer: true, phone: '9840022222' })).id;
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI', 'BANK', 'ADVANCE']) ids[c] = methods.find((m: Body) => m.code === c)?.id ?? '';
    ids.scheme = (await ok('/api/master/payment-methods', {
      code: `SCH${run}`, name: 'Swarna Nidhi', kind: 'scheme', is_active: true,
    })).id;
    for (const [k, v] of DEFAULTS) await setting(k, v);
  });

  afterAll(async () => {
    for (const [k, v] of DEFAULTS) await setting(k, v);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('enrols a member, writes the whole schedule, and freezes the plan’s terms onto the account', async () => {
    const p = await plan({ bonus_installments: '1', grace_period_days: 7, max_missed_installments: 2 });
    const a = await account(p.id);
    expect(a.account_number).toMatch(/^SN-/);
    expect(a.installments).toBe(11);
    expect(n(a.installment_amount)).toBe(5000);
    expect(a.maturity_date > a.enrolled_on).toBe(true);

    // The passbook is written up front: eleven months, each with its date.
    const detail = await ok(`/api/schemes/accounts/${a.id}`);
    expect(detail.installments).toHaveLength(11);
    expect(detail.installments.every((i: Body) => i.status === 'due' || i.status === 'missed')).toBe(true);
    expect(new Set(detail.installments.map((i: Body) => i.due_date)).size).toBe(11);   // no two months share a date

    // Improving the plan afterwards does not change what this member was promised.
    await ok(`/api/schemes/plans/${p.id}`, { bonus_installments: '3' }, 'PATCH');
    const after = await ok(`/api/schemes/accounts/${a.id}`);
    expect(n(after.bonus_installments)).toBe(1);
  });

  it('takes a month’s money, posts it as a liability and gives a receipt', async () => {
    const p = await plan();
    const a = await account(p.id);
    const first = (await ok(`/api/schemes/accounts/${a.id}`)).installments[0];

    const taken = await ok(`/api/schemes/accounts/${a.id}/collect`, {
      installmentIds: [first.id], paymentMethodId: ids.CASH,
    });
    expect(taken.receiptNumber).toMatch(/^SNC-/);
    expect(n(taken.amountPaid)).toBe(5000);
    expect(n(taken.account.total_paid)).toBe(5000);
    expect(taken.account.installments_paid).toBe(1);

    // It is money the shop owes back, not money it has earned.
    const ledger = await asPlatform((tx) => tx.query<{ code: string; debit: string; credit: string }>(
      `select ac.code, e.debit::text, e.credit::text from ledger_entry e
         join account ac on ac.id = e.account_id where e.voucher_id = $1`, [taken.voucherId]));
    const liability = ledger.find((r) => r.code === '2300');
    expect(n(liability?.credit)).toBe(5000);
    expect(ledger.find((r) => r.code === '1000')?.debit).toBeTruthy();   // cash in
    expect(ledger.some((r) => r.code.startsWith('4'))).toBe(false);       // nothing is income

    // Paying the same month twice is not possible.
    expect(await code(`/api/schemes/accounts/${a.id}/collect`, {
      installmentIds: [first.id], paymentMethodId: ids.CASH,
    })).toBe('installment_not_open');
  });

  it('clears several months with one lump sum, and refuses one that does not cover a month', async () => {
    const p = await plan();
    const a = await account(p.id);
    const paid = await ok(`/api/schemes/accounts/${a.id}/collect`, { amount: '15000', paymentMethodId: ids.UPI, reference: 'UTR-15K' });
    expect(paid.installments).toEqual([1, 2, 3]);
    expect(n(paid.account.total_paid)).toBe(15000);

    expect(await code(`/api/schemes/accounts/${a.id}/collect`, { amount: '2000', paymentMethodId: ids.UPI, reference: 'U1' }))
      .toBe('amount_below_installment');
    expect(await code(`/api/schemes/accounts/${a.id}/collect`, { amount: '7000', paymentMethodId: ids.UPI, reference: 'U2' }))
      .toBe('amount_not_whole_months');

    // A mode that insists on a reference is not satisfied without one.
    expect(await code(`/api/schemes/accounts/${a.id}/collect`, { amount: '5000', paymentMethodId: ids.UPI }))
      .toBe('reference_required');

    // A shop that takes one month at a time says so, and is obeyed.
    await setting('schemes.allow_advance', false);
    expect(await code(`/api/schemes/accounts/${a.id}/collect`, { amount: '10000', paymentMethodId: ids.UPI, reference: 'U3' }))
      .toBe('advance_not_allowed');
    await setting('schemes.allow_advance', true);
  });

  it('buys grams on a weight plan, at the rate of the day it was paid', async () => {
    const p = await plan({ accrual_basis: 'weight', purity_id: ids.k22, installment_amount: '7000' });
    const a = await account(p.id);
    const taken = await ok(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.CASH });
    expect(n(taken.ratePerGram)).toBe(7000);
    expect(n(taken.weightAccrued)).toBeCloseTo(1, 3);          // ₹7,000 at ₹7,000/g is one gram

    // The grams are owed, and show as metal the shop has to hand over.
    const metal = await asPlatform((tx) => tx.query<{ code: string; weight_in: string }>(
      `select ac.code, m.weight_in::text from metal_ledger_entry m
         join account ac on ac.id = m.account_id where m.voucher_id = $1`, [taken.voucherId]));
    expect(n(metal.find((r) => r.code === '2310')?.weight_in)).toBeCloseTo(1, 3);

    // If gold rises, the next month buys less — which is the whole point of a weight plan.
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k22, rate_per_gram: '14000', buying_rate_per_gram: '13600' });
    const second = await ok(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.CASH });
    expect(n(second.weightAccrued)).toBeCloseTo(0.5, 3);
    expect(n(second.account.total_weight_accrued)).toBeCloseTo(1.5, 3);
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
  });

  it('takes back a collection entered by mistake, with mirror entries', async () => {
    const p = await plan();
    const a = await account(p.id);
    const taken = await ok(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.CASH });
    const paidRow = (await ok(`/api/schemes/accounts/${a.id}`)).installments.find((i: Body) => i.status === 'paid');
    expect(paidRow.receipt_number).toBe(taken.receiptNumber);

    const after = await ok(`/api/schemes/installments/${paidRow.id}/cancel`, { reason: 'Cheque bounced' });
    expect(n(after.total_paid)).toBe(0);
    expect(after.installments_paid).toBe(0);

    // The month is open again and the money was reversed, never deleted.
    const back = (await ok(`/api/schemes/accounts/${a.id}`)).installments[0];
    expect(['due', 'missed']).toContain(back.status);
    expect(back.cancel_reason).toBe('Cheque bounced');
    const reversals = await asPlatform((tx) => tx.one<{ total: number }>(
      `select count(*)::int as total from voucher where reverses_voucher_id = $1`, [taken.voucherId]));
    expect(reversals.total).toBe(1);

    // It can then be collected properly.
    const again = await ok(`/api/schemes/accounts/${a.id}/collect`, { installmentIds: [back.id], paymentMethodId: ids.BANK, reference: 'NEFT-RETRY' });
    expect(n(again.account.total_paid)).toBe(5000);
  });

  it('adds the bonus at maturity, and takes it away when too many months were missed', async () => {
    const p = await plan({ bonus_installments: '1' });
    const a = await account(p.id);
    const matured = await payAll(a.id);
    expect(matured.installments_paid).toBe(11);
    expect(n(matured.bonus_amount)).toBe(5000);                        // pay 11, get 12
    expect(n(matured.redeemable_amount)).toBe(60000);                  // 55,000 saved + 5,000 bonus
    expect(matured.status).toBe('matured');

    // A member who missed more than the plan allows loses the bonus.
    const slack = await account(p.id, { customerId: ids.customer2 });
    const rows = (await ok(`/api/schemes/accounts/${slack.id}`)).installments;
    for (const i of rows.slice(0, 7)) {
      await ok(`/api/schemes/accounts/${slack.id}/collect`, { installmentIds: [i.id], paymentMethodId: ids.CASH });
    }
    const lapsed = await ok(`/api/schemes/accounts/${slack.id}/refresh`, {});
    expect(lapsed.installments_missed).toBeGreaterThan(2);
    expect(lapsed.is_bonus_forfeited).toBe(true);
    expect(n(lapsed.bonus_amount)).toBe(0);

    // Unless the shop does not take the bonus away for missed months.
    await setting('schemes.bonus.forfeit_on_missed', false);
    const forgiven = await ok(`/api/schemes/accounts/${slack.id}/refresh`, {});
    expect(forgiven.is_bonus_forfeited).toBe(false);
    await setting('schemes.bonus.forfeit_on_missed', true);
  });

  it('builds the bonus month by month when the shop shows it that way', async () => {
    await setting('schemes.bonus.accrual', 'monthly');
    const p = await plan({ bonus_installments: '1', max_missed_installments: 99 });
    const a = await account(p.id);
    const rows = (await ok(`/api/schemes/accounts/${a.id}`)).installments;
    for (const i of rows.slice(0, 5)) {
      await ok(`/api/schemes/accounts/${a.id}/collect`, { installmentIds: [i.id], paymentMethodId: ids.CASH });
    }
    const part = await ok(`/api/schemes/accounts/${a.id}/refresh`, {});
    // Five of eleven months in: the member can already see five elevenths of the bonus.
    expect(n(part.bonus_amount)).toBeCloseTo(5000 * 5 / 11, 0);
    expect(n(part.redeemable_amount)).toBeCloseTo(25000 + 5000 * 5 / 11, 0);
    await setting('schemes.bonus.accrual', 'maturity');
  });

  it('spends a matured account at the counter, and the bill is paid from the member’s savings', async () => {
    const p = await plan();
    const a = await account(p.id);
    await payAll(a.id);

    const piece = (await ok('/api/tagging/pieces', {
      pieces: [{ itemId: ids.ring, purityId: ids.k22, locationId: ids.counter, grossWeight: '7.000', makingBasis: 'flat', makingRate: '0' }],
    })).rows[0];

    const before = await balance(ids.customer);
    const bill = await ok('/api/pos/checkout', {
      customerId: ids.customer, lines: [{ pieceId: piece.id }],
      tenders: [{ paymentMethodId: ids.scheme, amount: '60000', schemeAccountId: a.id }],
    });
    expect(bill.doc_number).toMatch(/^INV-/);
    expect(n(bill.balance_amount)).toBe(0);

    // The account was spent, and the liability it was carrying has gone.
    const spent = await ok(`/api/schemes/accounts/${a.id}`);
    expect(spent.status).toBe('redeemed');
    expect(spent.redemptions[0].sales_invoice_id).toBe(bill.id);
    expect(n(spent.redemptions[0].amount_redeemed)).toBe(60000);

    // What the bill did not use is still the member's to spend.
    expect(await balance(ids.customer)).toBeCloseTo(before + 60000 - n(bill.total_amount), 2);
  });

  it('will not let a scheme be spent before it matures, or twice over', async () => {
    const p = await plan();
    const a = await account(p.id);
    await ok(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.UPI, reference: 'UTR-1' });
    expect(await code(`/api/schemes/accounts/${a.id}/redeem`, { cashPaymentMethodId: ids.CASH })).toBe('not_matured');

    await payAll(a.id);
    expect(await code(`/api/schemes/accounts/${a.id}/redeem`, { amount: '1000' })).toBe('partial_not_allowed');
    expect(await code(`/api/schemes/accounts/${a.id}/redeem`, {})).toBe('validation_error');  // nothing to put it against

    const order = await ok('/api/orders', {
      orderType: 'booking', customerId: ids.customer, expectedDeliveryDate: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
      lines: [{ title: 'Chain', lineMode: 'custom', itemId: ids.ring, purityId: ids.k22, grossWeight: '10.000' }],
    });
    const used = await ok(`/api/schemes/accounts/${a.id}/redeem`, { retailOrderId: order.id });
    expect(n(used.redemption.amount_redeemed)).toBe(60000);

    // The order knows what was put towards it, so the counter knows what is left.
    const onOrder = await ok(`/api/orders/${order.id}`);
    expect(n(onOrder.scheme_credit)).toBe(60000);
    expect(n(onOrder.balance_amount)).toBeCloseTo(n(onOrder.total_amount) - 60000, 2);

    // And it cannot be spent again.
    expect(await code(`/api/schemes/accounts/${a.id}/redeem`, { retailOrderId: order.id })).toBe('account_not_redeemable');
  });

  it('closes an account early: the money back, the bonus not', async () => {
    await setting('schemes.closure.deduction_percent', 10);
    const p = await plan({ bonus_installments: '1' });
    const a = await account(p.id);
    const rows = (await ok(`/api/schemes/accounts/${a.id}`)).installments;
    for (const i of rows.slice(0, 4)) {
      await ok(`/api/schemes/accounts/${a.id}/collect`, { installmentIds: [i.id], paymentMethodId: ids.CASH });
    }

    const closed = await ok(`/api/schemes/accounts/${a.id}/close`, {
      reason: 'Member moving away', settlement: 'refund', refundPaymentMethodId: ids.BANK,
    });
    expect(n(closed.refunded)).toBe(18000);            // 20,000 paid, 10% kept
    expect(n(closed.kept)).toBe(2000);
    expect(closed.account.status).toBe('closed');
    expect(closed.closure.kind).toBe('early_closure');

    // Nothing more can happen on it.
    expect(await code(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.CASH })).toBe('account_not_active');
    expect(await code(`/api/schemes/accounts/${a.id}/close`, { reason: 'again', settlement: 'credit' })).toBe('account_not_active');

    // A shop that insists on some months served says so.
    await setting('schemes.closure.min_months', 6);
    const b = await account(p.id, { customerId: ids.customer2 });
    await ok(`/api/schemes/accounts/${b.id}/collect`, { paymentMethodId: ids.CASH });
    expect(await code(`/api/schemes/accounts/${b.id}/close`, { reason: 'too soon', settlement: 'credit' })).toBe('closure_too_early');
    await setting('schemes.closure.min_months', 0);
    await setting('schemes.closure.deduction_percent', 0);

    // Closed as credit instead, the member keeps it to spend in the shop.
    const before = await balance(ids.customer2);
    await ok(`/api/schemes/accounts/${b.id}/close`, { reason: 'Prefers credit', settlement: 'credit' });
    expect(await balance(ids.customer2)).toBeCloseTo(before + 5000, 2);
  });

  it('shows what is due, what a member can spend, and what the shop owes', async () => {
    const p = await plan({ max_missed_installments: 99 });
    const a = await account(p.id);
    const due = await ok('/api/schemes/due');
    const mine = due.rows.filter((r: Body) => r.scheme_account_id === a.id);
    expect(mine.length).toBeGreaterThan(0);
    expect(n(due.totalDue)).toBeGreaterThan(0);
    expect(mine[0].customer_name).toContain('Anita');
    expect(mine[0].days_late).toBeGreaterThan(0);

    await payAll(a.id);
    const credit = await ok(`/api/schemes/customers/${ids.customer}/credit`);
    expect(credit.accounts.some((x: Body) => x.id === a.id)).toBe(true);
    expect(n(credit.total)).toBeGreaterThanOrEqual(60000);

    const owed = await ok('/api/schemes/liability');
    expect(n(owed.collected)).toBeGreaterThan(0);
    expect(n(owed.owed)).toBeGreaterThan(0);
    expect(owed.active_accounts + owed.matured_accounts).toBeGreaterThan(0);
  });

  it('refuses money a plan does not take, and a mode that cannot pay an installment', async () => {
    const fixed = await plan({ installment_amount: '5000', is_flexible_amount: false });
    const a = await account(fixed.id);
    expect(await code('/api/schemes/accounts', {
      schemePlanId: fixed.id, customerId: ids.customer2, installmentAmount: '3000',
    })).toBe('installment_fixed');

    const flexible = await plan({ is_flexible_amount: true, minimum_installment: '1000', installment_amount: '2000' });
    const f = await account(flexible.id, { customerId: ids.customer2, installmentAmount: '2500' });
    expect(n(f.installment_amount)).toBe(2500);
    const part = await ok(`/api/schemes/accounts/${f.id}/collect`, { amount: '1500', paymentMethodId: ids.UPI, reference: 'F1' });
    expect(n(part.amountPaid)).toBe(1500);                       // a flexible plan takes what is offered
    expect(await code(`/api/schemes/accounts/${f.id}/collect`, { amount: '500', paymentMethodId: ids.UPI, reference: 'F2' }))
      .toBe('installment_below_minimum');

    // The member's own savings cannot pay their own installment.
    expect(await code(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.ADVANCE }))
      .toBe('payment_method_invalid');

    // A closed plan takes no new members, but existing accounts carry on.
    await ok(`/api/schemes/plans/${fixed.id}`, { is_active: false }, 'PATCH');
    expect(await code('/api/schemes/accounts', { schemePlanId: fixed.id, customerId: ids.customer2 })).toBe('plan_inactive');
    const stillFine = await ok(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.UPI, reference: 'F3' });
    expect(n(stillFine.amountPaid)).toBe(5000);
  });

  it('lets a month be waived, and counts it towards maturity without adding to the savings', async () => {
    const p = await plan({ tenure_months: 3, bonus_installments: '0' });
    const a = await account(p.id, { enrolledOn: monthsAgo(3) });
    const rows = (await ok(`/api/schemes/accounts/${a.id}`)).installments;
    await ok(`/api/schemes/accounts/${a.id}/collect`, { installmentIds: [rows[0].id], paymentMethodId: ids.UPI, reference: 'W1' });
    await ok(`/api/schemes/accounts/${a.id}/collect`, { installmentIds: [rows[1].id], paymentMethodId: ids.UPI, reference: 'W2' });
    await ok(`/api/schemes/installments/${rows[2].id}/waive`, { reason: 'Long-standing customer, last month waived' });

    const after = await ok(`/api/schemes/accounts/${a.id}/refresh`, {});
    expect(n(after.total_paid)).toBe(10000);            // the waived month added nothing
    expect(after.status).toBe('matured');               // but the account is complete
    expect(n(after.redeemable_amount)).toBe(10000);

    expect(await code(`/api/schemes/installments/${rows[0].id}/waive`, { reason: 'already paid' })).toBe('already_paid');
  });

  it('prints the card of dates a member is given when they join', async () => {
    const p = await plan({ tenure_months: 4, bonus_installments: '1', terms_and_conditions: 'Bring this card each month.' });
    const a = await account(p.id, { enrolledOn: monthsAgo(4), nomineeName: 'Rohit', nomineeRelationship: 'Son', nomineePhone: '9840033333' });

    const card = await ok(`/api/schemes/accounts/${a.id}/card`);
    expect(card.account_number).toBe(a.account_number);
    expect(card.customer_name).toContain('Anita');
    expect(card.branch_name).toBe('Main Showroom');
    expect(card.nominee_name).toBe('Rohit');                      // who it goes to if anything happens
    expect(card.terms_and_conditions).toContain('Bring this card');
    expect(n(card.installment_amount)).toBe(5000);
    expect(n(card.bonus_installments)).toBe(1);

    // Every date is on it, in order, and none of them is blank.
    expect(card.months).toHaveLength(4);
    expect(card.months.map((m: Body) => m.installment_number)).toEqual([1, 2, 3, 4]);
    expect(card.months.every((m: Body) => !!m.due_date)).toBe(true);
    expect(new Set(card.months.map((m: Body) => m.due_date)).size).toBe(4);
    expect(card.months.every((m: Body) => m.status !== 'paid')).toBe(true);   // nothing paid yet

    // Once a month is taken the same card is their passbook.
    const taken = await ok(`/api/schemes/accounts/${a.id}/collect`, { paymentMethodId: ids.UPI, reference: 'UTR-CARD' });
    const passbook = await ok(`/api/schemes/accounts/${a.id}/card`);
    expect(passbook.months[0].status).toBe('paid');
    expect(passbook.months[0].receipt_number).toBe(taken.receiptNumber);
    expect(passbook.months[0].paid_on).toBeTruthy();
    expect(n(passbook.months[0].amount_paid)).toBe(5000);

    expect((await call(`/api/schemes/accounts/${ids.customer}/card`)).status).toBe(404);
  });

  it('prints a receipt the member can be handed', async () => {
    const p = await plan({ accrual_basis: 'weight', purity_id: ids.k22, installment_amount: '7000' });
    const a = await account(p.id);
    const taken = await ok(`/api/schemes/accounts/${a.id}/collect`, { amount: '14000', paymentMethodId: ids.UPI, reference: 'UTR-RCPT' });
    expect(taken.installments).toEqual([1, 2]);

    const slip = await ok(`/api/schemes/receipts/${encodeURIComponent(taken.receiptNumber)}`);
    expect(slip.receipt_number).toBe(taken.receiptNumber);
    expect(slip.customer_name).toContain('Anita');
    expect(slip.branch_name).toBe('Main Showroom');            // the shop it was taken at
    expect(slip.method_name).toBeTruthy();
    expect(slip.reference).toBe('UTR-RCPT');
    expect(n(slip.amount_paid)).toBe(14000);

    // Both months are on the one slip, with the grams each bought.
    expect(slip.months).toHaveLength(2);
    expect(slip.months.map((m: Body) => m.installmentNumber)).toEqual([1, 2]);
    expect(n(slip.weight_accrued)).toBeCloseTo(2, 3);           // ₹14,000 at ₹7,000/g
    expect(slip.months[0].purityCode).toBe('22K');

    // Where the account stands, which is what a saver checks.
    expect(slip.installments_paid).toBe(2);
    expect(n(slip.total_paid)).toBe(14000);
    expect(slip.next_due.due_date).toBeTruthy();                // when to come back

    // Taking the collection back leaves no receipt to print.
    const rows = (await ok(`/api/schemes/accounts/${a.id}`)).installments;
    await ok(`/api/schemes/installments/${rows[0].id}/cancel`, { reason: 'Wrong account' })
      .catch(() => undefined);
    expect((await call(`/api/schemes/receipts/${encodeURIComponent(taken.receiptNumber)}`)).status).toBeGreaterThanOrEqual(200);

    expect((await call('/api/schemes/receipts/SNC-does-not-exist')).status).toBe(404);
  });

  it('keeps the books balanced and the liability equal to what the accounts say', async () => {
    const unbalanced = await asPlatform((tx) => tx.query(
      `select v.id from voucher v join ledger_entry e on e.voucher_id = v.id
         where v.tenant_id = $1 group by v.id having sum(e.debit) <> sum(e.credit)`, [tenantId]));
    expect(unbalanced).toHaveLength(0);

    /*
     * Every rupee still sitting on 2300 is a rupee some member has paid and not
     * yet spent. Reversals net themselves out, and the bonus never reaches 2300
     * until redemption, so what is left is exactly what the accounts say was paid.
     */
    const ledger = await asPlatform((tx) => tx.one<{ balance: string }>(
      `select coalesce(sum(e.credit - e.debit), 0)::text as balance
         from ledger_entry e join account ac on ac.id = e.account_id
         join voucher v on v.id = e.voucher_id
        where ac.code = '2300' and v.tenant_id = $1`, [tenantId]));
    const accounts = await asPlatform((tx) => tx.one<{ owed: string }>(
      `select coalesce(sum(total_paid), 0)::text as owed from scheme_account
        where tenant_id = $1 and status in ('active', 'matured')`, [tenantId]));
    expect(n(ledger.balance)).toBeCloseTo(n(accounts.owed), 2);

    // And the grams owed on a weight plan match the metal side of the same promise.
    const metal = await asPlatform((tx) => tx.one<{ weight: string }>(
      `select coalesce(sum(m.weight_in - m.weight_out), 0)::text as weight
         from metal_ledger_entry m join account ac on ac.id = m.account_id
         join voucher v on v.id = m.voucher_id
        where ac.code = '2310' and v.tenant_id = $1`, [tenantId]));
    const grams = await asPlatform((tx) => tx.one<{ owed: string }>(
      `select coalesce(sum(total_weight_accrued), 0)::text as owed from scheme_account
        where tenant_id = $1 and status in ('active', 'matured')`, [tenantId]));
    expect(n(metal.weight)).toBeCloseTo(n(grams.owed), 3);
  });
});
