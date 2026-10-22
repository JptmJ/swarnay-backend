/**
 * The ready reports. Each is only a saved set of choices over a data set, so
 * every one of them can be opened in the designer, changed and saved as the
 * owner's own. A few point to the Accounts reports instead of repeating them,
 * so each figure is worked out in exactly one place.
 */
import type { ReportSpec } from './engine.js';

export interface CatalogReport {
  key: string;
  name: string;
  category: string;
  description: string;
  spec?: ReportSpec;
  /** Opens a report that lives in another module. */
  link?: { module: string; tab: string };
  /** Totals shown as cards above the table. */
  kpis?: string[];
  tags?: string[];
}

export const CATEGORIES: { key: string; label: string; description: string }[] = [
  { key: 'sales', label: 'Sales', description: 'Bills, items, payments and returns' },
  { key: 'profit', label: 'Profit & margin', description: 'What each sale earned over its cost' },
  { key: 'stock', label: 'Stock', description: 'What you hold, how long, and what moved' },
  { key: 'purchase', label: 'Purchase', description: 'What you bought and from whom' },
  { key: 'oldgold', label: 'Old gold', description: 'Gold taken in and melted' },
  { key: 'orders', label: 'Orders & karigar', description: 'Orders, deliveries, jobs and ghat' },
  { key: 'schemes', label: 'Gold savings', description: 'Collections, defaulters and maturities' },
  { key: 'girvi', label: 'Girvi', description: 'Loans, interest and overdue' },
  { key: 'customers', label: 'Customers', description: 'Who buys, who has gone quiet, who owes' },
  { key: 'staff', label: 'Staff', description: 'Sales and discounts by salesperson' },
  { key: 'compliance', label: 'Compliance', description: 'PAN, cash limits, HUID and GST returns' },
  { key: 'accounts', label: 'Accounts', description: 'The books: P&L, balance sheet, GST, ledgers' },
];

export interface CatalogSettings { slowDays: number; dormantDays: number; highValueBill: number; cashLimit: number }

export function catalog(s: CatalogSettings): CatalogReport[] {
  const r = (key: string, name: string, category: string, description: string, spec: ReportSpec, extra: Partial<CatalogReport> = {}): CatalogReport =>
    ({ key, name, category, description, spec, ...extra });
  const sum = (...fields: string[]) => fields.map((field) => ({ field, agg: 'sum' as const }));
  const count = { field: '*', agg: 'count' as const };
  return [
    /* ---------------------------------------------------------------- sales */
    r('sales-register', 'Sales register', 'sales', 'Every bill in the period with weights, value, GST and what is still owed.',
      { dataset: 'sales_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }],
        columns: ['date', 'bill', 'customer', 'salesperson', 'net_weight', 'taxable', 'gst', 'total', 'paid', 'balance'] },
      { kpis: ['total', 'gst', 'balance'], tags: ['daily'] }),
    r('sales-today', 'Today’s sales', 'sales', 'Bills made today and what they came to.',
      { dataset: 'sales_bills', range: { preset: 'today' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }],
        columns: ['bill', 'customer', 'salesperson', 'net_weight', 'total', 'cash_paid', 'balance'] }, { kpis: ['total', 'net_weight'], tags: ['daily'] }),
    r('sales-daily', 'Sales day by day', 'sales', 'Bills, weight and value for each day, against the same period before.',
      { dataset: 'sales_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['date:day'],
        measures: [count, ...sum('net_weight', 'taxable', 'total')], compare: true, chart: 'bar' }),
    r('sales-monthly', 'Sales month by month', 'sales', 'Twelve months of sales side by side.',
      { dataset: 'sales_bills', range: { preset: 'last_365' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['date:month'],
        measures: [count, ...sum('net_weight', 'taxable', 'gst', 'total')], chart: 'line' }),
    r('sales-by-category', 'Sales by category', 'sales', 'Which kinds of jewellery sell: pieces, grams and value per category.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'kind', op: 'eq', value: 'Goods' }], groupBy: ['category'],
        measures: [...sum('pieces', 'net_weight', 'taxable')], compare: true, chart: 'donut' }),
    r('sales-by-item', 'Sales by item', 'sales', 'Every item’s pieces, weight and value sold.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'kind', op: 'eq', value: 'Goods' }], groupBy: ['item'],
        measures: [...sum('pieces', 'gross_weight', 'net_weight', 'making', 'taxable')] }),
    r('sales-by-purity', 'Sales by metal and purity', 'sales', '22K, 18K, silver: weight and value sold of each.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'kind', op: 'eq', value: 'Goods' }], groupBy: ['metal', 'purity'],
        measures: [...sum('net_weight', 'fine_weight', 'taxable')], chart: 'bar' }),
    r('sales-by-branch', 'Sales by branch', 'sales', 'Each branch’s bills, weight and value, against the period before.',
      { dataset: 'sales_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['branch'],
        measures: [count, ...sum('net_weight', 'total')], compare: true, chart: 'bar' }),
    r('sales-by-mode', 'Collections by payment mode', 'sales', 'How customers paid: cash, card, UPI, bank, old gold, savings, advance.',
      { dataset: 'sales_payments', range: { preset: 'this_month' }, groupBy: ['mode'], measures: [count, ...sum('amount')], chart: 'donut' }, { tags: ['daily'] }),
    r('sales-by-hour', 'Busiest hours', 'sales', 'Bills and value by hour of the day, to plan counter staff.',
      { dataset: 'sales_bills', range: { preset: 'last_30' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['hour'],
        measures: [count, ...sum('total')], sort: [{ key: 'hour', dir: 'asc' }], chart: 'bar' }),
    r('sales-by-weekday', 'Busiest days of the week', 'sales', 'Bills and value by day of the week.',
      { dataset: 'sales_bills', range: { preset: 'last_90' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['date:weekday'],
        measures: [count, ...sum('total')], chart: 'bar' }),
    r('sales-by-city', 'Sales by customer city', 'sales', 'Where your buyers come from.',
      { dataset: 'sales_bills', range: { preset: 'this_fy' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['customer_city'],
        measures: [count, ...sum('total')], limit: 25, chart: 'bar' }),
    r('sales-discounts', 'Discount register', 'sales', 'Every bill that carried a discount, largest first.',
      { dataset: 'sales_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }, { field: 'discount', op: 'gt', value: 0 }],
        columns: ['date', 'bill', 'customer', 'salesperson', 'taxable', 'discount', 'discount_percent', 'total'], sort: [{ key: 'discount', dir: 'desc' }] },
      { kpis: ['discount'] }),
    r('sales-returns', 'Returns register', 'sales', 'Goods brought back, from which bill, why, and how it was settled.',
      { dataset: 'sales_returns', range: { preset: 'this_month' },
        columns: ['date', 'return_no', 'bill', 'customer', 'item', 'purity', 'net_weight', 'value', 'reason', 'settlement'] }, { kpis: ['value', 'net_weight'] }),
    r('sales-credit-bills', 'Bills not fully paid', 'sales', 'Every bill with money still owed on it.',
      { dataset: 'sales_bills', range: { preset: 'all' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }, { field: 'balance', op: 'gt', value: 0 }],
        columns: ['date', 'bill', 'customer', 'customer_phone', 'total', 'paid', 'balance'], sort: [{ key: 'date', dir: 'asc' }] }, { kpis: ['balance'] }),
    r('sales-labour', 'Labour and repair income', 'sales', 'Labour, polish and repair charges billed.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'kind', op: 'eq', value: 'Labour' }],
        columns: ['date', 'bill', 'customer', 'item', 'taxable', 'gst', 'line_total'] }, { kpis: ['taxable'] }),

    /* --------------------------------------------------------------- profit */
    r('profit-by-category', 'Margin by category', 'profit', 'Sales against what the goods cost, per category, with margin %.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'kind', op: 'eq', value: 'Goods' }], groupBy: ['category'],
        measures: [...sum('net_weight', 'taxable', 'cost', 'margin'), { field: 'margin_percent', agg: 'sum' }], chart: 'bar' }),
    r('profit-by-item', 'Margin by item', 'profit', 'Which items earn the most, and which barely cover their cost.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'kind', op: 'eq', value: 'Goods' }], groupBy: ['item'],
        measures: [...sum('pieces', 'taxable', 'cost', 'margin'), { field: 'margin_percent', agg: 'sum' }] }),
    r('profit-by-bill', 'Margin by bill', 'profit', 'Every bill’s margin, lowest first — where discounts went too far.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, groupBy: ['bill'],
        measures: [...sum('taxable', 'discount', 'cost', 'margin'), { field: 'margin_percent', agg: 'sum' }], sort: [{ key: 'margin_percent', dir: 'asc' }] }),
    r('profit-making-wastage', 'Making and wastage earned', 'profit', 'What making, wastage, stones and hallmarking brought in, month by month.',
      { dataset: 'sales_lines', range: { preset: 'this_fy' }, groupBy: ['date:month'], measures: [...sum('metal_value', 'making', 'wastage', 'stones', 'hallmark', 'discount')], chart: 'bar' }),
    r('profit-by-salesperson', 'Margin by salesperson', 'profit', 'What each salesperson sold and what it earned after cost and discount.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, groupBy: ['salesperson'],
        measures: [...sum('taxable', 'discount', 'margin'), { field: 'margin_percent', agg: 'sum' }] }),

    /* ---------------------------------------------------------------- stock */
    r('stock-summary', 'Stock summary', 'stock', 'Everything in stock now by item and purity: pieces, weights and value.',
      { dataset: 'stock_balances', groupBy: ['category', 'purity'], measures: [...sum('pieces', 'gross_weight', 'net_weight', 'fine_weight', 'value', 'metal_value_today')], chart: 'bar' },
      { kpis: ['sum_net_weight', 'sum_fine_weight', 'sum_value'] }),
    r('stock-by-location', 'Stock by location', 'stock', 'What is in each counter, safe and branch.',
      { dataset: 'stock_balances', groupBy: ['branch', 'location'], measures: [...sum('pieces', 'net_weight', 'fine_weight', 'value')] }),
    r('stock-tag-list', 'Tag-wise stock list', 'stock', 'Every tagged piece in stock with its weights — for a physical check.',
      { dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_stock' }],
        columns: ['tag', 'huid', 'item', 'purity', 'location', 'gross_weight', 'stone_weight', 'net_weight', 'fine_weight'], sort: [{ key: 'tag', dir: 'asc' }] },
      { kpis: ['pieces', 'net_weight'] }),
    r('stock-ageing', 'Stock ageing', 'stock', 'How long pieces have been sitting, by age band.',
      { dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_stock' }], groupBy: ['age_band'],
        measures: [...sum('pieces', 'net_weight', 'cost')], sort: [{ key: 'age_band', dir: 'asc' }], chart: 'bar' }),
    r('stock-slow-moving', 'Slow-moving stock', 'stock', `Pieces in stock for more than ${s.slowDays} days, oldest first.`,
      { dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_stock' }, { field: 'days_in_stock', op: 'gt', value: s.slowDays }],
        columns: ['tag', 'item', 'category', 'purity', 'location', 'net_weight', 'days_in_stock', 'cost'], sort: [{ key: 'days_in_stock', dir: 'desc' }] },
      { kpis: ['pieces', 'net_weight', 'cost'] }),
    r('stock-fast-moving', 'Best sellers', 'stock', 'Items that sold the most pieces in the last 90 days.',
      { dataset: 'sales_lines', range: { preset: 'last_90' }, filters: [{ field: 'kind', op: 'eq', value: 'Goods' }], groupBy: ['item'],
        measures: [...sum('pieces', 'net_weight', 'taxable')], sort: [{ key: 'sum_pieces', dir: 'desc' }], limit: 30 }),
    r('stock-movement-summary', 'Stock movement: opening to closing', 'stock', 'For each item: what it opened with, what came in, what went out, and the closing balance.',
      { dataset: 'stock_position', range: { preset: 'this_month' }, groupBy: ['item', 'purity'], measures: [...sum('opening', 'in', 'out', 'closing', 'closing_fine')] }),
    r('stock-movements', 'Stock movement register', 'stock', 'Every movement in and out, with why.',
      { dataset: 'stock_movements', range: { preset: 'today' }, columns: ['date', 'direction', 'reason', 'item', 'purity', 'location', 'net_in', 'net_out', 'note'] }),
    r('stock-huid-pending', 'Pieces without HUID', 'stock', 'Pieces in stock with no hallmark ID yet.',
      { dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_stock' }, { field: 'has_huid', op: 'eq', value: 'No' }, { field: 'metal', op: 'eq', value: 'Gold' }],
        columns: ['tag', 'item', 'purity', 'location', 'net_weight', 'days_in_stock'] }, { kpis: ['pieces'] }),
    r('stock-in-transit', 'Stock in transit', 'stock', 'Pieces sent between branches and not yet received.',
      { dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_transit' }], columns: ['tag', 'item', 'purity', 'branch', 'location', 'net_weight', 'cost'] }),
    r('stock-adjustments', 'Stock adjustments and losses', 'stock', 'Shortages, damage, losses, counts and weighing corrections.',
      { dataset: 'stock_movements', range: { preset: 'this_fy' }, filters: [{ field: 'reason', op: 'eq', value: 'adjustment' }],
        columns: ['date', 'direction', 'item', 'purity', 'location', 'net_in', 'net_out', 'value_change', 'note'] }),
    r('stock-booked', 'Pieces booked for orders', 'stock', 'Pieces set aside for a customer order.',
      { dataset: 'stock_pieces', filters: [{ field: 'reserved', op: 'eq', value: 'Yes' }], columns: ['tag', 'item', 'purity', 'location', 'net_weight'] }),
    r('stock-tags-unprinted', 'Tags not printed', 'stock', 'Tagged pieces whose label has never been printed.',
      { dataset: 'stock_pieces', filters: [{ field: 'status', op: 'eq', value: 'in_stock' }, { field: 'label_printed', op: 'eq', value: 'No' }],
        columns: ['tag', 'item', 'purity', 'location', 'net_weight', 'tagged_on'] }),

    /* ------------------------------------------------------------- purchase */
    r('purchase-register', 'Purchase register', 'purchase', 'Everything received from suppliers in the period.',
      { dataset: 'purchases', range: { preset: 'this_month' },
        columns: ['date', 'inward', 'supplier', 'bill', 'item', 'purity', 'net_weight', 'rate', 'making', 'cost', 'billed'] }, { kpis: ['net_weight', 'cost'] }),
    r('purchase-by-supplier', 'Purchases by supplier', 'purchase', 'Weight and value bought from each supplier.',
      { dataset: 'purchases', range: { preset: 'this_fy' }, groupBy: ['supplier'], measures: [count, ...sum('net_weight', 'fine_weight', 'cost')], chart: 'bar' }),
    r('purchase-unbilled', 'Goods received, bill pending', 'purchase', 'Inwards the supplier has not billed yet.',
      { dataset: 'purchases', range: { preset: 'all' }, filters: [{ field: 'billed', op: 'eq', value: 'No' }],
        columns: ['date', 'inward', 'supplier', 'item', 'net_weight', 'cost'], sort: [{ key: 'date', dir: 'asc' }] }),
    r('purchase-bills', 'Supplier bills', 'purchase', 'Every supplier bill with GST and due date.',
      { dataset: 'purchase_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }],
        columns: ['date', 'bill', 'supplier', 'gstin', 'taxable', 'cgst', 'sgst', 'igst', 'total', 'due_date'] }, { kpis: ['taxable', 'gst', 'total'] }),
    r('purchase-fine-owed', 'Gold-for-gold purchases', 'purchase', 'Fine gold owed to suppliers from metal-basis purchases.',
      { dataset: 'purchases', range: { preset: 'this_fy' }, filters: [{ field: 'basis', op: 'eq', value: 'Gold for gold' }], groupBy: ['supplier'], measures: [...sum('net_weight', 'fine_owed')] }),
    { key: 'payables', name: 'Supplier balances', category: 'purchase', description: 'What you owe each supplier, by how old the bill is.', link: { module: 'accounts', tab: 'ageing' } },

    /* ------------------------------------------------------------- old gold */
    r('oldgold-register', 'Old gold register', 'oldgold', 'Every article taken in: weights, tested purity, fine gold, rate and value.',
      { dataset: 'old_gold', range: { preset: 'this_month' },
        columns: ['date', 'voucher', 'customer', 'settlement', 'category', 'gross_weight', 'net_weight', 'purity_percent', 'fine_weight', 'rate', 'value'] },
      { kpis: ['gross_weight', 'fine_weight', 'value'] }),
    r('oldgold-by-type', 'Old gold: exchange vs buyback', 'oldgold', 'How much came in as exchange and how much was bought for cash.',
      { dataset: 'old_gold', range: { preset: 'this_month' }, groupBy: ['settlement'], measures: [count, ...sum('net_weight', 'fine_weight', 'value')], chart: 'donut' }),
    r('oldgold-unmelted', 'Old gold not yet melted', 'oldgold', 'Old gold waiting to go to the refiner.',
      { dataset: 'old_gold', range: { preset: 'all' }, filters: [{ field: 'melted', op: 'eq', value: 'No' }], groupBy: ['metal'], measures: [count, ...sum('net_weight', 'fine_weight', 'value')] }),

    /* --------------------------------------------------------------- orders */
    r('orders-open', 'Open orders', 'orders', 'Orders still running, earliest promise first.',
      { dataset: 'orders', range: { preset: 'all' }, filters: [{ field: 'status', op: 'eq', value: 'active' }],
        columns: ['order', 'customer', 'type', 'stage', 'promised', 'days_late', 'total', 'advance', 'balance'], sort: [{ key: 'promised', dir: 'asc' }] },
      { kpis: ['total', 'advance', 'balance'] }),
    r('orders-late', 'Late orders', 'orders', 'Orders past their promised date.',
      { dataset: 'orders', range: { preset: 'all' }, filters: [{ field: 'late', op: 'eq', value: 'Yes' }],
        columns: ['order', 'customer', 'karigar', 'stage', 'promised', 'days_late', 'balance'], sort: [{ key: 'days_late', dir: 'desc' }] }),
    r('orders-by-status', 'Orders by stage', 'orders', 'How many orders sit at each stage.',
      { dataset: 'orders', range: { preset: 'this_fy' }, groupBy: ['status', 'stage'], measures: [count, ...sum('total', 'balance')] }),
    r('karigar-jobs-out', 'Jobs with karigars', 'orders', 'Work still with karigars, longest out first.',
      { dataset: 'karigar_jobs', range: { preset: 'all' }, filters: [{ field: 'received', op: 'empty' }],
        columns: ['job', 'karigar', 'order', 'date', 'due', 'days_out', 'issued_fine'], sort: [{ key: 'days_out', dir: 'desc' }] }),
    r('karigar-ghat', 'Ghat by karigar', 'orders', 'Fine gold issued and returned, ghat against the allowance, and wages, per karigar.',
      { dataset: 'karigar_jobs', range: { preset: 'this_fy' }, groupBy: ['karigar'], measures: [count, ...sum('issued_fine', 'returned_fine', 'ghat', 'ghat_allowed', 'ghat_excess', 'wages')] }),

    /* -------------------------------------------------------------- schemes */
    r('schemes-collections', 'Savings collected', 'schemes', 'Instalments paid in the period.',
      { dataset: 'scheme_installments', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'paid' }],
        columns: ['paid_on', 'account', 'member', 'plan', 'month', 'amount_paid', 'receipt'] }, { kpis: ['amount_paid'] }),
    r('schemes-due', 'Savings due this month', 'schemes', 'Instalments falling due this month that are not yet paid.',
      { dataset: 'scheme_installments', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'in', value: ['due', 'missed'] }],
        columns: ['due_date', 'account', 'member', 'member_phone', 'plan', 'amount_due', 'days_late'] }, { kpis: ['amount_due'] }),
    r('schemes-defaulters', 'Savings defaulters', 'schemes', 'Members who have missed months.',
      { dataset: 'scheme_accounts', range: { preset: 'all' }, filters: [{ field: 'missed', op: 'gt', value: 0 }, { field: 'status', op: 'in', value: ['active', 'defaulted'] }],
        columns: ['account', 'member', 'member_phone', 'plan', 'paid', 'missed', 'saved'], sort: [{ key: 'missed', dir: 'desc' }] }),
    r('schemes-maturing', 'Savings maturing', 'schemes', 'Accounts maturing in the next three months, and what is owed on each.',
      { dataset: 'scheme_accounts', range: { preset: 'all' }, filters: [{ field: 'status', op: 'in', value: ['active', 'matured'] }],
        columns: ['account', 'member', 'member_phone', 'plan', 'maturity', 'saved', 'bonus', 'owed'], sort: [{ key: 'maturity', dir: 'asc' }] }, { kpis: ['owed'] }),
    r('schemes-by-plan', 'Savings by plan', 'schemes', 'Members, money saved and what is owed, per plan.',
      { dataset: 'scheme_accounts', range: { preset: 'all' }, groupBy: ['plan', 'status'], measures: [count, ...sum('saved', 'bonus', 'owed')] }),

    /* ---------------------------------------------------------------- girvi */
    r('girvi-register', 'Girvi loan register', 'girvi', 'Every loan given in the period.',
      { dataset: 'girvi_loans', range: { preset: 'this_month' },
        columns: ['loan', 'sanctioned', 'borrower', 'phone', 'packet', 'fine_weight', 'appraised', 'principal', 'rate', 'due', 'status'] }, { kpis: ['principal', 'fine_weight'] }),
    r('girvi-outstanding', 'Girvi loans running', 'girvi', 'Every running loan and what is owed on it now.',
      { dataset: 'girvi_loans', range: { preset: 'all' }, filters: [{ field: 'status', op: 'in', value: ['active', 'overdue'] }],
        columns: ['loan', 'borrower', 'phone', 'sanctioned', 'due', 'fine_weight', 'principal', 'interest_charged', 'interest_paid', 'outstanding'] },
      { kpis: ['principal', 'outstanding', 'fine_weight'] }),
    r('girvi-overdue', 'Girvi overdue', 'girvi', 'Loans past their due date, longest first, with notices sent.',
      { dataset: 'girvi_loans', range: { preset: 'all' }, filters: [{ field: 'days_overdue', op: 'gt', value: 0 }],
        columns: ['loan', 'borrower', 'phone', 'due', 'days_overdue', 'notices', 'outstanding', 'fine_weight'], sort: [{ key: 'days_overdue', dir: 'desc' }] }),
    r('girvi-interest', 'Girvi interest received', 'girvi', 'Interest, penalty and charges received, month by month.',
      { dataset: 'girvi_repayments', range: { preset: 'this_fy' }, groupBy: ['date:month'], measures: [count, ...sum('amount', 'interest', 'penalty', 'charges', 'principal')], chart: 'bar' }),

    /* ------------------------------------------------------------ customers */
    r('customers-top', 'Top customers', 'customers', 'Your biggest buyers in the period.',
      { dataset: 'customers', range: { preset: 'this_fy' }, filters: [{ field: 'period_spend', op: 'gt', value: 0 }],
        columns: ['customer', 'phone', 'city', 'period_bills', 'period_spend', 'spend', 'last_bill'], sort: [{ key: 'period_spend', dir: 'desc' }], limit: 50 }),
    r('customers-dormant', 'Customers gone quiet', 'customers', `Customers who have not bought for more than ${s.dormantDays} days — worth a call.`,
      { dataset: 'customers', filters: [{ field: 'days_since', op: 'gt', value: s.dormantDays }],
        columns: ['customer', 'phone', 'city', 'last_bill', 'days_since', 'bills', 'spend'], sort: [{ key: 'spend', dir: 'desc' }] }),
    r('customers-birthdays', 'Birthdays this month', 'customers', 'Customers with a birthday this month.',
      { dataset: 'customers', filters: [{ field: 'birthday_month', op: 'eq', value: '@this_month' }], columns: ['customer', 'phone', 'birthday', 'city', 'spend'] }),
    r('customers-anniversaries', 'Anniversaries this month', 'customers', 'Customers with a wedding anniversary this month.',
      { dataset: 'customers', filters: [{ field: 'anniversary_month', op: 'eq', value: '@this_month' }], columns: ['customer', 'phone', 'anniversary', 'city', 'spend'] }),
    r('customers-owing', 'Customers who owe you', 'customers', 'Every customer with money outstanding.',
      { dataset: 'customers', filters: [{ field: 'owed', op: 'gt', value: 0 }], columns: ['customer', 'phone', 'city', 'owed', 'credit_limit', 'last_bill'], sort: [{ key: 'owed', dir: 'desc' }] },
      { kpis: ['owed'] }),
    r('customers-new', 'New customers', 'customers', 'Customers added in the period and what they have bought.',
      { dataset: 'customers', filters: [{ field: 'joined', op: 'gte', value: '@month_start' }], columns: ['customer', 'phone', 'city', 'joined', 'bills', 'spend'] }),
    r('customers-advances', 'Advances you hold', 'customers', 'Customers whose money you hold as advance or credit.',
      { dataset: 'customers', filters: [{ field: 'advance', op: 'gt', value: 0 }], columns: ['customer', 'phone', 'advance', 'last_bill'], sort: [{ key: 'advance', dir: 'desc' }] }),

    /* ---------------------------------------------------------------- staff */
    r('staff-sales', 'Sales by salesperson', 'staff', 'Bills, weight, value and average bill per salesperson.',
      { dataset: 'sales_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['salesperson'],
        measures: [count, ...sum('net_weight', 'total'), { field: 'total', agg: 'avg' }], compare: true, chart: 'bar' }),
    r('staff-discounts', 'Discounts by salesperson', 'staff', 'How much discount each salesperson gave, and as a % of sales.',
      { dataset: 'sales_bills', range: { preset: 'this_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }], groupBy: ['salesperson'],
        measures: [count, ...sum('taxable', 'discount'), { field: 'discount_percent', agg: 'sum' }] }),

    /* ----------------------------------------------------------- compliance */
    r('compliance-pan', `Bills of ₹${s.highValueBill.toLocaleString('en-IN')} and above (PAN)`, 'compliance', 'High-value bills with the customer’s PAN, as Rule 114B requires.',
      { dataset: 'sales_bills', range: { preset: 'this_fy' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }, { field: 'total', op: 'gte', value: s.highValueBill }],
        columns: ['date', 'bill', 'customer', 'customer_pan', 'total', 'cash_paid'] }),
    r('compliance-cash', 'Cash of ₹2 lakh and above on one bill', 'compliance', 'Bills paid with large cash (section 269ST). The Accounts watchlist also checks across a whole day.',
      { dataset: 'sales_bills', range: { preset: 'this_fy' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }, { field: 'cash_paid', op: 'gte', value: s.cashLimit }],
        columns: ['date', 'bill', 'customer', 'customer_pan', 'cash_paid', 'total'] }),
    r('compliance-b2b', 'GSTR-1: sales to GST-registered buyers (B2B)', 'compliance', 'Bill-wise B2B sales for the return.',
      { dataset: 'sales_bills', range: { preset: 'last_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }, { field: 'b2b', op: 'eq', value: 'B2B' }],
        columns: ['date', 'bill', 'customer', 'taxable', 'gst', 'total'] }),
    r('compliance-b2c', 'GSTR-1: consumer sales (B2C)', 'compliance', 'B2C sales by date for the return.',
      { dataset: 'sales_bills', range: { preset: 'last_month' }, filters: [{ field: 'status', op: 'eq', value: 'posted' }, { field: 'b2b', op: 'eq', value: 'B2C' }],
        groupBy: ['date:day'], measures: [count, ...sum('taxable', 'gst', 'total')] }),
    r('compliance-hsn', 'GSTR-1: HSN summary', 'compliance', 'Quantity, weight, taxable value and tax per HSN code.',
      { dataset: 'sales_lines', range: { preset: 'last_month' }, groupBy: ['hsn'], measures: [count, ...sum('net_weight', 'taxable', 'cgst', 'sgst', 'igst')] }),
    r('compliance-huid-sold', 'Gold sold without HUID', 'compliance', 'Gold lines billed without a hallmark ID.',
      { dataset: 'sales_lines', range: { preset: 'this_month' }, filters: [{ field: 'metal', op: 'eq', value: 'Gold' }, { field: 'kind', op: 'eq', value: 'Goods' }, { field: 'huid', op: 'empty' }],
        columns: ['date', 'bill', 'item', 'purity', 'net_weight', 'taxable'] }),

    /* ------------------------------------------------------------- accounts */
    ...([
      ['acc-pnl', 'Profit & loss', 'pnl', 'Gross and net profit, and where the margin came from.'],
      ['acc-bs', 'Balance sheet', 'balance-sheet', 'What the business owns and owes on any date.'],
      ['acc-tb', 'Trial balance', 'report-group', 'Every ledger’s opening, movement and closing.'],
      ['acc-gst', 'GST summary', 'gst', 'Output and input GST, net payable and HSN.'],
      ['acc-ageing', 'Receivables & payables ageing', 'ageing', 'Who owes and whom you owe, by age.'],
      ['acc-daybook', 'Day book', 'daybook', 'Every entry from every module.'],
      ['acc-cash', 'Cash day close', 'day-close', 'The drawer: expected, counted, short or excess.'],
      ['acc-metal', 'Metal position', 'metal-position', 'Gold held, owed and net.'],
      ['acc-forecast', 'Cash forecast', 'forecast', 'What comes in and goes out over the next weeks.'],
      ['acc-statement', 'Ledger & party statements', 'report-account', 'Any ledger, customer or supplier with a running balance.'],
    ] as const).map(([key, name, tab, description]) => ({ key, name, category: 'accounts', description, link: { module: 'accounts', tab } })),
  ];
}
