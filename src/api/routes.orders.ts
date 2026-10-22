/**
 * Custom Orders and Karigar job work.
 *
 * Five order types, each walking its own stage list. An order holds a rate and
 * reserves what is promised; advances post as they are taken; the finished
 * order is billed at the counter, which is what moves stock and GST.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction, type Tx } from '../core/db/client.js';
import { repo } from '../core/db/repository.js';
import { param } from '../core/http/middleware.js';
import { ORDER_PIPELINES, ORDER_TYPES, ORDER_TYPE_LABELS, RATE_LOCK_TYPES } from '../modules/orders/order-pipelines.js';
import {
  addOrderPayment, board, cancelOrder, cancelOrderPayment, createOrder, moveStage, orderDetail, orderForBilling,
  orderSettings, pipelineFor, returnCustodyItem, updateOrder,
} from '../modules/orders/orders.service.js';
import { cancelJob, issueJob, jobDetail, karigarBalances, payKarigar, receiveJob } from '../modules/orders/karigar.service.js';
import { decodeCursor, encodeCursor } from './crud.js';
import { decimal, errorEnvelope, idParam, isoDate, money, record, uuid, weight } from './schemas.js';

const DAY = '2026-10-07';
const seed = [{ date: '2026-09-18', kind: 'added' as const, note: 'Orders: five types with per-type stages.' }];
const built = (note: string) => [...seed, { date: DAY, kind: 'changed' as const, note }];
const O = '/api/orders';
const K = '/api/karigars';
const cursorPage = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
const page = z.object({ rows: z.array(record), nextCursor: z.string().nullable() });
const reason = z.object({ reason: z.string().trim().min(3).max(500) });

async function newestFirst(tx: Tx, sql: (where: string, limit: string) => string, clauses: string[], params: unknown[],
  q: { cursor?: string; limit?: number }, alias: string) {
  const limit = Number(q.limit ?? 50);
  if (q.cursor) { params.push(decodeCursor(q.cursor).id); clauses.push(`${alias}.id < $${params.length}::uuid`); }
  params.push(limit + 1);
  const rows = await tx.query<Record<string, unknown> & { id: string }>(
    sql(clauses.length ? `where ${clauses.join(' and ')}` : '', `$${params.length}`), params);
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, nextCursor: more ? encodeCursor(null, rows[rows.length - 1]!.id) : null };
}

const lineSchema = z.object({
  lineMode: z.enum(['booking', 'custom']).default('booking').describe('booking promises a piece already in stock; custom is made to order.'),
  title: z.string().trim().min(1).max(200),
  designSpecification: z.string().max(2000).optional(),
  itemId: uuid.nullish(), pieceId: uuid.nullish().describe('A tagged piece promised off the shelf; it is held for this order.'),
  purityId: uuid.nullish(), categoryId: uuid.nullish(),
  quantity: decimal.optional(), grossWeight: weight.optional(), stoneWeight: weight.optional(),
  ratePerGram: money.optional().describe('Falls back to the order’s locked rate, then today’s sale rate in Masters → Rates for the line’s purity.'),
  makingBasis: z.enum(['per_gram', 'percent', 'flat']).optional(),
  makingRate: decimal.optional(), wastagePercent: decimal.optional(),
  stoneAmount: money.optional(), discountAmount: money.optional(), gstRate: decimal.optional(),
  hsnCode: z.string().optional(), specialInstructions: z.string().optional(),
});

const custodySchema = z.object({
  description: z.string().trim().min(1).max(500),
  tokenNumber: z.string().max(40).optional().describe('The shop’s token/tag on the held item.'),
  metalId: uuid.nullish(), purityId: uuid.nullish(),
  testedPurityPercent: decimal.optional().describe('Purity read on the touchstone/XRF, if tested.'),
  grossWeight: weight.optional(), stoneWeight: weight.optional(),
  declaredValue: money.optional().describe('Value agreed with the customer for the item held.'),
  conditionNotes: z.string().max(2000).optional(), whereKept: z.string().max(200).optional(),
});

defineRoute({
  method: 'get', path: `${O}/pipelines`, module: 'orders', summary: 'The steps each order type walks',
  description: 'A repair genuinely has different steps from a wedding order. Read this rather than hardcoding them; a shop can set its own.',
  permission: 'orders.view',
  responses: [{ status: 200, description: 'Steps per type.', schema: z.object({ pipelines: z.array(record) }) }],
  changelog: seed,
  handler: async () => transaction(async (tx) => ({
    pipelines: await Promise.all(ORDER_TYPES.map(async (t) => ({
      orderType: t, label: ORDER_TYPE_LABELS[t], stages: await pipelineFor(tx, t),
      builtIn: ORDER_PIPELINES[t],
    }))),
  })),
});

/* ------------------------------------------------------------------- board */

defineRoute({
  method: 'get', path: `${O}/board`, module: 'orders', summary: 'The board for one order type',
  description: 'Live orders grouped into the step they are on, with what is overdue or due soon and how many jobs are still with a karigar.',
  permission: 'orders.view',
  query: z.object({ orderType: z.enum(ORDER_TYPES), branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'Orders per step.', schema: record }],
  changelog: built('Shows overdue, due soon and open karigar jobs.'),
  handler: async (req) => {
    const q = queryOf<{ orderType: (typeof ORDER_TYPES)[number]; branchId?: string }>(req);
    return transaction((tx) => board(tx, q.orderType, q.branchId ?? null));
  },
});

/* -------------------------------------------------------------------- list */

defineRoute({
  method: 'get', path: O, module: 'orders', summary: 'Orders', permission: 'orders.view',
  query: z.object({
    orderType: z.enum(ORDER_TYPES).optional(), status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
    stage: z.string().optional(), customerId: uuid.optional(), karigarId: uuid.optional(),
    from: isoDate.optional(), to: isoDate.optional(), overdue: z.enum(['true', 'false']).optional(),
    search: z.string().optional().describe('Order number, customer name or mobile.'),
  }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: built('Cursor pages, search and the overdue filter.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['o.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    for (const [key, col] of [['orderType', 'o.order_type'], ['status', 'o.status'], ['stage', 'o.stage'],
      ['customerId', 'o.customer_id'], ['karigarId', 'o.karigar_id']] as const) {
      if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
    }
    if (q.from) { params.push(q.from); clauses.push(`o.order_date >= $${params.length}`); }
    if (q.to) { params.push(q.to); clauses.push(`o.order_date <= $${params.length}`); }
    if (q.overdue === 'true') clauses.push(`o.status = 'active' and o.expected_delivery_date < current_date`);
    if (q.search) {
      params.push(`%${q.search}%`);
      clauses.push(`(o.order_number ilike $${params.length} or p.name ilike $${params.length} or p.phone ilike $${params.length})`);
    }
    return newestFirst(tx, (where, limit) =>
      `select o.id, o.order_number, o.order_type, o.status, o.stage, o.order_date, o.expected_delivery_date, o.delivered_at,
              o.total_amount, o.advance_amount, o.balance_amount, o.total_net_weight, o.rate_lock_type, o.locked_rate_per_gram,
              p.name as customer_name, p.phone as customer_phone, k.name as karigar_name, si.doc_number as invoice_number,
              o.expected_delivery_date < current_date and o.status = 'active' as is_overdue,
              (select count(*)::int from order_line l where l.retail_order_id = o.id) as line_count,
              (select count(*)::int from karigar_job j where j.retail_order_id = o.id and j.status = 'issued') as open_jobs
         from retail_order o join party p on p.id = o.customer_id
         left join karigar k on k.id = o.karigar_id left join sales_invoice si on si.id = o.sales_invoice_id
         ${where} order by o.id desc limit ${limit}`, clauses, params, q, 'o');
  }),
});

defineRoute({
  method: 'get', path: `${O}/custody`, module: 'orders', summary: 'The customer’s own jewellery the shop is holding',
  description: 'Repairs and metal brought in for a new piece, across every order: the token on the paper tag, what it weighs, where it is kept and who it belongs to. Never stock — the shop does not own any of it.',
  permission: 'orders.view',
  query: z.object({
    status: z.enum(['received', 'with_karigar', 'ready', 'returned', 'written_off']).optional(),
    held: z.enum(['true', 'false']).optional().describe('true = still with the shop (not yet given back).'),
    search: z.string().optional().describe('Token, description, order number, customer name or mobile.'),
  }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: built('Customer goods register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['o.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    if (q.status) { params.push(q.status); clauses.push(`c.status = $${params.length}`); }
    if (q.held === 'true') clauses.push(`c.status <> 'returned'`);
    if (q.search) {
      params.push(`%${q.search}%`);
      clauses.push(`(c.token_number ilike $${params.length} or c.description ilike $${params.length}
                     or o.order_number ilike $${params.length} or p.name ilike $${params.length} or p.phone ilike $${params.length})`);
    }
    return newestFirst(tx, (where, limit) =>
      `select c.id, c.token_number, c.description, c.gross_weight, c.stone_weight, c.net_weight, c.tested_purity_percent,
              c.declared_value, c.condition_notes, c.where_kept, c.status, c.received_on, c.returned_on, c.returned_to_name,
              m.name as metal_name, o.id as retail_order_id, o.order_number, o.order_type, o.status as order_status,
              p.name as customer_name, p.phone as customer_phone, j.job_number, k.name as karigar_name
         from order_custody_item c
         join retail_order o on o.id = c.retail_order_id
         join party p on p.id = o.customer_id
         left join metal m on m.id = c.metal_id
         left join karigar_job j on j.id = c.karigar_job_id
         left join karigar k on k.id = j.karigar_id
         ${where} order by c.id desc limit ${limit}`, clauses, params, q, 'c');
  }),
});

defineRoute({
  method: 'get', path: `${O}/:id`, module: 'orders', summary: 'One order with everything on it',
  description: 'Lines, the customer’s own items held, the history, advances, karigar jobs, attachments and messages.',
  permission: 'orders.view', params: idParam,
  responses: [{ status: 200, description: 'The order.', schema: record }, { status: 404, description: 'Not found.', schema: errorEnvelope }],
  changelog: built('Carries custody items and karigar jobs.'),
  handler: async (req) => transaction((tx) => orderDetail(tx, param(req, 'id'))),
});

/* ------------------------------------------------------------------ create */

defineRoute({
  method: 'post', path: O, module: 'orders', summary: 'Take an order',
  description: [
    'One endpoint for all five types; `orderType` decides what is required. A corporate order needs the company and their PO; a repair needs what was taken in.',
    'Lines are priced by the same engine the counter uses. A line with no purity or weight yet is carried as an estimate.',
    'A piece promised off the shelf is held for this order and cannot be promised twice. An advance posts as it is taken.',
  ].join(' '),
  permission: 'orders.create',
  body: z.object({
    orderType: z.enum(ORDER_TYPES), customerId: uuid,
    orderDate: isoDate.optional().describe('The shop’s today if left out.'),
    expectedDeliveryDate: isoDate,
    salespersonId: uuid.optional(), karigarId: uuid.optional(),
    rateLockType: z.enum(RATE_LOCK_TYPES).optional().describe('Falls back to orders.rate_lock.default.'),
    lockedRatePerGram: money.optional().describe('Required when the rate is fixed by agreement.'),
    lines: z.array(lineSchema).max(100).optional(),
    custodyItems: z.array(custodySchema).max(50).optional().describe('The customer’s own jewellery left with the shop.'),
    advance: z.object({ paymentMethodId: uuid, amount: money, reference: z.string().max(80).optional() }).optional(),
    notes: z.string().max(2000).optional(),

    requirementDescription: z.string().max(2000).optional(), sizeSpecifications: z.string().max(1000).optional(),
    budgetMin: money.optional(), budgetMax: money.optional(),
    manufacturingRoute: z.enum(['in_house', 'external']).optional(), externalManufacturerId: uuid.optional(),

    repairItemDescription: z.string().max(500).optional().describe('Required for a repair.'),
    repairIssueDescription: z.string().max(2000).optional(), repairIssueTypes: z.array(z.string().max(40)).max(20).optional(),
    repairServiceCharge: money.optional(), repairInvoiceType: z.enum(['service', 'goods']).optional(),
    underWarranty: z.boolean().optional(), originalInvoiceNumber: z.string().max(40).optional(),

    eventDate: isoDate.optional(), eventType: z.string().max(100).optional(),
    companyName: z.string().max(200).optional().describe('Required for a corporate order.'),
    companyGstin: z.string().max(15).optional(), poReference: z.string().max(60).optional().describe('Required for a corporate order.'),
    creditTerms: z.enum(['net_15', 'net_30', 'custom']).optional(), creditTermsNote: z.string().max(500).optional(),
    brandingNotes: z.string().max(1000).optional(),
  }),
  responses: [
    { status: 201, description: 'Taken, on the first step of its type.', schema: record },
    { status: 422, description: 'Advance above the order, a piece already promised, or a type rule.', schema: errorEnvelope },
  ],
  changelog: [
    ...seed,
    { date: '2026-10-10', kind: 'changed', note: 'A line with a purity and no rate is priced at today’s sale rate from Masters → Rates instead of 0.' },
  ],
  handler: async (req, res) => {
    const order = await transaction((tx) => createOrder(tx, req.body));
    res.status(201).json(order);
  },
});

defineRoute({
  method: 'patch', path: `${O}/:id`, module: 'orders', summary: 'Change an order that is not delivered yet',
  description: [
    'The date, the karigar, the brief, the rate and the lines. Sending `lines` replaces all of them: the order is priced again and the holds move with it — a piece dropped is let go, a piece added is held.',
    'Changing the rate needs `orders.rate.override`. An order cannot be made worth less than what has already been taken for it.',
  ].join(' '),
  permission: 'orders.update', params: idParam,
  body: z.object({
    expectedDeliveryDate: isoDate.optional(),
    karigarId: uuid.nullish(), notes: z.string().max(2000).nullish(),
    rateLockType: z.enum(RATE_LOCK_TYPES).optional(), lockedRatePerGram: money.nullish(),
    lines: z.array(lineSchema).max(100).optional(),

    requirementDescription: z.string().max(2000).nullish(), sizeSpecifications: z.string().max(1000).nullish(),
    budgetMin: money.nullish(), budgetMax: money.nullish(),
    manufacturingRoute: z.enum(['in_house', 'external']).nullish(), externalManufacturerId: uuid.nullish(),
    designApproval: z.enum(['pending', 'approved', 'revision_requested']).nullish(),
    productionStatus: z.enum(['not_started', 'sent_to_manufacturer', 'quote_received', 'in_production', 'completed']).nullish(),

    repairItemDescription: z.string().max(500).nullish(), repairIssueDescription: z.string().max(2000).nullish(),
    repairIssueTypes: z.array(z.string().max(40)).max(20).optional(),
    repairServiceCharge: money.optional(), repairInvoiceType: z.enum(['service', 'goods']).nullish(),
    underWarranty: z.boolean().optional(), originalInvoiceNumber: z.string().max(40).nullish(),
    estimateApproved: z.object({ byName: z.string().max(120).optional() }).nullish()
      .describe('The customer agreed the repair estimate, so the work can start.'),

    eventDate: isoDate.nullish(), eventType: z.string().max(100).nullish(),
    companyName: z.string().max(200).nullish(), companyGstin: z.string().max(15).nullish(),
    poReference: z.string().max(60).nullish(),
    creditTerms: z.enum(['net_15', 'net_30', 'custom']).nullish(), creditTermsNote: z.string().max(500).nullish(),
    brandingNotes: z.string().max(1000).nullish(),
  }),
  responses: [
    { status: 200, description: 'Changed.', schema: record },
    { status: 422, description: 'Delivered or cancelled, a piece already promised elsewhere, or worth less than what was taken.', schema: errorEnvelope },
  ],
  changelog: built('An order can be changed until it is delivered.'),
  handler: async (req) => transaction((tx) => updateOrder(tx, param(req, 'id'), req.body)),
});

/* ------------------------------------------------------------------ stages */

defineRoute({
  method: 'post', path: `${O}/:id/stage`, module: 'orders', summary: 'Move an order to another step',
  description: 'Going back a step is allowed but needs a reason, which is kept on the order’s history. Delivery is not a step: bill the order instead.',
  permission: 'orders.update', params: idParam,
  body: z.object({
    stage: z.string().min(1), reason: z.string().max(500).optional().describe('Required when going back.'),
    note: z.string().max(500).optional(),
  }),
  responses: [
    { status: 200, description: 'Moved.', schema: record },
    { status: 422, description: 'Not a step for this type, a backward move with no reason, or an attempt to deliver without billing.', schema: errorEnvelope },
  ],
  changelog: built('Delivery now happens by billing the order.'),
  handler: async (req) => transaction((tx) => moveStage(tx, param(req, 'id'), req.body.stage, req.body.reason, req.body.note)),
});

defineRoute({
  method: 'post', path: `${O}/:id/cancel`, module: 'orders', summary: 'Cancel an order',
  description: 'Lets go of any piece held for it. Refused while a karigar still has metal or the customer’s own item is with the shop.',
  permission: 'orders.cancel', params: idParam, body: reason,
  responses: [{ status: 200, description: 'Cancelled.', schema: record },
    { status: 422, description: 'Already billed, a job is open, or the customer’s item is still held.', schema: errorEnvelope }],
  changelog: built('Releases held pieces and checks open jobs.'),
  handler: async (req) => transaction((tx) => cancelOrder(tx, param(req, 'id'), req.body.reason)),
});

/* ---------------------------------------------------------------- advances */

defineRoute({
  method: 'post', path: `${O}/:id/payments`, module: 'orders', summary: 'Take an advance on an order',
  description: 'Money in, credited to the customer. The counter spends it on the bill as “Order Advance”. Payment-mode rules and the ₹2 lakh daily cash rule apply as they do at the counter.',
  permission: 'orders.update', params: idParam,
  body: z.object({
    paymentMethodId: uuid, amount: money, reference: z.string().max(80).optional(), notes: z.string().max(500).optional(),
  }),
  responses: [{ status: 201, description: 'Taken and posted.', schema: record },
    { status: 422, description: 'More than is due, a reference is missing, or the cash rule.', schema: errorEnvelope }],
  changelog: built('Advances now post to the books.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => addOrderPayment(tx, param(req, 'id'), req.body))); },
});

defineRoute({
  method: 'post', path: `${O}/payments/:id/cancel`, module: 'orders', summary: 'Take back an advance entered by mistake',
  permission: 'orders.update', params: idParam, body: reason,
  responses: [{ status: 200, description: 'Cancelled; the money goes back out the way it came.', schema: record },
    { status: 422, description: 'The order is billed, or the credit was already spent.', schema: errorEnvelope }],
  changelog: built('Cancel an advance.'),
  handler: async (req) => transaction((tx) => cancelOrderPayment(tx, param(req, 'id'), req.body.reason)),
});

/* ---------------------------------------------------------------- delivery */

defineRoute({
  method: 'get', path: `${O}/:id/billing`, module: 'orders', summary: 'What the counter needs to bill an order',
  description: 'The order’s lines, the rate it is held at (and why), the credit already on the customer, and how a repair is to be billed. Nothing is written; the bill itself is made at the counter.',
  permission: 'orders.view', params: idParam,
  responses: [{ status: 200, description: 'Ready to bill.', schema: record },
    { status: 422, description: 'Cancelled or already billed.', schema: errorEnvelope }],
  changelog: built('Delivery through the counter.'),
  handler: async (req) => transaction((tx) => orderForBilling(tx, param(req, 'id'))),
});

/* ----------------------------------------------------------------- custody */

defineRoute({
  method: 'post', path: `${O}/custody/:id/return`, module: 'orders', summary: 'Give the customer their own item back',
  description: 'For a repair or metal the customer brought. Refused while the item is still with a karigar.',
  permission: 'orders.update', params: idParam,
  body: z.object({ returnedToName: z.string().max(120).optional(), notes: z.string().max(500).optional() }),
  responses: [{ status: 200, description: 'Given back.', schema: record },
    { status: 422, description: 'Already returned, or still with the karigar.', schema: errorEnvelope }],
  changelog: built('Customer goods register.'),
  handler: async (req) => transaction((tx) => returnCustodyItem(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: `${O}/:id/acknowledge`, module: 'orders', summary: 'Record what the customer signed for at intake',
  description: 'Taken before a repair leaves the counter: a signature or a verified OTP reference, never the code itself.',
  permission: 'orders.update', params: idParam,
  body: z.object({
    method: z.enum(['signature', 'otp']),
    signatureStorageKey: z.string().max(500).optional(), otpReference: z.string().max(100).optional(),
    acknowledgedByName: z.string().max(120).optional(),
  }),
  responses: [{ status: 201, description: 'Recorded.', schema: record },
    { status: 422, description: 'Nothing to show for the method chosen.', schema: errorEnvelope }],
  changelog: seed,
  handler: async (req, res) => {
    const row = await transaction((tx) => repo(tx, 'order_acknowledgement').insert({
      retail_order_id: param(req, 'id'), method: req.body.method,
      signature_storage_key: req.body.signatureStorageKey ?? null,
      otp_reference: req.body.otpReference ?? null,
      acknowledged_by_name: req.body.acknowledgedByName ?? null,
    }));
    res.status(201).json(row);
  },
});

defineRoute({
  method: 'post', path: `${O}/:id/messages`, module: 'orders', summary: 'Log what was said to the customer',
  description: [
    'The order’s communication log: a reminder that it is ready, a call about the estimate, a message the customer sent back.',
    'It records what the shop did — nothing here sends anything, so the status is what the staff member says happened.',
  ].join(' '),
  permission: 'orders.update', params: idParam,
  body: z.object({
    channel: z.enum(['sms', 'whatsapp', 'email', 'call', 'in_person']).default('whatsapp'),
    direction: z.enum(['outbound', 'inbound']).default('outbound'),
    message: z.string().trim().min(1).max(2000),
    deliveryStatus: z.enum(['queued', 'sent', 'delivered', 'read', 'failed']).default('sent'),
  }),
  responses: [{ status: 201, description: 'Logged.', schema: record },
    { status: 404, description: 'No such order.', schema: errorEnvelope }],
  changelog: built('The customer communication log can be written to, not only read.'),
  handler: async (req, res) => {
    const row = await transaction(async (tx) => {
      await tx.one(`select id from retail_order where id = $1`, [param(req, 'id')]);
      return repo(tx, 'order_communication').insert({
        retail_order_id: param(req, 'id'), channel: req.body.channel, direction: req.body.direction,
        message: req.body.message, delivery_status: req.body.deliveryStatus,
        actor_user_id: tx.context.userId ?? null,
      });
    });
    res.status(201).json(row);
  },
});

/* ----------------------------------------------------------------- karigar */

defineRoute({
  method: 'get', path: `${K}/balances`, module: 'orders', summary: 'What each karigar holds and is owed',
  description: 'Fine metal in their hands, wages owed, and how many jobs are still out.',
  permission: 'orders.view',
  responses: [{ status: 200, description: 'Every karigar.', schema: z.object({ rows: z.array(record) }) }],
  changelog: built('Karigar job work.'),
  handler: async () => transaction(async (tx) => ({ rows: await karigarBalances(tx) })),
});

defineRoute({
  method: 'post', path: `${K}/jobs`, module: 'orders', summary: 'Issue work to a karigar',
  description: [
    '`shop` metal leaves stock and sits against the karigar; `customer` is their own item, which never was the shop’s and so moves no money.',
    'The ghat allowance and the labour rate are fixed here, and compared against what actually comes back.',
  ].join(' '),
  permission: 'orders.karigar',
  body: z.object({
    karigarId: uuid, retailOrderId: uuid.optional(), kind: z.enum(['making', 'repair']).optional(),
    metalSource: z.enum(['shop', 'customer']).default('shop'),
    metalId: uuid, purityId: uuid.optional(), dueDate: isoDate.optional(),
    ghatPercent: decimal.optional().describe('Falls back to the karigar’s own allowance.'),
    labourBasis: z.enum(['per_gram', 'flat', 'percent']).optional(), labourRate: decimal.optional(),
    itemId: uuid.optional().describe('Shop metal: the lot it leaves.'),
    locationId: uuid.optional().describe('Shop metal: where it leaves from.'),
    grossWeight: weight.optional(), stoneWeight: weight.optional(),
    custodyItemIds: z.array(uuid).max(50).optional().describe('The customer’s own items going out.'),
    notes: z.string().max(1000).optional(),
  }),
  responses: [{ status: 201, description: 'Issued.', schema: record },
    { status: 422, description: 'Nothing to issue, the item is not at the counter, or the karigar is inactive.', schema: errorEnvelope }],
  changelog: built('Karigar job work.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => issueJob(tx, req.body))); },
});

defineRoute({
  method: 'get', path: `${K}/jobs`, module: 'orders', summary: 'Karigar jobs', permission: 'orders.view',
  query: z.object({
    karigarId: uuid.optional(), status: z.enum(['issued', 'received', 'cancelled']).optional(),
    retailOrderId: uuid.optional(), overdue: z.enum(['true', 'false']).optional(),
  }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page }],
  changelog: built('Karigar job work.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses = ['j.branch_id = $1']; const params: unknown[] = [tx.context.branchId];
    for (const [key, col] of [['karigarId', 'j.karigar_id'], ['status', 'j.status'], ['retailOrderId', 'j.retail_order_id']] as const) {
      if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
    }
    if (q.overdue === 'true') clauses.push(`j.status = 'issued' and j.due_date is not null and j.due_date < current_date`);
    return newestFirst(tx, (where, limit) =>
      `select j.id, j.job_number, j.kind, j.status, j.metal_source, j.issued_on, j.due_date, j.received_on,
              j.issued_gross_weight, j.issued_fine_weight, j.received_gross_weight, j.received_fine_weight,
              j.ghat_allowed_fine, j.ghat_actual_fine, j.ghat_excess_fine, j.labour_amount, j.issued_value,
              k.name as karigar_name, m.name as metal_name, o.order_number, p.name as customer_name,
              j.status = 'issued' and j.due_date is not null and j.due_date < current_date as is_overdue
         from karigar_job j join karigar k on k.id = j.karigar_id join metal m on m.id = j.metal_id
         left join retail_order o on o.id = j.retail_order_id left join party p on p.id = o.customer_id
         ${where} order by j.id desc limit ${limit}`, clauses, params, q, 'j');
  }),
});

defineRoute({
  method: 'get', path: `${K}/jobs/:id`, module: 'orders', summary: 'One job card', permission: 'orders.view', params: idParam,
  responses: [{ status: 200, description: 'The job.', schema: record }],
  changelog: built('Karigar job work.'),
  handler: async (req) => transaction((tx) => jobDetail(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: `${K}/jobs/:id/receive`, module: 'orders', summary: 'Take the work back from the karigar',
  description: [
    'What came back is weighed and tested. The loss is compared with the ghat allowed: anything beyond it is recovered from the karigar’s wages or written off, as Orders settings say.',
    'Shop metal comes back into stock — tagged as a piece when `tag` is given. The customer’s own item simply becomes ready to hand back.',
  ].join(' '),
  permission: 'orders.karigar', params: idParam,
  body: z.object({
    receivedGrossWeight: weight, receivedStoneWeight: weight.optional(),
    assayPercent: decimal.optional().describe('Tested on what came back; the job’s purity is used otherwise.'),
    labourAmount: money.optional().describe('Worked out from the agreed basis when left out.'),
    intoLocationId: uuid.optional().describe('Shop metal: where it goes.'),
    tag: z.object({ itemId: uuid, purityId: uuid, huid: z.string().max(10).optional(), makingCost: money.optional() }).optional(),
    notes: z.string().max(1000).optional(),
  }),
  responses: [{ status: 200, description: 'Received.', schema: record },
    { status: 422, description: 'Not out with anyone, or more came back than went out.', schema: errorEnvelope }],
  changelog: built('Karigar job work.'),
  handler: async (req) => transaction((tx) => receiveJob(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: `${K}/jobs/:id/cancel`, module: 'orders', summary: 'Call a job back',
  description: 'For work sent out by mistake. The metal returns exactly as it left.',
  permission: 'orders.karigar', params: idParam, body: reason,
  responses: [{ status: 200, description: 'Cancelled.', schema: record },
    { status: 422, description: 'Already received or already cancelled.', schema: errorEnvelope }],
  changelog: built('Karigar job work.'),
  handler: async (req) => transaction((tx) => cancelJob(tx, param(req, 'id'), req.body.reason)),
});

defineRoute({
  method: 'post', path: `${K}/payments`, module: 'orders', summary: 'Pay a karigar their wages',
  permission: 'orders.karigar',
  body: z.object({
    karigarId: uuid, amount: money, paymentMethodId: uuid,
    reference: z.string().max(80).optional(), notes: z.string().max(500).optional(),
  }),
  responses: [{ status: 201, description: 'Paid.', schema: record },
    { status: 422, description: 'More than is owed, or a payment-mode rule.', schema: errorEnvelope }],
  changelog: built('Karigar wages.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => payKarigar(tx, req.body))); },
});
