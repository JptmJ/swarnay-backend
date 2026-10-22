import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { signAccessToken } from '../src/modules/identity/auth.service.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';

const SHOP = 'girvitest';
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe('Girvi pawn loans', { timeout: 300_000 }, () => {
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
    ['girvi.interest.rate_basis', 'per_month'], ['girvi.interest.default_rate', 2], ['girvi.interest.rate_editable', true],
    ['girvi.interest.method', 'simple'], ['girvi.interest.period_basis', 'calendar'],
    ['girvi.interest.minimum_months', 1], ['girvi.interest.part_month', 'full'], ['girvi.interest.grace_days', 0],
    ['girvi.interest.penal_rate', 0], ['girvi.interest.book_when', 'accrued'],
    ['girvi.valuation.rate_source', 'buying'], ['girvi.valuation.margin_percent', 0], ['girvi.valuation.basis', 'fine'],
    ['girvi.ltv.percent', 75], ['girvi.ltv.hard_cap', 75], ['girvi.ltv.silver_percent', 60],
    ['girvi.loan.minimum_amount', 0], ['girvi.loan.maximum_amount', 0], ['girvi.loan.rounding', 100],
    ['girvi.tenure.months', 12], ['girvi.tenure.grace_days', 15],
    ['girvi.charges.processing_basis', 'flat'], ['girvi.charges.processing_value', 0],
    ['girvi.charges.processing_taken', 'deducted'], ['girvi.charges.appraisal_fee', 0],
    ['girvi.charges.penalty_basis', 'none'], ['girvi.charges.storage_per_month', 0],
    ['girvi.repayment.allocation', 'penalty_interest_principal'], ['girvi.repayment.allow_interest_only', true],
    ['girvi.repayment.allow_part_principal', true], ['girvi.repayment.minimum_amount', 0],
    ['girvi.repayment.allow_foreclosure', true], ['girvi.repayment.foreclosure_percent', 0],
    ['girvi.custody.packet_required', true], ['girvi.custody.witness_required', false],
    ['girvi.kyc.required', true], ['girvi.kyc.min_value', 0], ['girvi.kyc.borrower_photo', false],
    ['girvi.custody.article_photo', false],
    ['girvi.default.notice_after_days', 30], ['girvi.default.notice_count', 3], ['girvi.default.notice_gap_days', 30],
    ['girvi.default.auction_after_days', 30], ['girvi.default.surplus', 'return'],
    ['girvi.cash.disbursal_limit', 0], ['girvi.cash.repayment_limit', 0],
  ];
  const monthsAgo = (m: number) => { const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString().slice(0, 10); };
  /** A loan with sensible collateral, back-dated so interest has had time to run. */
  const lend = async (over: Body = {}) => ok('/api/girvi/loans', {
    customerId: ids.customer, principalAmount: '50000', disbursalMethodId: ids.CASH,
    borrowerIdType: 'aadhaar', borrowerIdNumber: 'XXXX1234',
    collateral: [{ description: 'Gold bangles', metalId: ids.gold, purityId: ids.k22, grossWeight: '30.000' }],
    ...over,
  });

  beforeAll(async () => {
    const existing = await asPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from tenant where code = $1`, [SHOP]));
    tenantId = existing?.id ?? (await provisionTenant({
      code: SHOP, legalName: 'Girvi Test Jewellers', displayName: 'Girvi Test', kind: 'retailer',
      owner: { email: `owner@${SHOP}.in`, fullName: 'Girvi Owner', password: 'owner-pass-1' },
      firstBranch: { code: 'MAIN', name: 'Main Showroom' },
    })).tenantId;
    const o = await asPlatform(async (tx) => {
      const u = await tx.one<{ id: string; tv: number; branch: string }>(
        `select u.id, u.token_version as tv, (select id from branch where tenant_id = $1 and code = 'MAIN') as branch
           from app_user u where u.tenant_id = $1 and u.email = $2`, [tenantId, `owner@${SHOP}.in`]);
      await tx.query(`update app_user set must_change_password = false where id = $1`, [u.id]);
      return u;
    });
    /*
     * Start from nothing. Loan numbers are unique for all time, so rows left by
     * an earlier run would collide the moment the financial-year counter rolls;
     * clearing this tenant's own Girvi rows keeps the suite re-runnable.
     */
    await asPlatform(async (tx) => {
      await tx.query(`set local app.bypass_rls = 'on'`);
      // The loans point at their vouchers, so they go first.
      await tx.query(`delete from girvi_loan where tenant_id = $1`, [tenantId]);
      await tx.query(`delete from ledger_entry where voucher_id in (select id from voucher where tenant_id = $1 and voucher_type = 'mortgage')`, [tenantId]);
      await tx.query(`delete from metal_ledger_entry where voucher_id in (select id from voucher where tenant_id = $1 and voucher_type = 'mortgage')`, [tenantId]);
      await tx.query(`update voucher set reverses_voucher_id = null where tenant_id = $1 and voucher_type = 'mortgage'`, [tenantId]);
      await tx.query(`delete from voucher where tenant_id = $1 and voucher_type = 'mortgage'`, [tenantId]);
      await tx.query(
        `update numbering_series set next_number = 1, current_period = null
          where tenant_id = $1 and doc_type in ('girvi_loan','girvi_receipt','girvi_release','girvi_packet')`, [tenantId]);
    });

    main = o.branch;
    owner = signAccessToken({ sub: o.id, tenantId, tv: o.tv });
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const metals = (await ok('/api/master/metals')).rows;
    ids.gold = metals.find((m: Body) => m.code === 'GOLD').id;
    ids.silver = metals.find((m: Body) => m.code === 'SILVER')?.id ?? '';
    const purities = (await ok(`/api/master/purities?metal_id=${ids.gold}`)).rows;
    ids.k22 = purities.find((r: Body) => r.code === '22K').id;
    ids.customer = (await ok('/api/master/parties', { name: `Kamala ${run}`, is_customer: true, phone: '9850011111' })).id;
    ids.customer2 = (await ok('/api/master/parties', { name: `Suresh ${run}`, is_customer: true, phone: '9850022222' })).id;
    await ok('/api/master/rates', { metal_id: ids.gold, purity_id: ids.k22, rate_per_gram: '7000', buying_rate_per_gram: '6800' });
    if (ids.silver) {
      const sp = (await ok(`/api/master/purities?metal_id=${ids.silver}`)).rows[0];
      if (sp) { ids.silverPurity = sp.id; await ok('/api/master/rates', { metal_id: ids.silver, purity_id: sp.id, rate_per_gram: '95', buying_rate_per_gram: '90' }); }
    }
    const methods = (await ok('/api/pos/tenders')).rows;
    for (const c of ['CASH', 'UPI', 'BANK']) ids[c] = methods.find((m: Body) => m.code === c)?.id ?? '';
    for (const [k, v] of DEFAULTS) await setting(k, v);
  });

  afterAll(async () => {
    for (const [k, v] of DEFAULTS) await setting(k, v);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('values the gold at the shop’s own rate and caps what may be lent', async () => {
    /*
     * 30 g of 22K is 27.48 g of pure gold. Valued on fine weight it is priced at
     * the PURE rate (the 22K buying rate brought up to 100%), which comes to the
     * same thing as 30 g at the 22K rate — as it must, or purity would be
     * counted twice.
     */
    const quote = await ok('/api/girvi/appraise', {
      collateral: [{ description: 'Bangles', metalId: ids.gold, purityId: ids.k22, grossWeight: '30.000' }],
    });
    expect(n(quote.appraised)).toBeCloseTo(30 * 6800, 0);
    expect(n(quote.lines[0].ratePerGram)).toBeCloseTo(6800 * 100 / 91.6, 0);
    expect(quote.ltvPercent).toBe(75);
    expect(n(quote.maxEligible)).toBeCloseTo(n(quote.appraised) * 0.75, 0);
    expect(n(quote.lines[0].fine)).toBeCloseTo(27.48, 3);

    // Stones come off before anything is valued.
    const withStones = await ok('/api/girvi/appraise', {
      collateral: [{ description: 'Stone-set ring', metalId: ids.gold, purityId: ids.k22, grossWeight: '10.000', stoneWeight: '2.000' }],
    });
    expect(n(withStones.lines[0].net)).toBeCloseTo(8, 3);

    // Lending above the ceiling is refused, and the message says what the ceiling is.
    expect(await code('/api/girvi/loans', {
      customerId: ids.customer, principalAmount: '500000', disbursalMethodId: ids.CASH,
      borrowerIdType: 'aadhaar', borrowerIdNumber: 'XXXX1234',
      collateral: [{ description: 'Bangles', metalId: ids.gold, purityId: ids.k22, grossWeight: '30.000' }],
    })).toBe('ltv_exceeded');
  });

  it('gives the loan, seals a packet and moves money without touching stock', async () => {
    const loan = await lend();
    expect(loan.loan_number).toMatch(/^GRV-/);
    expect(loan.status).toBe('active');
    expect(loan.vault_packet_number).toBeTruthy();                 // sealed, because the shop insists
    expect(n(loan.principal_amount)).toBe(50000);
    expect(n(loan.disbursed_amount)).toBe(50000);
    expect(loan.collateral).toHaveLength(1);
    expect(n(loan.collateral[0].fine_weight)).toBeCloseTo(27.48, 3);
    expect(loan.due_date).toBeTruthy();                            // twelve months out, by default

    // The books: cash out, a receivable in. No stock, and no metal, because the gold is not the shop's.
    const ledger = await asPlatform((tx) => tx.query<{ code: string; debit: string; credit: string }>(
      `select ac.code, e.debit::text, e.credit::text from ledger_entry e
         join account ac on ac.id = e.account_id where e.voucher_id = $1`, [loan.voucher_id]));
    expect(n(ledger.find((r) => r.code === '1400')?.debit)).toBe(50000);
    expect(n(ledger.find((r) => r.code === '1000')?.credit)).toBe(50000);
    const metal = await asPlatform((tx) => tx.query(
      `select 1 from metal_ledger_entry where voucher_id = $1`, [loan.voucher_id]));
    expect(metal).toHaveLength(0);

    // The vault register can find it without opening anything.
    const vault = await ok('/api/girvi/vault');
    const mine = vault.rows.find((r: Body) => r.loan_number === loan.loan_number);
    expect(mine).toBeTruthy();
    expect(n(mine.articles)).toBe(1);
    expect(n(vault.totals.lentAgainst)).toBeGreaterThan(0);
  });

  it('charges interest one period at a time, and never charges the same period twice', async () => {
    const loan = await lend({ sanctionedOn: monthsAgo(3), principalAmount: '10000' });
    const run1 = await ok(`/api/girvi/loans/${loan.id}/accrue`, {});
    expect(run1.written).toBe(3);                                   // three whole months have passed
    expect(n(run1.loan.interest_accrued)).toBeCloseTo(600, 0);      // 2% of ₹10,000, three times

    // Running it again writes nothing and changes nothing.
    const run2 = await ok(`/api/girvi/loans/${loan.id}/accrue`, {});
    expect(run2.written).toBe(0);
    expect(n(run2.loan.interest_accrued)).toBeCloseTo(600, 0);

    // Every period is on the record, so a borrower can be shown how it adds up.
    const detail = await ok(`/api/girvi/loans/${loan.id}`);
    expect(detail.accruals).toHaveLength(3);
    expect(detail.accruals.every((a: Body) => a.kind === 'interest')).toBe(true);
    expect(new Set(detail.accruals.map((a: Body) => a.period_start)).size).toBe(3);

    // Interest earned but not received sits as a receivable, not as cash.
    const ledger = await asPlatform((tx) => tx.query<{ code: string; debit: string; credit: string }>(
      `select ac.code, e.debit::text, e.credit::text from ledger_entry e
         join account ac on ac.id = e.account_id join voucher v on v.id = e.voucher_id
        where v.source_type = 'girvi_accrual' and v.source_id = $1`, [loan.id]));
    expect(n(ledger.find((r) => r.code === '1410')?.debit)).toBeCloseTo(600, 0);
    expect(n(ledger.find((r) => r.code === '4300')?.credit)).toBeCloseTo(600, 0);
  });

  it('applies a payment the way the shop says, and clears the loan when it is all in', async () => {
    const loan = await lend({ sanctionedOn: monthsAgo(2), principalAmount: '10000' });
    const quote = await ok(`/api/girvi/loans/${loan.id}/settlement`);
    expect(n(quote.interestDue)).toBeCloseTo(400, 0);
    expect(n(quote.principalDue)).toBe(10000);
    expect(n(quote.totalToClear)).toBeCloseTo(10400, 0);

    // Interest first, then principal.
    const part = await ok(`/api/girvi/loans/${loan.id}/repayments`, { amount: '1000', paymentMethodId: ids.CASH });
    expect(n(part.receipt.interest_component)).toBeCloseTo(400, 0);
    expect(n(part.receipt.principal_component)).toBeCloseTo(600, 0);
    expect(part.receipt.receipt_number).toMatch(/^GRC-/);
    expect(part.cleared).toBe(false);

    // The rest clears it.
    const left = await ok(`/api/girvi/loans/${loan.id}/settlement`);
    const final = await ok(`/api/girvi/loans/${loan.id}/repayments`, { amount: left.totalToClear, paymentMethodId: ids.CASH });
    expect(final.cleared).toBe(true);
    expect(final.loan.status).toBe('redeemed');
    expect(n(final.loan.outstanding_amount)).toBeLessThanOrEqual(0.01);

    // More than is owed is refused.
    expect(await code(`/api/girvi/loans/${loan.id}/repayments`, { amount: '100', paymentMethodId: ids.CASH }))
      .toBe('loan_not_active');
  });

  it('gives the packet back only once nothing is owed', async () => {
    const loan = await lend({ sanctionedOn: monthsAgo(1), principalAmount: '10000' });
    expect(await code(`/api/girvi/loans/${loan.id}/release`, {})).toBe('balance_outstanding');

    const quote = await ok(`/api/girvi/loans/${loan.id}/settlement`);
    await ok(`/api/girvi/loans/${loan.id}/repayments`, { amount: quote.totalToClear, paymentMethodId: ids.CASH });
    const released = await ok(`/api/girvi/loans/${loan.id}/release`, { releasedToName: 'Kamala' });
    expect(released.releaseNumber).toMatch(/^GRL-/);
    expect(released.status).toBe('redeemed');
    expect(released.collateral.every((c: Body) => c.is_released)).toBe(true);
    expect(released.packet_opened_at).toBeTruthy();

    // It cannot go back twice, and it leaves the vault register.
    expect(await code(`/api/girvi/loans/${loan.id}/release`, {})).toBe('already_released');
    const vault = await ok('/api/girvi/vault');
    expect(vault.rows.some((r: Body) => r.loan_number === loan.loan_number)).toBe(false);
  });

  it('takes a payment back with mirror entries, and reopens a loan it had closed', async () => {
    const loan = await lend({ sanctionedOn: monthsAgo(1), principalAmount: '10000' });
    const quote = await ok(`/api/girvi/loans/${loan.id}/settlement`);
    const paid = await ok(`/api/girvi/loans/${loan.id}/repayments`, { amount: quote.totalToClear, paymentMethodId: ids.CASH });
    expect(paid.cleared).toBe(true);

    const after = await ok(`/api/girvi/repayments/${paid.receipt.id}/cancel`, { reason: 'Cheque bounced' });
    expect(after.status).toBe('active');                            // open again
    expect(n(after.outstanding_amount)).toBeCloseTo(n(quote.totalToClear), 0);
    expect(after.repayments[0].status).toBe('cancelled');

    const reversals = await asPlatform((tx) => tx.one<{ total: number }>(
      `select count(*)::int as total from voucher where reverses_voucher_id = $1`, [paid.receipt.voucher_id]));
    expect(reversals.total).toBe(1);
  });

  it('runs the notices before it will allow an auction, and shares out what the sale fetches', async () => {
    await setting('girvi.default.notice_count', 2);
    await setting('girvi.default.notice_after_days', 0);
    await setting('girvi.default.notice_gap_days', 1);
    await setting('girvi.default.auction_after_days', 0);

    const loan = await lend({ sanctionedOn: monthsAgo(18), principalAmount: '10000', tenureMonths: 1 });
    await ok(`/api/girvi/loans/${loan.id}/accrue`, {});
    const overdue = await ok(`/api/girvi/loans/${loan.id}`);
    expect(overdue.status).toBe('overdue');                         // past its date, by the dates alone

    // No auction until the notices have gone out.
    expect(await code(`/api/girvi/loans/${loan.id}/auction`, { proceeds: '20000' })).toBe('notices_pending');
    await ok(`/api/girvi/loans/${loan.id}/notice`, {});
    await ok(`/api/girvi/loans/${loan.id}/notice`, {});
    expect(await code(`/api/girvi/loans/${loan.id}/notice`, {})).toBe('notices_exhausted');

    const owed = n((await ok(`/api/girvi/loans/${loan.id}`)).outstanding_amount);
    const sold = await ok(`/api/girvi/loans/${loan.id}/auction`, { proceeds: String(owed + 5000), paymentMethodId: ids.CASH });
    expect(sold.loan.status).toBe('auctioned');
    expect(n(sold.surplus)).toBeCloseTo(5000, 0);
    expect(sold.surplusReturned).toBe(true);                        // the borrower's money, not the shop's
    expect(n(sold.shortfall)).toBe(0);
    expect(sold.loan.collateral.every((c: Body) => c.is_released)).toBe(true);

    // The surplus is held for the borrower as credit, not taken as income.
    const ledger = await asPlatform((tx) => tx.query<{ code: string; credit: string }>(
      `select ac.code, e.credit::text from ledger_entry e join account ac on ac.id = e.account_id
        where e.voucher_id = $1`, [sold.voucherId]));
    expect(n(ledger.find((r) => r.code === '2400')?.credit)).toBeCloseTo(5000, 0);

    for (const [k, v] of DEFAULTS) await setting(k, v);
  });

  it('bends to how each shop quotes and charges', async () => {
    // The old way: ₹2 per ₹100 a month is 2% a month.
    await setting('girvi.interest.rate_basis', 'per_hundred');
    const perHundred = await lend({ quotedRate: '2', principalAmount: '10000', sanctionedOn: monthsAgo(1) });
    expect(n(perHundred.interest_rate_monthly)).toBeCloseTo(2, 3);
    expect(perHundred.quoted_rate_basis).toBe('per_hundred');

    // Quoted by the year, stored by the month.
    await setting('girvi.interest.rate_basis', 'per_year');
    const perYear = await lend({ quotedRate: '24', principalAmount: '10000', sanctionedOn: monthsAgo(1) });
    expect(n(perYear.interest_rate_monthly)).toBeCloseTo(2, 3);
    await setting('girvi.interest.rate_basis', 'per_month');

    // A processing fee taken out of what is handed over.
    await setting('girvi.charges.processing_basis', 'percent');
    await setting('girvi.charges.processing_value', 2);
    const withFee = await lend({ principalAmount: '10000' });
    expect(n(withFee.processing_fee)).toBe(200);
    expect(n(withFee.disbursed_amount)).toBe(9800);                 // deducted
    expect(n(withFee.principal_amount)).toBe(10000);                // but still owed back in full

    // The same fee added to the loan instead.
    await setting('girvi.charges.processing_taken', 'added');
    const feeAdded = await lend({ principalAmount: '10000' });
    expect(n(feeAdded.disbursed_amount)).toBe(10000);
    expect(n(feeAdded.principal_amount)).toBe(10200);

    // Principal first, for a shop that works that way.
    await setting('girvi.charges.processing_basis', 'flat');
    await setting('girvi.charges.processing_value', 0);
    await setting('girvi.charges.processing_taken', 'deducted');
    await setting('girvi.repayment.allocation', 'principal_first');
    const principalFirst = await lend({ sanctionedOn: monthsAgo(2), principalAmount: '10000' });
    const paid = await ok(`/api/girvi/loans/${principalFirst.id}/repayments`, { amount: '1000', paymentMethodId: ids.CASH });
    expect(n(paid.receipt.principal_component)).toBe(1000);
    expect(n(paid.receipt.interest_component)).toBe(0);

    for (const [k, v] of DEFAULTS) await setting(k, v);
  });

  it('holds the shop to its own rules', async () => {
    // Identity, where the shop insists on it.
    expect(await code('/api/girvi/loans', {
      customerId: ids.customer, principalAmount: '10000', disbursalMethodId: ids.CASH,
      collateral: [{ description: 'Chain', metalId: ids.gold, purityId: ids.k22, grossWeight: '20.000' }],
    })).toBe('identity_required');

    // A rate nobody may change.
    await setting('girvi.interest.rate_editable', false);
    expect(await code('/api/girvi/loans', {
      customerId: ids.customer, principalAmount: '10000', disbursalMethodId: ids.CASH, quotedRate: '5',
      borrowerIdType: 'pan', borrowerIdNumber: 'ABCDE1234F',
      collateral: [{ description: 'Chain', metalId: ids.gold, purityId: ids.k22, grossWeight: '20.000' }],
    })).toBe('rate_not_editable');
    await setting('girvi.interest.rate_editable', true);

    // A smallest loan.
    await setting('girvi.loan.minimum_amount', 5000);
    expect(await code('/api/girvi/loans', {
      customerId: ids.customer, principalAmount: '1000', disbursalMethodId: ids.CASH,
      borrowerIdType: 'pan', borrowerIdNumber: 'ABCDE1234F',
      collateral: [{ description: 'Chain', metalId: ids.gold, purityId: ids.k22, grossWeight: '20.000' }],
    })).toBe('below_minimum');
    await setting('girvi.loan.minimum_amount', 0);

    // Interest-only, and part-principal, where the shop forbids them.
    const loan = await lend({ sanctionedOn: monthsAgo(2), principalAmount: '10000' });
    await setting('girvi.repayment.allow_part_principal', false);
    expect(await code(`/api/girvi/loans/${loan.id}/repayments`, { amount: '1000', paymentMethodId: ids.CASH }))
      .toBe('part_principal_not_allowed');
    await setting('girvi.repayment.allow_part_principal', true);

    // A mode that cannot be used, and one that needs a reference.
    expect(await code(`/api/girvi/loans/${loan.id}/repayments`, { amount: '100', paymentMethodId: ids.UPI }))
      .toBe('reference_required');

    for (const [k, v] of DEFAULTS) await setting(k, v);
  });

  it('keeps the books balanced, and what is owed equal to what the loans say', async () => {
    const unbalanced = await asPlatform((tx) => tx.query(
      `select v.id from voucher v join ledger_entry e on e.voucher_id = v.id
        where v.tenant_id = $1 group by v.id having sum(e.debit) <> sum(e.credit)`, [tenantId]));
    expect(unbalanced).toHaveLength(0);

    /*
     * Every rupee on 1400 is principal a borrower has not yet repaid. Reversals
     * net themselves out, so what is left is exactly what the loans say is out.
     */
    const ledger = await asPlatform((tx) => tx.one<{ balance: string }>(
      `select coalesce(sum(e.debit - e.credit), 0)::text as balance
         from ledger_entry e join account ac on ac.id = e.account_id
         join voucher v on v.id = e.voucher_id
        where ac.code = '1400' and v.tenant_id = $1`, [tenantId]));
    const loans = await asPlatform((tx) => tx.one<{ out: string }>(
      `select coalesce(sum(principal_amount - principal_repaid), 0)::text as out
         from girvi_loan where tenant_id = $1 and status in ('active', 'overdue')`, [tenantId]));
    expect(n(ledger.balance)).toBeCloseTo(n(loans.out), 2);

    // The portfolio reads the same book.
    const book = await ok('/api/girvi/portfolio');
    expect(n(book.principal_out)).toBeCloseTo(n(loans.out), 2);
    expect(book.active_loans + book.overdue_loans).toBeGreaterThan(0);
    expect(n(book.fine_weight_held)).toBeGreaterThan(0);
  });
});
