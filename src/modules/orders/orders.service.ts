/**
 * Custom Orders.
 *
 * The interesting part is the stage machine. Each order type has its own
 * pipeline, a tenant may override it, and every move — forward or backward — is
 * written to the timeline. Backward moves demand a reason, because on a shop
 * floor "who moved this back to Design and why" is a question that gets asked.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { newId } from '../../core/util/id.js';
import { add, compare, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { nextDocumentNumber } from '../numbering/numbering.service.js';
import { loadPricingSettings, priceLine, totalDocument } from '../pricing/pricing.service.js';
import {
  ORDER_PIPELINES, firstStage, stageMoveDirection, type OrderType, type StageSpec,
} from './order-pipelines.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfig } from '../../core/config/config-service.js';

export interface OrderLineInput {
  lineMode?: 'booking' | 'custom';
  title: string;
  designSpecification?: string;
  itemId?: string | null;
  pieceId?: string | null;
  purityId?: string | null;
  categoryId?: string | null;
  quantity?: Decimal;
  grossWeight?: Decimal;
  stoneWeight?: Decimal;
  ratePerGram?: Decimal;
  makingBasis?: 'per_gram' | 'percent' | 'flat';
  makingRate?: Decimal;
  wastagePercent?: Decimal;
  stoneAmount?: Decimal;
  discountAmount?: Decimal;
  gstRate?: Decimal;
  hsnCode?: string;
  specialInstructions?: string;
}

export interface CreateOrderInput {
  orderType: OrderType;
  customerId: string;
  branchId: string;
  orderDate: string;
  expectedDeliveryDate: string;
  salespersonId?: string;
  karigarId?: string;
  rateLockType?: 'today' | 'floating' | 'fixed_future';
  lockedRatePerGram?: Decimal;
  lines?: OrderLineInput[];
  advanceAmount?: Decimal;
  notes?: string;

  requirementDescription?: string;
  sizeSpecifications?: string;
  budgetMin?: Decimal;
  budgetMax?: Decimal;
  manufacturingRoute?: 'in_house' | 'external';
  externalManufacturerId?: string;

  repairItemDescription?: string;
  repairIssueDescription?: string;
  repairIssueTypes?: string[];
  underWarranty?: boolean;
  originalInvoiceNumber?: string;

  eventDate?: string;
  eventType?: string;
  companyName?: string;
  companyGstin?: string;
  poReference?: string;
  creditTerms?: 'net_15' | 'net_30' | 'custom';
  creditTermsNote?: string;
  brandingNotes?: string;
}

/** The stage list for a type — tenant override if present, built-in otherwise. */
export async function pipelineFor(tx: Tx, orderType: OrderType): Promise<StageSpec[]> {
  const override = await tx.maybeOne<{ stages: StageSpec[] }>(
    `select stages from order_pipeline where order_type = $1 and is_active = true`,
    [orderType],
  );
  const stages = override?.stages;
  return Array.isArray(stages) && stages.length > 0 ? stages : ORDER_PIPELINES[orderType];
}

export async function createOrder(tx: Tx, input: CreateOrderInput) {
  const allowBackdating = await getConfig(tx, CONFIG.allowBackdating);
  const today = new Date().toISOString().slice(0, 10);
  if (!allowBackdating && input.orderDate < today) {
    throw new BusinessRuleError('Back-dated orders are switched off for this business.', 'backdating_not_allowed');
  }
  if (input.expectedDeliveryDate < input.orderDate) {
    throw new ValidationError('Expected delivery cannot be before the order date.');
  }

  const customer = await tx.maybeOne<{ id: string; name: string; is_customer: boolean; state_code: string | null }>(
    `select id, name, is_customer, state_code from party where id = $1 and deleted_at is null`,
    [input.customerId],
  );
  if (!customer) throw new NotFoundError('Customer', input.customerId);
  if (!customer.is_customer) {
    throw new BusinessRuleError(`${customer.name} is not marked as a customer.`, 'not_a_customer');
  }

  const branch = await tx.maybeOne<{ id: string; state_code: string | null }>(
    `select id, state_code from branch where id = $1 and deleted_at is null`, [input.branchId],
  );
  if (!branch) throw new NotFoundError('Branch', input.branchId);

  if (input.orderType === 'corporate' && (!input.companyName || !input.poReference)) {
    throw new ValidationError('Corporate orders need a company name and a PO reference.');
  }
  if (input.orderType === 'repair' && !input.repairItemDescription) {
    throw new ValidationError('Repair orders need an item description.');
  }
  if (input.budgetMin && input.budgetMax && compare(input.budgetMin, input.budgetMax) > 0) {
    throw new ValidationError('Minimum budget cannot exceed maximum budget.');
  }

  const interState = Boolean(branch.state_code && customer.state_code && branch.state_code !== customer.state_code);
  const settings = await loadPricingSettings(tx);
  const lines = input.lines ?? [];

  const purities = await loadPurities(tx, lines.map((l) => l.purityId));
  const todays = await masterRates(tx, lines.filter((l) => !l.ratePerGram).map((l) => l.purityId), input.branchId);
  const priced = lines.map((line) =>
    priceLine(
      {
        quantity: line.quantity,
        grossWeight: line.grossWeight ?? '0',
        stoneWeight: line.stoneWeight,
        purityPercent: line.purityId ? purities.get(line.purityId) : '100',
        ratePerGram: line.ratePerGram ?? input.lockedRatePerGram ?? (line.purityId ? todays.get(line.purityId) : undefined) ?? '0',
        makingBasis: line.makingBasis,
        makingRate: line.makingRate,
        wastagePercent: line.wastagePercent,
        stoneAmount: line.stoneAmount,
        discountAmount: line.discountAmount,
        gstRate: line.gstRate,
        interState,
      },
      settings,
    ),
  );

  const totals = totalDocument(priced, settings);
  const advance = input.advanceAmount ?? '0';
  if (compare(advance, totals.totalAmount) > 0 && compare(totals.totalAmount, '0') > 0) {
    throw new BusinessRuleError('Advance cannot exceed the order value.', 'advance_exceeds_total');
  }

  const { number } = await nextDocumentNumber(tx, 'retail_order', {
    branchId: input.branchId, date: new Date(input.orderDate),
  });

  const orderId = newId();
  const order = await repo(tx, 'retail_order').insert({
    id: orderId,
    order_number: number,
    order_type: input.orderType,
    status: 'active',
    stage: firstStage(input.orderType),
    branch_id: input.branchId,
    customer_id: input.customerId,
    salesperson_id: input.salespersonId ?? tx.context.userId,
    karigar_id: input.karigarId ?? null,
    order_date: input.orderDate,
    expected_delivery_date: input.expectedDeliveryDate,
    rate_lock_type: input.rateLockType ?? 'today',
    locked_rate_per_gram: input.lockedRatePerGram ?? null,
    rate_locked_at: input.lockedRatePerGram ? new Date() : null,
    metal_amount: totals.metalAmount,
    making_amount: totals.makingAmount,
    stone_amount: totals.stoneAmount,
    discount_amount: totals.discountAmount,
    taxable_amount: totals.taxableAmount,
    cgst_amount: totals.cgstAmount,
    sgst_amount: totals.sgstAmount,
    igst_amount: totals.igstAmount,
    total_amount: totals.totalAmount,
    advance_amount: advance,
    balance_amount: sub(totals.totalAmount, advance),
    total_gross_weight: totals.totalGrossWeight,
    total_net_weight: totals.totalNetWeight,
    requirement_description: input.requirementDescription ?? null,
    size_specifications: input.sizeSpecifications ?? null,
    budget_min: input.budgetMin ?? null,
    budget_max: input.budgetMax ?? null,
    manufacturing_route: input.manufacturingRoute ?? null,
    external_manufacturer_id: input.externalManufacturerId ?? null,
    design_approval: input.orderType === 'custom' ? 'pending' : null,
    production_status: input.orderType === 'custom' ? 'not_started' : null,
    repair_item_description: input.repairItemDescription ?? null,
    repair_issue_description: input.repairIssueDescription ?? null,
    repair_issue_types: JSON.stringify(input.repairIssueTypes ?? []),
    under_warranty: input.underWarranty ?? false,
    original_invoice_number: input.originalInvoiceNumber ?? null,
    event_date: input.eventDate ?? null,
    event_type: input.eventType ?? null,
    company_name: input.companyName ?? null,
    company_gstin: input.companyGstin ?? null,
    po_reference: input.poReference ?? null,
    credit_terms: input.creditTerms ?? null,
    credit_terms_note: input.creditTermsNote ?? null,
    branding_notes: input.brandingNotes ?? null,
    notes: input.notes ?? null,
  });

  if (lines.length) {
    await repo(tx, 'order_line').insertMany(
      priced.map((p, i) => {
        const line = lines[i]!;
        return {
          retail_order_id: orderId,
          line_number: i + 1,
          line_mode: line.lineMode ?? 'booking',
          title: line.title,
          design_specification: line.designSpecification ?? null,
          item_id: line.itemId ?? null,
          piece_id: line.pieceId ?? null,
          purity_id: line.purityId ?? null,
          category_id: line.categoryId ?? null,
          hsn_code: line.hsnCode ?? null,
          special_instructions: line.specialInstructions ?? null,
          quantity: p.quantity,
          gross_weight: p.grossWeight,
          stone_weight: p.stoneWeight,
          net_weight: p.netWeight,
          rate_per_gram: p.ratePerGram,
          metal_amount: p.metalAmount,
          making_basis: p.makingBasis,
          making_rate: p.makingRate,
          making_amount: p.makingAmount,
          wastage_percent: p.wastagePercent,
          stone_amount: p.stoneAmount,
          discount_amount: p.discountAmount,
          taxable_amount: p.taxableAmount,
          gst_rate: p.gstRate,
          cgst_amount: p.cgstAmount,
          sgst_amount: p.sgstAmount,
          igst_amount: p.igstAmount,
          line_total: p.lineTotal,
        };
      }),
    );
  }

  await recordStage(tx, orderId, null, firstStage(input.orderType), 'forward', 'Order created');
  if (compare(advance, '0') > 0) {
    await repo(tx, 'order_payment').insert({
      retail_order_id: orderId, mode: 'cash', amount: advance, notes: 'Advance at booking',
    });
  }

  return order;
}

/**
 * Today's sale rate per purity from Masters → Rates (a branch rate beats the
 * shared one), for lines that arrive without a rate of their own.
 */
export async function masterRates(
  tx: Tx, purityIds: Array<string | null | undefined>, branchId: string | null,
): Promise<Map<string, Decimal>> {
  const wanted = [...new Set(purityIds.filter((i): i is string => Boolean(i)))];
  if (!wanted.length) return new Map();
  const rows = await tx.query<{ purity_id: string; rate: Decimal }>(
    `select distinct on (purity_id) purity_id, rate_per_gram::text as rate
       from metal_rate
      where purity_id = any($1::uuid[]) and effective_from <= now() and retired_at is null
        and (branch_id = $2 or branch_id is null)
      order by purity_id, effective_from desc, branch_id nulls last`,
    [wanted, branchId],
  );
  return new Map(rows.map((r) => [r.purity_id, r.rate]));
}

async function loadPurities(tx: Tx, ids: Array<string | null | undefined>): Promise<Map<string, Decimal>> {
  const wanted = [...new Set(ids.filter((i): i is string => Boolean(i)))];
  if (!wanted.length) return new Map();
  const rows = await tx.query<{ id: string; fineness_percent: Decimal }>(
    `select id, fineness_percent from purity where id = any($1::uuid[])`, [wanted],
  );
  return new Map(rows.map((r) => [r.id, r.fineness_percent]));
}

async function recordStage(
  tx: Tx, orderId: string, from: string | null, to: string,
  direction: 'forward' | 'backward' | 'same', note?: string, reason?: string,
): Promise<void> {
  await tx.query(
    `insert into order_stage_event (id, tenant_id, retail_order_id, from_stage, to_stage, direction, reason, note, actor_user_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [newId(), tx.context.tenantId, orderId, from, to, direction, reason ?? null, note ?? null, tx.context.userId],
  );
}

export async function moveStage(tx: Tx, orderId: string, toStage: string, reason?: string, note?: string) {
  const order = await tx.maybeOne<{ id: string; order_type: OrderType; stage: string; status: string }>(
    `select id, order_type, stage, status from retail_order where id = $1 for update`, [orderId],
  );
  if (!order) throw new NotFoundError('Order', orderId);
  if (order.status === 'cancelled') throw new BusinessRuleError('This order was cancelled.', 'cancelled');

  const stages = await pipelineFor(tx, order.order_type);
  const target = stages.find((s) => s.key === toStage);
  if (!target) {
    throw new BusinessRuleError(
      `"${toStage}" is not a stage for a ${order.order_type} order. Valid stages: ${stages.map((s) => s.key).join(', ')}.`,
      'invalid_stage_move',
      { validStages: stages.map((s) => s.key) },
    );
  }

  const direction = stageMoveDirection(order.order_type, order.stage, toStage);
  if (direction === 'same') return { order, moved: false };
  if (direction === 'invalid') {
    // The order is sitting on a stage the current pipeline no longer contains,
    // which happens when a tenant edits the pipeline under live orders.
    throw new BusinessRuleError(
      `This order is on stage "${order.stage}", which is no longer part of the ${order.order_type} pipeline. Fix the pipeline in Settings, or move the order to a valid stage.`,
      'invalid_stage_move',
      { currentStage: order.stage, validStages: stages.map((s) => s.key) },
    );
  }
  // Going backwards is allowed, but it has to be explained.
  if (direction === 'backward' && !reason) {
    throw new BusinessRuleError(
      'Moving an order backward needs a reason — it is written to the audit trail.',
      'backward_move_needs_reason',
    );
  }

  const updated = await tx.one(
    `update retail_order
        set stage = $2,
            status = case when $3 then 'completed' else status end,
            delivered_at = case when $3 then now() else delivered_at end,
            updated_at = now(), updated_by = $4
      where id = $1 returning *`,
    [orderId, toStage, Boolean(target.terminal), tx.context.userId],
  );

  await recordStage(tx, orderId, order.stage, toStage, direction, note, reason);
  return { order: updated, moved: true, direction };
}

export async function cancelOrder(tx: Tx, orderId: string, reason: string) {
  const order = await tx.maybeOne<{ id: string; status: string; stage: string }>(
    `select id, status, stage from retail_order where id = $1 for update`, [orderId],
  );
  if (!order) throw new NotFoundError('Order', orderId);
  if (order.status === 'cancelled') throw new BusinessRuleError('Already cancelled.', 'already_cancelled');

  await recordStage(tx, orderId, order.stage, order.stage, 'same', `Cancelled: ${reason}`, reason);
  // The order stays in the audit trail; it just leaves the active pipeline.
  return tx.one(
    `update retail_order set status = 'cancelled', cancelled_at = now(), cancel_reason = $2,
            updated_at = now(), updated_by = $3
      where id = $1 returning *`,
    [orderId, reason, tx.context.userId],
  );
}

/** The Kanban board: every active order grouped by stage, for one order type. */
export async function board(tx: Tx, orderType: OrderType, branchId?: string | null) {
  const stages = await pipelineFor(tx, orderType);
  const params: unknown[] = [orderType];
  let branchClause = '';
  if (branchId) { params.push(branchId); branchClause = ` and o.branch_id = $${params.length}`; }

  const rows = await tx.query<Record<string, unknown>>(
    `select o.id, o.order_number, o.stage, o.status, o.order_date, o.expected_delivery_date,
            o.total_amount, o.balance_amount, o.total_net_weight, o.is_sla_breached,
            p.name as customer_name, k.name as karigar_name,
            (select title from order_line l where l.retail_order_id = o.id order by line_number limit 1) as first_line_title
       from retail_order o
       join party p on p.id = o.customer_id
       left join karigar k on k.id = o.karigar_id
      where o.order_type = $1 and o.status = 'active'${branchClause}
      order by o.expected_delivery_date`,
    params,
  );

  return {
    orderType,
    stages: stages.map((stage) => ({
      ...stage,
      orders: rows.filter((r) => r.stage === stage.key),
    })),
  };
}
