/**
 * Module 9 — the dual ledger.
 *
 * A jewellery business owes two different things to the same person at the
 * same time: rupees, and grams of gold. A customer who leaves 10g of old gold
 * against a future purchase is owed metal, not money — and if the rate moves
 * overnight, the rupee value of that debt moves with it while the gram figure
 * does not.
 *
 * So there are two parallel journals:
 *
 *     money ledger  ->  debit / credit in rupees      (what accountants expect)
 *     metal ledger  ->  in / out in fine grams        (what the trade runs on)
 *
 * Both hang off the same `voucher`, so a single transaction posts to both and
 * they can never drift apart.
 *
 * Around them sit the things an owner actually does with books: vouchers typed
 * by hand (expenses, payments, contra, journals), the cash drawer counted open
 * and shut each day, months and years closed so nobody edits the past, and a
 * bank statement ticked off against what the books say.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const LEDGER_KINDS = ['cash', 'bank', 'general'] as const;

export const accountTable = defineTable({
  name: 'account',
  module: 'accounts',
  softDelete: true,
  comment: 'Chart of accounts (Module 9.2): groups and the ledgers under them.',
  columns: {
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    account_type: col.enum(ACCOUNT_TYPES, { notNull: true }),
    parent_id: col.fk('account'),
    /** A group only adds up the ledgers under it; nothing is ever posted to it. */
    is_group: col.bool({ notNull: true, default: 'false' }),
    /** Groups only: counts toward gross profit (trading) rather than the net. */
    is_direct: col.bool({ notNull: true, default: 'false' }),
    /** Cash and bank ledgers get their own books, day close and reconciliation. */
    ledger_kind: col.enum(LEDGER_KINDS, { notNull: true, default: "'general'" }),
    /** A control account is posted to through a party, never directly. */
    is_control: col.bool({ notNull: true, default: 'false' }),
    control_for: col.enum(['customer', 'supplier', 'karigar'], {}),
    /** Metal accounts are measured in grams as well as rupees. */
    tracks_metal: col.bool({ notNull: true, default: 'false' }),
    is_system: col.bool({ notNull: true, default: 'false' }),
    is_active: col.bool({ notNull: true, default: 'true' }),
    description: col.text(),
    bank_name: col.text(),
    bank_account_number: col.text(),
    bank_ifsc: col.text(),
    /** What Tally calls this ledger, when it differs. */
    tally_name: col.text(),
  },
  uniques: [{ columns: ['code'] }],
  indexes: [{ columns: ['account_type'] }, { columns: ['parent_id'] }],
});

export const VOUCHER_TYPES = [
  'opening',
  'purchase',
  'purchase_return',
  'sale',
  'sales_return',
  'receipt',
  'payment',
  'journal',
  'old_gold',
  'scheme',
  'mortgage',
  'production',
  'contra',
  'expense',
  'stock_journal',
  'branch_transfer',
  'gst_settlement',
  'year_close',
  'cash_difference',
  'revaluation',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

export const voucherTable = defineTable({
  name: 'voucher',
  module: 'accounts',
  comment: 'The accounting header. Every posted document creates exactly one.',
  columns: {
    voucher_number: col.text({ notNull: true }),
    voucher_type: col.enum(VOUCHER_TYPES, { notNull: true }),
    voucher_date: col.date({ notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    narration: col.text(),
    /** The document this came from: sales_invoice, purchase_invoice... */
    source_type: col.text({ notNull: true }),
    source_id: col.uuid({ notNull: true }),
    is_reversed: col.bool({ notNull: true, default: 'false' }),
    reverses_voucher_id: col.fk('voucher'),
    /** Set once this voucher has gone to Tally, so the next export sends only what is new. */
    exported_at: col.timestamptz(),
  },
  uniques: [{ columns: ['voucher_number'] }],
  indexes: [
    { columns: ['voucher_date'] },
    { columns: ['source_type', 'source_id'] },
    { columns: ['voucher_type', 'voucher_date'] },
  ],
});

export const ledgerEntryTable = defineTable({
  name: 'ledger_entry',
  module: 'accounts',
  comment: 'The money side. Debits and credits in the base currency.',
  columns: {
    voucher_id: col.fk('voucher', { notNull: true, onDelete: 'cascade' }),
    account_id: col.fk('account', { notNull: true }),
    /** Set when the account is a control account — whose balance this is. */
    party_id: col.fk('party'),
    branch_id: col.fk('branch', { notNull: true }),
    entry_date: col.date({ notNull: true }),
    debit: col.money({ notNull: true, default: '0' }),
    credit: col.money({ notNull: true, default: '0' }),
    narration: col.text(),
    /** For ageing reports: which invoice this payment is against. */
    against_type: col.text(),
    against_id: col.uuid(),
    /** Bank ledgers: the day the bank statement shows this, once reconciled. */
    bank_cleared_on: col.date(),
  },
  indexes: [
    { columns: ['account_id', 'entry_date'] },
    { columns: ['party_id', 'entry_date'], where: 'party_id is not null' },
    { columns: ['voucher_id'] },
    { columns: ['branch_id', 'entry_date'] },
  ],
  checks: [
    {
      name: 'one_side_only',
      expression: '(debit = 0 or credit = 0) and debit >= 0 and credit >= 0 and (debit + credit) > 0',
    },
  ],
});

export const metalLedgerEntryTable = defineTable({
  name: 'metal_ledger_entry',
  module: 'accounts',
  comment: 'The metal side. Weights in fine grams, so 22K and 24K are directly comparable.',
  columns: {
    voucher_id: col.fk('voucher', { notNull: true, onDelete: 'cascade' }),
    account_id: col.fk('account', { notNull: true }),
    party_id: col.fk('party'),
    branch_id: col.fk('branch', { notNull: true }),
    entry_date: col.date({ notNull: true }),
    metal_id: col.fk('metal', { notNull: true }),
    purity_id: col.fk('purity'),
    /** As weighed, at the stated purity. */
    gross_weight: col.weight({ notNull: true, default: '0' }),
    /** Converted to pure metal. This is the number that gets added up. */
    weight_in: col.weight({ notNull: true, default: '0' }),
    weight_out: col.weight({ notNull: true, default: '0' }),
    /** The rate used at the moment of posting, kept so history stays explainable. */
    rate_per_gram: col.money(),
    narration: col.text(),
  },
  indexes: [
    { columns: ['account_id', 'entry_date'] },
    { columns: ['party_id', 'metal_id', 'entry_date'], where: 'party_id is not null' },
    { columns: ['voucher_id'] },
  ],
  checks: [
    {
      name: 'one_direction_only',
      expression: '(weight_in = 0 or weight_out = 0) and weight_in >= 0 and weight_out >= 0',
    },
  ],
});

/* ------------------------------------------------------- typed vouchers */

/** What a person can type by hand, plus the ones the books write for themselves. */
export const JOURNAL_TYPES = [
  'payment', 'receipt', 'contra', 'journal', 'expense', 'opening',
  'gst_settlement', 'year_close', 'cash_difference', 'revaluation',
] as const;
export type JournalType = (typeof JOURNAL_TYPES)[number];
export const JOURNAL_STATUSES = ['pending_approval', 'posted', 'rejected', 'cancelled'] as const;

export const journalEntryTable = defineTable({
  name: 'journal_entry',
  module: 'accounts',
  comment: 'A voucher typed in Accounts: an expense, a payment, cash to bank, a journal, an opening balance.',
  columns: {
    doc_number: col.text({ notNull: true }),
    doc_type: col.enum(JOURNAL_TYPES, { notNull: true }),
    doc_date: col.date({ notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    status: col.enum(JOURNAL_STATUSES, { notNull: true, default: "'posted'" }),
    party_id: col.fk('party'),
    /** Paid to someone who is not on file — the electrician, the tea stall. */
    payee: col.text(),
    amount: col.money({ notNull: true, default: '0' }),
    narration: col.text(),
    reference: col.text(),
    /** The supplier's own bill, for an expense. */
    bill_number: col.text(),
    bill_date: col.date(),
    attachment_key: col.text(),
    /** Set on the vouchers the books write for themselves (a day close, a month close). */
    source_type: col.text(),
    source_id: col.uuid(),
    approved_by: col.fk('app_user'),
    approved_at: col.timestamptz(),
    reject_reason: col.text(),
    cancelled_by: col.fk('app_user'),
    cancelled_at: col.timestamptz(),
    cancel_reason: col.text(),
    /** Revaluation is undone the next morning, so the books never keep a paper profit. */
    auto_reverse_on: col.date(),
    voucher_id: col.fk('voucher'),
  },
  uniques: [{ columns: ['doc_number'] }],
  indexes: [
    { columns: ['doc_type', 'doc_date'] },
    { columns: ['status'] },
    { columns: ['source_type', 'source_id'], where: 'source_id is not null' },
  ],
  checks: [{ name: 'amount_not_negative', expression: 'amount >= 0' }],
});

export const journalEntryLineTable = defineTable({
  name: 'journal_entry_line',
  module: 'accounts',
  comment: 'One side of a typed voucher. Money, grams, or both.',
  columns: {
    journal_entry_id: col.fk('journal_entry', { notNull: true, onDelete: 'cascade' }),
    line_number: col.int({ notNull: true }),
    account_id: col.fk('account', { notNull: true }),
    party_id: col.fk('party'),
    debit: col.money({ notNull: true, default: '0' }),
    credit: col.money({ notNull: true, default: '0' }),
    metal_id: col.fk('metal'),
    purity_id: col.fk('purity'),
    weight_in: col.weight({ notNull: true, default: '0' }),
    weight_out: col.weight({ notNull: true, default: '0' }),
    narration: col.text(),
  },
  uniques: [{ columns: ['journal_entry_id', 'line_number'] }],
  checks: [{ name: 'line_not_negative', expression: 'debit >= 0 and credit >= 0 and weight_in >= 0 and weight_out >= 0' }],
});

/* ------------------------------------------------------------ the day */

export const cashDayTable = defineTable({
  name: 'cash_day',
  module: 'accounts',
  comment: 'The cash drawer, counted when the shop opens and again when it shuts.',
  columns: {
    branch_id: col.fk('branch', { notNull: true }),
    business_date: col.date({ notNull: true }),
    account_id: col.fk('account', { notNull: true }),
    status: col.enum(['open', 'closed'], { notNull: true, default: "'open'" }),
    opening_expected: col.money({ notNull: true, default: '0' }),
    opening_counted: col.money({ notNull: true, default: '0' }),
    opening_denominations: col.jsonb(),
    opened_by: col.fk('app_user'),
    opened_at: col.timestamptz(),
    closing_expected: col.money(),
    closing_counted: col.money(),
    closing_denominations: col.jsonb(),
    /** Counted less expected: short is negative. */
    difference: col.money(),
    difference_voucher_id: col.fk('voucher'),
    summary: col.jsonb({ comment: 'Money in and out by where it came from, frozen at close.' }),
    note: col.text(),
    closed_by: col.fk('app_user'),
    closed_at: col.timestamptz(),
    reopened_by: col.fk('app_user'),
    reopened_at: col.timestamptz(),
    reopen_reason: col.text(),
  },
  uniques: [{ columns: ['branch_id', 'business_date', 'account_id'] }],
  indexes: [{ columns: ['business_date'] }],
});

export const accountingPeriodTable = defineTable({
  name: 'accounting_period',
  module: 'accounts',
  comment: 'A month or a financial year, and whether it is closed to new entries.',
  columns: {
    period_type: col.enum(['month', 'year'], { notNull: true }),
    start_date: col.date({ notNull: true }),
    end_date: col.date({ notNull: true }),
    status: col.enum(['open', 'closed'], { notNull: true, default: "'open'" }),
    closed_by: col.fk('app_user'),
    closed_at: col.timestamptz(),
    reopened_by: col.fk('app_user'),
    reopened_at: col.timestamptz(),
    reopen_reason: col.text(),
    summary: col.jsonb(),
    /** The GST set-off for a month, the profit moved to capital for a year. */
    voucher_id: col.fk('voucher'),
  },
  uniques: [{ columns: ['period_type', 'start_date'] }],
  checks: [{ name: 'period_in_order', expression: 'end_date >= start_date' }],
});

/* -------------------------------------------------------------- the bank */

export const bankStatementLineTable = defineTable({
  name: 'bank_statement_line',
  module: 'accounts',
  comment: 'A line off the bank statement, matched against the books.',
  columns: {
    account_id: col.fk('account', { notNull: true }),
    txn_date: col.date({ notNull: true }),
    description: col.text(),
    reference: col.text(),
    /** Money out of the account, as the bank sees it. */
    withdrawal: col.money({ notNull: true, default: '0' }),
    deposit: col.money({ notNull: true, default: '0' }),
    balance: col.money(),
    import_batch: col.text(),
    status: col.enum(['unmatched', 'matched', 'ignored'], { notNull: true, default: "'unmatched'" }),
    matched_entry_id: col.fk('ledger_entry'),
    matched_by: col.fk('app_user'),
    matched_at: col.timestamptz(),
    note: col.text(),
  },
  indexes: [{ columns: ['account_id', 'txn_date'] }, { columns: ['status'] }],
  checks: [{ name: 'one_side', expression: 'withdrawal >= 0 and deposit >= 0 and (withdrawal = 0 or deposit = 0)' }],
});

/* ------------------------------------------------------------- the chart */

export interface ChartRow {
  code: string;
  name: string;
  account_type: AccountType;
  parent: string | null;
  is_group?: boolean;
  is_direct?: boolean;
  ledger_kind?: (typeof LEDGER_KINDS)[number];
  is_control?: boolean;
  control_for?: 'customer' | 'supplier' | 'karigar';
  tracks_metal?: boolean;
  description?: string;
}

const g = (code: string, name: string, account_type: AccountType, parent: string | null, is_direct = false): ChartRow =>
  ({ code, name, account_type, parent, is_group: true, is_direct });

/**
 * The chart every business starts with. Group names follow Tally's own, so an
 * accountant recognises the shape on sight and the export lands in the right
 * place. Ledger codes keep the usual Indian numbering.
 */
export const CHART: ChartRow[] = [
  /* groups */
  g('G-CAP', 'Capital Account', 'equity', null),
  g('G-RES', 'Reserves & Surplus', 'equity', 'G-CAP'),
  g('G-LOAN', 'Loans (Liability)', 'liability', null),
  g('G-CL', 'Current Liabilities', 'liability', null),
  g('G-DT', 'Duties & Taxes', 'liability', 'G-CL'),
  g('G-SC', 'Sundry Creditors', 'liability', 'G-CL'),
  g('G-PROV', 'Provisions', 'liability', 'G-CL'),
  g('G-CADV', 'Customer Advances & Deposits', 'liability', 'G-CL'),
  g('G-FA', 'Fixed Assets', 'asset', null),
  g('G-CA', 'Current Assets', 'asset', null),
  g('G-CASH', 'Cash-in-Hand', 'asset', 'G-CA'),
  g('G-BANK', 'Bank Accounts', 'asset', 'G-CA'),
  g('G-SD', 'Sundry Debtors', 'asset', 'G-CA'),
  g('G-STK', 'Stock-in-Hand', 'asset', 'G-CA'),
  g('G-LA', 'Loans & Advances (Asset)', 'asset', 'G-CA'),
  g('G-TAXA', 'GST & Tax Credits', 'asset', 'G-CA'),
  g('G-SUS', 'Suspense A/c', 'asset', null),
  g('G-SALES', 'Sales Accounts', 'income', null, true),
  g('G-DI', 'Direct Incomes', 'income', null, true),
  g('G-II', 'Indirect Incomes', 'income', null),
  g('G-PUR', 'Purchase Accounts', 'expense', null, true),
  g('G-DE', 'Direct Expenses', 'expense', null, true),
  g('G-IE', 'Indirect Expenses', 'expense', null),

  /* assets */
  { code: '1000', name: 'Cash in Hand', account_type: 'asset', parent: 'G-CASH', ledger_kind: 'cash' },
  { code: '1010', name: 'Bank Accounts', account_type: 'asset', parent: 'G-BANK', ledger_kind: 'bank' },
  { code: '1100', name: 'Sundry Debtors', account_type: 'asset', parent: 'G-SD', is_control: true, control_for: 'customer' },
  { code: '1200', name: 'Stock in Hand', account_type: 'asset', parent: 'G-STK' },
  { code: '1210', name: 'Metal Stock', account_type: 'asset', parent: 'G-STK', tracks_metal: true },
  { code: '1220', name: 'Metal with Refiners & Karigars', account_type: 'asset', parent: 'G-STK', tracks_metal: true },
  { code: '1295', name: 'Stock Revaluation Adjustment', account_type: 'asset', parent: 'G-STK',
    description: 'Month-end mark-to-market of metal stock. Reversed the next day.' },
  { code: '1300', name: 'GST Input Credit (combined)', account_type: 'asset', parent: 'G-TAXA',
    description: 'Input GST posted before CGST, SGST and IGST were kept apart.' },
  { code: '1301', name: 'CGST Input', account_type: 'asset', parent: 'G-TAXA' },
  { code: '1302', name: 'SGST Input', account_type: 'asset', parent: 'G-TAXA' },
  { code: '1303', name: 'IGST Input', account_type: 'asset', parent: 'G-TAXA' },
  { code: '1309', name: 'GST Credit Carried Forward', account_type: 'asset', parent: 'G-TAXA' },
  { code: '1400', name: 'Girvi Loans Receivable', account_type: 'asset', parent: 'G-LA', is_control: true, control_for: 'customer' },
  { code: '1410', name: 'Girvi Interest Receivable', account_type: 'asset', parent: 'G-LA' },
  { code: '1420', name: 'Staff Advances', account_type: 'asset', parent: 'G-LA' },
  { code: '1430', name: 'Deposits Paid', account_type: 'asset', parent: 'G-LA' },
  { code: '1500', name: 'Furniture & Fixtures', account_type: 'asset', parent: 'G-FA' },
  { code: '1510', name: 'Computers & Equipment', account_type: 'asset', parent: 'G-FA' },
  { code: '1520', name: 'Safe & Security Systems', account_type: 'asset', parent: 'G-FA' },
  { code: '1530', name: 'Vehicles', account_type: 'asset', parent: 'G-FA' },
  { code: '1600', name: 'Branch Transfers in Transit', account_type: 'asset', parent: 'G-SUS',
    description: 'Stock sent from one branch and not yet received at the other.' },
  { code: '1900', name: 'Suspense', account_type: 'asset', parent: 'G-SUS' },

  /* liabilities */
  { code: '2000', name: 'Sundry Creditors', account_type: 'liability', parent: 'G-SC', is_control: true, control_for: 'supplier' },
  { code: '2010', name: 'Supplier Metal Payable', account_type: 'liability', parent: 'G-SC', is_control: true, control_for: 'supplier', tracks_metal: true },
  { code: '2020', name: 'Karigar Wages Payable', account_type: 'liability', parent: 'G-PROV' },
  { code: '2030', name: 'Salaries Payable', account_type: 'liability', parent: 'G-PROV' },
  { code: '2040', name: 'Expenses Payable', account_type: 'liability', parent: 'G-PROV' },
  { code: '2100', name: 'Customer Metal Payable', account_type: 'liability', parent: 'G-CADV', tracks_metal: true },
  { code: '2200', name: 'GST Output (combined)', account_type: 'liability', parent: 'G-DT',
    description: 'Output GST posted before CGST, SGST and IGST were kept apart.' },
  { code: '2201', name: 'CGST Output', account_type: 'liability', parent: 'G-DT' },
  { code: '2202', name: 'SGST Output', account_type: 'liability', parent: 'G-DT' },
  { code: '2203', name: 'IGST Output', account_type: 'liability', parent: 'G-DT' },
  { code: '2210', name: 'Composition Tax Payable', account_type: 'liability', parent: 'G-DT' },
  { code: '2250', name: 'TDS Payable', account_type: 'liability', parent: 'G-DT' },
  { code: '2299', name: 'GST Payable (Net)', account_type: 'liability', parent: 'G-DT' },
  { code: '2300', name: 'Scheme Liability', account_type: 'liability', parent: 'G-CADV' },
  { code: '2310', name: 'Scheme Metal Payable', account_type: 'liability', parent: 'G-CADV', tracks_metal: true },
  { code: '2400', name: 'Advance from Customers', account_type: 'liability', parent: 'G-CADV' },
  { code: '2500', name: 'Loans & Borrowings', account_type: 'liability', parent: 'G-LOAN' },

  /* equity */
  { code: '3000', name: 'Capital Account', account_type: 'equity', parent: 'G-CAP' },
  { code: '3010', name: 'Drawings', account_type: 'equity', parent: 'G-CAP' },
  { code: '3100', name: 'Retained Earnings', account_type: 'equity', parent: 'G-RES' },
  { code: '3900', name: 'Opening Balance Difference', account_type: 'equity', parent: 'G-RES',
    description: 'Where opening balances that did not add up wait until they are sorted out.' },

  /* income */
  { code: '4000', name: 'Sales (combined)', account_type: 'income', parent: 'G-SALES' },
  { code: '4001', name: 'Sales - Metal Value', account_type: 'income', parent: 'G-SALES' },
  { code: '4002', name: 'Sales - Making Charges', account_type: 'income', parent: 'G-SALES' },
  { code: '4003', name: 'Sales - Wastage', account_type: 'income', parent: 'G-SALES' },
  { code: '4004', name: 'Sales - Stones', account_type: 'income', parent: 'G-SALES' },
  { code: '4005', name: 'Sales - Hallmarking', account_type: 'income', parent: 'G-SALES' },
  { code: '4009', name: 'Sales Discount', account_type: 'income', parent: 'G-SALES' },
  { code: '4100', name: 'Labour & Services Income', account_type: 'income', parent: 'G-DI' },
  { code: '4200', name: 'Metal Gain / Loss', account_type: 'income', parent: 'G-DI' },
  { code: '4300', name: 'Girvi Interest Income', account_type: 'income', parent: 'G-II' },
  { code: '4310', name: 'Girvi Charges & Penalty', account_type: 'income', parent: 'G-II' },
  { code: '4400', name: 'Other Income', account_type: 'income', parent: 'G-II' },
  { code: '4600', name: 'Stock Revaluation (Unrealised)', account_type: 'income', parent: 'G-II' },
  { code: '4900', name: 'Round Off', account_type: 'income', parent: 'G-II' },

  /* expenses */
  { code: '5000', name: 'Purchases', account_type: 'expense', parent: 'G-PUR' },
  { code: '5010', name: 'GST on Purchases (No Credit)', account_type: 'expense', parent: 'G-PUR' },
  { code: '5100', name: 'Cost of Goods Sold', account_type: 'expense', parent: 'G-DE' },
  { code: '5200', name: 'Karigar Wages', account_type: 'expense', parent: 'G-DE' },
  { code: '5440', name: 'Hallmarking Charges', account_type: 'expense', parent: 'G-DE' },
  { code: '5910', name: 'Stock Adjustments (Gain / Loss)', account_type: 'expense', parent: 'G-DE' },
  { code: '5300', name: 'Scheme Bonus', account_type: 'expense', parent: 'G-IE' },
  { code: '5400', name: 'Rent', account_type: 'expense', parent: 'G-IE' },
  { code: '5410', name: 'Bank & Card Charges', account_type: 'expense', parent: 'G-IE' },
  { code: '5420', name: 'Salaries & Wages', account_type: 'expense', parent: 'G-IE' },
  { code: '5430', name: 'Electricity', account_type: 'expense', parent: 'G-IE' },
  { code: '5450', name: 'Repairs & Maintenance', account_type: 'expense', parent: 'G-IE' },
  { code: '5460', name: 'Insurance', account_type: 'expense', parent: 'G-IE' },
  { code: '5470', name: 'Office & Stationery', account_type: 'expense', parent: 'G-IE' },
  { code: '5480', name: 'Telephone & Internet', account_type: 'expense', parent: 'G-IE' },
  { code: '5490', name: 'Travel & Conveyance', account_type: 'expense', parent: 'G-IE' },
  { code: '5500', name: 'Advertisement', account_type: 'expense', parent: 'G-IE' },
  { code: '5510', name: 'Professional Fees', account_type: 'expense', parent: 'G-IE' },
  { code: '5520', name: 'Security Charges', account_type: 'expense', parent: 'G-IE' },
  { code: '5530', name: 'Packing Material', account_type: 'expense', parent: 'G-IE' },
  { code: '5540', name: 'Depreciation', account_type: 'expense', parent: 'G-IE' },
  { code: '5600', name: 'Composition Tax', account_type: 'expense', parent: 'G-IE' },
  { code: '5900', name: 'Other Expenses', account_type: 'expense', parent: 'G-IE' },
  { code: '5920', name: 'Cash Short / Excess', account_type: 'expense', parent: 'G-IE' },
];

/** Kept for the older call sites; the chart is the source of truth. */
export const DEFAULT_ACCOUNTS = CHART;

/** Standard ledgers renamed since they were first seeded. Only an untouched name is updated. */
export const CHART_RENAMES: Record<string, string> = {
  'Making Charges Income': 'Labour & Services Income',
  'GST Input Credit': 'GST Input Credit (combined)',
  'GST Output Payable': 'GST Output (combined)',
  Sales: 'Sales (combined)',
};
