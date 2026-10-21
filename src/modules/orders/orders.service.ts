/**
 * Custom Orders.
 *
 * An order is a promise, not a transaction: taking one moves no stock and
 * writes no ledger entry. What it does do is hold a rate, reserve any piece
 * promised off the shelf, and take advances — and an advance *is* money, so it
 * posts the moment it is taken, exactly as a counter receipt does. The finished
 * order is billed at the counter, which is where stock and GST actually move.
 *
 * Each order type walks its own stage list, a tenant may override it, and every
 * move — forward or back — is written to the timeline. Backward moves demand a
 * reason, because "who moved this back to Design, and why" gets asked.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { newId } from '../../core/util/id.js';
import { add, compare, div, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { loadPricer, type PriceRequest } from '../masters/pricing/pricing.service.js';
import { postVoucher, reverseVoucher, type MoneyEntry } from '../accounts/ledger.service.js';
import { paymentAccount } from '../purchase/purchase.service.js';
import { modeCharges, postingSettings } from '../accounts/posting.js';
import { activeCustomer, checkCashLimit } from '../sales/sales.service.js';
import { hasPermission } from '../identity/permissions.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { ORDER_PIPELINES, firstStage, stageMoveDirection, type OrderType, type StageSpec } from './order-pipelines.js';

const rs = (v: Decimal) => round(v, 2);
const g3 = (v: Decimal) => round(v, 3);
const inr = (v: Decimal | number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SETTINGS = {
  rateLock: CONFIG.orderRateLock, rateLockDays: CONFIG.orderRateLockDays, onExpiry: CONFIG.orderRateLockOnExpiry,
  allowRateChange: CONFIG.orderRateLockAllowChange, advanceMinPercent: CONFIG.orderAdvanceMinPercent,
  requireFullPayment: CONFIG.orderDeliveryNeedsFullPayment, repairInvoiceType: CONFIG.orderRepairInvoiceType,
  repairSac: CONFIG.orderRepairSac, repairGstPercent: CONFIG.orderRepairGstPercent,
  excessGhat: CONFIG.orderKarigarExcessGhat, slaWarnDays: CONFIG.orderSlaWarnDays,
};
/** Every Orders setting, for the desk and the board. Anyone with orders.view may read them. */
export const orderSettings = (tx: Tx) => getConfigMany(tx, SETTINGS);
export type OrderSettings = Awaited<ReturnType<typeof orderSettings>>;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

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
  stoneAmount?: Decimal;
  makingBasis?: 'per_gram' | 'percent' | 'flat';
  makingRate?: Decimal;
  wastagePercent?: Decimal;
  discountAmount?: Decimal;
  hsnCode?: string;
  specialInstructions?: string;
  /** For work that cannot be priced yet: what the customer was quoted. */
  estimatedAmount?: Decimal;
}

export interface CustodyItemInput {
  description: string;
  tokenNumber?: string;
  metalId?: string;
  purityId?: string;
  testedPurityPercent?: Decimal;
  grossWeight?: Decimal;
  stoneWeight?: Decimal;
  declaredValue?: Decimal;
  conditionNotes?: string;
  whereKept?: string;
}

export interface CreateOrderInput {
  orderType: OrderType;
  customerId: string;
  orderDate?: string;
  expectedDeliveryDate: string;
  salespersonId?: string;
  karigarId?: string;
  rateLockType?: 'booking' | 'delivery' | 'fixed';
  lockedRatePerGram?: Decimal;
  lines?: OrderLineInput[];
  /** The customer's own jewellery left with the shop (repairs, metal for making). */
  custodyItems?: CustodyItemInput[];
  advance?: { paymentMethodId: string; amount: Decimal; reference?: string };
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
  repairServiceCharge?: Decimal;
  repairInvoiceType?: 'service' | 'goods';
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

/* ------------------------------------------------------------------ stages */

/** The stage list for a type — the tenant's own if it set one, the built-in otherwise. */
export async function pipelineFor(tx: Tx, orderType: OrderType): Promise<StageSpec[]> {
  const override = await tx.maybeOne<{ stages: StageSpec[] }>(
    `select stages from order_pipeline where order_type = $1 and is_active = true`, [orderType]);
  const stages = override?.stages;
  return Array.isArray(stages) && stages.length > 0 ? stages : ORDER_PIPELINES[orderType];
}

/* ----------------------------------------------------------- master rates */

/**
 * Today's rate per actual gram for each purity, resolved the same way the
 * counter's pricer does: a rate set for that exact purity wins; otherwise the
 * metal's pure (100%) rate brought down by the purity's fineness. The pure
 * rate is a base (no-purity) row, or the purest purity's rate scaled to 100%.
 * Returned per gram of real metal, so metalAmount = net weight × this rate —
 * which matches `priceLine` whether the shop values on net or fine weight.
 *
 * Used by bulk order import, where lines are priced without going through the
 * full pricer (some rows have no item/HSN yet). Purities with no usable rate
 * are simply left out of the map, so the caller can flag those rows.
 */
export async function masterRates(
  tx: Tx,
  purityIds: Array<string | null | undefined>,
  branchId: string | null,
): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  const ids = [...new Set(purityIds.filter((v): v is string => Boolean(v)))];
  if (!ids.length) return out;

  const purities = await tx.query<{ id: string; metal_id: string; fineness: Decimal }>(
    `select id, metal_id, fineness_percent::text as fineness from purity where id = any($1::uuid[])`,
    [ids]);
  if (!purities.length) return out;

  const metalIds = [...new Set(purities.map((p) => p.metal_id))];
  // Every purity of those metals, so a missing purity-specific rate can fall
  // back to the purest purity's rate brought up to 100%.
  const allPurities = await tx.query<{ id: string; metal_id: string; fineness: Decimal }>(
    `select id, metal_id, fineness_percent::text as fineness from purity where metal_id = any($1::uuid[])`,
    [metalIds]);
  // Latest effective, non-retired rate per (metal, purity); a branch rate wins
  // over the all-branch rate.
  const rates = await tx.query<{ metal_id: string; purity_id: string | null; rate: Decimal }>(
    `select distinct on (metal_id, purity_id) metal_id, purity_id, rate_per_gram::text as rate
       from metal_rate
      where metal_id = any($1::uuid[]) and effective_from <= now() and retired_at is null
        and (branch_id = $2 or branch_id is null)
      order by metal_id, purity_id, effective_from desc, branch_id nulls last`,
    [metalIds, branchId]);

  const purityById = new Map(allPurities.map((p) => [p.id, p]));
  const pureRateOf = (metalId: string): Decimal | null => {
    const base = rates.find((r) => r.metal_id === metalId && r.purity_id === null);
    if (base) return base.rate;
    const purest = rates
      .filter((r) => r.metal_id === metalId && r.purity_id && purityById.has(r.purity_id))
      .sort((a, b) => compare(purityById.get(b.purity_id!)!.fineness, purityById.get(a.purity_id!)!.fineness))[0];
    if (!purest) return null;
    return round(div(mul(purest.rate, '100'), purityById.get(purest.purity_id!)!.fineness), 2);
  };

  for (const p of purities) {
    const own = rates.find((r) => r.metal_id === p.metal_id && r.purity_id === p.id);
    if (own) { out.set(p.id, own.rate); continue; }
    const pure = pureRateOf(p.metal_id);
    if (pure) out.set(p.id, round(div(mul(pure, p.fineness), '100'), 2));
  }
  return out;
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

/* --------------------------------------------------------------- rate lock */

export interface RateDecision {
  /** Which rate the bill should use. */
  source: 'booking' | 'delivery' | 'fixed';
  /** The held rate, when there is one. Null means "today's rate". */
  ratePerGram: Decimal | null;
  expired: boolean;
  /** Shown to whoever bills the order, so the customer can be told why. */
  note: string;
}

const day = (v: string | Date | null | undefined) => (v ? new Date(v).toISOString().slice(0, 10) : null);

/**
 * Which rate an order is billed at, from its own lock and the shop's settings.
 * A held rate survives until the order is delivered unless the shop set a limit.
 */
export function rateDecisionFor(
  order: { rate_lock_type: string; locked_rate_per_gram: Decimal | null; rate_locked_at: Date | string | null; rate_lock_expires_at: Date | string | null },
  settings: Pick<OrderSettings, 'onExpiry'>,
  today: string,
): RateDecision {
  const locked = order.locked_rate_per_gram;
  if (order.rate_lock_type === 'delivery' || !locked) {
    return { source: 'delivery', ratePerGram: null, expired: false, note: 'Priced at today’s rate.' };
  }
  if (order.rate_lock_type === 'fixed') {
    return { source: 'fixed', ratePerGram: locked, expired: false, note: `Priced at the agreed rate of ${inr(locked)} per gram.` };
  }
  const expiresOn = day(order.rate_lock_expires_at);
  const lockedOn = day(order.rate_locked_at);
  const expired = Boolean(expiresOn && today > expiresOn);
  if (expired && settings.onExpiry === 'delivery_rate') {
    return { source: 'delivery', ratePerGram: null, expired: true, note: `The rate held from ${lockedOn} ran out on ${expiresOn}; today’s rate applies.` };
  }
  return {
    source: 'booking', ratePerGram: locked, expired,
    note: expired
      ? `The rate held from ${lockedOn} ran out on ${expiresOn}, but the shop honours it: ${inr(locked)} per gram.`
      : `Priced at ${inr(locked)} per gram, held from ${lockedOn}.`,
  };
}

/* ----------------------------------------------------------------- pricing */

interface PricedOrderLine {
  input: OrderLineInput;
  estimate: boolean;
  quantity: Decimal; grossWeight: Decimal; stoneWeight: Decimal; netWeight: Decimal;
  ratePerGram: Decimal; metalAmount: Decimal;
  makingBasis: 'per_gram' | 'percent' | 'flat'; makingRate: Decimal; makingAmount: Decimal;
  wastagePercent: Decimal; stoneAmount: Decimal; discountAmount: Decimal;
  taxableAmount: Decimal; gstRate: Decimal; cgst: Decimal; sgst: Decimal; igst: Decimal; lineTotal: Decimal;
  hsnCode: string | null;
}

/**
 * Prices an order's lines through the same engine the counter uses, so the
 * figure quoted at booking and the figure billed at delivery come from one
 * place. A line with no purity or weight yet is carried as the estimate it is.
 */
async function priceOrderLines(
  tx: Tx, lines: OrderLineInput[], rate: Decimal | null, customerStateCode: string | null,
): Promise<PricedOrderLine[]> {
  const blank = (l: OrderLineInput): PricedOrderLine => ({
    input: l, estimate: true,
    quantity: g3(l.quantity ?? '1'), grossWeight: g3(l.grossWeight ?? '0'), stoneWeight: g3(l.stoneWeight ?? '0'),
    netWeight: g3(sub(l.grossWeight ?? '0', l.stoneWeight ?? '0')),
    ratePerGram: '0', metalAmount: '0', makingBasis: l.makingBasis ?? 'per_gram', makingRate: l.makingRate ?? '0', makingAmount: '0',
    wastagePercent: l.wastagePercent ?? '0', stoneAmount: rs(l.stoneAmount ?? '0'), discountAmount: rs(l.discountAmount ?? '0'),
    taxableAmount: '0', gstRate: '0', cgst: '0', sgst: '0', igst: '0', lineTotal: rs(l.estimatedAmount ?? '0'),
    hsnCode: l.hsnCode ?? null,
  });

  const canPrice = (l: OrderLineInput) => Boolean(l.purityId) && Boolean(l.itemId) && compare(l.grossWeight ?? '0', '0') > 0;
  const pricable = lines.filter(canPrice);
  if (!pricable.length) return lines.map(blank);

  const metalOf = await purityMetals(tx, pricable.map((l) => l.purityId!));
  // A piece already on the shelf is priced on the terms written on its tag — the
  // same ones the counter will use — so the price quoted at booking is the price billed.
  const tagOf = await pieceTagTerms(tx, pricable.map((l) => l.pieceId).filter(Boolean) as string[]);
  const reqs: PriceRequest[] = pricable.map((l) => ({
    metalId: metalOf.get(l.purityId!) ?? '', purityId: l.purityId!, itemId: l.itemId ?? null, categoryId: l.categoryId ?? null,
    hsnCode: l.hsnCode ?? null, quantity: Number(l.quantity ?? 1), grossWeightG: String(l.grossWeight ?? '0'),
    stoneWeightG: String(l.stoneWeight ?? '0'), stoneAmount: String(l.stoneAmount ?? '0'),
    discount: compare(l.discountAmount ?? '0', '0') > 0 ? { amount: String(l.discountAmount), on: 'charges' as const } : null,
    customerStateCode,
    tag: l.pieceId ? tagOf.get(l.pieceId) : undefined,
    override: {
      ...(rate ? { ratePerGram: String(rate) } : {}),
      ...(l.makingRate !== undefined ? { making: { id: null, basis: l.makingBasis ?? 'per_gram', rate: String(l.makingRate), flatAmount: String(l.makingRate), slabs: [], slabMode: 'whole' as const, minimumAmount: null } } : {}),
    },
  }));
  const price = await loadPricer(tx, reqs);

  let at = -1;
  return lines.map((l) => {
    if (!canPrice(l)) return blank(l);
    at += 1;
    const p = price(reqs[at]!);
    return {
      input: l, estimate: false,
      quantity: g3(l.quantity ?? '1'), grossWeight: g3(l.grossWeight ?? '0'), stoneWeight: g3(l.stoneWeight ?? '0'), netWeight: g3(p.netWeightG),
      ratePerGram: rs(p.snapshot.ratePerGram), metalAmount: rs(p.metalAmount),
      makingBasis: (p.snapshot.making?.basis as PricedOrderLine['makingBasis']) ?? 'per_gram',
      makingRate: p.snapshot.making?.rate ?? p.snapshot.making?.flatAmount ?? '0', makingAmount: rs(p.makingAmount),
      wastagePercent: p.snapshot.wastage?.rate ?? '0', stoneAmount: rs(p.stoneAmount), discountAmount: rs(p.discountAmount),
      taxableAmount: rs(p.taxableAmount), gstRate: p.taxBreakup[0]?.ratePercent ?? '0',
      cgst: rs(p.cgstAmount), sgst: rs(p.sgstAmount), igst: rs(p.igstAmount), lineTotal: rs(p.lineTotal),
      hsnCode: p.snapshot.hsnCode ?? l.hsnCode ?? null,
    };
  });
}

/** Making and wastage as written on each tag, for pieces an order has promised. */
async function pieceTagTerms(tx: Tx, pieceIds: string[]): Promise<Map<string, NonNullable<PriceRequest['tag']>>> {
  const wanted = [...new Set(pieceIds)];
  const found = new Map<string, NonNullable<PriceRequest['tag']>>();
  if (!wanted.length) return found;
  const rows = await tx.query<{ id: string; making_basis: 'per_gram' | 'flat' | 'percent' | null; making_rate: Decimal | null; wastage_percent: Decimal | null }>(
    `select id, making_basis, making_rate, wastage_percent from stock_piece where id = any($1::uuid[])`, [wanted]);
  for (const row of rows) {
    found.set(row.id, {
      making: row.making_basis && row.making_rate !== null ? { id: null, basis: row.making_basis, rate: row.making_rate } : null,
      wastage: row.wastage_percent !== null ? { id: null, basis: 'percent', rate: row.wastage_percent } : null,
    });
  }
  return found;
}

async function purityMetals(tx: Tx, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)];
  if (!wanted.length) return new Map();
  const rows = await tx.query<{ id: string; metal_id: string }>(
    `select id, metal_id from purity where id = any($1::uuid[])`, [wanted]);
  return new Map(rows.map((r) => [r.id, r.metal_id]));
}

/* ------------------------------------------------------------ reservations */

/**
 * A piece promised off the shelf is held for that order: it stays in stock,
 * still owned and still valued, but it cannot be promised twice and the counter
 * will only bill it against the order holding it.
 */
async function reservePieces(tx: Tx, orderId: string, branchId: string, pieceIds: string[]): Promise<void> {
  for (const pieceId of [...new Set(pieceIds)]) {
    const piece = await tx.maybeOne<{ id: string; tag_number: string; status: string; reserved_order_id: string | null; branch: string | null }>(
      `select p.id, p.tag_number, p.status, p.reserved_order_id, l.branch_id as branch
         from stock_piece p join stock_location l on l.id = p.location_id where p.id = $1 for update of p`, [pieceId]);
    if (!piece) throw new NotFoundError('Piece', pieceId);
    if (piece.branch !== branchId) throw new BusinessRuleError(`${piece.tag_number} is at another branch.`, 'piece_other_branch');
    if (piece.status !== 'in_stock') {
      throw new BusinessRuleError(`${piece.tag_number} is ${piece.status.replace('_', ' ')}, so it cannot be promised.`, 'piece_not_in_stock');
    }
    if (piece.reserved_order_id && piece.reserved_order_id !== orderId) {
      const held = await tx.maybeOne<{ order_number: string; name: string }>(
        `select o.order_number, p.name from retail_order o join party p on p.id = o.customer_id where o.id = $1`, [piece.reserved_order_id]);
      throw new BusinessRuleError(
        `${piece.tag_number} is already booked on ${held?.order_number} for ${held?.name}. Choose another piece.`, 'piece_reserved');
    }
    await tx.query(
      `update stock_piece set reserved_order_id = $2, reserved_at = now(), updated_at = now(), updated_by = $3 where id = $1`,
      [pieceId, orderId, tx.context.userId]);
  }
}

/** Lets a piece go again — the order was cancelled, or the line dropped. */
async function releasePieces(tx: Tx, orderId: string): Promise<void> {
  await tx.query(
    `update stock_piece set reserved_order_id = null, reserved_at = null, updated_at = now(), updated_by = $2
      where reserved_order_id = $1`, [orderId, tx.context.userId]);
}

/* ------------------------------------------------------------------ create */

export async function createOrder(tx: Tx, input: CreateOrderInput) {
  const branchId = branchOf(tx);
  const s = await orderSettings(tx);
  const today = await businessDate(tx);
  const orderDate = input.orderDate ?? today;
  if (orderDate > today) throw new BusinessRuleError('An order cannot be dated in the future.', 'future_date');
  if (input.expectedDeliveryDate < orderDate) {
    throw new ValidationError('The delivery date cannot be before the order date.');
  }

  const customer = await activeCustomer(tx, input.customerId);
  if (customer.code === 'WALKIN') {
    throw new BusinessRuleError('An order needs the customer’s name. Choose or add the customer.', 'walk_in_not_allowed');
  }

  if (input.orderType === 'corporate' && (!input.companyName?.trim() || !input.poReference?.trim())) {
    throw new ValidationError('A corporate order needs the company name and their PO reference.');
  }
  if (input.orderType === 'repair' && !input.repairItemDescription?.trim()) {
    throw new ValidationError('A repair needs a description of the item taken in.');
  }
  if (input.budgetMin && input.budgetMax && compare(input.budgetMin, input.budgetMax) > 0) {
    throw new ValidationError('The smallest budget cannot be more than the largest.');
  }

  /* The rate this order is held at. */
  const lockType = input.rateLockType ?? s.rateLock;
  let lockedRate: Decimal | null = null;
  let expiresAt: Date | null = null;
  if (lockType === 'fixed') {
    if (!input.lockedRatePerGram || !(compare(input.lockedRatePerGram, '0') > 0)) {
      throw new ValidationError('Enter the rate agreed with the customer.');
    }
    lockedRate = rs(input.lockedRatePerGram);
  } else if (lockType === 'booking') {
    lockedRate = input.lockedRatePerGram ? rs(input.lockedRatePerGram) : null;
    const days = Number(s.rateLockDays);
    if (days > 0) expiresAt = new Date(new Date(`${orderDate}T00:00:00Z`).getTime() + days * 86_400_000);
  }

  const lines = input.lines ?? [];
  const priced = await priceOrderLines(tx, lines, lockedRate, customer.state_code);
  const totals = {
    metal: sum(priced.map((p) => p.metalAmount)), making: sum(priced.map((p) => p.makingAmount)),
    stone: sum(priced.map((p) => p.stoneAmount)), discount: sum(priced.map((p) => p.discountAmount)),
    taxable: sum(priced.map((p) => p.taxableAmount)), cgst: sum(priced.map((p) => p.cgst)),
    sgst: sum(priced.map((p) => p.sgst)), igst: sum(priced.map((p) => p.igst)),
    total: sum(priced.map((p) => p.lineTotal)),
    gross: sum(priced.map((p) => p.grossWeight)), net: sum(priced.map((p) => p.netWeight)),
  };
  /* A repair's labour is the order's value when there is nothing else on it. */
  const repairCharge = rs(input.repairServiceCharge ?? '0');
  const orderTotal = rs(add(totals.total, repairCharge));

  const advance = input.advance ? rs(input.advance.amount) : '0';
  if (compare(advance, orderTotal) > 0 && compare(orderTotal, '0') > 0) {
    throw new BusinessRuleError(`The advance cannot be more than the order of ${inr(orderTotal)}.`, 'advance_exceeds_total');
  }
  const minPercent = Number(s.advanceMinPercent);
  if (minPercent > 0 && compare(orderTotal, '0') > 0) {
    const needed = rs(div(mul(orderTotal, String(minPercent)), '100'));
    if (compare(advance, needed) < 0) {
      throw new BusinessRuleError(`This shop takes at least ${minPercent}% in advance — ${inr(needed)} on this order.`, 'advance_below_minimum');
    }
  }

  const { numbers: [orderNumber] } = await reserveDocumentNumbers(tx, 'retail_order', 1, { branchId, date: new Date(orderDate) });
  const orderId = newId();
  const order = await repo<{ id: string; order_number: string }>(tx, 'retail_order').insert({
    id: orderId,
    order_number: orderNumber,
    order_type: input.orderType,
    status: 'active',
    stage: firstStage(input.orderType),
    branch_id: branchId,
    customer_id: customer.id,
    salesperson_id: input.salespersonId ?? tx.context.userId,
    karigar_id: input.karigarId ?? null,
    order_date: orderDate,
    expected_delivery_date: input.expectedDeliveryDate,
    rate_lock_type: lockType,
    locked_rate_per_gram: lockedRate,
    rate_locked_at: lockedRate ? new Date() : null,
    rate_lock_expires_at: expiresAt,
    metal_amount: totals.metal, making_amount: totals.making, stone_amount: totals.stone, discount_amount: totals.discount,
    taxable_amount: totals.taxable, cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
    total_amount: orderTotal, advance_amount: '0', balance_amount: orderTotal,
    total_gross_weight: totals.gross, total_net_weight: totals.net,
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
    repair_invoice_type: input.repairInvoiceType ?? null,
    repair_service_charge: repairCharge,
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

  if (priced.length) {
    await repo(tx, 'order_line').insertMany(priced.map((p, i) => ({
      retail_order_id: orderId, line_number: i + 1, line_mode: p.input.lineMode ?? 'booking',
      title: p.input.title, design_specification: p.input.designSpecification ?? null,
      item_id: p.input.itemId ?? null, piece_id: p.input.pieceId ?? null, purity_id: p.input.purityId ?? null,
      category_id: p.input.categoryId ?? null, hsn_code: p.hsnCode, special_instructions: p.input.specialInstructions ?? null,
      is_estimate: p.estimate,
      quantity: p.quantity, gross_weight: p.grossWeight, stone_weight: p.stoneWeight, net_weight: p.netWeight,
      rate_per_gram: p.ratePerGram, metal_amount: p.metalAmount, making_basis: p.makingBasis, making_rate: p.makingRate,
      making_amount: p.makingAmount, wastage_percent: p.wastagePercent, stone_amount: p.stoneAmount,
      discount_amount: p.discountAmount, taxable_amount: p.taxableAmount, gst_rate: p.gstRate,
      cgst_amount: p.cgst, sgst_amount: p.sgst, igst_amount: p.igst, line_total: p.lineTotal,
    })));
  }

  const pieceIds = lines.map((l) => l.pieceId).filter((p): p is string => Boolean(p));
  if (pieceIds.length) await reservePieces(tx, orderId, branchId, pieceIds);

  const custody = input.custodyItems ?? [];
  if (custody.length) {
    await repo(tx, 'order_custody_item').insertMany(custody.map((c, i) => ({
      retail_order_id: orderId, line_number: i + 1,
      token_number: c.tokenNumber?.trim() || `${orderNumber}/${i + 1}`,
      description: c.description, metal_id: c.metalId ?? null, purity_id: c.purityId ?? null,
      tested_purity_percent: c.testedPurityPercent ?? null,
      gross_weight: g3(c.grossWeight ?? '0'), stone_weight: g3(c.stoneWeight ?? '0'),
      net_weight: g3(sub(c.grossWeight ?? '0', c.stoneWeight ?? '0')),
      declared_value: c.declaredValue ?? null, condition_notes: c.conditionNotes ?? null,
      where_kept: c.whereKept ?? null, status: 'received', received_on: orderDate,
    })));
  }

  await recordStage(tx, orderId, null, firstStage(input.orderType), 'forward', `Order taken: ${orderNumber}`);
  if (input.advance && compare(advance, '0') > 0) {
    await addOrderPayment(tx, orderId, { ...input.advance, amount: advance });
  }
  return orderDetail(tx, orderId);
}

/* ------------------------------------------------------------------ update */

export interface UpdateOrderInput {
  expectedDeliveryDate?: string;
  karigarId?: string | null;
  notes?: string | null;
  rateLockType?: 'booking' | 'delivery' | 'fixed';
  lockedRatePerGram?: Decimal | null;
  /** Given, these replace every line. Pieces no longer on the order are let go. */
  lines?: OrderLineInput[];

  requirementDescription?: string | null;
  sizeSpecifications?: string | null;
  budgetMin?: Decimal | null;
  budgetMax?: Decimal | null;
  manufacturingRoute?: 'in_house' | 'external' | null;
  externalManufacturerId?: string | null;
  designApproval?: 'pending' | 'approved' | 'revision_requested' | null;
  productionStatus?: 'not_started' | 'sent_to_manufacturer' | 'quote_received' | 'in_production' | 'completed' | null;

  repairItemDescription?: string | null;
  repairIssueDescription?: string | null;
  repairIssueTypes?: string[];
  repairServiceCharge?: Decimal;
  repairInvoiceType?: 'service' | 'goods' | null;
  underWarranty?: boolean;
  originalInvoiceNumber?: string | null;
  estimateApproved?: { byName?: string } | null;

  eventDate?: string | null;
  eventType?: string | null;
  companyName?: string | null;
  companyGstin?: string | null;
  poReference?: string | null;
  creditTerms?: 'net_15' | 'net_30' | 'custom' | null;
  creditTermsNote?: string | null;
  brandingNotes?: string | null;
}

/**
 * Changes an order that has not been delivered yet. Everything a shop actually
 * has to change after taking an order lives here: the date, the karigar, the
 * brief, the rate, and the lines themselves.
 *
 * Replacing the lines re-prices the order from scratch and moves the holds with
 * it — a piece dropped from the order is let go, a piece added is held — so the
 * shelf always matches what has been promised.
 */
export async function updateOrder(tx: Tx, orderId: string, input: UpdateOrderInput) {
  const branchId = branchOf(tx);
  const s = await orderSettings(tx);
  const today = await businessDate(tx);
  const order = await tx.one<{
    id: string; order_number: string; status: string; order_type: OrderType; customer_id: string; order_date: string;
    rate_lock_type: string; locked_rate_per_gram: Decimal | null; advance_amount: Decimal;
    old_gold_credit: Decimal; scheme_credit: Decimal; repair_service_charge: Decimal;
  }>(`select * from retail_order where id = $1 for update`, [orderId]);
  if (order.status === 'cancelled') throw new BusinessRuleError(`${order.order_number} was cancelled.`, 'cancelled');
  if (order.status === 'completed') {
    throw new BusinessRuleError(`${order.order_number} is delivered and billed; change it on the bill instead.`, 'already_billed');
  }
  if (input.expectedDeliveryDate && input.expectedDeliveryDate < order.order_date) {
    throw new ValidationError('The delivery date cannot be before the order date.');
  }
  if (input.budgetMin && input.budgetMax && compare(input.budgetMin, input.budgetMax) > 0) {
    throw new ValidationError('The smallest budget cannot be more than the largest.');
  }
  if (order.order_type === 'corporate' && (input.companyName === null || input.poReference === null)) {
    throw new ValidationError('A corporate order needs the company name and their PO reference.');
  }

  /* The rate, if it is being changed. */
  const lockType = (input.rateLockType ?? order.rate_lock_type) as 'booking' | 'delivery' | 'fixed';
  let lockedRate: Decimal | null = input.lockedRatePerGram !== undefined ? input.lockedRatePerGram : order.locked_rate_per_gram;
  if (input.rateLockType && input.rateLockType !== order.rate_lock_type) {
    checkRateOverride(tx, s);
    if (lockType === 'delivery') lockedRate = null;
    if (lockType === 'fixed' && !(lockedRate && compare(lockedRate, '0') > 0)) {
      throw new ValidationError('Enter the rate agreed with the customer.');
    }
  }

  const set: Record<string, unknown> = { updated_at: new Date(), updated_by: tx.context.userId };
  const put = (column: string, value: unknown) => { if (value !== undefined) set[column] = value; };
  put('expected_delivery_date', input.expectedDeliveryDate);
  put('karigar_id', input.karigarId);
  put('notes', input.notes);
  put('requirement_description', input.requirementDescription);
  put('size_specifications', input.sizeSpecifications);
  put('budget_min', input.budgetMin);
  put('budget_max', input.budgetMax);
  put('manufacturing_route', input.manufacturingRoute);
  put('external_manufacturer_id', input.externalManufacturerId);
  put('design_approval', input.designApproval);
  put('production_status', input.productionStatus);
  put('repair_item_description', input.repairItemDescription);
  put('repair_issue_description', input.repairIssueDescription);
  put('repair_invoice_type', input.repairInvoiceType);
  put('under_warranty', input.underWarranty);
  put('original_invoice_number', input.originalInvoiceNumber);
  put('event_date', input.eventDate);
  put('event_type', input.eventType);
  put('company_name', input.companyName);
  put('company_gstin', input.companyGstin);
  put('po_reference', input.poReference);
  put('credit_terms', input.creditTerms);
  put('credit_terms_note', input.creditTermsNote);
  put('branding_notes', input.brandingNotes);
  if (input.repairIssueTypes) set.repair_issue_types = JSON.stringify(input.repairIssueTypes);
  if (input.rateLockType) {
    set.rate_lock_type = lockType;
    set.locked_rate_per_gram = lockedRate;
    set.rate_locked_at = lockedRate ? new Date() : null;
    const days = Number(s.rateLockDays);
    set.rate_lock_expires_at = lockType === 'booking' && days > 0
      ? new Date(new Date(`${today}T00:00:00Z`).getTime() + days * 86_400_000) : null;
  }
  /* The customer agreed the repair estimate, so the work can start. */
  if (input.estimateApproved) {
    set.estimate_approved_at = new Date();
    set.estimate_approved_by_name = input.estimateApproved.byName ?? null;
  } else if (input.estimateApproved === null) {
    set.estimate_approved_at = null;
    set.estimate_approved_by_name = null;
  }

  /* Lines, when they are being replaced. */
  const repairCharge = input.repairServiceCharge !== undefined ? rs(input.repairServiceCharge) : order.repair_service_charge;
  if (input.repairServiceCharge !== undefined) set.repair_service_charge = repairCharge;

  if (input.lines) {
    const customer = await activeCustomer(tx, order.customer_id);
    const priced = await priceOrderLines(tx, input.lines, lockedRate, customer.state_code);
    const keeping = new Set(input.lines.map((l) => l.pieceId).filter((p): p is string => Boolean(p)));
    /* Pieces dropped from the order go back on the shelf. */
    const held = await tx.query<{ id: string }>(`select id from stock_piece where reserved_order_id = $1`, [orderId]);
    const letGo = held.map((h) => h.id).filter((id) => !keeping.has(id));
    if (letGo.length) {
      await tx.query(
        `update stock_piece set reserved_order_id = null, reserved_at = null, updated_at = now(), updated_by = $2
          where id = any($1::uuid[])`, [letGo, tx.context.userId]);
    }
    await tx.query(`delete from order_line where retail_order_id = $1`, [orderId]);
    if (priced.length) {
      await repo(tx, 'order_line').insertMany(priced.map((p, i) => ({
        retail_order_id: orderId, line_number: i + 1, line_mode: p.input.lineMode ?? 'booking',
        title: p.input.title, design_specification: p.input.designSpecification ?? null,
        item_id: p.input.itemId ?? null, piece_id: p.input.pieceId ?? null, purity_id: p.input.purityId ?? null,
        category_id: p.input.categoryId ?? null, hsn_code: p.hsnCode, special_instructions: p.input.specialInstructions ?? null,
        is_estimate: p.estimate,
        quantity: p.quantity, gross_weight: p.grossWeight, stone_weight: p.stoneWeight, net_weight: p.netWeight,
        rate_per_gram: p.ratePerGram, metal_amount: p.metalAmount, making_basis: p.makingBasis, making_rate: p.makingRate,
        making_amount: p.makingAmount, wastage_percent: p.wastagePercent, stone_amount: p.stoneAmount,
        discount_amount: p.discountAmount, taxable_amount: p.taxableAmount, gst_rate: p.gstRate,
        cgst_amount: p.cgst, sgst_amount: p.sgst, igst_amount: p.igst, line_total: p.lineTotal,
      })));
    }
    if (keeping.size) await reservePieces(tx, orderId, branchId, [...keeping]);

    const totals = {
      metal: sum(priced.map((p) => p.metalAmount)), making: sum(priced.map((p) => p.makingAmount)),
      stone: sum(priced.map((p) => p.stoneAmount)), discount: sum(priced.map((p) => p.discountAmount)),
      taxable: sum(priced.map((p) => p.taxableAmount)), cgst: sum(priced.map((p) => p.cgst)),
      sgst: sum(priced.map((p) => p.sgst)), igst: sum(priced.map((p) => p.igst)),
      total: sum(priced.map((p) => p.lineTotal)),
      gross: sum(priced.map((p) => p.grossWeight)), net: sum(priced.map((p) => p.netWeight)),
    };
    Object.assign(set, {
      metal_amount: totals.metal, making_amount: totals.making, stone_amount: totals.stone, discount_amount: totals.discount,
      taxable_amount: totals.taxable, cgst_amount: totals.cgst, sgst_amount: totals.sgst, igst_amount: totals.igst,
      total_gross_weight: totals.gross, total_net_weight: totals.net,
      total_amount: rs(add(totals.total, repairCharge)),
    });
  } else if (input.repairServiceCharge !== undefined) {
    const lineTotal = (await tx.one<{ total: Decimal }>(
      `select coalesce(sum(line_total), 0)::text as total from order_line where retail_order_id = $1`, [orderId])).total;
    set.total_amount = rs(add(lineTotal, repairCharge));
  }

  /* An order can never be worth less than what has already been taken for it. */
  if (set.total_amount !== undefined) {
    const taken = add(order.advance_amount, add(order.old_gold_credit, order.scheme_credit));
    if (compare(taken, set.total_amount as Decimal) > 0) {
      throw new BusinessRuleError(
        `${inr(taken)} has already been taken on ${order.order_number}; it cannot be worth only ${inr(set.total_amount as Decimal)}. Give some back first.`,
        'total_below_taken');
    }
  }

  const columns = Object.keys(set);
  await tx.query(
    `update retail_order set ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1`,
    [orderId, ...columns.map((c) => set[c])]);
  await refreshOrderMoney(tx, orderId);
  await recordStage(tx, orderId, null, (await tx.one<{ stage: string }>(`select stage from retail_order where id = $1`, [orderId])).stage,
    'same', input.lines ? 'Order changed, including its lines' : 'Order changed');
  return orderDetail(tx, orderId);
}

/* ---------------------------------------------------------------- advances */

/**
 * An advance against an order. Real money, so it posts at once: in through the
 * payment mode, credited to the customer on 2400 — the same place the counter
 * reads credit from, which is how an advance taken here is spent on the bill.
 */
export async function addOrderPayment(
  tx: Tx, orderId: string, input: { paymentMethodId: string; amount: Decimal; reference?: string; notes?: string },
) {
  const branchId = branchOf(tx);
  const order = await tx.one<{ id: string; order_number: string; status: string; customer_id: string; total_amount: Decimal; advance_amount: Decimal; old_gold_credit: Decimal; scheme_credit: Decimal }>(
    `select id, order_number, status, customer_id, total_amount, advance_amount, old_gold_credit, scheme_credit
       from retail_order where id = $1 for update`, [orderId]);
  if (order.status === 'cancelled') throw new BusinessRuleError(`${order.order_number} was cancelled.`, 'cancelled');
  if (order.status === 'completed') throw new BusinessRuleError(`${order.order_number} is already delivered and billed.`, 'already_billed');

  const amount = rs(input.amount);
  if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount taken.');
  const left = sub(order.total_amount, add(order.advance_amount, add(order.old_gold_credit, order.scheme_credit)));
  if (compare(order.total_amount, '0') > 0 && compare(amount, left) > 0) {
    throw new BusinessRuleError(`At most ${inr(left)} is still due on ${order.order_number}.`, 'advance_exceeds_total');
  }

  const customer = await activeCustomer(tx, order.customer_id);
  const method = await paymentAccount(tx, input.paymentMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) {
    throw new BusinessRuleError(`${method.name} cannot be taken as an order advance. Choose cash, card, UPI or bank.`, 'payment_method_invalid');
  }
  if (method.requires_reference && !input.reference?.trim()) {
    throw new BusinessRuleError(`${method.name} needs a reference (UTR, card slip, cheque number).`, 'reference_required');
  }
  if (method.max_amount && compare(amount, method.max_amount) > 0) {
    throw new BusinessRuleError(`${method.name} allows at most ${inr(method.max_amount)} at once.`, 'payment_limit');
  }
  const docDate = await businessDate(tx);
  if (method.kind === 'cash') await checkCashLimit(tx, customer, amount, docDate);

  const { numbers: [receiptNumber] } = await reserveDocumentNumbers(tx, 'customer_receipt', 1, { branchId, date: new Date(docDate) });
  const payment = await repo<{ id: string }>(tx, 'order_payment').insert({
    retail_order_id: orderId, payment_method_id: method.id, amount, reference: input.reference?.trim() || null,
    doc_date: docDate, receipt_number: receiptNumber, status: 'posted', notes: input.notes ?? null,
  });

  const money: MoneyEntry[] = [
    { ...method.account, debit: amount, narration: `Advance on ${order.order_number}` },
    { accountCode: '2400', partyId: customer.id, credit: amount, narration: `Advance on ${order.order_number} (${receiptNumber})` },
    ...modeCharges(await postingSettings(tx), method, amount, receiptNumber!),
  ];
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'receipt', voucherDate: docDate, branchId, sourceType: 'order_payment', sourceId: payment.id,
    narration: `Order advance ${receiptNumber} from ${customer.name}`, money,
  });
  await tx.query(`update order_payment set voucher_id = $2 where id = $1`, [payment.id, voucherId]);
  await refreshOrderMoney(tx, orderId);
  return orderDetail(tx, orderId);
}

/** Takes back an advance entered by mistake. The money goes back out the way it came. */
export async function cancelOrderPayment(tx: Tx, paymentId: string, reason: string) {
  const payment = await tx.one<{ id: string; retail_order_id: string; receipt_number: string; status: string; voucher_id: string | null }>(
    `select id, retail_order_id, receipt_number, status, voucher_id from order_payment where id = $1 for update`, [paymentId]);
  if (payment.status === 'cancelled') throw new BusinessRuleError(`${payment.receipt_number} is already cancelled.`, 'already_cancelled');
  const order = await tx.one<{ status: string; order_number: string; customer_id: string }>(
    `select status, order_number, customer_id from retail_order where id = $1`, [payment.retail_order_id]);
  if (order.status === 'completed') {
    throw new BusinessRuleError(`${order.order_number} is billed; take the money back through the bill instead.`, 'already_billed');
  }
  const credit = await customerCredit(tx, order.customer_id);
  const amount = (await tx.one<{ amount: Decimal }>(`select amount from order_payment where id = $1`, [paymentId])).amount;
  if (compare(amount, credit) > 0) {
    throw new BusinessRuleError(`${inr(credit)} of credit is left; the rest was already spent on a bill.`, 'credit_used');
  }
  if (payment.voucher_id) await reverseVoucher(tx, payment.voucher_id, `Cancelled: ${reason}`);
  await tx.query(
    `update order_payment set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() where id = $1`,
    [paymentId, reason]);
  await refreshOrderMoney(tx, payment.retail_order_id);
  return orderDetail(tx, payment.retail_order_id);
}

/** The customer's credit on 2400 — advances, credit notes and old gold together. */
async function customerCredit(tx: Tx, customerId: string): Promise<Decimal> {
  const row = await tx.one<{ advance: Decimal }>(
    `select coalesce(sum(e.credit - e.debit), 0)::text as advance from ledger_entry e join account a on a.id = e.account_id
      where e.party_id = $1 and a.code = '2400'`, [customerId]);
  return row.advance;
}

/** Re-adds the order's advances and credits from the rows that posted. */
async function refreshOrderMoney(tx: Tx, orderId: string): Promise<void> {
  await tx.query(
    `update retail_order o
        set advance_amount = c.paid,
            balance_amount = o.total_amount - c.paid - o.old_gold_credit - o.scheme_credit,
            updated_at = now()
       from (select coalesce(sum(amount), 0) as paid from order_payment
              where retail_order_id = $1 and status = 'posted') c
      where o.id = $1`, [orderId]);
}

/* ------------------------------------------------------------------ stages */

export async function moveStage(tx: Tx, orderId: string, toStage: string, reason?: string, note?: string) {
  const order = await tx.maybeOne<{ id: string; order_number: string; order_type: OrderType; stage: string; status: string }>(
    `select id, order_number, order_type, stage, status from retail_order where id = $1 for update`, [orderId]);
  if (!order) throw new NotFoundError('Order', orderId);
  if (order.status === 'cancelled') throw new BusinessRuleError(`${order.order_number} was cancelled.`, 'cancelled');
  if (order.status === 'completed') throw new BusinessRuleError(`${order.order_number} is delivered.`, 'already_delivered');

  const stages = await pipelineFor(tx, order.order_type);
  const target = stages.find((s) => s.key === toStage);
  if (!target) {
    throw new BusinessRuleError(
      `"${toStage}" is not a step for a ${order.order_type} order. The steps are: ${stages.map((s) => s.label).join(' → ')}.`,
      'invalid_stage_move', { validStages: stages.map((s) => s.key) });
  }
  const direction = stageMoveDirection(order.order_type, order.stage, toStage);
  if (direction === 'same') return orderDetail(tx, orderId);
  if (direction === 'invalid') {
    throw new BusinessRuleError(
      `This order sits on "${order.stage}", which is no longer a step for a ${order.order_type} order. Put the step back in Settings, or move the order to one that exists.`,
      'invalid_stage_move', { currentStage: order.stage, validStages: stages.map((s) => s.key) });
  }
  if (direction === 'backward' && !reason?.trim()) {
    throw new BusinessRuleError('Say why the order is going back a step — it is kept on the order’s history.', 'backward_move_needs_reason');
  }
  /* Delivery happens by billing the order, not by dragging a card. */
  if (target.terminal) {
    throw new BusinessRuleError(
      `${order.order_number} is delivered by billing it, so stock and the books move together. Open the order and choose Bill & Deliver.`,
      'deliver_by_billing');
  }

  await tx.query(`update retail_order set stage = $2, updated_at = now(), updated_by = $3 where id = $1`,
    [orderId, toStage, tx.context.userId]);
  await recordStage(tx, orderId, order.stage, toStage, direction, note, reason);
  return orderDetail(tx, orderId);
}

/* ------------------------------------------------------------------ cancel */

export async function cancelOrder(tx: Tx, orderId: string, reason: string) {
  const order = await tx.one<{ id: string; order_number: string; status: string; stage: string; advance_amount: Decimal }>(
    `select id, order_number, status, stage, advance_amount from retail_order where id = $1 for update`, [orderId]);
  if (order.status === 'cancelled') throw new BusinessRuleError(`${order.order_number} is already cancelled.`, 'already_cancelled');
  if (order.status === 'completed') {
    throw new BusinessRuleError(`${order.order_number} is delivered and billed. Take the goods back on the bill instead.`, 'already_billed');
  }
  const openJob = await tx.maybeOne<{ job_number: string }>(
    `select job_number from karigar_job where retail_order_id = $1 and status = 'issued' limit 1`, [orderId]);
  if (openJob) {
    throw new BusinessRuleError(`${openJob.job_number} is still with the karigar. Take the metal back first.`, 'job_open');
  }
  const held = await tx.maybeOne<{ token_number: string }>(
    `select token_number from order_custody_item where retail_order_id = $1 and status <> 'returned' limit 1`, [orderId]);
  if (held) {
    throw new BusinessRuleError(`The customer’s own item (${held.token_number}) is still with the shop. Give it back first.`, 'custody_held');
  }

  await releasePieces(tx, orderId);
  await recordStage(tx, orderId, order.stage, order.stage, 'same', `Cancelled: ${reason}`, reason);
  await tx.query(
    `update retail_order set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now(), updated_by = $3
      where id = $1`, [orderId, reason, tx.context.userId]);
  return orderDetail(tx, orderId);
}

/* ----------------------------------------------------------------- custody */

/** Hands the customer's own jewellery back and notes who took it. */
export async function returnCustodyItem(tx: Tx, itemId: string, input: { returnedToName?: string; notes?: string }) {
  const item = await tx.one<{ id: string; retail_order_id: string; token_number: string; status: string }>(
    `select id, retail_order_id, token_number, status from order_custody_item where id = $1 for update`, [itemId]);
  if (item.status === 'returned') throw new BusinessRuleError(`${item.token_number} was already given back.`, 'already_returned');
  if (item.status === 'with_karigar') {
    throw new BusinessRuleError(`${item.token_number} is still with the karigar. Take it back first.`, 'with_karigar');
  }
  await tx.query(
    `update order_custody_item set status = 'returned', returned_on = $2, returned_to_name = $3, notes = coalesce($4, notes), updated_at = now()
      where id = $1`, [itemId, await businessDate(tx), input.returnedToName ?? null, input.notes ?? null]);
  return orderDetail(tx, item.retail_order_id);
}

/* ---------------------------------------------------------------- delivery */

/**
 * What the counter needs to bill an order: its lines, the rate it is held at,
 * and the credit already on the customer. Nothing is written here — the bill
 * itself is made at the counter, which is what moves stock and GST.
 */
export async function orderForBilling(tx: Tx, orderId: string) {
  const s = await orderSettings(tx);
  const today = await businessDate(tx);
  const order = await tx.one<Record<string, unknown> & {
    id: string; order_number: string; status: string; order_type: OrderType; customer_id: string;
    rate_lock_type: string; locked_rate_per_gram: Decimal | null; rate_locked_at: Date | null; rate_lock_expires_at: Date | null;
    repair_invoice_type: string | null; repair_service_charge: Decimal;
  }>(`select o.*, p.name as customer_name, p.code as customer_code, p.phone as customer_phone, p.gstin as customer_gstin
        from retail_order o join party p on p.id = o.customer_id where o.id = $1`, [orderId]);
  if (order.status === 'cancelled') throw new BusinessRuleError(`${order.order_number} was cancelled.`, 'cancelled');
  if (order.status === 'completed') throw new BusinessRuleError(`${order.order_number} is already billed.`, 'already_billed');

  const lines = await tx.query(
    `select l.*, i.name as item_name, i.tracking, p.tag_number, p.status as piece_status, pu.code as purity_code
       from order_line l left join item i on i.id = l.item_id left join stock_piece p on p.id = l.piece_id
       left join purity pu on pu.id = l.purity_id
      where l.retail_order_id = $1 order by l.line_number`, [orderId]);
  const rate = rateDecisionFor(order, s, today);
  const credit = await customerCredit(tx, order.customer_id);
  const repairAs = (order.repair_invoice_type ?? s.repairInvoiceType) as 'service' | 'goods';

  return {
    order, lines, rate, credit,
    /** A repair billed as a service: labour on a SAC code, nothing through stock. */
    repair: order.order_type === 'repair'
      ? { billAs: repairAs, serviceCharge: order.repair_service_charge, sac: s.repairSac, gstPercent: String(s.repairGstPercent) }
      : null,
    requireFullPayment: s.requireFullPayment,
    canChangeRate: s.allowRateChange,
  };
}

/**
 * Called by the counter the moment an order's bill is saved: the order is
 * delivered, its reserved pieces are released (the bill has sold them), and the
 * customer's own items are marked ready to hand back.
 */
export async function markOrderBilled(tx: Tx, orderId: string, invoiceId: string): Promise<void> {
  const order = await tx.one<{ id: string; stage: string; order_type: OrderType }>(
    `select id, stage, order_type from retail_order where id = $1 for update`, [orderId]);
  const stages = await pipelineFor(tx, order.order_type);
  const delivered = stages.find((x) => x.terminal)?.key ?? 'delivered';
  await tx.query(
    `update stock_piece set reserved_order_id = null, reserved_at = null, updated_at = now() where reserved_order_id = $1`, [orderId]);
  await tx.query(
    `update retail_order set status = 'completed', stage = $2, delivered_at = now(), sales_invoice_id = $3,
            balance_amount = 0, updated_at = now(), updated_by = $4
      where id = $1`, [orderId, delivered, invoiceId, tx.context.userId]);
  await tx.query(
    `update order_custody_item set status = 'ready', updated_at = now()
      where retail_order_id = $1 and status in ('received', 'with_karigar')`, [orderId]);
  await recordStage(tx, orderId, order.stage, delivered, 'forward', 'Billed and delivered');
}

/** Whoever bills may switch between the held rate and today's, if the shop allows it. */
export function checkRateOverride(tx: Tx, settings: Pick<OrderSettings, 'allowRateChange'>): void {
  if (!settings.allowRateChange) {
    throw new BusinessRuleError('This shop bills orders at the rate they were taken at. Change it in Orders → Settings.', 'rate_change_not_allowed');
  }
  if (!hasPermission(tx.context.permissions, 'orders.rate.override')) {
    throw new ForbiddenError('You cannot change the rate on an order.');
  }
}

/* ------------------------------------------------------------------ detail */

export async function orderDetail(tx: Tx, orderId: string) {
  const order = await tx.maybeOne<Record<string, unknown> & { order_type: OrderType }>(
    `select o.*, p.name as customer_name, p.phone as customer_phone, p.code as customer_code,
            p.address_line1 as customer_address, p.city as customer_city, p.gstin as customer_gstin,
            k.name as karigar_name, u.full_name as salesperson_name, b.name as branch_name,
            si.doc_number as invoice_number, m.name as external_manufacturer_name
       from retail_order o
       join party p on p.id = o.customer_id
       join branch b on b.id = o.branch_id
       left join karigar k on k.id = o.karigar_id
       left join app_user u on u.id = o.salesperson_id
       left join sales_invoice si on si.id = o.sales_invoice_id
       left join party m on m.id = o.external_manufacturer_id
      where o.id = $1`, [orderId]);
  if (!order) throw new NotFoundError('Order', orderId);

  const [lines, custody, timeline, payments, jobs, attachments, acknowledgement, messages, stages] = await Promise.all([
    tx.query(`select l.*, i.name as item_name, pu.code as purity_code, sp.tag_number
                from order_line l left join item i on i.id = l.item_id left join purity pu on pu.id = l.purity_id
                left join stock_piece sp on sp.id = l.piece_id
               where l.retail_order_id = $1 order by l.line_number`, [orderId]),
    tx.query(`select c.*, m.name as metal_name, j.job_number
                from order_custody_item c left join metal m on m.id = c.metal_id left join karigar_job j on j.id = c.karigar_job_id
               where c.retail_order_id = $1 order by c.line_number`, [orderId]),
    tx.query(`select e.*, u.full_name as actor_name from order_stage_event e left join app_user u on u.id = e.actor_user_id
               where e.retail_order_id = $1 order by e.at`, [orderId]),
    tx.query(`select p.*, m.name as method_name, m.kind as method_kind from order_payment p
                join payment_method m on m.id = p.payment_method_id
               where p.retail_order_id = $1 order by p.received_at`, [orderId]),
    tx.query(`select j.*, k.name as karigar_name from karigar_job j join karigar k on k.id = j.karigar_id
               where j.retail_order_id = $1 order by j.issued_on`, [orderId]),
    tx.query(`select * from order_attachment where retail_order_id = $1 order by sort_order, created_at`, [orderId]),
    tx.maybeOne(`select * from order_acknowledgement where retail_order_id = $1`, [orderId]),
    tx.query(`select * from order_communication where retail_order_id = $1 order by sent_at desc limit 50`, [orderId]),
    pipelineFor(tx, order.order_type),
  ]);
  return { ...order, lines, custody, timeline, payments, jobs, attachments, acknowledgement, messages, stages };
}

/* ------------------------------------------------------------------- board */

/** The board: every live order of one type, grouped by the step it is on. */
export async function board(tx: Tx, orderType: OrderType, branchId?: string | null) {
  const s = await orderSettings(tx);
  const stages = await pipelineFor(tx, orderType);
  const params: unknown[] = [orderType, Number(s.slaWarnDays)];
  let branchClause = '';
  if (branchId) { params.push(branchId); branchClause = ` and o.branch_id = $${params.length}`; }

  const rows = await tx.query<Record<string, unknown>>(
    `select o.id, o.order_number, o.stage, o.status, o.order_date, o.expected_delivery_date,
            o.total_amount, o.advance_amount, o.balance_amount, o.total_net_weight, o.order_type,
            p.name as customer_name, p.phone as customer_phone, k.name as karigar_name,
            o.expected_delivery_date < current_date as is_overdue,
            o.expected_delivery_date <= current_date + ($2::int) as is_due_soon,
            (select count(*)::int from karigar_job j where j.retail_order_id = o.id and j.status = 'issued') as open_jobs,
            (select title from order_line l where l.retail_order_id = o.id order by line_number limit 1) as first_line_title
       from retail_order o
       join party p on p.id = o.customer_id
       left join karigar k on k.id = o.karigar_id
      where o.order_type = $1 and o.status = 'active'${branchClause}
      order by o.expected_delivery_date`, params);

  return { orderType, warnDays: Number(s.slaWarnDays), stages: stages.map((stage) => ({ ...stage, orders: rows.filter((r) => r.stage === stage.key) })) };
}
