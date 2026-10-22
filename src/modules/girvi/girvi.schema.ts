/**
 * Girvi — loan against jewellery.
 *
 * The shop holds the customer's gold in a sealed vault packet and lends against
 * it, typically to 75% of appraised value. Interest accrues monthly. If the
 * loan is repaid the packet comes back; if it is not, after due notice, the
 * collateral is auctioned.
 *
 * The thing to get right is that accrual is **append-only**. Recomputing
 * interest from the sanction date every time you open the screen sounds
 * simpler, but the rate can change mid-loan, payments land irregularly, and a
 * customer disputing a figure needs to see how it was arrived at month by
 * month. So each period's interest is a row, written once.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const GIRVI_STATUSES = [
  'draft', 'sanctioned', 'active', 'overdue', 'redeemed', 'defaulted', 'auctioned', 'cancelled',
] as const;

export const girviLoanTable = defineTable({
  name: 'girvi_loan',
  module: 'girvi',
  comment: 'The pawn agreement.',
  columns: {
    loan_number: col.text({ notNull: true }),
    status: col.enum(GIRVI_STATUSES, { notNull: true, default: "'draft'" }),
    branch_id: col.fk('branch', { notNull: true }),
    /** Existing customers link to party; walk-ins are captured inline. */
    customer_id: col.fk('party'),
    borrower_name: col.text({ notNull: true }),
    borrower_phone: col.text({ notNull: true }),
    borrower_address: col.text(),
    borrower_id_type: col.enum(['aadhaar', 'pan', 'voter', 'driving_licence', 'passport'], {}),
    borrower_id_number: col.text(),
    borrower_photo_key: col.text(),

    sanctioned_on: col.date(),
    due_date: col.date(),

    /* --- valuation --- */
    total_gross_weight: col.weight({ notNull: true, default: '0' }),
    total_net_weight: col.weight({ notNull: true, default: '0' }),
    total_fine_weight: col.weight({ notNull: true, default: '0' }),
    /** Market value of the collateral at sanction, at the buying rate. */
    appraised_value: col.money({ notNull: true, default: '0' }),
    /** Loan-to-value actually applied. Regulatory cap is 75%. */
    ltv_percent: col.rate({ notNull: true, default: '75' }),
    max_eligible_amount: col.money({ notNull: true, default: '0' }),
    principal_amount: col.money({ notNull: true, default: '0' }),

    /*
     * The terms this borrower was given, frozen on the day they took the loan.
     * A shop that changes its rate or its rules next month must not quietly
     * rewrite what someone already signed, and interest already worked out on
     * the old terms has to stay explainable.
     */
    interest_rate_monthly: col.rate({ notNull: true, default: '0', comment: 'Always stored as a % a month, whatever the shop quotes in.' }),
    quoted_rate: col.rate({ notNull: true, default: '0', comment: 'The number staff actually typed.' }),
    quoted_rate_basis: col.enum(['per_month', 'per_year', 'per_hundred'], { notNull: true, default: "'per_month'" }),
    interest_method: col.enum(['simple', 'compound'], { notNull: true, default: "'simple'" }),
    compound_months: col.int({ notNull: true, default: '12' }),
    period_basis: col.enum(['calendar', 'thirty_days', 'actual_days'], { notNull: true, default: "'calendar'" }),
    minimum_months: col.numeric(6, 3, { notNull: true, default: '1' }),
    part_month: col.enum(['full', 'pro_rata'], { notNull: true, default: "'full'" }),
    grace_days: col.int({ notNull: true, default: '0' }),
    penal_rate_monthly: col.rate({ notNull: true, default: '0' }),
    allocation_order: col.enum(['penalty_interest_principal', 'interest_penalty_principal', 'principal_first'], {
      notNull: true, default: "'penalty_interest_principal'",
    }),
    overdue_grace_days: col.int({ notNull: true, default: '15' }),

    /** What the shop charged to set the loan up, and how it was taken. */
    processing_fee: col.money({ notNull: true, default: '0' }),
    appraisal_fee: col.money({ notNull: true, default: '0' }),
    fee_treatment: col.enum(['deducted', 'added', 'separate'], { notNull: true, default: "'deducted'" }),
    storage_per_month: col.money({ notNull: true, default: '0' }),
    penalty_accrued: col.money({ notNull: true, default: '0' }),
    penalty_paid: col.money({ notNull: true, default: '0' }),

    disbursed_amount: col.money({ notNull: true, default: '0' }),
    /** Masters -> Payment Modes, so the shop's own modes and their rules apply. */
    disbursal_method_id: col.fk('payment_method'),
    disbursal_reference: col.text(),
    disbursed_at: col.timestamptz(),

    /* --- running balances --- */
    interest_accrued: col.money({ notNull: true, default: '0' }),
    interest_paid: col.money({ notNull: true, default: '0' }),
    principal_repaid: col.money({ notNull: true, default: '0' }),
    outstanding_amount: col.money({ notNull: true, default: '0' }),
    last_accrued_on: col.date(),

    /* --- custody --- */
    vault_packet_number: col.text({ comment: 'The sealed packet the collateral sits in.' }),
    vault_location_id: col.fk('stock_location'),
    packet_sealed_at: col.timestamptz(),
    packet_opened_at: col.timestamptz(),

    packet_witness_name: col.text({ comment: 'Who watched the packet being sealed, where the shop asks for it.' }),

    /* --- close-out --- */
    redeemed_at: col.timestamptz(),
    release_receipt_number: col.text(),
    released_to_name: col.text(),
    foreclosure_fee: col.money({ notNull: true, default: '0' }),
    /** How far along the notice run this loan is. */
    notice_count: col.int({ notNull: true, default: '0' }),
    last_notice_at: col.timestamptz(),
    default_notice_sent_at: col.timestamptz(),
    auction_date: col.date(),
    auction_proceeds: col.money(),
    /** Anything left after the debt is cleared goes back to the borrower. */
    surplus_returned: col.money(),
    voucher_id: col.fk('voucher'),
    notes: col.text(),
  },
  uniques: [{ columns: ['loan_number'] }],
  indexes: [
    { columns: ['status', 'due_date'] },
    { columns: ['customer_id'], where: 'customer_id is not null' },
    { columns: ['borrower_phone'] },
    { columns: ['vault_packet_number'], where: 'vault_packet_number is not null' },
    { columns: ['branch_id', 'sanctioned_on'] },
  ],
  checks: [
    { name: 'ltv_within_cap', expression: 'ltv_percent > 0 and ltv_percent <= 90' },
    { name: 'principal_within_eligible', expression: 'principal_amount <= max_eligible_amount + 0.01' },
    { name: 'amounts_not_negative', expression: 'principal_amount >= 0 and interest_accrued >= 0' },
  ],
});

export const girviCollateralTable = defineTable({
  name: 'girvi_collateral',
  module: 'girvi',
  comment: 'The individual articles held against the loan.',
  columns: {
    girvi_loan_id: col.fk('girvi_loan', { notNull: true, onDelete: 'cascade' }),
    line_number: col.int({ notNull: true }),
    description: col.text({ notNull: true }),
    item_category_id: col.fk('item_category'),
    metal_id: col.fk('metal', { notNull: true }),
    purity_id: col.fk('purity'),

    quantity: col.int({ notNull: true, default: '1' }),
    gross_weight: col.weight({ notNull: true }),
    stone_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true }),
    fine_weight: col.weight({ notNull: true, default: '0' }),
    tested_purity_percent: col.purity(),
    test_method: col.enum(['xrf', 'touchstone', 'declared'], { notNull: true, default: "'xrf'" }),

    appraised_value: col.money({ notNull: true, default: '0' }),
    /** Condition at intake, so nobody argues about a scratch on release. */
    condition_notes: col.text(),
    photo_storage_key: col.text(),
    is_released: col.bool({ notNull: true, default: 'false' }),
    released_at: col.timestamptz(),
  },
  uniques: [{ columns: ['girvi_loan_id', 'line_number'] }],
  checks: [
    { name: 'gross_positive', expression: 'gross_weight > 0' },
    { name: 'net_within_gross', expression: 'net_weight <= gross_weight' },
  ],
});

export const girviAccrualTable = defineTable({
  name: 'girvi_accrual',
  module: 'girvi',
  comment: 'One row per interest period. Written once, never recalculated.',
  columns: {
    girvi_loan_id: col.fk('girvi_loan', { notNull: true, onDelete: 'cascade' }),
    period_start: col.date({ notNull: true }),
    period_end: col.date({ notNull: true }),
    /** The balance interest was charged on for this period. */
    principal_base: col.money({ notNull: true }),
    rate_monthly: col.rate({ notNull: true }),
    days: col.int({ notNull: true }),
    interest_amount: col.money({ notNull: true }),
    /** interest is the normal charge; penal is the extra once a loan is overdue; storage is the locker charge. */
    kind: col.enum(['interest', 'penal', 'storage'], { notNull: true, default: "'interest'" }),
    is_waived: col.bool({ notNull: true, default: 'false' }),
    waive_reason: col.text(),
    voucher_id: col.fk('voucher'),
  },
  uniques: [{ columns: ['girvi_loan_id', 'period_start', 'kind'] }],
  indexes: [{ columns: ['period_end'] }],
  checks: [{ name: 'period_ordered', expression: 'period_end >= period_start' }],
});

export const girviRepaymentTable = defineTable({
  name: 'girvi_repayment',
  module: 'girvi',
  comment: 'Money coming back in. Interest is cleared before principal.',
  columns: {
    girvi_loan_id: col.fk('girvi_loan', { notNull: true, onDelete: 'cascade' }),
    receipt_number: col.text({ notNull: true }),
    paid_on: col.date({ notNull: true }),
    amount: col.money({ notNull: true }),
    /** How the payment was split. */
    interest_component: col.money({ notNull: true, default: '0' }),
    principal_component: col.money({ notNull: true, default: '0' }),
    penalty_component: col.money({ notNull: true, default: '0' }),
    fee_component: col.money({ notNull: true, default: '0' }),
    /** Masters -> Payment Modes, so reference rules and per-mode limits apply here too. */
    payment_method_id: col.fk('payment_method'),
    reference: col.text(),
    collected_by: col.fk('app_user'),
    voucher_id: col.fk('voucher'),
    /** A payment entered by mistake goes back with mirror entries, never by deleting it. */
    status: col.enum(['posted', 'cancelled'], { notNull: true, default: "'posted'" }),
    cancelled_at: col.timestamptz(),
    cancel_reason: col.text(),
    /** Balance after this payment, kept so a receipt can be reprinted exactly. */
    outstanding_after: col.money({ notNull: true, default: '0' }),
    notes: col.text(),
  },
  uniques: [{ columns: ['receipt_number'] }],
  indexes: [{ columns: ['girvi_loan_id', 'paid_on'] }],
  checks: [
    { name: 'amount_positive', expression: 'amount > 0' },
    {
      name: 'components_sum_to_amount',
      expression: 'abs((interest_component + principal_component + penalty_component + fee_component) - amount) < 0.01',
    },
  ],
});
