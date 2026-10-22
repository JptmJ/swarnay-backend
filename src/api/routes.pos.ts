/**
 * POS & billing: the counter bill, returns and exchanges, money received from
 * customers, and pieces sent out on approval.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction, type Tx } from '../core/db/client.js';
import { param } from '../core/http/middleware.js';
import { AppError } from '../core/errors/app-error.js';
import {
  cancelInvoice, cancelReceipt, checkout, quote, createMemo, createReceipt, createSalesReturn, customerBalance, invoiceDetail, memoDetail, returnMemoPieces,
} from '../modules/sales/sales.service.js';
import { decodeCursor, encodeCursor } from './crud.js';
import { idProof, oldGoldLine } from './routes.oldgold.js';
import { decimal, errorEnvelope, idParam, isoDate, money, record, uuid, weight } from './schemas.js';

const DAY = '2026-09-30';
const added = (note: string) => [{ date: DAY, kind: 'added' as const, note }];
const S = '/api/pos';
const cursorPage = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const page = z.object({ rows: z.array(record), nextCursor: z.string().nullable() });
const reason = z.object({ reason: z.string().trim().min(3).max(500) });

async function newestFirst(tx: Tx, sql: (where: string, limit: string) => string, clauses: string[], params: unknown[],
  q: { cursor?: string; limit?: number }, alias: string) {
  const limit = Number(q.limit ?? 50);
  if (q.cursor) { params.push(decodeCursor(q.cursor).id); clauses.push(`${alias}.id < $${params.length}::uuid`); }
  params.push(limit + 1);
  const rows = await tx.query<Record<string, unknown> & { id: string }>(sql(clauses.length ? `where ${clauses.join(' and ')}` : '', `$${params.length}`), params);
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, nextCursor: more ? encodeCursor(null, rows[rows.length - 1]!.id) : null };
}

/* ---------------------------------------------------------------- the counter */

defineRoute({
  method: 'get', path: `${S}/tenders`, module: 'pos', summary: 'Payment methods offered at this branch', permission: 'pos.view',
  responses: [{ status: 200, description: 'From Masters → Payment Modes, in their order.', schema: z.object({ rows: z.array(record) }) }],
  changelog: added('Tenders for the counter.'),
  handler: async () => transaction(async (tx) => ({ rows: await tx.query(
    `select m.id, m.code, m.name, m.kind, m.requires_reference, m.max_amount from payment_method m
      where m.is_active and m.deleted_at is null
        and (not exists (select 1 from payment_method_branch b where b.payment_method_id = m.id)
             or exists (select 1 from payment_method_branch b where b.payment_method_id = m.id and b.branch_id = $1))
      order by m.sort_order, m.name`, [tx.context.branchId]) })),
});

defineRoute({
  method: 'get', path: `${S}/scan/:code`, module: 'pos', summary: 'Find a piece by tag number or HUID for the bill',
  description: 'Exact match on the tag or HUID. Says where the piece is when it cannot be sold here.',
  permission: 'pos.view', params: z.object({ code: z.string().trim().min(1).max(40) }),
  responses: [{ status: 200, description: 'The piece.', schema: record }, { status: 404, description: 'No piece has that tag or HUID.', schema: errorEnvelope }],
  changelog: added('Scan at the counter.'),
  handler: async (req) => transaction(async (tx) => {
    const code = param(req, 'code').toUpperCase();
    const piece = await tx.maybeOne(
      `select p.id, p.tag_number, p.huid, p.status, p.gross_weight, p.stone_weight, p.other_weight, p.net_weight, p.stone_cost,
              p.item_id, i.name as item_name, c.name as category_name, p.purity_id, pu.code as purity_code, pu.metal_id,
              p.location_id, l.name as location_name, l.branch_id, b.name as branch_name,
              (select m.customer_id from approval_memo_line ml join approval_memo m on m.id = ml.approval_memo_id
                where ml.piece_id = p.id and ml.returned_at is null and ml.sales_invoice_id is null and m.status = 'open') as memo_customer_id
         from stock_piece p join item i on i.id = p.item_id left join item_category c on c.id = i.category_id join purity pu on pu.id = p.purity_id
         join stock_location l on l.id = p.location_id join branch b on b.id = l.branch_id
        where upper(p.tag_number) = $1 or p.huid = $1
        order by (p.status = 'in_stock') desc limit 1`, [code]);
    if (!piece) throw new AppError(`No piece has tag or HUID ${code}.`, 404, 'piece_not_found');
    return piece;
  }),
});

const saleLine = z.object({
  pieceId: uuid.optional(), itemId: uuid.optional(), purityId: uuid.optional(), locationId: uuid.optional(),
  grossWeight: weight.optional(), hallmarkAmount: money.optional(),
}).refine((l) => l.pieceId || (l.itemId && l.purityId && l.grossWeight), { message: 'Send a piece, or an item, purity and weight.' });

defineRoute({
  method: 'post', path: `${S}/checkout`, module: 'pos', summary: 'Bill the customer',
  description: [
    'Prices every line on the server (rate; making and wastage from the tag, else Masters → Formulas; GST), takes the discount off making and wastage,',
    'takes the tenders and posts at once: stock out at cost, the books, and any unpaid balance on the customer.',
    'A discount above the counter limit needs `approver` (someone with discount approval) unless the biller has it.',
    'A bill of ₹2 lakh or more needs the customer’s PAN; cash reaching ₹2 lakh from one customer in a day (bills and receipts together) is refused.',
    'Without customerId it is a walk-in bill: paid in full, under ₹2 lakh, no advance.',
  ].join(' '),
  permission: 'pos.create',
  body: z.object({
    customerId: uuid.optional().describe('Leave out for a walk-in: paid in full and under ₹2 lakh.'), lines: z.array(saleLine).max(100).default([]),
    tenders: z.array(z.object({
      paymentMethodId: uuid, amount: money, reference: z.string().trim().max(80).optional(),
      schemeAccountId: uuid.optional().describe('For a scheme tender: the matured account being spent, redeemed as this bill saves.'),
    })).max(10),
    discount: money.optional(), approver: z.object({ identifier: z.string().min(1), password: z.string().min(1) }).optional(),
    pan: z.string().trim().max(10).optional(), salespersonId: uuid.optional(), notes: z.string().max(500).optional(),
    expectedTotal: money.optional().describe('The total the counter showed; refused with price_changed if the price moved since.'),
    oldGold: z.object({ lines: z.array(oldGoldLine).min(1).max(50), locationId: uuid.optional(), idProof: idProof.optional() }).optional()
      .describe('Old gold handed over with this bill: taken in and used as payment up to what is left; any more stays as advance (not for a walk-in).'),
    orderId: uuid.optional()
      .describe('Billing a customer’s order: the pieces it holds may be sold, and saving this bill delivers the order.'),
    services: z.array(z.object({
      description: z.string().trim().min(1).max(200), amount: money,
      sacCode: z.string().trim().max(10).optional(), gstPercent: decimal.optional(),
    })).max(20).optional()
      .describe('Labour on the bill — a repair, a polish, a resize. No metal and no stock: a SAC line at the service rate.'),
  }),
  responses: [
    { status: 201, description: 'The posted bill with its lines and payments, and any pricing warnings.', schema: record },
    { status: 422, description: 'Piece not in stock, discount needs approval, PAN needed, cash limit, overpayment.', schema: errorEnvelope },
  ],
  changelog: [{ date: DAY, kind: 'added', note: 'Counter billing on the shared pricing engine; replaces create + post.' },
    { date: '2026-09-30', kind: 'changed', note: 'Making and wastage from the tag first; discount comes off making and wastage.' }],
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => checkout(tx, req.body))); },
});

defineRoute({
  method: 'post', path: `${S}/quote`, module: 'pos', summary: 'Price the bill on the counter',
  description: 'The same pricing checkout will save — tag terms, formulas, discount on making and wastage, GST, round off — with each line’s metal, wastage and making, and where they came from. Nothing is saved.',
  permission: 'pos.create',
  body: z.object({
    customerId: uuid.nullish(), lines: z.array(saleLine).max(100).default([]), discount: money.optional(), orderId: uuid.optional(),
    services: z.array(z.object({
      description: z.string().trim().min(1).max(200), amount: money,
      sacCode: z.string().trim().max(10).optional(), gstPercent: decimal.optional(),
    })).max(20).optional(),
  }),
  responses: [
    { status: 200, description: 'Lines, totals, the most discount allowed and the limit before approval, and pricing warnings.', schema: record },
    { status: 422, description: 'Piece not in stock, or discount above making and wastage.', schema: errorEnvelope },
  ],
  changelog: [{ date: '2026-09-30', kind: 'added', note: 'Live counter price.' }],
  handler: async (req) => transaction((tx) => quote(tx, req.body)),
});

defineRoute({
  method: 'get', path: `${S}/invoices`, module: 'pos', summary: 'Bills', permission: 'pos.view',
  query: z.object({ search: z.string().trim().optional(), status: z.enum(['posted', 'cancelled']).optional(), customerId: uuid.optional(),
    due: z.enum(['true', 'false']).optional(), from: isoDate.optional(), to: isoDate.optional() }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: [{ date: DAY, kind: 'changed', note: 'Cursor pages; search by bill number, customer name or phone; due filter.' }],
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['si.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    if (q.search) { params.push(`%${q.search}%`); clauses.push(`(si.doc_number ilike $${params.length} or p.name ilike $${params.length} or p.phone like $${params.length})`); }
    for (const [key, col] of [['status', 'si.status'], ['customerId', 'si.customer_id']] as const) {
      if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
    }
    if (q.due === 'true') clauses.push(`si.balance_amount > 0 and si.status = 'posted'`);
    if (q.from) { params.push(q.from); clauses.push(`si.doc_date >= $${params.length}`); }
    if (q.to) { params.push(q.to); clauses.push(`si.doc_date <= $${params.length}`); }
    return newestFirst(tx, (where, limit) =>
      `select si.id, si.doc_number, si.doc_date, si.status, si.total_amount, si.paid_amount, si.balance_amount, si.discount_amount,
              si.total_net_weight, p.name as customer_name, p.phone as customer_phone, u.full_name as salesperson_name,
              (select count(*)::int from sales_invoice_line where sales_invoice_id = si.id) as line_count,
              (select case when sum(l.returned_net_weight) = 0 then null when sum(l.returned_net_weight) >= sum(l.net_weight) then 'full' else 'part' end
                 from sales_invoice_line l where l.sales_invoice_id = si.id) as returned
         from sales_invoice si join party p on p.id = si.customer_id left join app_user u on u.id = si.salesperson_id
         ${where} order by si.id desc limit ${limit}`, clauses, params, q, 'si');
  }),
});

defineRoute({
  method: 'get', path: `${S}/invoices/:id`, module: 'pos', summary: 'One bill: lines, payments and returns, ready to print',
  permission: 'pos.view', params: idParam,
  responses: [{ status: 200, description: 'The bill.', schema: record }, { status: 404, description: 'Not found.', schema: errorEnvelope }],
  changelog: [{ date: DAY, kind: 'changed', note: 'Carries branch and customer details for printing, returns and the salesperson.' }],
  handler: async (req) => transaction((tx) => invoiceDetail(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${S}/invoices/:id/cancel`, module: 'pos', summary: 'Cancel a bill entered by mistake',
  description: 'Everything reverses and the pieces go back on the shelf. Not once goods came back on a return or a receipt was paid against it.',
  permission: 'pos.cancel', params: idParam, body: reason,
  responses: [{ status: 200, description: 'Cancelled.', schema: record }, { status: 422, description: 'Returned, paid against, or has an IRN.', schema: errorEnvelope }],
  changelog: added('Cancel a bill.'),
  handler: async (req) => transaction((tx) => cancelInvoice(tx, param(req, 'id'), req.body.reason)),
});

/* ------------------------------------------------------------------ returns */

defineRoute({
  method: 'post', path: `${S}/returns`, module: 'pos', summary: 'Take goods back from a customer',
  description: 'Against one bill. The value comes back in proportion, first clearing anything still owed on that bill, then as a refund or a credit note for an exchange.',
  permission: 'pos.return.create',
  body: z.object({
    invoiceId: uuid, lines: z.array(z.object({ invoiceLineId: uuid, netWeight: weight.optional() })).min(1).max(100),
    settlement: z.enum(['refund', 'credit_note']), refundPaymentMethodId: uuid.optional(), deduction: money.optional(),
    locationId: uuid.optional(), reason: z.enum(['defect', 'size', 'dislike', 'wrong_item', 'other']).optional(), notes: z.string().max(500).optional(),
  }),
  responses: [{ status: 201, description: 'The return.', schema: record }, { status: 422, description: 'Already returned, weight above what was sold.', schema: errorEnvelope }],
  changelog: added('Customer return and exchange.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => createSalesReturn(tx, req.body))); },
});

defineRoute({
  method: 'get', path: `${S}/returns`, module: 'pos', summary: 'Customer returns', permission: 'pos.view',
  query: z.object({ customerId: uuid.optional(), search: z.string().trim().optional().describe('Return or bill number, customer name or mobile.') }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: added('Return register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['r.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    if (q.customerId) { params.push(q.customerId); clauses.push(`r.customer_id = $${params.length}`); }
    if (q.search) {
      params.push(`%${q.search}%`);
      clauses.push(`(r.doc_number ilike $${params.length} or si.doc_number ilike $${params.length} or p.name ilike $${params.length} or p.phone like $${params.length})`);
    }
    return newestFirst(tx, (where, limit) =>
      `select r.id, r.doc_number, r.doc_date, r.status, r.settlement, r.reason, r.total_amount, r.deduction_amount, r.refund_amount, r.adjusted_amount,
              r.total_net_weight, p.name as customer_name, p.phone as customer_phone, si.id as invoice_id, si.doc_number as invoice_number,
              pm.name as refund_method_name,
              (select count(*)::int from sales_return_line where sales_return_id = r.id) as line_count
         from sales_return r join party p on p.id = r.customer_id join sales_invoice si on si.id = r.sales_invoice_id
         left join payment_method pm on pm.id = r.refund_payment_method_id
         ${where} order by r.id desc limit ${limit}`, clauses, params, q, 'r');
  }),
});

/* ------------------------------------------------------------------ receipts */

defineRoute({
  method: 'get', path: `${S}/customers/:id/balance`, module: 'pos', summary: 'What a customer owes and holds',
  description: 'Owed on bills, advance and credit notes, bills with a balance, and pieces out on approval.',
  permission: 'pos.view', params: idParam,
  responses: [{ status: 200, description: 'The balance.', schema: record }],
  changelog: added('Customer balance.'),
  handler: async (req) => transaction(async (tx) => {
    const id = param(req, 'id');
    const [balance, due, memos] = await Promise.all([
      customerBalance(tx, id),
      tx.query(`select id, doc_number, doc_date, total_amount, balance_amount from sales_invoice
                 where customer_id = $1 and status = 'posted' and balance_amount > 0 order by doc_date`, [id]),
      tx.query(`select m.id, m.doc_number, m.due_date, sp.id as piece_id, sp.tag_number, i.name as item_name
                  from approval_memo m join approval_memo_line ml on ml.approval_memo_id = m.id join stock_piece sp on sp.id = ml.piece_id
                  join item i on i.id = sp.item_id
                 where m.customer_id = $1 and m.status = 'open' and ml.returned_at is null and ml.sales_invoice_id is null order by m.due_date`, [id]),
    ]);
    return { ...balance, due, memoPieces: memos };
  }),
});

defineRoute({
  method: 'post', path: `${S}/receipts`, module: 'pos', summary: 'Receive money from a customer',
  description: 'Clears their oldest unpaid bills first; anything more is kept as advance for a later bill.',
  permission: 'pos.create',
  body: z.object({ customerId: uuid, amount: money, paymentMethodId: uuid, reference: z.string().trim().max(80).optional(), notes: z.string().max(500).optional() }),
  responses: [{ status: 201, description: 'The receipt with the bills it cleared.', schema: record }],
  changelog: added('Customer receipt.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => createReceipt(tx, req.body))); },
});

defineRoute({
  method: 'get', path: `${S}/receipts`, module: 'pos', summary: 'Customer receipts', permission: 'pos.view',
  query: z.object({ customerId: uuid.optional() }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: added('Receipt register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['r.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    if (q.customerId) { params.push(q.customerId); clauses.push(`r.customer_id = $${params.length}`); }
    return newestFirst(tx, (where, limit) =>
      `select r.*, p.name as customer_name, pm.name as method_name
         from customer_receipt r join party p on p.id = r.customer_id join payment_method pm on pm.id = r.payment_method_id
         ${where} order by r.id desc limit ${limit}`, clauses, params, q, 'r');
  }),
});

defineRoute({
  method: 'get', path: `${S}/receipts/:id`, module: 'pos', summary: 'One receipt, as it prints', permission: 'pos.view', params: idParam,
  responses: [{ status: 200, description: 'The receipt with the shop, the customer and the bills it cleared.', schema: record }],
  changelog: [{ date: '2026-09-30', kind: 'added', note: 'Receipt detail for printing.' }],
  handler: async (req) => transaction((tx) => tx.one(
    `select r.*, p.name as customer_name, p.phone as customer_phone, p.address_line1 as customer_address, p.city as customer_city,
            pm.name as method_name, pm.kind as method_kind,
            b.name as branch_name, b.gstin as branch_gstin, b.address_line1 as branch_address, b.city as branch_city, b.phone as branch_phone
       from customer_receipt r join party p on p.id = r.customer_id join payment_method pm on pm.id = r.payment_method_id
       join branch b on b.id = r.branch_id where r.id = $1`, [param(req, 'id')])),
});

defineRoute({
  method: 'post', path: `${S}/receipts/:id/cancel`, module: 'pos', summary: 'Cancel a receipt', permission: 'pos.cancel', params: idParam, body: reason,
  responses: [{ status: 200, description: 'Cancelled; the bills it cleared are owed again.', schema: record }, { status: 422, description: 'Its advance was already used.', schema: errorEnvelope }],
  changelog: added('Cancel a receipt.'),
  handler: async (req) => transaction((tx) => cancelReceipt(tx, param(req, 'id'), req.body.reason)),
});

/* ------------------------------------------------------------------- memos */

defineRoute({
  method: 'get', path: `${S}/memos`, module: 'pos', summary: 'Approval memos', permission: 'pos.view',
  query: z.object({ status: z.enum(['open', 'closed']).optional(), overdue: z.enum(['true', 'false']).optional() }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: added('Memo register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['m.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    if (q.status) { params.push(q.status); clauses.push(`m.status = $${params.length}`); }
    if (q.overdue === 'true') clauses.push(`m.status = 'open' and m.due_date < current_date`);
    return newestFirst(tx, (where, limit) =>
      `select m.*, p.name as customer_name, p.phone as customer_phone,
              (select count(*)::int from approval_memo_line where approval_memo_id = m.id and returned_at is null and sales_invoice_id is null) as pieces_out
         from approval_memo m join party p on p.id = m.customer_id ${where} order by m.id desc limit ${limit}`, clauses, params, q, 'm');
  }),
});

defineRoute({
  method: 'get', path: `${S}/memos/:id`, module: 'pos', summary: 'One approval memo', permission: 'pos.view', params: idParam,
  responses: [{ status: 200, description: 'The memo with each piece: out, returned or billed.', schema: record }],
  changelog: added('Memo detail.'),
  handler: async (req) => transaction((tx) => memoDetail(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${S}/memos`, module: 'pos', summary: 'Send pieces to a customer on approval',
  description: 'The pieces stay ours and show "On approval". Bill them to the same customer from the counter, or take them back.',
  permission: 'pos.create',
  body: z.object({ customerId: uuid, pieceIds: z.array(uuid).min(1).max(200), dueDate: isoDate, notes: z.string().max(500).optional() }),
  responses: [{ status: 201, description: 'The memo.', schema: record }, { status: 422, description: 'A piece is not in stock here.', schema: errorEnvelope }],
  changelog: added('Approval memo.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => createMemo(tx, req.body))); },
});

defineRoute({
  method: 'post', path: `${S}/memos/:id/return`, module: 'pos', summary: 'Take pieces back from approval', permission: 'pos.create',
  params: idParam, body: z.object({ pieceIds: z.array(uuid).min(1).max(200) }),
  responses: [{ status: 200, description: 'The memo; it closes when every piece is back or billed.', schema: record }],
  changelog: added('Return from approval.'),
  handler: async (req) => transaction((tx) => returnMemoPieces(tx, param(req, 'id'), req.body.pieceIds)),
});
