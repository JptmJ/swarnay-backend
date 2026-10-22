/**
 * Swarna Nidhi — monthly gold savings schemes.
 *
 * The customer pays a fixed amount each month; at maturity the shop adds a
 * bonus (classically one free installment) and the total buys jewellery at
 * that day's rate. Two things make this worth modelling carefully:
 *
 * 1. **It is a liability, not revenue.** Money collected is owed back in gold
 *    until the customer redeems. Booking it as income is how jewellers get
 *    into trouble, so it posts to a liability account.
 *
 * 2. **Some schemes accrue grams, not rupees.** Paying ₹5,000 when gold is
 *    ₹6,500/g buys 0.769g, and that gram figure is what the customer is owed —
 *    the rupee value moves with the rate. Both accrual styles are supported.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const schemePlanTable = defineTable({
  name: 'scheme_plan',
  module: 'schemes',
  softDelete: true,
  comment: 'The scheme product: tenure, installment, bonus rules.',
  columns: {
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    description: col.text(),
    metal_id: col.fk('metal', { notNull: true }),
    /** The purity the grams are counted in. Null = the purest priced purity of the metal. */
    purity_id: col.fk('purity'),

    /** rupee = accumulate money; weight = accumulate grams at each payment's rate. */
    accrual_basis: col.enum(['rupee', 'weight'], { notNull: true, default: "'rupee'" }),
    tenure_months: col.int({ notNull: true }),
    installment_amount: col.money({ comment: 'Null for flexible-amount schemes.' }),
    minimum_installment: col.money(),
    is_flexible_amount: col.bool({ notNull: true, default: 'false' }),

    /** The classic "pay 11, get 12". */
    bonus_installments: col.numeric(6, 3, { notNull: true, default: '0' }),
    bonus_percent: col.rate({ notNull: true, default: '0' }),
    /** Bonus is forfeited if more than this many payments are missed. */
    max_missed_installments: col.int({ notNull: true, default: '2' }),
    /** Some schemes waive making charges at redemption instead of paying a bonus. */
    making_charge_discount_percent: col.rate({ notNull: true, default: '0' }),

    allow_partial_redemption: col.bool({ notNull: true, default: 'false' }),
    /** Redemption is normally restricted to jewellery, not cash. */
    allow_cash_redemption: col.bool({ notNull: true, default: 'false' }),
    grace_period_days: col.int({ notNull: true, default: '7' }),
    terms_and_conditions: col.text(),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['code'] }],
  checks: [
    { name: 'tenure_positive', expression: 'tenure_months > 0' },
    { name: 'bonus_not_negative', expression: 'bonus_installments >= 0 and bonus_percent >= 0' },
  ],
});

export const SCHEME_ACCOUNT_STATUSES = [
  'active', 'matured', 'redeemed', 'defaulted', 'cancelled', 'closed',
] as const;

export const schemeAccountTable = defineTable({
  name: 'scheme_account',
  module: 'schemes',
  comment: 'One customer enrolled in one scheme.',
  columns: {
    account_number: col.text({ notNull: true }),
    scheme_plan_id: col.fk('scheme_plan', { notNull: true }),
    customer_id: col.fk('party', { notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    status: col.enum(SCHEME_ACCOUNT_STATUSES, { notNull: true, default: "'active'" }),

    enrolled_on: col.date({ notNull: true }),
    maturity_date: col.date({ notNull: true }),
    /** Which day of the month the installment falls due. */
    due_day: col.int({ notNull: true, default: '1' }),
    installment_amount: col.money({ notNull: true }),

    /*
     * The plan's terms as they stood the day this customer signed. A shop that
     * improves its bonus next year must not change what it already promised, and
     * a shop that reduces it must not take anything away from people already in.
     */
    accrual_basis: col.enum(['rupee', 'weight'], { notNull: true, default: "'rupee'" }),
    purity_id: col.fk('purity'),
    bonus_installments: col.numeric(6, 3, { notNull: true, default: '0' }),
    bonus_percent: col.rate({ notNull: true, default: '0' }),
    making_charge_discount_percent: col.rate({ notNull: true, default: '0' }),
    max_missed_installments: col.int({ notNull: true, default: '2' }),
    grace_period_days: col.int({ notNull: true, default: '7' }),
    is_flexible_amount: col.bool({ notNull: true, default: 'false' }),
    minimum_installment: col.money(),
    installments_missed: col.int({ notNull: true, default: '0' }),

    /** Running totals, kept in step with the installment rows. */
    installments_paid: col.int({ notNull: true, default: '0' }),
    installments_due: col.int({ notNull: true, default: '0' }),
    total_paid: col.money({ notNull: true, default: '0' }),
    /** Grams accrued, for weight-basis schemes. */
    total_weight_accrued: col.weight({ notNull: true, default: '0' }),
    bonus_amount: col.money({ notNull: true, default: '0' }),
    bonus_weight: col.weight({ notNull: true, default: '0' }),
    /** What the customer can spend today. */
    redeemable_amount: col.money({ notNull: true, default: '0' }),
    redeemable_weight: col.weight({ notNull: true, default: '0' }),
    is_bonus_forfeited: col.bool({ notNull: true, default: 'false' }),

    nominee_name: col.text(),
    nominee_relationship: col.text(),
    nominee_phone: col.text(),

    matured_at: col.timestamptz(),
    closed_at: col.timestamptz(),
    close_reason: col.text(),
  },
  uniques: [{ columns: ['account_number'] }],
  indexes: [
    { columns: ['customer_id', 'status'] },
    { columns: ['status', 'maturity_date'] },
    { columns: ['branch_id', 'status'] },
    { columns: ['due_day'], where: "status = 'active'" },
  ],
  checks: [
    { name: 'due_day_valid', expression: 'due_day between 1 and 28' },
    { name: 'totals_not_negative', expression: 'total_paid >= 0 and installments_paid >= 0' },
  ],
});

export const INSTALLMENT_STATUSES = ['due', 'paid', 'missed', 'waived', 'advance'] as const;

export const schemeInstallmentTable = defineTable({
  name: 'scheme_installment',
  module: 'schemes',
  comment: 'The full schedule, generated at enrollment. Each row is later paid or missed.',
  columns: {
    scheme_account_id: col.fk('scheme_account', { notNull: true, onDelete: 'cascade' }),
    installment_number: col.int({ notNull: true }),
    due_date: col.date({ notNull: true }),
    status: col.enum(INSTALLMENT_STATUSES, { notNull: true, default: "'due'" }),

    amount_due: col.money({ notNull: true }),
    amount_paid: col.money({ notNull: true, default: '0' }),
    paid_on: col.date(),
    /** The rate on the day it was paid — fixes the grams this installment bought. */
    rate_per_gram: col.money(),
    weight_accrued: col.weight({ notNull: true, default: '0' }),

    /** Masters -> Payment Modes, so reference rules, per-mode limits and the cash limit apply here too. */
    payment_method_id: col.fk('payment_method'),
    payment_reference: col.text(),
    receipt_number: col.text(),
    collected_by: col.fk('app_user'),
    voucher_id: col.fk('voucher'),
    /** The purity the grams were bought in, and which rate was read. */
    purity_id: col.fk('purity'),
    /** A collection entered by mistake goes back to due; the money is reversed with mirror entries. */
    cancelled_at: col.timestamptz(),
    cancel_reason: col.text(),
    waived_reason: col.text(),
    /** Reminder tracking for the "due / missed" log. */
    last_reminder_at: col.timestamptz(),
    reminder_count: col.int({ notNull: true, default: '0' }),
    notes: col.text(),
  },
  uniques: [{ columns: ['scheme_account_id', 'installment_number'] }],
  indexes: [
    { columns: ['due_date', 'status'] },
    { columns: ['status', 'due_date'] },
    { columns: ['scheme_account_id', 'status'] },
  ],
  checks: [{ name: 'amounts_not_negative', expression: 'amount_due >= 0 and amount_paid >= 0' }],
});

export const schemeRedemptionTable = defineTable({
  name: 'scheme_redemption',
  module: 'schemes',
  comment: 'Turning a matured account into jewellery. Partial redemption leaves the account open.',
  columns: {
    scheme_account_id: col.fk('scheme_account', { notNull: true }),
    redemption_number: col.text({ notNull: true }),
    redeemed_on: col.date({ notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    is_partial: col.bool({ notNull: true, default: 'false' }),

    /** What was consumed from the account. */
    amount_redeemed: col.money({ notNull: true, default: '0' }),
    weight_redeemed: col.weight({ notNull: true, default: '0' }),
    bonus_applied: col.money({ notNull: true, default: '0' }),
    /** The rate used to convert the balance into metal on the day. */
    rate_per_gram: col.money({ notNull: true, default: '0' }),

    sales_invoice_id: col.fk('sales_invoice'),
    retail_order_id: col.fk('retail_order'),
    /** Only when the plan allows it, which is unusual. */
    cash_paid_out: col.money({ notNull: true, default: '0' }),
    bonus_weight_applied: col.weight({ notNull: true, default: '0' }),
    making_discount_percent: col.rate({ notNull: true, default: '0' }),
    /** Money handed back when an account is closed early, and what was kept. */
    deduction_amount: col.money({ notNull: true, default: '0' }),
    kind: col.enum(['redemption', 'early_closure'], { notNull: true, default: "'redemption'" }),
    status: col.enum(['posted', 'cancelled'], { notNull: true, default: "'posted'" }),
    voucher_id: col.fk('voucher'),
    notes: col.text(),
  },
  uniques: [{ columns: ['redemption_number'] }],
  indexes: [{ columns: ['scheme_account_id', 'redeemed_on'] }],
});
