/**
 * Swarna Nidhi — monthly gold savings schemes.
 *
 * Plans are a master; accounts are the promise to one customer; installments
 * are money the shop owes back until the member takes jewellery for it. Nothing
 * here earns revenue — the redemption bill does that.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { param } from '../core/http/middleware.js';
import { defineCrud } from './crud.js';
import {
  accountDetail, cancelCollection, closeAccount, collect, customerSchemeCredit, dueList, enroll,
  liabilitySummary, matureAccount, redeem, refreshAccount, schemeCard, schemeReceipt, schemeSettings, schemeRate,
  waiveInstallment,
} from '../modules/schemes/schemes.service.js';
import { decimal, errorEnvelope, idParam, isoDate, money, pagination, phone, record, uuid } from './schemas.js';

const DAY = '2026-10-09';
const seed = [{ date: '2026-09-18', kind: 'added' as const, note: 'Swarna Nidhi schemes.' }];
const built = (note: string) => [...seed, { date: DAY, kind: 'changed' as const, note }];
const S = '/api/schemes';
const listOf = (item: typeof record) => z.object({ rows: z.array(item), total: z.number().optional() });

/* ------------------------------------------------------------------ plans */

defineCrud({
  basePath: S, resource: 'plans', table: 'scheme_plan', module: 'schemes', label: 'scheme plan',
  permission: 'schemes.plans', searchColumns: ['code', 'name'], defaultOrder: 'name',
  filters: { is_active: z.coerce.boolean().optional() },
  changelog: built('A plan can name the purity its grams are counted in.'),
  createSchema: z.object({
    code: z.string().trim().min(1).max(30), name: z.string().trim().min(1), description: z.string().max(2000).optional(),
    metal_id: uuid,
    purity_id: uuid.nullish().describe('The purity the grams are counted in. Left out, the purest priced purity is used.'),
    accrual_basis: z.enum(['rupee', 'weight']).default('rupee')
      .describe('weight accrues grams at each payment’s rate — the member is owed metal, not money.'),
    tenure_months: z.coerce.number().int().min(1).max(120),
    installment_amount: money.optional(), minimum_installment: money.optional(),
    is_flexible_amount: z.boolean().default(false),
    bonus_installments: decimal.optional().describe('The classic “pay 11, get 12” is 1.'),
    bonus_percent: decimal.optional(),
    max_missed_installments: z.coerce.number().int().min(0).max(120).default(2),
    making_charge_discount_percent: decimal.optional(),
    allow_partial_redemption: z.boolean().default(false), allow_cash_redemption: z.boolean().default(false),
    grace_period_days: z.coerce.number().int().min(0).max(90).default(7),
    terms_and_conditions: z.string().max(8000).optional(),
  }),
  updateSchema: z.object({
    name: z.string().trim().min(1).optional(), description: z.string().max(2000).nullish(),
    purity_id: uuid.nullish(), installment_amount: money.optional(), minimum_installment: money.nullish(),
    bonus_installments: decimal.optional(), bonus_percent: decimal.optional(),
    making_charge_discount_percent: decimal.optional(),
    max_missed_installments: z.coerce.number().int().min(0).max(120).optional(),
    allow_partial_redemption: z.boolean().optional(), allow_cash_redemption: z.boolean().optional(),
    grace_period_days: z.coerce.number().int().min(0).max(90).optional(),
    terms_and_conditions: z.string().max(8000).nullish(), is_active: z.boolean().optional(),
  }),
});

/* --------------------------------------------------------------- settings */

defineRoute({
  method: 'get', path: `${S}/settings`, module: 'schemes', summary: 'Schemes settings in force',
  description: 'Bonus, rate source, late pricing, maturity, redemption and early-closure rules. Read-only here; changed in Settings.',
  permission: 'schemes.accounts.view',
  responses: [{ status: 200, description: 'The settings.', schema: record }],
  changelog: built('Every scheme rule is a setting.'),
  handler: async () => transaction((tx) => schemeSettings(tx)),
});

defineRoute({
  method: 'get', path: `${S}/rate`, module: 'schemes', summary: 'What a gram costs for a scheme today',
  description: 'The rate a weight plan would use right now, so the counter can show the member what their money buys before taking it.',
  permission: 'schemes.accounts.view',
  query: z.object({ metalId: uuid, purityId: uuid.optional(), onDate: isoDate.optional() }),
  responses: [
    { status: 200, description: 'The rate and where it came from.', schema: record },
    { status: 422, description: 'No rate is set for that metal.', schema: errorEnvelope },
  ],
  changelog: built('The rate comes from the server, never from the screen.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<{ metalId: string; purityId?: string; onDate?: string }>(req);
    const s = await schemeSettings(tx);
    return schemeRate(tx, q.metalId, q.purityId ?? null, s.rateSource, q.onDate ?? new Date().toISOString().slice(0, 10));
  }),
});

/* --------------------------------------------------------------- accounts */

defineRoute({
  method: 'post', path: `${S}/accounts`, module: 'schemes', summary: 'Enrol a member and write the schedule',
  description: [
    'Opens the account and writes every installment up front, so “what is due this month” stays a query and the member can be handed their dates on the day they join.',
    'The plan’s terms — bonus, grace, how many months may be missed — are copied onto the account, so changing the plan later never rewrites a promise already made.',
  ].join(' '),
  permission: 'schemes.accounts.create',
  body: z.object({
    schemePlanId: uuid, customerId: uuid, enrolledOn: isoDate.optional(),
    installmentAmount: money.optional().describe('Needed only for a flexible plan, or to override the plan’s amount.'),
    dueDay: z.coerce.number().int().min(1).max(28).optional(),
    nomineeName: z.string().max(120).optional(), nomineeRelationship: z.string().max(60).optional(),
    nomineePhone: phone.optional(), notes: z.string().max(2000).optional(),
  }),
  responses: [
    { status: 201, description: 'The account with its schedule written.', schema: record },
    { status: 422, description: 'Plan closed, amount below the minimum, or a fixed plan taking a different amount.', schema: errorEnvelope },
  ],
  changelog: built('Enrollment snapshots the plan’s terms.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => enroll(tx, req.body))); },
});

defineRoute({
  method: 'get', path: `${S}/accounts`, module: 'schemes', summary: 'Scheme accounts', permission: 'schemes.accounts.view',
  query: z.object({
    status: z.enum(['active', 'matured', 'redeemed', 'defaulted', 'cancelled', 'closed']).optional(),
    customerId: uuid.optional(), branchId: uuid.optional(), schemePlanId: uuid.optional(),
    search: z.string().trim().optional(),
    maturingBefore: isoDate.optional().describe('Accounts whose maturity falls on or before this date.'),
  }).merge(pagination),
  responses: [{ status: 200, description: 'Newest first, with progress and what each can spend.', schema: listOf(record) }],
  changelog: seed,
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const params: unknown[] = [];
    const where: string[] = [];
    for (const [key, column] of [['status', 'a.status'], ['customerId', 'a.customer_id'],
      ['branchId', 'a.branch_id'], ['schemePlanId', 'a.scheme_plan_id']] as const) {
      if (q[key]) { params.push(q[key]); where.push(`${column} = $${params.length}`); }
    }
    if (q.maturingBefore) { params.push(q.maturingBefore); where.push(`a.maturity_date <= $${params.length}`); }
    if (q.search) {
      params.push(`%${q.search}%`);
      where.push(`(a.account_number ilike $${params.length} or p.name ilike $${params.length} or p.phone ilike $${params.length})`);
    }
    const clause = where.length ? `where ${where.join(' and ')}` : '';
    const [rows, counted] = await Promise.all([
      tx.query(
        `select a.*, p.name as customer_name, p.phone as customer_phone, s.name as plan_name, s.code as plan_code,
                s.allow_partial_redemption, s.allow_cash_redemption
           from scheme_account a join party p on p.id = a.customer_id join scheme_plan s on s.id = a.scheme_plan_id
           ${clause} order by a.enrolled_on desc, a.account_number desc
           limit ${Number(q.limit ?? 50)} offset ${Number(q.offset ?? 0)}`, params),
      tx.one<{ total: number }>(
        `select count(*)::int as total from scheme_account a join party p on p.id = a.customer_id ${clause}`, params),
    ]);
    return { rows, total: counted.total };
  }),
});

defineRoute({
  method: 'get', path: `${S}/accounts/:id`, module: 'schemes', summary: 'One account with its passbook',
  description: 'Every month with its receipt and who took it, and what the account has been spent on.',
  permission: 'schemes.accounts.view', params: idParam,
  responses: [
    { status: 200, description: 'The account, its installments and its redemptions.', schema: record },
    { status: 404, description: 'No such account.', schema: errorEnvelope },
  ],
  changelog: seed,
  handler: async (req) => transaction((tx) => accountDetail(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${S}/accounts/:id/refresh`, module: 'schemes', summary: 'Work the account’s totals out again',
  description: 'Rebuilds the totals and the bonus from the installment rows, marks months that have gone past as missed, and matures the account if it is fully paid.',
  permission: 'schemes.accounts.view', params: idParam,
  responses: [{ status: 200, description: 'The account as it now stands.', schema: record }],
  changelog: built('Totals are derived from the rows, never only added up as they go.'),
  handler: async (req) => transaction((tx) => refreshAccount(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${S}/accounts/:id/mature`, module: 'schemes', summary: 'Mature an account by hand',
  description: 'For shops that would rather check an account before letting it be spent.',
  permission: 'schemes.maturity.update', params: idParam,
  responses: [
    { status: 200, description: 'Matured.', schema: record },
    { status: 422, description: 'Already settled.', schema: errorEnvelope },
  ],
  changelog: built('Maturity, which nothing did before.'),
  handler: async (req) => transaction((tx) => matureAccount(tx, param(req, 'id'))),
});

/* ------------------------------------------------------------- collection */

defineRoute({
  method: 'post', path: `${S}/accounts/:id/collect`, module: 'schemes', summary: 'Take a month’s money',
  description: [
    'Settles one month, several at once, or a flexible amount. The money posts to the scheme liability (2300) as it is taken — it is owed back in gold, never income.',
    'A weight plan also works out the grams it bought at the day’s rate and carries them on 2310, which is the obligation that actually matters.',
    'Payment modes come from Masters, so reference rules, per-mode limits and the ₹2 lakh daily cash rule apply exactly as at the counter.',
  ].join(' '),
  permission: 'schemes.collection.create', params: idParam,
  body: z.object({
    installmentIds: z.array(uuid).max(60).optional().describe('Left out, the oldest month still open is taken.'),
    amount: money.optional().describe('A lump sum clears as many whole months as it covers.'),
    paymentMethodId: uuid, reference: z.string().trim().max(80).optional(),
    docDate: isoDate.optional(), notes: z.string().max(500).optional(),
  }),
  responses: [
    { status: 201, description: 'Collected, with the receipt number and the grams it bought.', schema: record },
    { status: 422, description: 'Account not active, nothing due, amount does not cover a month, reference or cash limit.', schema: errorEnvelope },
  ],
  changelog: built('Collection posts to the books and gives a receipt.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => collect(tx, param(req, 'id'), req.body))); },
});

defineRoute({
  method: 'post', path: `${S}/installments/:id/cancel`, module: 'schemes', summary: 'Take back a collection entered by mistake',
  description: 'The month goes back to due and the money is reversed with mirror entries. Nothing posted is ever deleted.',
  permission: 'schemes.collection.create', params: idParam,
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
  responses: [
    { status: 200, description: 'Taken back.', schema: record },
    { status: 422, description: 'Not paid, already settled, or one receipt covering several months.', schema: errorEnvelope },
  ],
  changelog: built('A wrong collection can be undone.'),
  handler: async (req) => transaction((tx) => cancelCollection(tx, param(req, 'id'), req.body.reason)),
});

defineRoute({
  method: 'post', path: `${S}/installments/:id/waive`, module: 'schemes', summary: 'Let a month go',
  description: 'A goodwill call, kept with its reason. A waived month counts as settled towards maturity but adds nothing to what the member saved.',
  permission: 'schemes.collection.waive', params: idParam,
  body: z.object({ reason: z.string().trim().min(3).max(500) }),
  responses: [
    { status: 200, description: 'Waived.', schema: record },
    { status: 422, description: 'Already paid.', schema: errorEnvelope },
  ],
  changelog: built('Waiving a month, with its own permission.'),
  handler: async (req) => transaction((tx) => waiveInstallment(tx, param(req, 'id'), req.body.reason)),
});

defineRoute({
  method: 'get', path: `${S}/due`, module: 'schemes', summary: 'Months due or already missed',
  description: 'The collection worklist, oldest first. Drives the “scheme collections due” figure on the dashboard.',
  permission: 'schemes.collection.view',
  query: z.object({
    onDate: isoDate.optional(), includeMissed: z.coerce.boolean().default(true),
    branchId: uuid.optional(), customerId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
  }),
  responses: [{ status: 200, description: 'What is due, with how late each one is.', schema: z.object({ rows: z.array(record), totalDue: money, onDate: z.string() }) }],
  changelog: seed,
  handler: async (req) => transaction((tx) => dueList(tx, queryOf(req))),
});

defineRoute({
  method: 'get', path: `${S}/accounts/:id/card`, module: 'schemes', summary: 'The member’s card, as it prints',
  description: 'Given at enrolment: every date they have to pay, the terms they were promised, and room to tick the months off. Printed later it is their passbook, because the same rows carry what was paid.',
  permission: 'schemes.accounts.view', params: idParam,
  responses: [
    { status: 200, description: 'The shop, the member, the terms and every month.', schema: record },
    { status: 404, description: 'No such account.', schema: errorEnvelope },
  ],
  changelog: built('A card to hand over at enrolment, which doubles as the passbook.'),
  handler: async (req) => transaction((tx) => schemeCard(tx, param(req, 'id'))),
});

defineRoute({
  method: 'get', path: `${S}/receipts/:number`, module: 'schemes', summary: 'A collection as it prints',
  description: 'The slip handed to the member: the months it settled, the grams they bought, and where the account stands afterwards.',
  permission: 'schemes.collection.view',
  params: z.object({ number: z.string().min(1).max(40) }),
  responses: [
    { status: 200, description: 'The receipt with the shop, the member and the account.', schema: record },
    { status: 404, description: 'No such receipt.', schema: errorEnvelope },
  ],
  changelog: built('A receipt the member can be handed, not just a number on screen.'),
  handler: async (req) => transaction((tx) => schemeReceipt(tx, param(req, 'number'))),
});

/* ------------------------------------------------- redemption and closure */

defineRoute({
  method: 'post', path: `${S}/accounts/:id/redeem`, module: 'schemes', summary: 'Spend a matured account',
  description: [
    'Releases the liability and turns it into credit the member can spend at the counter or on an order — one path for customer credit, the same one advances and old gold use.',
    'Cash only where both the plan and the shop allow it. The bonus is the shop’s cost the moment it is handed over, unless the shop shows it as a discount on the bill instead.',
  ].join(' '),
  permission: 'schemes.maturity.update', params: idParam,
  body: z.object({
    amount: money.optional().describe('Left out, the whole balance is used.'),
    salesInvoiceId: uuid.optional(), retailOrderId: uuid.optional(),
    cashPaymentMethodId: uuid.optional(), docDate: isoDate.optional(), notes: z.string().max(500).optional(),
  }),
  responses: [
    { status: 201, description: 'Redeemed, with what is left on the account.', schema: record },
    { status: 422, description: 'Not matured, nothing left, part-redemption not allowed, or cash where it is not.', schema: errorEnvelope },
  ],
  changelog: built('Redemption, which the module never had.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => redeem(tx, param(req, 'id'), req.body))); },
});

defineRoute({
  method: 'post', path: `${S}/accounts/:id/close`, module: 'schemes', summary: 'Close an account early',
  description: [
    'A member who wants out before maturity gets back what they paid, less whatever the shop keeps, and never the bonus — the bonus is for seeing it through.',
    'The money is either handed back through a payment mode or left as the customer’s credit, as the shop’s settings say.',
  ].join(' '),
  permission: 'schemes.accounts.close', params: idParam,
  body: z.object({
    reason: z.string().trim().min(3).max(500),
    settlement: z.enum(['refund', 'credit']).optional(),
    refundPaymentMethodId: uuid.optional(), docDate: isoDate.optional(),
  }),
  responses: [
    { status: 201, description: 'Closed, with what was handed back and what was kept.', schema: record },
    { status: 422, description: 'Closure not allowed, too early, or already settled.', schema: errorEnvelope },
  ],
  changelog: built('Early closure, with a configurable deduction.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => closeAccount(tx, param(req, 'id'), req.body))); },
});

/* ------------------------------------------------------------ for others */

defineRoute({
  method: 'get', path: `${S}/customers/:id/credit`, module: 'schemes', summary: 'What a member can spend',
  description: 'Matured accounts with a balance, read by the counter and by Orders so a scheme can pay for jewellery.',
  permission: 'schemes.accounts.view', params: idParam,
  responses: [{ status: 200, description: 'Accounts and the total on them.', schema: z.object({ accounts: z.array(record), total: money }) }],
  changelog: built('The counter can see a member’s savings.'),
  handler: async (req) => transaction((tx) => customerSchemeCredit(tx, param(req, 'id'))),
});

defineRoute({
  method: 'get', path: `${S}/liability`, module: 'schemes', summary: 'What the shop owes its members',
  description: 'Collected, bonus accrued, still owed, grams owed and the monthly run rate — the number a jeweller has to watch.',
  permission: 'schemes.liability.view',
  query: z.object({ branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'The summary.', schema: record }],
  changelog: built('The liability dashboard.'),
  handler: async (req) => transaction((tx) => liabilitySummary(tx, queryOf<{ branchId?: string }>(req).branchId)),
});
