/** Custom Orders & Karigar — five order types, each with its own pipeline. */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { repo } from '../core/db/repository.js';
import { param } from '../core/http/middleware.js';
import {
  ORDER_PIPELINES, ORDER_TYPES, ORDER_TYPE_LABELS, RATE_LOCK_TYPES,
} from '../modules/orders/order-pipelines.js';
import { board, cancelOrder, createOrder, moveStage, pipelineFor } from '../modules/orders/orders.service.js';
import { decimal, errorEnvelope, idParam, isoDate, listOf, money, ok, pagination, record, uuid, weight } from './schemas.js';

const TODAY = '2026-09-18';
const seed = [{ date: TODAY, kind: 'added' as const, note: 'Orders module: five types with per-type pipelines.' }];

const lineSchema = z.object({
  lineMode: z.enum(['booking', 'custom']).default('booking')
    .describe('booking reserves existing stock; custom is made to order.'),
  title: z.string().min(1).describe('Every line needs a title.'),
  designSpecification: z.string().optional(),
  itemId: uuid.nullish(), pieceId: uuid.nullish(), purityId: uuid.nullish(), categoryId: uuid.nullish(),
  quantity: decimal.optional(), grossWeight: weight.optional(), stoneWeight: weight.optional(),
  ratePerGram: money.optional().describe('Falls back to the order’s locked rate, then today’s sale rate in Masters → Rates for the line’s purity.'),
  makingBasis: z.enum(['per_gram', 'percent', 'flat']).optional(),
  makingRate: decimal.optional(), wastagePercent: decimal.optional(),
  stoneAmount: money.optional(), discountAmount: money.optional(), gstRate: decimal.optional(),
  hsnCode: z.string().optional(), specialInstructions: z.string().optional(),
});

defineRoute({
  method: 'get', path: '/api/orders/pipelines', module: 'orders',
  summary: 'The Kanban stages for every order type',
  description:
    'Each order type has its own stage sequence — a repair genuinely has different steps from a wedding order. Read this rather than hardcoding stage names; a tenant can override the list.',
  permission: 'orders.view',
  responses: [{ status: 200, description: 'Stage definitions.', schema: z.object({
    pipelines: z.array(z.object({
      orderType: z.enum(ORDER_TYPES), label: z.string(),
      stages: z.array(z.object({ key: z.string(), label: z.string(), terminal: z.boolean().optional(), external: z.boolean().optional() })),
    })),
  }) }],
  changelog: seed,
  handler: async () => transaction(async (tx) => ({
    pipelines: await Promise.all(ORDER_TYPES.map(async (t) => ({
      orderType: t, label: ORDER_TYPE_LABELS[t], stages: await pipelineFor(tx, t),
    }))),
  })),
});

defineRoute({
  method: 'get', path: '/api/orders/board', module: 'orders',
  summary: 'The Kanban board for one order type',
  description: 'Active orders grouped into their stage columns, ready to render.',
  permission: 'orders.view',
  query: z.object({ orderType: z.enum(ORDER_TYPES), branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'Board with orders per stage.', schema: z.object({
    orderType: z.string(),
    stages: z.array(z.object({ key: z.string(), label: z.string(), orders: z.array(record) })),
  }) }],
  changelog: seed,
  handler: async (req) => {
    const q = queryOf<{ orderType: (typeof ORDER_TYPES)[number]; branchId?: string }>(req);
    return transaction((tx) => board(tx, q.orderType, q.branchId ?? null));
  },
});

defineRoute({
  method: 'get', path: '/api/orders', module: 'orders',
  summary: 'List orders',
  permission: 'orders.view',
  query: z.object({
    orderType: z.enum(ORDER_TYPES).optional(), stage: z.string().optional(),
    status: z.enum(['draft', 'active', 'completed', 'cancelled']).optional(),
    customerId: uuid.optional(), karigarId: uuid.optional(), branchId: uuid.optional(),
    from: isoDate.optional(), to: isoDate.optional(),
    search: z.string().optional().describe('Matches order number or customer name.'),
  }).merge(pagination),
  responses: [{ status: 200, description: 'Matching orders.', schema: listOf(record) }],
  changelog: seed,
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | number | undefined>>(req);
    const clauses: string[] = []; const params: unknown[] = [];
    const eq = (col: string, key: string) => { if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); } };
    eq('o.order_type', 'orderType'); eq('o.stage', 'stage'); eq('o.status', 'status');
    eq('o.customer_id', 'customerId'); eq('o.karigar_id', 'karigarId'); eq('o.branch_id', 'branchId');
    if (q.from) { params.push(q.from); clauses.push(`o.order_date >= $${params.length}`); }
    if (q.to) { params.push(q.to); clauses.push(`o.order_date <= $${params.length}`); }
    if (q.search) { params.push(`%${q.search}%`); clauses.push(`(o.order_number ilike $${params.length} or p.name ilike $${params.length})`); }
    const where = clauses.length ? `where ${clauses.join(' and ')}` : '';

    const rows = await tx.query(
      `select o.id, o.order_number, o.order_type, o.stage, o.status, o.order_date,
              o.expected_delivery_date, o.total_amount, o.balance_amount, o.advance_amount,
              o.total_net_weight, o.is_sla_breached, p.name as customer_name, p.phone as customer_phone,
              b.name as branch_name, k.name as karigar_name
         from retail_order o join party p on p.id = o.customer_id
         join branch b on b.id = o.branch_id left join karigar k on k.id = o.karigar_id
        ${where} order by o.order_date desc, o.order_number desc
        limit ${Number(q.limit ?? 50)} offset ${Number(q.offset ?? 0)}`, params);
    const counted = await tx.one<{ count: string }>(
      `select count(*)::text count from retail_order o join party p on p.id = o.customer_id ${where}`, params);
    return { rows, total: Number(counted.count), limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0) };
  }),
});

defineRoute({
  method: 'get', path: '/api/orders/:id', module: 'orders',
  summary: 'One order with everything attached',
  description: 'Lines, timeline, payments, attachments, acknowledgement and messages, in one call.',
  permission: 'orders.view', params: idParam,
  responses: [
    { status: 200, description: 'The order workspace.', schema: record },
    { status: 404, description: 'Not found.', schema: errorEnvelope },
  ],
  changelog: seed,
  handler: async (req) => transaction(async (tx) => {
    const id = param(req, 'id');
    const order = await tx.one(
      `select o.*, p.name as customer_name, p.phone as customer_phone, p.city as customer_city,
              b.name as branch_name, k.name as karigar_name, u.full_name as salesperson_name
         from retail_order o join party p on p.id = o.customer_id
         join branch b on b.id = o.branch_id
         left join karigar k on k.id = o.karigar_id
         left join app_user u on u.id = o.salesperson_id
        where o.id = $1`, [id]);
    const [lines, timeline, payments, attachments, acknowledgement, messages] = await Promise.all([
      tx.query(`select l.*, i.name as item_name, pu.code as purity_code, sp.tag_number
                  from order_line l left join item i on i.id = l.item_id
                  left join purity pu on pu.id = l.purity_id
                  left join stock_piece sp on sp.id = l.piece_id
                 where l.retail_order_id = $1 order by l.line_number`, [id]),
      tx.query(`select e.*, u.full_name as actor_name from order_stage_event e
                  left join app_user u on u.id = e.actor_user_id
                 where e.retail_order_id = $1 order by e.at`, [id]),
      tx.query(`select * from order_payment where retail_order_id = $1 order by received_at`, [id]),
      tx.query(`select * from order_attachment where retail_order_id = $1 order by kind, sort_order`, [id]),
      tx.maybeOne(`select * from order_acknowledgement where retail_order_id = $1`, [id]),
      tx.query(`select * from order_communication where retail_order_id = $1 order by sent_at desc`, [id]),
    ]);
    const stages = await pipelineFor(tx, (order as { order_type: (typeof ORDER_TYPES)[number] }).order_type);
    return { ...order, lines, timeline, payments, attachments, acknowledgement, messages, stages };
  }),
});

defineRoute({
  method: 'post', path: '/api/orders', module: 'orders',
  summary: 'Create an order',
  description:
    'One endpoint for all five types; `orderType` decides which fields are required. Corporate orders need `companyName` and `poReference`; repairs need `repairItemDescription`. Lines are priced server-side from the rate master, so the client never has to compute GST.',
  permission: 'orders.create',
  body: z.object({
    orderType: z.enum(ORDER_TYPES),
    customerId: uuid, branchId: uuid,
    orderDate: isoDate, expectedDeliveryDate: isoDate.describe('Expected delivery date is required.'),
    salespersonId: uuid.optional(), karigarId: uuid.optional(),
    rateLockType: z.enum(RATE_LOCK_TYPES).default('today'),
    lockedRatePerGram: money.optional(),
    advanceAmount: money.optional().describe('Cannot exceed the order value.'),
    lines: z.array(lineSchema).optional(),
    notes: z.string().optional(),

    requirementDescription: z.string().optional().describe('Custom orders.'),
    sizeSpecifications: z.string().optional(),
    budgetMin: money.optional(), budgetMax: money.optional(),
    manufacturingRoute: z.enum(['in_house', 'external']).optional(),
    externalManufacturerId: uuid.optional(),

    repairItemDescription: z.string().optional().describe('Required for repair orders.'),
    repairIssueDescription: z.string().optional(),
    repairIssueTypes: z.array(z.string()).optional().describe('e.g. ["clasp","stone_loose"]'),
    underWarranty: z.boolean().optional(), originalInvoiceNumber: z.string().optional(),

    eventDate: isoDate.optional().describe('Wedding orders.'), eventType: z.string().optional(),
    companyName: z.string().optional().describe('Required for corporate orders.'),
    companyGstin: z.string().optional(), poReference: z.string().optional().describe('Required for corporate orders.'),
    creditTerms: z.enum(['net_15', 'net_30', 'custom']).optional(), creditTermsNote: z.string().optional(),
    brandingNotes: z.string().optional(),
  }),
  responses: [
    { status: 201, description: 'Created, starting at the first stage of its pipeline.', schema: record },
    { status: 400, description: 'Validation failed.', schema: errorEnvelope },
    { status: 422, description: 'A business rule refused it — advance over total, back-dating off, budget inverted.', schema: errorEnvelope },
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
  method: 'post', path: '/api/orders/:id/stage', module: 'orders',
  summary: 'Move an order to another stage',
  description:
    'Moving backward is allowed but requires `reason` — it is written to the timeline and the audit stream. Reaching a terminal stage completes the order.',
  permission: 'orders.update', params: idParam,
  body: z.object({
    stage: z.string().min(1).describe('Must exist in this order type’s pipeline.'),
    reason: z.string().max(500).optional().describe('Required when moving backward.'),
    note: z.string().max(500).optional(),
  }),
  responses: [
    { status: 200, description: 'Moved.', schema: z.object({ order: record, moved: z.boolean(), direction: z.string().optional() }) },
    { status: 422, description: 'Stage not in the pipeline, or a backward move with no reason.', schema: errorEnvelope },
  ],
  changelog: [...seed, { date: TODAY, kind: 'changed', note: 'Backward moves now require a reason.' }],
  handler: async (req) => transaction((tx) => moveStage(tx, param(req, 'id'), req.body.stage, req.body.reason, req.body.note)),
});

defineRoute({
  method: 'post', path: '/api/orders/:id/cancel', module: 'orders',
  summary: 'Cancel an order',
  description: 'The order stays in the audit trail and leaves the active pipeline.',
  permission: 'orders.cancel', params: idParam,
  body: z.object({ reason: z.string().min(3).max(500) }),
  responses: [
    { status: 200, description: 'Cancelled.', schema: record },
    { status: 422, description: 'Already cancelled.', schema: errorEnvelope },
  ],
  changelog: seed,
  handler: async (req) => transaction((tx) => cancelOrder(tx, param(req, 'id'), req.body.reason)),
});

defineRoute({
  method: 'post', path: '/api/orders/:id/payments', module: 'orders',
  summary: 'Record an advance or token payment',
  permission: 'orders.update', params: idParam,
  body: z.object({
    mode: z.enum(['cash', 'card', 'upi', 'bank_transfer', 'cheque', 'emi', 'old_gold', 'scheme']),
    amount: money, reference: z.string().optional(), notes: z.string().optional(),
  }),
  responses: [{ status: 201, description: 'Recorded; the order balance is updated.', schema: record }],
  changelog: seed,
  handler: async (req, res) => {
    const row = await transaction(async (tx) => {
      const id = param(req, 'id');
      const payment = await repo(tx, 'order_payment').insert({ retail_order_id: id, ...req.body });
      await tx.query(
        `update retail_order set advance_amount = advance_amount + $2,
                balance_amount = total_amount - (advance_amount + $2) - old_gold_credit - scheme_credit,
                updated_at = now() where id = $1`, [id, req.body.amount]);
      return payment;
    });
    res.status(201).json(row);
  },
});

defineRoute({
  method: 'post', path: '/api/orders/:id/acknowledge', module: 'orders',
  summary: 'Capture the customer acknowledgement on a repair intake',
  description:
    'Required before a repair leaves the counter. Either a captured signature or a verified OTP reference — never the OTP code itself.',
  permission: 'orders.update', params: idParam,
  body: z.object({
    method: z.enum(['signature', 'otp']),
    signatureStorageKey: z.string().optional().describe('Required when method is signature.'),
    otpReference: z.string().optional().describe('The provider’s reference, required when method is otp.'),
    acknowledgedByName: z.string().optional(),
  }),
  responses: [
    { status: 201, description: 'Acknowledged.', schema: record },
    { status: 422, description: 'Evidence missing for the chosen method.', schema: errorEnvelope },
  ],
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
