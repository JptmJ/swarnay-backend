/**
 * The shop's data, arranged for reporting.
 *
 * Each data set is one kind of row — a bill line, a stock piece, a girvi loan —
 * with everything a jeweller would want beside it already joined in: the
 * branch, the salesperson, the customer's city, the item's category and purity.
 * A report is then any choice of columns, filters, groupings and totals over
 * one data set, run in the database.
 *
 * Every SQL fragment here is fixed in code. Nothing a user types is ever put
 * into SQL: the engine only picks fields by key and passes values as
 * parameters. Tokens like {{from}}, {{to}}, {{today}} and {{rate_basis}} are
 * replaced with parameters by the engine.
 */

export type FieldType = 'text' | 'int' | 'number' | 'money' | 'weight' | 'percent' | 'date' | 'datetime' | 'bool';
export type Picker = 'branch' | 'metal' | 'purity' | 'category' | 'item' | 'staff' | 'customer' | 'supplier' | 'karigar'
  | 'location' | 'payment_method' | 'account' | 'scheme_plan' | 'enum' | 'text';
export type Agg = 'sum' | 'count' | 'avg' | 'min' | 'max' | 'count_distinct';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  sql: string;
  /** Can be grouped by (a dimension). Text, dates, bools and small numbers are. */
  dim?: boolean;
  /** Default aggregation when used as a measure. Numbers default to sum. */
  agg?: Agg;
  /** A percentage that must be worked out from two totals, never summed. */
  ratio?: { num: string; den: string; scale?: number };
  /** Cost and margin need their own permission. */
  sensitive?: 'cost';
  picker?: Picker;
  options?: string[];
  description?: string;
}

export interface DatasetDef {
  key: string;
  label: string;
  description: string;
  /** Reports category, which decides the permission. */
  category: string;
  with?: string;
  from: string;
  where?: string;
  /** The field key the date range applies to. */
  dateField?: string;
  /** 'within' = between from and to; 'upto' = everything up to `to` (balances); 'none' = no date range. */
  dateMode?: 'within' | 'upto' | 'none';
  /** A faster date condition than the date field itself, one an index can use. */
  dateWhere?: { within: string; upto: string };
  branchSql?: string;
  fields: FieldDef[];
  defaultColumns: string[];
  defaultSort?: { key: string; dir: 'asc' | 'desc' };
}

const money = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'money', sql, ...extra });
const weight = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'weight', sql, ...extra });
const text = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'text', sql, dim: true, ...extra });
const date = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'date', sql, dim: true, ...extra });
const int = (key: string, label: string, sql: string, extra: Partial<FieldDef> = {}): FieldDef => ({ key, label, type: 'int', sql, ...extra });

/** The parts of a jeweller's row that repeat across data sets. */
const branch = (alias: string) => text('branch', 'Branch', `${alias}.name`, { picker: 'branch' });
const productFields = (i: string, c: string, m: string, pu: string): FieldDef[] => [
  text('item', 'Item', `${i}.name`, { picker: 'item' }),
  text('category', 'Category', `coalesce(${c}.name, 'Uncategorised')`, { picker: 'category' }),
  text('metal', 'Metal', `${m}.name`, { picker: 'metal' }),
  text('purity', 'Purity', `${pu}.code`, { picker: 'purity' }),
];

/** Pure (fine) rate per metal on a day, buying or selling, for stock at today's rate. */
const PURE_RATE = `pure_rate as (
  select distinct on (r.metal_id) r.metal_id,
         round((case when {{rate_basis}} = 'buying' then coalesce(r.buying_rate_per_gram, r.rate_per_gram) else r.rate_per_gram end)
               * 100 / coalesce(nullif(rp.fineness_percent, 0), 100), 2) as rate
    from metal_rate r left join purity rp on rp.id = r.purity_id
   where r.effective_from < ({{today}}::date + 1)
   order by r.metal_id, coalesce(rp.fineness_percent, 100) desc, r.effective_from desc)`;

export const DATASETS: DatasetDef[] = [
  /* ------------------------------------------------------------------ sales */
  {
    key: 'sales_lines', label: 'Sales — line by line', category: 'sales',
    description: 'Every item sold on a posted bill, with the bill, customer, salesperson, item, purity, weights, value parts, GST, cost and margin.',
    from: `sales_invoice_line l
      join sales_invoice s on s.id = l.sales_invoice_id and s.status = 'posted'
      join branch b on b.id = s.branch_id
      join party p on p.id = s.customer_id
      join item i on i.id = l.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = l.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)
      left join app_user u on u.id = s.salesperson_id
      left join stock_piece sp on sp.id = l.piece_id`,
    dateField: 'date', branchSql: 's.branch_id',
    fields: [
      text('bill', 'Bill', 's.doc_number'),
      date('date', 'Date', 's.doc_date'),
      branch('b'),
      text('salesperson', 'Salesperson', `coalesce(u.full_name, 'Not recorded')`, { picker: 'staff' }),
      text('customer', 'Customer', 'p.name', { picker: 'customer' }),
      text('customer_city', 'Customer city', `coalesce(p.city, '')`),
      text('channel', 'Channel', 's.channel', { picker: 'enum', options: ['counter', 'wholesale', 'export', 'online'] }),
      ...productFields('i', 'c', 'm', 'pu'),
      text('kind', 'Goods or labour', `case when i.nature = 'service' then 'Labour' else 'Goods' end`, { picker: 'enum', options: ['Goods', 'Labour'] }),
      text('tag', 'Tag', `coalesce(sp.tag_number, '')`),
      text('huid', 'HUID', `coalesce(sp.huid, '')`),
      text('hsn', 'HSN', `coalesce(l.hsn_code, '')`),
      int('pieces', 'Pieces', `case when l.piece_id is not null then 1 else 0 end`),
      weight('gross_weight', 'Gross weight', 'l.gross_weight'),
      weight('net_weight', 'Net weight', 'l.net_weight'),
      weight('fine_weight', 'Fine weight', 'l.fine_weight'),
      money('rate', 'Rate / g', 'l.rate_per_gram', { agg: 'avg' }),
      money('metal_value', 'Metal value', 'l.metal_amount'),
      money('making', 'Making', 'l.making_amount'),
      weight('wastage_weight', 'Wastage weight', 'l.wastage_weight'),
      money('wastage', 'Wastage value', 'l.wastage_amount'),
      money('stones', 'Stones', 'l.stone_amount'),
      money('hallmark', 'Hallmarking', 'l.hallmark_charge'),
      money('discount', 'Discount', 'l.discount_amount'),
      money('taxable', 'Taxable value', 'l.taxable_amount'),
      money('cgst', 'CGST', 'l.cgst_amount'), money('sgst', 'SGST', 'l.sgst_amount'), money('igst', 'IGST', 'l.igst_amount'),
      money('gst', 'GST', 'l.cgst_amount + l.sgst_amount + l.igst_amount'),
      money('line_total', 'Line total', 'l.line_total'),
      money('cost', 'Cost', 'l.cost_value', { sensitive: 'cost' }),
      money('margin', 'Margin', 'l.taxable_amount - l.cost_value', { sensitive: 'cost' }),
      { key: 'margin_percent', label: 'Margin %', type: 'percent', sql: `case when l.taxable_amount > 0 then (l.taxable_amount - l.cost_value) * 100 / l.taxable_amount end`,
        ratio: { num: 'l.taxable_amount - l.cost_value', den: 'l.taxable_amount', scale: 100 }, sensitive: 'cost' },
      weight('returned_weight', 'Returned weight', 'l.returned_net_weight'),
    ],
    defaultColumns: ['date', 'bill', 'customer', 'item', 'purity', 'net_weight', 'taxable', 'gst', 'line_total'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
  {
    key: 'sales_bills', label: 'Sales — bill by bill', category: 'sales',
    description: 'One row per bill: totals, payment, what was settled by old gold or savings, what is still owed, and when in the day it was made.',
    from: `sales_invoice s
      join branch b on b.id = s.branch_id
      join party p on p.id = s.customer_id
      left join app_user u on u.id = s.salesperson_id`,
    dateField: 'date', branchSql: 's.branch_id',
    fields: [
      text('bill', 'Bill', 's.doc_number'),
      date('date', 'Date', 's.doc_date'),
      { key: 'hour', label: 'Hour of day', type: 'int', sql: `extract(hour from s.posted_at at time zone {{tz}})::int`, dim: true },
      text('weekday', 'Day of week', `trim(to_char(s.doc_date, 'Day'))`),
      text('status', 'Status', 's.status', { picker: 'enum', options: ['posted', 'cancelled'] }),
      branch('b'),
      text('salesperson', 'Salesperson', `coalesce(u.full_name, 'Not recorded')`, { picker: 'staff' }),
      text('customer', 'Customer', 'p.name', { picker: 'customer' }),
      text('customer_phone', 'Phone', `coalesce(p.phone, '')`),
      text('customer_city', 'Customer city', `coalesce(p.city, '')`),
      text('customer_pan', 'PAN', `coalesce(p.pan, '')`),
      text('b2b', 'B2B / B2C', `case when coalesce(p.gstin, '') <> '' then 'B2B' else 'B2C' end`, { picker: 'enum', options: ['B2B', 'B2C'] }),
      text('channel', 'Channel', 's.channel', { picker: 'enum', options: ['counter', 'wholesale', 'export', 'online'] }),
      int('lines', 'Lines', '(select count(*) from sales_invoice_line x where x.sales_invoice_id = s.id)'),
      weight('gross_weight', 'Gross weight', 's.total_gross_weight'),
      weight('net_weight', 'Net weight', 's.total_net_weight'),
      weight('fine_weight', 'Fine weight', 's.total_fine_weight'),
      money('discount', 'Discount', 's.discount_amount'),
      money('taxable', 'Taxable value', 's.taxable_amount'),
      money('gst', 'GST', 's.cgst_amount + s.sgst_amount + s.igst_amount'),
      money('round_off', 'Round off', 's.round_off'),
      money('total', 'Bill total', 's.total_amount'),
      money('paid', 'Paid', 's.paid_amount'),
      money('old_gold', 'Old gold used', 's.old_gold_amount'),
      money('savings', 'Savings used', 's.scheme_amount'),
      money('balance', 'Still owed', 's.balance_amount'),
      { key: 'discount_percent', label: 'Discount %', type: 'percent', sql: `case when s.taxable_amount + s.discount_amount > 0 then s.discount_amount * 100 / (s.taxable_amount + s.discount_amount) end`,
        ratio: { num: 's.discount_amount', den: 's.taxable_amount + s.discount_amount', scale: 100 } },
      { key: 'cash_paid', label: 'Paid in cash', type: 'money', sql: `(select coalesce(sum(sp.amount), 0) from sales_payment sp left join payment_method pm on pm.id = sp.payment_method_id
                                                            where sp.sales_invoice_id = s.id and coalesce(pm.kind, sp.mode) = 'cash')` },
    ],
    defaultColumns: ['date', 'bill', 'customer', 'salesperson', 'net_weight', 'taxable', 'gst', 'total', 'balance'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
  {
    key: 'sales_payments', label: 'Sales — payments taken', category: 'sales',
    description: 'Every payment on every bill, by payment mode — cash, card, UPI, bank, old gold, savings, advance.',
    from: `sales_payment sp
      join sales_invoice s on s.id = sp.sales_invoice_id and s.status = 'posted'
      join branch b on b.id = s.branch_id
      join party p on p.id = s.customer_id
      left join payment_method pm on pm.id = sp.payment_method_id`,
    dateField: 'date', branchSql: 's.branch_id',
    fields: [
      date('date', 'Date', 's.doc_date'),
      text('bill', 'Bill', 's.doc_number'),
      branch('b'),
      text('customer', 'Customer', 'p.name', { picker: 'customer' }),
      text('mode', 'Payment mode', `coalesce(pm.name, sp.mode)`, { picker: 'payment_method' }),
      text('mode_kind', 'Kind', `coalesce(pm.kind, sp.mode)`, { picker: 'enum', options: ['cash', 'card', 'upi', 'bank', 'cheque', 'wallet', 'advance', 'old_gold', 'scheme', 'credit'] }),
      text('reference', 'Reference', `coalesce(sp.reference, '')`),
      money('amount', 'Amount', 'sp.amount'),
    ],
    defaultColumns: ['date', 'bill', 'customer', 'mode', 'reference', 'amount'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
  {
    key: 'sales_returns', label: 'Sales — returns', category: 'sales',
    description: 'Goods customers brought back: what, from which bill, why, and whether it was refunded or kept as credit.',
    from: `sales_return_line rl
      join sales_return r on r.id = rl.sales_return_id and r.status = 'posted'
      join sales_invoice s on s.id = r.sales_invoice_id
      join branch b on b.id = r.branch_id
      join party p on p.id = r.customer_id
      join item i on i.id = rl.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = rl.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)`,
    dateField: 'date', branchSql: 'r.branch_id',
    fields: [
      date('date', 'Date', 'r.doc_date'),
      text('return_no', 'Return', 'r.doc_number'),
      text('bill', 'Original bill', 's.doc_number'),
      branch('b'),
      text('customer', 'Customer', 'p.name', { picker: 'customer' }),
      ...productFields('i', 'c', 'm', 'pu'),
      text('reason', 'Reason', `coalesce(r.reason, '')`),
      text('settlement', 'Settled as', 'r.settlement', { picker: 'enum', options: ['refund', 'credit_note'] }),
      weight('net_weight', 'Net weight', 'rl.net_weight'),
      weight('fine_weight', 'Fine weight', 'rl.fine_weight'),
      money('taxable', 'Taxable value', 'rl.taxable_amount'),
      money('value', 'Value', 'rl.line_total'),
      money('cost', 'Cost', 'rl.cost_value', { sensitive: 'cost' }),
    ],
    defaultColumns: ['date', 'return_no', 'bill', 'customer', 'item', 'net_weight', 'value', 'settlement'],
    defaultSort: { key: 'date', dir: 'desc' },
  },

  /* ------------------------------------------------------------------ stock */
  {
    key: 'stock_pieces', label: 'Stock — tagged pieces', category: 'stock',
    description: 'Every tagged piece with its weights, cost, how long it has been in stock, and what it is worth at today’s rate.',
    with: PURE_RATE,
    from: `stock_piece sp
      join stock_location lo on lo.id = sp.location_id
      join branch b on b.id = lo.branch_id
      join item i on i.id = sp.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = sp.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)
      left join party sup on sup.id = sp.supplier_id
      left join pure_rate pr on pr.metal_id = m.id`,
    dateField: 'tagged_on', dateMode: 'none', branchSql: 'lo.branch_id',
    fields: [
      text('tag', 'Tag', 'sp.tag_number'),
      text('huid', 'HUID', `coalesce(sp.huid, '')`),
      text('has_huid', 'Hallmarked', `case when coalesce(sp.huid, '') <> '' then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      text('status', 'Status', 'sp.status', { picker: 'enum', options: ['in_stock', 'in_transit', 'on_approval', 'reserved', 'sold', 'written_off', 'melted'] }),
      branch('b'),
      text('location', 'Location', 'lo.name', { picker: 'location' }),
      ...productFields('i', 'c', 'm', 'pu'),
      text('supplier', 'Supplier', `coalesce(sup.name, '')`, { picker: 'supplier' }),
      date('tagged_on', 'Tagged on', `coalesce(sp.received_at, sp.created_at)::date`),
      int('days_in_stock', 'Days in stock', `({{today}}::date - coalesce(sp.received_at, sp.created_at)::date)`, { agg: 'avg' }),
      text('age_band', 'Age', `case when {{today}}::date - coalesce(sp.received_at, sp.created_at)::date <= 30 then '0–30 days'
                                     when {{today}}::date - coalesce(sp.received_at, sp.created_at)::date <= 90 then '31–90 days'
                                     when {{today}}::date - coalesce(sp.received_at, sp.created_at)::date <= 180 then '91–180 days'
                                     when {{today}}::date - coalesce(sp.received_at, sp.created_at)::date <= 365 then '181–365 days' else 'Over a year' end`),
      int('pieces', 'Pieces', '1'),
      weight('gross_weight', 'Gross weight', 'sp.gross_weight'),
      weight('stone_weight', 'Stone weight', 'sp.stone_weight'),
      weight('net_weight', 'Net weight', 'sp.net_weight'),
      weight('fine_weight', 'Fine weight', 'sp.fine_weight'),
      money('cost', 'Cost', 'sp.cost_value', { sensitive: 'cost' }),
      money('metal_value_today', 'Metal value today', 'round(sp.fine_weight * coalesce(pr.rate, 0), 2)'),
      text('label_printed', 'Tag printed', `case when sp.label_printed_at is not null then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      text('reserved', 'Booked for an order', `case when sp.reserved_order_id is not null then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
    ],
    defaultColumns: ['tag', 'item', 'category', 'purity', 'location', 'net_weight', 'fine_weight', 'days_in_stock', 'metal_value_today'],
    defaultSort: { key: 'days_in_stock', dir: 'desc' },
  },
  {
    key: 'stock_balances', label: 'Stock — balances by item and location', category: 'stock',
    description: 'What is in stock now for every item, purity and location: pieces, weights and value at cost — lots by weight and tagged pieces alike.',
    with: PURE_RATE,
    from: `stock_balance sb
      join stock_location lo on lo.id = sb.location_id
      join branch b on b.id = lo.branch_id
      join item i on i.id = sb.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = sb.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)
      left join pure_rate pr on pr.metal_id = m.id`,
    where: '(sb.net_weight <> 0 or sb.quantity <> 0)',
    dateMode: 'none', branchSql: 'lo.branch_id',
    fields: [
      branch('b'),
      text('location', 'Location', 'lo.name', { picker: 'location' }),
      text('location_kind', 'Location kind', 'lo.kind'),
      ...productFields('i', 'c', 'm', 'pu'),
      text('tracking', 'Kept as', `case when i.tracking = 'piece' then 'Tagged pieces' else 'By weight' end`, { picker: 'enum', options: ['Tagged pieces', 'By weight'] }),
      int('pieces', 'Pieces', 'sb.quantity'),
      weight('gross_weight', 'Gross weight', 'sb.gross_weight'),
      weight('net_weight', 'Net weight', 'sb.net_weight'),
      weight('fine_weight', 'Fine weight', 'sb.fine_weight'),
      money('value', 'Value at cost', 'sb.value', { sensitive: 'cost' }),
      money('metal_value_today', 'Metal value today', 'round(sb.fine_weight * coalesce(pr.rate, 0), 2)'),
      { key: 'last_movement', label: 'Last moved', type: 'date', sql: 'sb.last_movement_at::date', dim: true },
    ],
    defaultColumns: ['item', 'purity', 'location', 'pieces', 'net_weight', 'fine_weight', 'value'],
    defaultSort: { key: 'net_weight', dir: 'desc' },
  },
  {
    key: 'stock_movements', label: 'Stock — every movement', category: 'stock',
    description: 'Every gram in and out: purchases, sales, returns, transfers, karigar, old gold, adjustments and counts.',
    from: `stock_movement sm
      join stock_location lo on lo.id = sm.location_id
      join branch b on b.id = lo.branch_id
      join item i on i.id = sm.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = sm.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)`,
    dateField: 'date', branchSql: 'lo.branch_id',
    dateWhere: {
      within: "sm.moved_at >= ({{from}}::date)::timestamp at time zone {{tz}} and sm.moved_at < ({{to}}::date + 1)::timestamp at time zone {{tz}}",
      upto: "sm.moved_at < ({{to}}::date + 1)::timestamp at time zone {{tz}}",
    },
    fields: [
      { key: 'date', label: 'Date', type: 'date', sql: `(sm.moved_at at time zone {{tz}})::date`, dim: true },
      text('direction', 'In / out', `case when sm.direction = 'in' then 'In' else 'Out' end`, { picker: 'enum', options: ['In', 'Out'] }),
      text('reason', 'Why', `replace(sm.reason, '_', ' ')`, { picker: 'enum', options: ['opening', 'purchase', 'purchase return', 'sale', 'sales return', 'transfer out', 'transfer in', 'production issue', 'production receipt', 'old gold intake', 'melting', 'refining', 'adjustment', 'memo out', 'memo in', 'metal payment'] }),
      branch('b'),
      text('location', 'Location', 'lo.name', { picker: 'location' }),
      ...productFields('i', 'c', 'm', 'pu'),
      text('note', 'Note', `coalesce(sm.note, '')`),
      int('pieces_in', 'Pieces in', `case when sm.direction = 'in' then sm.quantity::int else 0 end`),
      int('pieces_out', 'Pieces out', `case when sm.direction = 'out' then sm.quantity::int else 0 end`),
      weight('net_in', 'Net in', `case when sm.direction = 'in' then sm.net_weight else 0 end`),
      weight('net_out', 'Net out', `case when sm.direction = 'out' then sm.net_weight else 0 end`),
      weight('net_change', 'Net change', `case when sm.direction = 'in' then sm.net_weight else -sm.net_weight end`),
      weight('fine_change', 'Fine change', `case when sm.direction = 'in' then sm.fine_weight else -sm.fine_weight end`),
      money('value_change', 'Value change', `case when sm.direction = 'in' then sm.value else -sm.value end`, { sensitive: 'cost' }),
    ],
    defaultColumns: ['date', 'direction', 'reason', 'item', 'purity', 'location', 'net_in', 'net_out', 'note'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
  {
    key: 'stock_position', label: 'Stock — opening, in, out, closing', category: 'stock',
    description: 'For any period: what each item opened with, what came in, what went out and what it closed at, in pieces and grams.',
    from: `stock_movement sm
      join stock_location lo on lo.id = sm.location_id
      join branch b on b.id = lo.branch_id
      join item i on i.id = sm.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = sm.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)`,
    dateField: 'date', dateMode: 'upto', branchSql: 'lo.branch_id',
    dateWhere: {
      within: "sm.moved_at >= ({{from}}::date)::timestamp at time zone {{tz}} and sm.moved_at < ({{to}}::date + 1)::timestamp at time zone {{tz}}",
      upto: "sm.moved_at < ({{to}}::date + 1)::timestamp at time zone {{tz}}",
    },
    fields: [
      { key: 'date', label: 'Date', type: 'date', sql: `(sm.moved_at at time zone {{tz}})::date`, dim: true },
      branch('b'),
      text('location', 'Location', 'lo.name', { picker: 'location' }),
      ...productFields('i', 'c', 'm', 'pu'),
      weight('opening', 'Opening net', `case when (sm.moved_at at time zone {{tz}})::date < {{from}}::date then (case when sm.direction = 'in' then sm.net_weight else -sm.net_weight end) else 0 end`),
      weight('in', 'In', `case when (sm.moved_at at time zone {{tz}})::date >= {{from}}::date and sm.direction = 'in' then sm.net_weight else 0 end`),
      weight('out', 'Out', `case when (sm.moved_at at time zone {{tz}})::date >= {{from}}::date and sm.direction = 'out' then sm.net_weight else 0 end`),
      weight('closing', 'Closing net', `case when sm.direction = 'in' then sm.net_weight else -sm.net_weight end`),
      weight('closing_fine', 'Closing fine', `case when sm.direction = 'in' then sm.fine_weight else -sm.fine_weight end`),
      int('opening_pieces', 'Opening pieces', `case when i.tracking = 'piece' and (sm.moved_at at time zone {{tz}})::date < {{from}}::date then (case when sm.direction = 'in' then 1 else -1 end) * sm.quantity::int else 0 end`),
      int('closing_pieces', 'Closing pieces', `case when i.tracking = 'piece' then (case when sm.direction = 'in' then 1 else -1 end) * sm.quantity::int else 0 end`),
      money('closing_value', 'Closing value', `case when sm.direction = 'in' then sm.value else -sm.value end`, { sensitive: 'cost' }),
    ],
    defaultColumns: ['item', 'purity', 'opening', 'in', 'out', 'closing'],
    defaultSort: { key: 'closing', dir: 'desc' },
  },

  /* --------------------------------------------------------------- purchase */
  {
    key: 'purchases', label: 'Purchase — goods received', category: 'purchase',
    description: 'Every line received from suppliers: weights, rate, making, cost, gold owed, and whether the bill has come.',
    from: `goods_receipt_line gl
      join goods_receipt g on g.id = gl.goods_receipt_id and g.status = 'posted'
      join branch b on b.id = g.branch_id
      join party sup on sup.id = g.supplier_id
      join item i on i.id = gl.item_id
      left join item_category c on c.id = i.category_id
      left join purity pu on pu.id = gl.purity_id
      left join metal m on m.id = coalesce(pu.metal_id, i.metal_id)
      left join purchase_invoice pi on pi.id = g.purchase_invoice_id`,
    dateField: 'date', branchSql: 'g.branch_id',
    fields: [
      date('date', 'Date', 'g.doc_date'),
      text('inward', 'Inward', 'g.doc_number'),
      text('bill', 'Supplier bill', `coalesce(pi.supplier_invoice_number, '')`),
      text('billed', 'Billed', `case when g.purchase_invoice_id is not null then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      text('direct', 'Direct purchase', `case when g.is_direct then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      branch('b'),
      text('supplier', 'Supplier', 'sup.name', { picker: 'supplier' }),
      ...productFields('i', 'c', 'm', 'pu'),
      text('basis', 'Bought on', `case when gl.metal_basis = 'fine' then 'Gold for gold' else 'Rupees' end`),
      int('pieces', 'Pieces', 'gl.quantity::int'),
      weight('gross_weight', 'Gross weight', 'gl.gross_weight'),
      weight('net_weight', 'Net weight', 'gl.net_weight'),
      weight('fine_weight', 'Fine weight', 'gl.fine_weight'),
      money('rate', 'Rate / g', 'gl.rate_per_gram', { agg: 'avg' }),
      money('making', 'Making', 'gl.making_amount'),
      weight('fine_owed', 'Fine gold owed', 'gl.fine_owed'),
      money('cost', 'Cost', 'gl.cost_value', { sensitive: 'cost' }),
    ],
    defaultColumns: ['date', 'inward', 'supplier', 'item', 'purity', 'net_weight', 'rate', 'cost', 'billed'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
  {
    key: 'purchase_bills', label: 'Purchase — supplier bills', category: 'purchase',
    description: 'Every supplier bill with its GST, total and due date.',
    from: `purchase_invoice pi
      join branch b on b.id = pi.branch_id
      join party sup on sup.id = pi.supplier_id`,
    dateField: 'date', branchSql: 'pi.branch_id',
    fields: [
      date('date', 'Bill date', 'pi.supplier_invoice_date'),
      date('entered_on', 'Entered on', 'pi.doc_date'),
      text('doc', 'Our number', 'pi.doc_number'),
      text('bill', 'Their bill', `coalesce(pi.supplier_invoice_number, '')`),
      text('status', 'Status', 'pi.status', { picker: 'enum', options: ['posted', 'cancelled'] }),
      branch('b'),
      text('supplier', 'Supplier', 'sup.name', { picker: 'supplier' }),
      text('gstin', 'Supplier GSTIN', `coalesce(sup.gstin, '')`),
      date('due_date', 'Due', 'pi.due_date'),
      money('taxable', 'Taxable value', 'pi.taxable_amount'),
      money('cgst', 'CGST', 'pi.cgst_amount'), money('sgst', 'SGST', 'pi.sgst_amount'), money('igst', 'IGST', 'pi.igst_amount'),
      money('gst', 'GST', 'pi.cgst_amount + pi.sgst_amount + pi.igst_amount'),
      money('total', 'Total', 'pi.total_amount'),
    ],
    defaultColumns: ['date', 'bill', 'supplier', 'taxable', 'gst', 'total', 'due_date'],
    defaultSort: { key: 'date', dir: 'desc' },
  },

  /* --------------------------------------------------------------- old gold */
  {
    key: 'old_gold', label: 'Old gold — taken in', category: 'oldgold',
    description: 'Every old-gold article taken in: weights before and after deductions, tested purity, fine gold, rate and value.',
    from: `old_gold_item og
      join old_gold_intake oi on oi.id = og.old_gold_intake_id and oi.status <> 'cancelled'
      join branch b on b.id = oi.branch_id
      left join party p on p.id = oi.customer_id
      left join metal m on m.id = og.metal_id
      left join item_category c on c.id = og.item_category_id`,
    dateField: 'date', branchSql: 'oi.branch_id',
    fields: [
      date('date', 'Date', 'oi.voucher_date'),
      text('voucher', 'Voucher', 'oi.voucher_number'),
      branch('b'),
      text('customer', 'Customer', `coalesce(p.name, 'Walk-in')`, { picker: 'customer' }),
      text('settlement', 'Taken as', `replace(oi.settlement_type, '_', ' ')`),
      text('channel', 'Where', `coalesce(oi.channel, '')`),
      text('metal', 'Metal', `coalesce(m.name, '')`, { picker: 'metal' }),
      text('category', 'Article', `coalesce(c.name, og.description)`),
      text('test', 'Tested by', `coalesce(og.test_method, '')`),
      text('melted', 'Melted', `case when og.melt_batch_id is not null then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      weight('gross_weight', 'Gross weight', 'og.gross_weight'),
      weight('stone_weight', 'Stone weight', 'og.stone_weight'),
      weight('dirt_weight', 'Dirt', 'og.dirt_weight'),
      weight('net_weight', 'Net weight', 'og.net_weight'),
      { key: 'purity_percent', label: 'Tested purity %', type: 'percent', sql: 'og.tested_purity_percent', agg: 'avg' },
      weight('loss_weight', 'Loss allowed', 'og.loss_weight'),
      weight('fine_weight', 'Fine weight', 'og.fine_weight'),
      money('rate', 'Rate / g', 'og.rate_per_gram', { agg: 'avg' }),
      money('value', 'Value', 'og.value'),
    ],
    defaultColumns: ['date', 'voucher', 'customer', 'category', 'gross_weight', 'purity_percent', 'fine_weight', 'value'],
    defaultSort: { key: 'date', dir: 'desc' },
  },

  /* ---------------------------------------------------------------- orders */
  {
    key: 'orders', label: 'Orders', category: 'orders',
    description: 'Customer orders and repairs: status, promised date, how late, what is paid and what is still due.',
    from: `retail_order o
      join branch b on b.id = o.branch_id
      join party p on p.id = o.customer_id
      left join app_user u on u.id = o.salesperson_id
      left join karigar k on k.id = o.karigar_id`,
    dateField: 'date', branchSql: 'o.branch_id',
    fields: [
      date('date', 'Ordered on', 'o.order_date'),
      text('order', 'Order', 'o.order_number'),
      text('type', 'Type', `replace(o.order_type, '_', ' ')`),
      text('status', 'Status', 'o.status', { picker: 'enum', options: ['draft', 'active', 'completed', 'cancelled'] }),
      text('stage', 'Stage', `coalesce(o.stage, '')`),
      text('production', 'Production', `coalesce(o.production_status, '')`),
      branch('b'),
      text('customer', 'Customer', 'p.name', { picker: 'customer' }),
      text('salesperson', 'Salesperson', `coalesce(u.full_name, '')`, { picker: 'staff' }),
      text('karigar', 'Karigar', `coalesce(k.name, '')`, { picker: 'karigar' }),
      text('rate_lock', 'Rate', `replace(o.rate_lock_type, '_', ' ')`),
      date('promised', 'Promised for', 'o.expected_delivery_date'),
      date('delivered', 'Delivered', 'o.delivered_at::date'),
      int('days_late', 'Days late', `case when o.status = 'active' and o.expected_delivery_date < {{today}}::date then {{today}}::date - o.expected_delivery_date else 0 end`, { agg: 'max' }),
      text('late', 'Late', `case when o.status = 'active' and o.expected_delivery_date < {{today}}::date then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      weight('net_weight', 'Net weight', 'o.total_net_weight'),
      money('total', 'Order value', 'o.total_amount'),
      money('advance', 'Advance', 'o.advance_amount'),
      money('balance', 'Balance due', 'o.balance_amount'),
    ],
    defaultColumns: ['date', 'order', 'customer', 'status', 'promised', 'days_late', 'total', 'advance', 'balance'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
  {
    key: 'karigar_jobs', label: 'Karigar jobs', category: 'orders',
    description: 'Metal issued to each karigar, what came back, the ghat against the allowance, and wages.',
    from: `karigar_job j
      join karigar k on k.id = j.karigar_id
      join branch b on b.id = j.branch_id
      left join retail_order o on o.id = j.retail_order_id
      left join metal m on m.id = j.metal_id
      left join purity pu on pu.id = j.purity_id`,
    dateField: 'date', branchSql: 'j.branch_id',
    fields: [
      date('date', 'Issued on', 'j.issued_on'),
      text('job', 'Job', 'j.job_number'),
      text('karigar', 'Karigar', 'k.name', { picker: 'karigar' }),
      text('status', 'Status', 'j.status'),
      text('order', 'Order', `coalesce(o.order_number, '')`),
      branch('b'),
      text('metal', 'Metal', `coalesce(m.name, '')`, { picker: 'metal' }),
      text('purity', 'Purity', `coalesce(pu.code, '')`, { picker: 'purity' }),
      date('due', 'Due back', 'j.due_date'),
      date('received', 'Received', 'j.received_on'),
      int('days_out', 'Days out', `coalesce(j.received_on, {{today}}::date) - j.issued_on`, { agg: 'avg' }),
      weight('issued_fine', 'Fine issued', 'j.issued_fine_weight'),
      weight('returned_fine', 'Fine back', 'coalesce(j.received_fine_weight, 0)'),
      weight('ghat', 'Ghat', 'coalesce(j.ghat_actual_fine, 0)'),
      weight('ghat_allowed', 'Ghat allowed', 'coalesce(j.ghat_allowed_fine, 0)'),
      weight('ghat_excess', 'Ghat over allowance', 'coalesce(j.ghat_excess_fine, 0)'),
      money('wages', 'Wages', 'coalesce(j.labour_amount, 0)'),
    ],
    defaultColumns: ['date', 'job', 'karigar', 'status', 'issued_fine', 'returned_fine', 'ghat', 'ghat_excess', 'wages'],
    defaultSort: { key: 'date', dir: 'desc' },
  },

  /* --------------------------------------------------------------- schemes */
  {
    key: 'scheme_installments', label: 'Gold savings — instalments', category: 'schemes',
    description: 'Every month of every savings account: due, paid, missed or waived, and how late.',
    from: `scheme_installment si
      join scheme_account a on a.id = si.scheme_account_id
      join scheme_plan pl on pl.id = a.scheme_plan_id
      join party p on p.id = a.customer_id
      join branch b on b.id = a.branch_id`,
    dateField: 'due_date', branchSql: 'a.branch_id',
    fields: [
      date('due_date', 'Due', 'si.due_date'),
      date('paid_on', 'Paid on', 'si.paid_on'),
      text('account', 'Account', 'a.account_number'),
      text('plan', 'Plan', 'pl.name', { picker: 'scheme_plan' }),
      text('member', 'Member', 'p.name', { picker: 'customer' }),
      text('member_phone', 'Phone', `coalesce(p.phone, '')`),
      branch('b'),
      text('status', 'Status', 'si.status', { picker: 'enum', options: ['due', 'paid', 'missed', 'waived', 'advance'] }),
      int('month', 'Month no.', 'si.installment_number', { dim: true, agg: 'max' }),
      int('days_late', 'Days late', `case when si.status in ('due', 'missed') and si.due_date < {{today}}::date then {{today}}::date - si.due_date else 0 end`, { agg: 'max' }),
      money('amount_due', 'Due amount', 'si.amount_due'),
      money('amount_paid', 'Paid', 'si.amount_paid'),
      weight('weight', 'Gold bought', 'si.weight_accrued'),
      text('receipt', 'Receipt', `coalesce(si.receipt_number, '')`),
    ],
    defaultColumns: ['due_date', 'account', 'member', 'plan', 'status', 'amount_due', 'amount_paid', 'days_late'],
    defaultSort: { key: 'due_date', dir: 'asc' },
  },
  {
    key: 'scheme_accounts', label: 'Gold savings — accounts', category: 'schemes',
    description: 'Every member account: plan, months paid and missed, saved, bonus, what is owed back, and maturity.',
    from: `scheme_account a
      join scheme_plan pl on pl.id = a.scheme_plan_id
      join party p on p.id = a.customer_id
      join branch b on b.id = a.branch_id`,
    dateField: 'enrolled', branchSql: 'a.branch_id',
    fields: [
      text('account', 'Account', 'a.account_number'),
      date('enrolled', 'Enrolled', 'a.enrolled_on'),
      date('maturity', 'Matures', 'a.maturity_date'),
      text('plan', 'Plan', 'pl.name', { picker: 'scheme_plan' }),
      text('basis', 'Saves in', `case when a.accrual_basis = 'weight' then 'Grams' else 'Rupees' end`),
      text('member', 'Member', 'p.name', { picker: 'customer' }),
      text('member_phone', 'Phone', `coalesce(p.phone, '')`),
      branch('b'),
      text('status', 'Status', 'a.status', { picker: 'enum', options: ['active', 'matured', 'redeemed', 'defaulted', 'cancelled', 'closed'] }),
      int('paid', 'Months paid', 'a.installments_paid'),
      int('missed', 'Months missed', 'a.installments_missed'),
      int('months', 'Months in plan', 'a.installments_due'),
      money('installment', 'Monthly amount', 'a.installment_amount', { agg: 'avg' }),
      money('saved', 'Saved', 'a.total_paid'),
      weight('weight', 'Gold held', 'a.total_weight_accrued'),
      money('bonus', 'Bonus', 'a.bonus_amount'),
      money('owed', 'Owed to member', 'a.redeemable_amount'),
    ],
    defaultColumns: ['account', 'member', 'plan', 'status', 'paid', 'missed', 'saved', 'bonus', 'maturity'],
    defaultSort: { key: 'maturity', dir: 'asc' },
  },

  /* ----------------------------------------------------------------- girvi */
  {
    key: 'girvi_loans', label: 'Girvi — loans', category: 'girvi',
    description: 'Every gold loan: borrower, gold held, amount lent, interest, what is owed now, due date and days overdue.',
    from: `girvi_loan gl
      join branch b on b.id = gl.branch_id`,
    dateField: 'sanctioned', branchSql: 'gl.branch_id',
    fields: [
      text('loan', 'Loan', 'gl.loan_number'),
      date('sanctioned', 'Given on', 'gl.sanctioned_on'),
      date('due', 'Due', 'gl.due_date'),
      text('status', 'Status', 'gl.status', { picker: 'enum', options: ['active', 'overdue', 'redeemed', 'defaulted', 'auctioned', 'cancelled'] }),
      branch('b'),
      text('borrower', 'Borrower', 'gl.borrower_name'),
      text('phone', 'Phone', 'gl.borrower_phone'),
      text('packet', 'Packet', `coalesce(gl.vault_packet_number, '')`),
      int('days_overdue', 'Days overdue', `case when gl.status in ('active', 'overdue') and gl.due_date < {{today}}::date then {{today}}::date - gl.due_date else 0 end`, { agg: 'max' }),
      int('notices', 'Notices sent', 'gl.notice_count'),
      weight('fine_weight', 'Fine gold held', 'gl.total_fine_weight'),
      money('appraised', 'Appraised', 'gl.appraised_value'),
      { key: 'ltv', label: 'Loan to value %', type: 'percent', sql: 'gl.ltv_percent', ratio: { num: 'gl.principal_amount', den: 'gl.appraised_value', scale: 100 } },
      money('principal', 'Lent', 'gl.principal_amount'),
      { key: 'rate', label: 'Rate % a month', type: 'percent', sql: 'gl.interest_rate_monthly', agg: 'avg' },
      money('interest_charged', 'Interest charged', 'gl.interest_accrued'),
      money('interest_paid', 'Interest paid', 'gl.interest_paid'),
      money('principal_back', 'Principal repaid', 'gl.principal_repaid'),
      money('outstanding', 'Owed now', 'gl.outstanding_amount'),
    ],
    defaultColumns: ['loan', 'borrower', 'sanctioned', 'due', 'status', 'fine_weight', 'principal', 'outstanding', 'days_overdue'],
    defaultSort: { key: 'sanctioned', dir: 'desc' },
  },
  {
    key: 'girvi_repayments', label: 'Girvi — repayments', category: 'girvi',
    description: 'Every payment against a gold loan, split into interest, penalty, charges and principal.',
    from: `girvi_repayment r
      join girvi_loan gl on gl.id = r.girvi_loan_id
      join branch b on b.id = gl.branch_id
      left join payment_method pm on pm.id = r.payment_method_id`,
    where: `r.status = 'posted'`,
    dateField: 'date', branchSql: 'gl.branch_id',
    fields: [
      date('date', 'Date', 'r.paid_on'),
      text('receipt', 'Receipt', 'r.receipt_number'),
      text('loan', 'Loan', 'gl.loan_number'),
      text('borrower', 'Borrower', 'gl.borrower_name'),
      branch('b'),
      text('mode', 'Paid by', `coalesce(pm.name, '')`, { picker: 'payment_method' }),
      money('amount', 'Amount', 'r.amount'),
      money('interest', 'Interest', 'r.interest_component'),
      money('penalty', 'Penalty', 'r.penalty_component'),
      money('charges', 'Charges', 'r.fee_component'),
      money('principal', 'Principal', 'r.principal_component'),
    ],
    defaultColumns: ['date', 'receipt', 'loan', 'borrower', 'amount', 'interest', 'principal'],
    defaultSort: { key: 'date', dir: 'desc' },
  },

  /* ------------------------------------------------------------- customers */
  {
    key: 'customers', label: 'Customers', category: 'customers',
    description: 'Every customer with what they have bought, when they last came, what they owe, their savings and loans, birthday and anniversary.',
    from: `party p
      left join lateral (select count(*)::int as bills, coalesce(sum(s.total_amount), 0) as spend, min(s.doc_date) as first_bill, max(s.doc_date) as last_bill,
                                coalesce(sum(s.total_amount) filter (where s.doc_date between {{from}}::date and {{to}}::date), 0) as period_spend,
                                count(*) filter (where s.doc_date between {{from}}::date and {{to}}::date)::int as period_bills
                           from sales_invoice s where s.customer_id = p.id and s.status = 'posted') st on true
      left join lateral (select coalesce(sum(case when a.code = '1100' then e.debit - e.credit end), 0) as owed,
                                coalesce(sum(case when a.code = '2400' then e.credit - e.debit end), 0) as advance
                           from ledger_entry e join account a on a.id = e.account_id
                          where e.party_id = p.id and a.code in ('1100', '2400')) bal on true
      left join lateral (select count(*)::int as n from scheme_account sa where sa.customer_id = p.id and sa.status = 'active') sch on true
      left join lateral (select count(*)::int as n from girvi_loan g where g.customer_id = p.id and g.status in ('active', 'overdue')) gv on true`,
    where: `p.is_customer and p.deleted_at is null and p.code <> 'WALKIN'`,
    dateField: 'joined', dateMode: 'none',
    fields: [
      text('code', 'Code', 'p.code'),
      text('customer', 'Customer', 'p.name', { picker: 'customer' }),
      text('phone', 'Phone', `coalesce(p.phone, '')`),
      text('city', 'City', `coalesce(p.city, '')`),
      text('state', 'State', `coalesce(p.state, '')`),
      text('type', 'Type', `case when coalesce(p.gstin, '') <> '' then 'Business' else 'Individual' end`, { picker: 'enum', options: ['Business', 'Individual'] }),
      text('kyc', 'KYC', 'p.kyc_status', { picker: 'enum', options: ['none', 'pending', 'verified', 'rejected'] }),
      date('joined', 'Customer since', 'p.created_at::date'),
      date('birthday', 'Birthday', 'p.date_of_birth', { dim: false }),
      date('anniversary', 'Anniversary', 'p.anniversary', { dim: false }),
      int('birthday_month', 'Birthday month', 'extract(month from p.date_of_birth)::int', { dim: true }),
      int('anniversary_month', 'Anniversary month', 'extract(month from p.anniversary)::int', { dim: true }),
      date('first_bill', 'First bill', 'st.first_bill'),
      date('last_bill', 'Last bill', 'st.last_bill'),
      int('days_since', 'Days since last bill', `case when st.last_bill is not null then {{today}}::date - st.last_bill end`, { agg: 'avg' }),
      text('activity', 'Activity', `case when st.last_bill is null then 'Never bought' when {{today}}::date - st.last_bill <= 90 then 'Active'
                                         when {{today}}::date - st.last_bill <= 365 then 'Quiet' else 'Dormant' end`, { picker: 'enum', options: ['Active', 'Quiet', 'Dormant', 'Never bought'] }),
      int('bills', 'Bills (ever)', 'st.bills'),
      money('spend', 'Spent (ever)', 'st.spend'),
      int('period_bills', 'Bills in period', 'st.period_bills'),
      money('period_spend', 'Spent in period', 'st.period_spend'),
      money('owed', 'Owes you', 'bal.owed'),
      money('advance', 'Advance held', 'bal.advance'),
      int('savings', 'Savings accounts', 'sch.n'),
      int('loans', 'Girvi loans', 'gv.n'),
      money('credit_limit', 'Credit limit', 'coalesce(p.credit_limit, 0)'),
    ],
    defaultColumns: ['customer', 'phone', 'city', 'last_bill', 'bills', 'spend', 'owed', 'activity'],
    defaultSort: { key: 'spend', dir: 'desc' },
  },

  /* -------------------------------------------------------------- the books */
  {
    key: 'ledger', label: 'Books — every ledger entry', category: 'accounts',
    description: 'Every debit and credit in the books, with the voucher, ledger, group and party — for any analysis of income, expenses, cash or GST.',
    from: `ledger_entry e
      join voucher v on v.id = e.voucher_id
      join account a on a.id = e.account_id
      left join account grp on grp.id = a.parent_id
      left join party p on p.id = e.party_id
      join branch b on b.id = e.branch_id`,
    dateField: 'date', branchSql: 'e.branch_id',
    fields: [
      date('date', 'Date', 'e.entry_date'),
      text('voucher', 'Voucher', 'v.voucher_number'),
      text('voucher_type', 'Voucher type', `replace(v.voucher_type, '_', ' ')`),
      text('reversed', 'Reversed', `case when v.is_reversed or v.reverses_voucher_id is not null then 'Yes' else 'No' end`, { picker: 'enum', options: ['Yes', 'No'] }),
      branch('b'),
      text('account', 'Ledger', 'a.name', { picker: 'account' }),
      text('account_code', 'Ledger code', 'a.code'),
      text('group', 'Group', `coalesce(grp.name, '')`),
      text('account_type', 'Type', 'a.account_type', { picker: 'enum', options: ['asset', 'liability', 'equity', 'income', 'expense'] }),
      text('party', 'Party', `coalesce(p.name, '')`, { picker: 'customer' }),
      text('narration', 'Narration', `coalesce(e.narration, v.narration, '')`),
      money('debit', 'Debit', 'e.debit'),
      money('credit', 'Credit', 'e.credit'),
      money('net', 'Debit − credit', 'e.debit - e.credit'),
    ],
    defaultColumns: ['date', 'voucher', 'voucher_type', 'account', 'party', 'debit', 'credit', 'narration'],
    defaultSort: { key: 'date', dir: 'desc' },
  },
];

export const datasetByKey = new Map(DATASETS.map((d) => [d.key, d]));

/** Which permission reads each category. */
export const CATEGORY_PERMISSION: Record<string, string> = {
  sales: 'reports.sales.view', stock: 'reports.stock.view', purchase: 'reports.purchase.view', oldgold: 'reports.oldgold.view',
  orders: 'reports.orders.view', schemes: 'reports.schemes.view', girvi: 'reports.girvi.view', customers: 'reports.customers.view',
  accounts: 'reports.accounts.view', compliance: 'reports.compliance.view', staff: 'reports.staff.view', profit: 'reports.cost.view',
};
export const COST_PERMISSION = 'reports.cost.view';
