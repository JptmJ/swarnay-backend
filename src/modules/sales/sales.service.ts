/**
 * Module 5.2 — selling.
 *
 * A counter bill is priced by the shared engine from Masters (never from the
 * numbers the screen sends), settled by any mix of tenders, and posted as it
 * is saved: stock leaves at cost, revenue and GST are booked, and whatever is
 * unpaid stays on the customer. Returns, receipts and approval memos follow
 * the same rule — one transaction, all or nothing.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, fixed, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfig } from '../../core/config/config-service.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { loadPricer, type PriceRequest, type PricedLine } from '../masters/pricing/pricing.service.js';
import type { RuleSnapshot } from '../masters/pricing/engine.js';
import { recordMovements, reverseMovementsFor, type MovementInput } from '../inventory/stock.service.js';
import { postVoucher, reverseVoucher, type MetalEntry, type MoneyEntry } from '../accounts/ledger.service.js';
import { paymentAccount } from '../purchase/purchase.service.js';
import { compositionEntries, gstEntries, isComposition, line, modeCharges, postingSettings, revenueEntries } from '../accounts/posting.js';
import { verifyPassword, normalizePhone } from '../identity/auth.service.js';
import { effectiveGrants, loadUserAccess } from '../identity/access.service.js';
import { hasPermission } from '../identity/permissions.js';
import { businessDate } from '../../core/util/business-date.js';
import { cancelIntake, createIntake, type IdProof, type OldGoldLineInput } from '../oldgold/oldgold.service.js';
import { redeem } from '../schemes/schemes.service.js';
import { markOrderBilled } from '../orders/orders.service.js';

const rs = (v: Decimal) => round(v, 2);
const g = (v: Decimal) => round(v, 3);
const neg = (v: Decimal) => sub('0', v);
const inr = (v: Decimal) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Income-tax Act: PAN on a sale of ₹2 lakh or more (Rule 114B); cash of ₹2 lakh or more in one bill is not allowed (s.269ST). */
const PAN_LIMIT = '200000';
const CASH_LIMIT = '200000';
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

interface Customer { id: string; code: string; name: string; state_code: string | null; pan: string | null }

/** The shop's one walk-in customer: counter bills paid in full, under ₹2 lakh, with no name taken. */
const WALK_IN = 'WALKIN';
const isWalkIn = (c: Customer) => c.code === WALK_IN;

export async function activeCustomer(tx: Tx, id: string): Promise<Customer> {
  const c = await tx.maybeOne<Customer & { is_customer: boolean; is_active: boolean }>(
    `select id, code, name, state_code, pan, is_customer, is_active from party where id = $1 and deleted_at is null`, [id]);
  if (!c) throw new NotFoundError('Customer', id);
  if (!c.is_customer) throw new BusinessRuleError(`${c.name} is not marked as a customer.`, 'not_a_customer');
  if (!c.is_active) throw new BusinessRuleError(`${c.name} is inactive.`, 'party_inactive');
  return c;
}

/** Made the first time a shop bills a walk-in. */
async function walkInCustomer(tx: Tx): Promise<Customer> {
  return (await tx.maybeOne<Customer>(`select id, code, name, state_code, pan from party where code = $1 and deleted_at is null`, [WALK_IN]))
    ?? repo<Customer>(tx, 'party').insert({ code: WALK_IN, name: 'Walk-in Customer', is_customer: true, notes: 'Counter bills paid in full without a name.' });
}

/** A named customer, or refuses the walk-in for documents that must say who. */
function named(c: Customer, what: string): Customer {
  if (isWalkIn(c)) throw new BusinessRuleError(`${what} needs the customer's name. Choose or add the customer.`, 'walk_in_not_allowed');
  return c;
}

/**
 * Cash already taken from this customer today, on bills and receipts. Income-tax Act s.269ST
 * forbids ₹2 lakh or more in cash from one person in a day, however it is split.
 */
async function cashTakenToday(tx: Tx, customerId: string, date: string): Promise<Decimal> {
  const row = await tx.one<{ cash: Decimal }>(
    `select (coalesce((select sum(p.amount) from sales_payment p join sales_invoice s on s.id = p.sales_invoice_id
                        where s.customer_id = $1 and s.doc_date = $2 and s.status = 'posted' and p.mode = 'cash'), 0)
           + coalesce((select sum(r.amount) from customer_receipt r join payment_method m on m.id = r.payment_method_id
                        where r.customer_id = $1 and r.doc_date = $2 and r.status = 'posted' and m.kind = 'cash'), 0)
           + coalesce((select sum(op.amount) from order_payment op join payment_method m on m.id = op.payment_method_id
                        join retail_order o on o.id = op.retail_order_id
                        where o.customer_id = $1 and op.doc_date = $2 and op.status = 'posted' and m.kind = 'cash'), 0)
           + coalesce((select sum(si.amount_paid) from scheme_installment si
                        join payment_method m on m.id = si.payment_method_id
                        join scheme_account sa on sa.id = si.scheme_account_id
                        where sa.customer_id = $1 and si.paid_on = $2 and si.status = 'paid' and m.kind = 'cash'), 0))::text as cash`,
    [customerId, date]);
  return row.cash;
}

export async function checkCashLimit(tx: Tx, customer: Customer, cash: Decimal, date: string) {
  if (!(compare(cash, '0') > 0)) return;
  if (compare(cash, CASH_LIMIT) >= 0) {
    throw new BusinessRuleError(`Cash of ${inr(cash)} at once is not allowed (₹2 lakh or more, Income-tax Act s.269ST). Take the rest by card, UPI or bank.`, 'cash_limit');
  }
  if (isWalkIn(customer)) return;
  const earlier = await cashTakenToday(tx, customer.id, date);
  if (compare(add(earlier, cash), CASH_LIMIT) >= 0) {
    throw new BusinessRuleError(`${customer.name} already paid ${inr(earlier)} in cash today; with ${inr(cash)} more it reaches ₹2 lakh, which is not allowed in a day (s.269ST). Take it by card, UPI or bank.`, 'cash_limit');
  }
}

/** What a customer owes (Sundry Debtors) and holds as advance or credit notes, in rupees. */
export async function customerBalance(tx: Tx, customerId: string) {
  return tx.one<{ owed: Decimal; advance: Decimal }>(
    `select coalesce(sum(case when a.code = '1100' then e.debit - e.credit end), 0)::text as owed,
            coalesce(sum(case when a.code = '2400' then e.credit - e.debit end), 0)::text as advance
       from ledger_entry e join account a on a.id = e.account_id
      where e.party_id = $1 and a.code in ('1100', '2400')`, [customerId]);
}

/* ---------------------------------------------------------------- checkout */

export interface SaleLineInput {
  /** A tagged piece: its weights and stones come from the piece. */
  pieceId?: string;
  /** A lot sold by weight. */
  itemId?: string;
  purityId?: string;
  locationId?: string;
  grossWeight?: Decimal;
  hallmarkAmount?: Decimal;
}

export interface TenderInput {
  paymentMethodId: string; amount: Decimal; reference?: string;
  /** For a scheme tender: the matured account being spent. It is redeemed as this bill saves. */
  schemeAccountId?: string;
}

export interface CheckoutInput {
  /** Left out for a walk-in: paid in full, under ₹2 lakh. */
  customerId?: string;
  lines: SaleLineInput[];
  tenders: TenderInput[];
  /** Taken off making and wastage (never metal, stones or GST), spread over the lines by their making + wastage. */
  discount?: Decimal;
  /** Another person's sign-in when the discount is above the counter limit. */
  approver?: { identifier: string; password: string };
  /** Saved on the customer when the bill needs PAN and the customer has none. */
  pan?: string;
  salespersonId?: string;
  notes?: string;
  /** The total the counter showed. If rates or Masters changed since, the bill is refused rather than saved at a price nobody saw. */
  expectedTotal?: Decimal;
  /** Old gold the customer hands over with this bill: taken in and used as payment, in the same transaction. */
  oldGold?: { lines: OldGoldLineInput[]; locationId?: string; idProof?: IdProof };
  /** Billing a customer's order: its reserved pieces may be sold, and it is delivered when this bill saves. */
  orderId?: string;
  /** Labour on the bill — a repair, a polish, a resize. No metal and no stock: a SAC line at the service rate. */
  services?: ServiceLineInput[];
}

export interface ServiceLineInput {
  description: string;
  amount: Decimal;
  /** The shop's SAC for the work. Orders settings supply it for a repair. */
  sacCode?: string;
  gstPercent?: Decimal;
}

interface PricedService {
  description: string; sacCode: string | null; amount: Decimal; gstRate: Decimal;
  cgst: Decimal; sgst: Decimal; igst: Decimal; total: Decimal;
}

/**
 * The item every labour line is billed under. Created once per shop, like the
 * old-gold lot item, so a service line has somewhere to hang without asking the
 * shop to set one up first.
 */
async function serviceItem(tx: Tx): Promise<string> {
  const found = await tx.maybeOne<{ id: string }>(`select id from item where code = 'SERVICE' and deleted_at is null`);
  if (found) return found.id;
  const made = await repo<{ id: string }>(tx, 'item').insert({
    code: 'SERVICE', name: 'Labour & Services', nature: 'service', tracking: 'lot', uom: 'piece', is_active: true,
  });
  return made.id;
}

/** Works out the tax on labour lines. Nothing here touches stock. */
async function priceServices(
  tx: Tx, branchId: string, customer: Customer, services: ServiceLineInput[] | undefined,
): Promise<{ rows: PricedService[]; total: Decimal }> {
  if (!services?.length) return { rows: [], total: '0' };
  const branch = await tx.one<{ state_code: string | null }>(`select state_code from branch where id = $1`, [branchId]);
  const interState = Boolean(branch.state_code && customer.state_code && branch.state_code !== customer.state_code);
  const composition = await isComposition(tx);
  const rows = services.map((s) => {
    const amount = rs(s.amount);
    if (!(compare(amount, '0') > 0)) throw new ValidationError(`Enter what is charged for "${s.description}".`);
    if (!s.description.trim()) throw new ValidationError('Say what the labour is for.');
    const gstRate = composition ? '0' : s.gstPercent ?? '0';
    const tax = rs(div(mul(amount, gstRate), '100'));
    const half = rs(div(tax, '2'));
    return {
      description: s.description.trim(), sacCode: s.sacCode?.trim() || null, amount, gstRate,
      cgst: interState ? '0' : half, sgst: interState ? '0' : sub(tax, half), igst: interState ? tax : '0',
      total: add(amount, tax),
    };
  });
  return { rows, total: sum(rows.map((r) => r.total)) };
}

/** Tenders that spend the customer's credit (advance, credit notes, old gold) rather than bring money in. */
const CREDIT_KINDS = ['advance', 'old_gold', 'scheme'];

interface SaleLine {
  kind: 'piece' | 'lot';
  itemId: string; itemName: string; purityId: string; metalId: string; locationId: string; pieceId: string | null;
  tracking: 'piece' | 'lot'; quantity: number; gross: Decimal; stone: Decimal; other: Decimal; stoneAmount: Decimal;
  /** Typed on the line; left out, a Formulas hallmark rule applies to a piece with a HUID. */
  hallmark: Decimal | undefined; hallmarked: boolean; cost: Decimal | null; description: string; memoLineId: string | null; tagNumber: string | null;
  /** Making and wastage written on the tag, if any. */
  tag: PriceRequest['tag'];
}

type TagTerms = { making_basis: 'per_gram' | 'flat' | 'percent' | null; making_rate: Decimal | null; wastage_percent: Decimal | null };
const tagTerms = (p: TagTerms): PriceRequest['tag'] => ({
  making: p.making_basis && p.making_rate !== null ? { id: null, basis: p.making_basis, rate: p.making_rate } satisfies RuleSnapshot : null,
  wastage: p.wastage_percent !== null ? { id: null, basis: 'percent', rate: p.wastage_percent } satisfies RuleSnapshot : null,
});

async function resolveLines(tx: Tx, branchId: string, customerId: string | null, inputs: SaleLineInput[], lock: boolean, orderId?: string | null): Promise<SaleLine[]> {
  const pieceIds = inputs.flatMap((l) => (l.pieceId ? [l.pieceId] : []));
  if (new Set(pieceIds).size !== pieceIds.length) throw new BusinessRuleError('The same piece is on the bill twice.', 'piece_repeated');
  const pieces = pieceIds.length ? await tx.query<{ id: string; tag_number: string; status: string; branch_id: string; item_id: string; item_name: string;
    purity_id: string; metal_id: string; location_id: string; gross_weight: Decimal; stone_weight: Decimal; other_weight: Decimal;
    stone_cost: Decimal; cost_value: Decimal; memo_line_id: string | null; memo_customer: string | null; huid: string | null;
    reserved_order_id: string | null; reserved_order_number: string | null; reserved_customer: string | null } & TagTerms>(
    `select p.id, p.tag_number, p.status, l.branch_id, p.item_id, i.name as item_name, p.purity_id, pu.metal_id, p.location_id,
            p.gross_weight, p.stone_weight, p.other_weight, p.stone_cost, p.cost_value, ml.id as memo_line_id, m.customer_id as memo_customer,
            p.making_basis, p.making_rate, p.wastage_percent, p.huid,
            p.reserved_order_id, ro.order_number as reserved_order_number, rp.name as reserved_customer
       from stock_piece p join item i on i.id = p.item_id join purity pu on pu.id = p.purity_id join stock_location l on l.id = p.location_id
       left join approval_memo_line ml on ml.piece_id = p.id and ml.returned_at is null and ml.sales_invoice_id is null
       left join approval_memo m on m.id = ml.approval_memo_id and m.status = 'open'
       left join retail_order ro on ro.id = p.reserved_order_id
       left join party rp on rp.id = ro.customer_id
      where p.id = any($1::uuid[]) ${lock ? 'for update of p' : ''}`, [pieceIds]) : [];
  const pieceById = new Map(pieces.map((p) => [p.id, p]));

  const lotInputs = inputs.filter((l) => !l.pieceId);
  const lotRows = lotInputs.length ? await tx.query<{ item_id: string; name: string; tracking: string; metal_id: string | null;
    purity_id: string; purity_metal: string; location_id: string | null }>(
    `select i.id as item_id, i.name, i.tracking, i.metal_id, pu.id as purity_id, pu.metal_id as purity_metal,
            (select id from stock_location where branch_id = $3 and is_active and deleted_at is null and kind <> 'transit'
              order by is_default desc, (kind = 'counter') desc, code limit 1) as location_id
       from unnest($1::uuid[], $2::uuid[]) as x(item_id, purity_id) join item i on i.id = x.item_id join purity pu on pu.id = x.purity_id`,
    [lotInputs.map((l) => l.itemId ?? null), lotInputs.map((l) => l.purityId ?? null), branchId]) : [];

  return inputs.map((l, index) => {
    const n = inputs.length > 1 ? `Line ${index + 1}: ` : '';
    if (l.pieceId) {
      const p = pieceById.get(l.pieceId);
      if (!p) throw new NotFoundError('Piece', l.pieceId);
      if (p.branch_id !== branchId) throw new BusinessRuleError(`${n}${p.tag_number} is at another branch.`, 'piece_other_branch');
      const onMemoForThisCustomer = p.status === 'on_memo' && !!customerId && p.memo_customer === customerId;
      if (p.status !== 'in_stock' && !onMemoForThisCustomer) {
        throw new BusinessRuleError(p.status === 'on_memo'
          ? `${n}${p.tag_number} is out on approval${customerId ? ' with another customer' : ' — choose that customer first'}.`
          : `${n}${p.tag_number} is ${p.status.replace('_', ' ')}, not in stock.`, 'piece_not_in_stock');
      }
      // Promised on someone's order: it may only leave on that order's own bill.
      if (p.reserved_order_id && p.reserved_order_id !== orderId) {
        throw new BusinessRuleError(
          `${n}${p.tag_number} is booked on ${p.reserved_order_number} for ${p.reserved_customer}. Bill it from that order, or choose another piece.`,
          'piece_reserved');
      }
      return { kind: 'piece', itemId: p.item_id, itemName: p.item_name, purityId: p.purity_id, metalId: p.metal_id, locationId: p.location_id,
        pieceId: p.id, tracking: 'piece', quantity: 1, gross: p.gross_weight, stone: p.stone_weight, other: p.other_weight,
        stoneAmount: p.stone_cost, hallmark: l.hallmarkAmount, hallmarked: !!p.huid, cost: p.cost_value, description: `${p.item_name} · ${p.tag_number}`,
        memoLineId: onMemoForThisCustomer ? p.memo_line_id : null, tagNumber: p.tag_number, tag: tagTerms(p) };
    }
    const row = lotRows.find((r) => r.item_id === l.itemId && r.purity_id === l.purityId);
    if (!row) throw new ValidationError(`${n}Choose a tagged piece, or an item and purity sold by weight.`);
    if (row.tracking !== 'lot') throw new BusinessRuleError(`${n}${row.name} is tagged piece by piece — scan its tag.`, 'item_is_piece_tracked');
    if (row.metal_id && row.metal_id !== row.purity_metal) throw new BusinessRuleError(`${n}That purity is for a different metal than ${row.name}.`, 'purity_metal_mismatch');
    if (!(compare(l.grossWeight ?? '0', '0') > 0)) throw new BusinessRuleError(`${n}Enter the weight of ${row.name} sold.`, 'weight_required');
    const locationId = l.locationId ?? row.location_id;
    if (!locationId) throw new BusinessRuleError('This branch has no stock location.', 'no_stock_location');
    return { kind: 'lot', itemId: row.item_id, itemName: row.name, purityId: row.purity_id, metalId: row.purity_metal, locationId,
      pieceId: null, tracking: 'lot', quantity: 1, gross: l.grossWeight!, stone: '0', other: '0', stoneAmount: '0',
      hallmark: l.hallmarkAmount, hallmarked: false, cost: null, description: row.name, memoLineId: null, tagNumber: null, tag: undefined };
  });
}

/** Someone else signing in to approve: they must exist, be active here and hold discount approval. */
async function verifyApprover(tx: Tx, branchId: string, approver: { identifier: string; password: string }): Promise<string> {
  const identifier = approver.identifier.trim().toLowerCase();
  const phone = /^[\d+\s()-]+$/.test(identifier) ? normalizePhone(identifier) : null;
  const user = await tx.maybeOne<{ id: string; password_hash: string; is_active: boolean }>(
    `select id, password_hash, is_active from app_user where deleted_at is null and (lower(email) = $1 or phone = $2)`, [identifier, phone]);
  const refused = new BusinessRuleError('The approver\'s sign-in is not correct.', 'approver_invalid');
  if (!user || !user.is_active || !(await verifyPassword(approver.password, user.password_hash))) throw refused;
  const access = await loadUserAccess(tx, user.id);
  const grants = access ? effectiveGrants(access, branchId) : { permissions: [] as string[] };
  if (!hasPermission(new Set(grants.permissions), 'pos.discount.approve')) {
    throw new BusinessRuleError('That person cannot approve discounts.', 'approver_not_allowed');
  }
  return user.id;
}

/** Splits `total` across `weights` in proportion; the rounding paisa goes to the largest. */
function allocate(total: Decimal, weights: Decimal[]): Decimal[] {
  const whole = sum(weights);
  if (isZero(whole)) return weights.map(() => '0');
  const shares = weights.map((w) => rs(div(mul(total, w), whole)));
  const drift = sub(total, sum(shares));
  if (!isZero(drift)) {
    const largest = weights.reduce((best, w, i) => (compare(w, weights[best]!) > 0 ? i : best), 0);
    shares[largest] = add(shares[largest]!, drift);
  }
  return shares;
}

/** Making + wastage: what a counter discount can come off. */
const charges = (p: PricedLine) => add(p.makingAmount, p.wastageAmount);

/**
 * Prices a bill exactly as it will be saved: tag terms, then Masters → Formulas,
 * then the discount spread over making and wastage. The counter's live quote
 * and checkout both come through here, so the screen and the bill never differ.
 */
async function priceSale(
  tx: Tx, branchId: string, customer: Customer | null, inputs: SaleLineInput[], discountIn: Decimal | undefined, lock: boolean,
  orderId?: string | null, servicesTotal: Decimal = '0',
) {
  if (inputs.length === 0 && isZero(servicesTotal)) throw new ValidationError('Add at least one piece, item or charge to the bill.');
  const lines = await resolveLines(tx, branchId, customer?.id ?? null, inputs, lock, orderId);
  const requests: PriceRequest[] = lines.map((l) => ({
    metalId: l.metalId, purityId: l.purityId, itemId: l.itemId, quantity: l.quantity, grossWeightG: l.gross, stoneWeightG: l.stone,
    otherWeightG: l.other, stoneAmount: l.stoneAmount, hallmarkAmount: l.hallmark, hallmarked: l.hallmarked, customerStateCode: customer?.state_code ?? null, tag: l.tag,
  }));
  const price = await loadPricer(tx, requests);
  let priced: PricedLine[] = requests.map(price);
  const discount = rs(discountIn ?? '0');
  if (compare(discount, '0') < 0) throw new ValidationError('Discount cannot be negative.');
  const available = sum(priced.map(charges));
  const freePercent = String(await getConfig(tx, CONFIG.discountFreePercent));
  const free = rs(div(mul(available, freePercent), '100'));
  if (compare(discount, '0') > 0) {
    if (compare(discount, available) > 0) {
      throw new BusinessRuleError(`Discount ${inr(discount)} is more than the making and wastage ${inr(available)} on this bill.`, 'discount_exceeds_charges');
    }
    const shares = allocate(discount, priced.map(charges));
    priced = requests.map((r, i) => price({ ...r, discount: isZero(shares[i]!) ? null : { amount: shares[i]!, on: 'charges' } }));
  }
  const total = add(sum(priced.map((p) => p.lineTotal)), servicesTotal);
  const rounding = await getConfig(tx, CONFIG.invoiceRounding);
  const grand = rounding === 'none' ? total : rounding === 'nearest_10' ? mul(round(div(total, '10'), 0), '10') : round(total, 0);
  return { lines, priced, discount, available, free, freePercent, grand, roundOff: sub(grand, total) };
}

/** The live bill at the counter: the same prices checkout will save, nothing written. */
export async function quote(tx: Tx, input: {
  customerId?: string | null; lines: SaleLineInput[]; discount?: Decimal; orderId?: string; services?: ServiceLineInput[];
}) {
  const branchId = branchOf(tx);
  const customer = input.customerId ? await activeCustomer(tx, input.customerId) : null;
  // Labour is taxed the same way here as checkout will tax it, so the counter shows the figure that will be saved.
  const services = await priceServices(tx, branchId, customer ?? await walkInCustomer(tx), input.services);
  const labourTax = sum(services.rows.map((r) => sub(r.total, r.amount)));
  const q = await priceSale(tx, branchId, customer, input.lines, input.discount, false, input.orderId, services.total);
  const total = (k: keyof PricedLine) => sum(q.priced.map((p) => p[k] as Decimal));
  return {
    lines: q.lines.map((l, i) => {
      const p = q.priced[i]!;
      return {
        pieceId: l.pieceId, tagNumber: l.tagNumber, description: l.description, ratePerGram: p.snapshot.ratePerGram,
        netWeightG: p.netWeightG, fineWeightG: p.fineWeightG, metalOn: p.metalOn, metalWeightG: p.metalWeightG, metalAmount: p.metalAmount,
        wastagePercent: p.snapshot.wastage?.basis === 'percent' ? p.snapshot.wastage.rate : null, wastageWeightG: p.wastageWeightG,
        wastageAmount: p.wastageAmount, wastageSource: p.snapshot.wastageSource,
        making: p.snapshot.making ? { basis: p.snapshot.making.basis, rate: p.snapshot.making.rate } : null, makingAmount: p.makingAmount,
        makingSource: p.snapshot.makingSource, stoneAmount: p.stoneAmount, hallmarkAmount: p.hallmarkAmount, discountAmount: p.discountAmount,
        taxableAmount: p.taxableAmount, gstAmount: p.gstAmount, lineTotal: p.lineTotal,
      };
    }),
    services: services.rows,
    totals: {
      metal: total('metalAmount'), wastage: total('wastageAmount'), making: total('makingAmount'), stone: total('stoneAmount'),
      hallmark: total('hallmarkAmount'), discount: q.discount, labour: sum(services.rows.map((r) => r.amount)),
      taxable: add(total('taxableAmount'), sum(services.rows.map((r) => r.amount))), gst: add(total('gstAmount'), labourTax),
      roundOff: q.roundOff, grand: q.grand,
      /** Making + wastage: the most the discount can be; above discountFree it needs a manager. */
      discountable: q.available, discountFree: q.free, discountFreePercent: q.freePercent,
    },
    warnings: [...new Set(q.priced.flatMap((p) => p.warnings))],
  };
}

export async function checkout(tx: Tx, input: CheckoutInput) {
  const branchId = branchOf(tx);
  if (input.lines.length === 0 && !input.services?.length) {
    throw new ValidationError('Add at least one piece, item or charge to the bill.');
  }
  const customer = input.customerId ? await activeCustomer(tx, input.customerId) : await walkInCustomer(tx);
  const walkIn = isWalkIn(customer);
  const services = await priceServices(tx, branchId, customer, input.services);
  const { lines, priced, discount, free, freePercent, grand, roundOff } =
    await priceSale(tx, branchId, customer, input.lines, input.discount, true, input.orderId, services.total);
  if (input.expectedTotal !== undefined && compare(rs(input.expectedTotal), grand) !== 0) {
    throw new BusinessRuleError(`The price is now ${inr(grand)}, not ${inr(input.expectedTotal)} — a rate or Masters changed. Check the bill and save again.`, 'price_changed', { total: grand });
  }
  if (walkIn && compare(grand, PAN_LIMIT) >= 0) {
    throw new BusinessRuleError(`A bill of ${inr(grand)} needs the customer's name and PAN (₹2 lakh or more). Choose or add the customer.`, 'walk_in_not_allowed');
  }
  const docDate = await businessDate(tx);

  let approvedBy: string | null = null;
  if (compare(discount, free) > 0 && !hasPermission(tx.context.permissions, 'pos.discount.approve')) {
    if (!input.approver) {
      throw new BusinessRuleError(`A discount above ${inr(free)} (${freePercent}% of making and wastage) needs a manager's approval.`, 'discount_approval_required', { limit: free });
    }
    approvedBy = await verifyApprover(tx, branchId, input.approver);
  }

  if (compare(grand, PAN_LIMIT) >= 0 && !customer.pan) {
    const pan = input.pan?.trim().toUpperCase();
    if (!pan) throw new BusinessRuleError(`A bill of ${inr(grand)} needs the customer's PAN (₹2 lakh or more).`, 'pan_required');
    if (!PAN_PATTERN.test(pan)) throw new BusinessRuleError('PAN is 5 letters, 4 digits and a letter, like ABCDE1234F.', 'pan_invalid');
    await tx.query(`update party set pan = $2, updated_at = now(), updated_by = $3 where id = $1`, [customer.id, pan, tx.context.userId]);
  }

  // Tenders: each from Masters → Payment Modes; the rest stays on the customer.
  const tenders = [];
  const redeemed: { id: string; number: string }[] = [];
  const schemeTenders: (TenderInput & { amount: Decimal; method: Awaited<ReturnType<typeof paymentAccount>> })[] = [];
  for (const t of input.tenders) {
    const amount = rs(t.amount);
    if (!(compare(amount, '0') > 0)) continue;
    const method = await paymentAccount(tx, t.paymentMethodId, branchId);
    if (method.kind === 'credit') continue;
    if (method.requires_reference && !t.reference?.trim()) throw new BusinessRuleError(`${method.name} needs a reference (card slip, UTR, cheque number).`, 'reference_required');
    if (method.max_amount && compare(amount, method.max_amount) > 0) throw new BusinessRuleError(`${method.name} allows at most ${inr(method.max_amount)} on one bill.`, 'payment_limit');
    if (method.kind === 'scheme') {
      if (!t.schemeAccountId) {
        throw new BusinessRuleError('Choose which scheme account is being spent.', 'scheme_account_required');
      }
      schemeTenders.push({ ...t, amount, method });
      continue;
    }
    tenders.push({ ...t, amount, method });
  }

  /*
   * Savings spent on this bill. Most plans have to be taken in one go, so the
   * whole account is released and only what the bill needs is put against it —
   * the rest stays as the member's credit, exactly as old gold beyond a bill does.
   */
  for (const t of schemeTenders) {
    const done = await redeem(tx, t.schemeAccountId!, { docDate, toCredit: true });
    redeemed.push({ id: done.redemption.id, number: done.redemption.redemption_number });
    const left = sub(grand, sum(tenders.map((x) => x.amount)));
    const released = rs(done.redemption.amount_redeemed);
    const applied = compare(released, left) < 0 ? released : left;
    if (walkIn && compare(released, left) > 0) {
      throw new BusinessRuleError(`A scheme of ${inr(released)} is more than the ${inr(left)} left to pay. A walk-in cannot keep the difference: choose the customer.`, 'walk_in_not_allowed');
    }
    if (compare(applied, '0') > 0) {
      tenders.push({ ...t, amount: applied, reference: t.reference ?? done.redemption.redemption_number, method: t.method });
    }
  }
  // Customer's credit spent on this bill (advance, credit notes, old gold taken in earlier).
  const creditUsed = sum(tenders.filter((t) => CREDIT_KINDS.includes(t.method.kind)).map((t) => t.amount));
  if (walkIn && compare(creditUsed, '0') > 0) throw new BusinessRuleError('A walk-in has no advance to spend. Choose the customer.', 'walk_in_not_allowed');
  if (compare(creditUsed, '0') > 0) {
    const { advance } = await customerBalance(tx, customer.id);
    if (compare(creditUsed, advance) > 0) {
      throw new BusinessRuleError(`${customer.name} has ${inr(advance)} of advance, credit notes and old gold; ${inr(creditUsed)} was entered.`, 'advance_exceeds');
    }
  }

  // Old gold handed over now: taken in, credited, and used on this bill up to what is left to pay.
  let oldGoldIntake: { id: string; voucher_number: string } | null = null;
  if (input.oldGold) {
    if (!hasPermission(tx.context.permissions, 'oldgold.create')) throw new BusinessRuleError('You cannot take in old gold. Ask someone with Old Gold access.', 'forbidden');
    const og = await tx.maybeOne<{ id: string }>(`select id from payment_method where kind = 'old_gold' and is_active and deleted_at is null order by code limit 1`);
    if (!og) throw new BusinessRuleError('Add an Old Gold payment mode in Masters → Payment Modes.', 'tender_not_available');
    const method = await paymentAccount(tx, og.id, branchId);
    const intake = await createIntake(tx, { customerId: customer.id, channel: 'counter', settlement: 'exchange', lines: input.oldGold.lines,
      locationId: input.oldGold.locationId, idProof: input.oldGold.idProof }) as unknown as { id: string; voucher_number: string; net_value: Decimal };
    const left = sub(grand, sum(tenders.map((t) => t.amount)));
    if (walkIn && compare(intake.net_value, left) > 0) {
      throw new BusinessRuleError(`Old gold of ${inr(intake.net_value)} is more than the ${inr(left)} left to pay. A walk-in cannot keep the difference: choose the customer to keep it as advance.`, 'old_gold_exceeds');
    }
    const applied = compare(intake.net_value, left) < 0 ? intake.net_value : left;
    if (compare(applied, '0') > 0) tenders.push({ paymentMethodId: method.id, amount: applied, reference: intake.voucher_number, method });
    oldGoldIntake = intake;
  }
  const paid = sum(tenders.map((t) => t.amount));
  if (compare(paid, grand) > 0) {
    throw new BusinessRuleError(`Payments ${inr(paid)} are more than the bill ${inr(grand)}. Enter cash after change.`, 'overpayment');
  }
  await checkCashLimit(tx, customer, sum(tenders.filter((t) => t.method.kind === 'cash').map((t) => t.amount)), docDate);
  const balance = sub(grand, paid);
  if (walkIn && compare(balance, '0') > 0) {
    throw new BusinessRuleError(`A walk-in bill is paid in full; ${inr(balance)} is still unpaid. Take the rest, or choose the customer to leave it on account.`, 'walk_in_unpaid');
  }

  // What the goods cost us: a piece carries its own cost; a lot its location's average.
  const lotCosts = lines.some((l) => l.kind === 'lot') ? await tx.query<{ item_id: string; purity_id: string; location_id: string; average_rate: Decimal }>(
    `select item_id, purity_id, location_id, average_rate from stock_balance
      where (item_id, purity_id, location_id) in (select * from unnest($1::uuid[], $2::uuid[], $3::uuid[]))`,
    [lines.map((l) => l.itemId), lines.map((l) => l.purityId), lines.map((l) => l.locationId)]) : [];
  const costs = lines.map((l, i) => l.cost ?? rs(mul(priced[i]!.netWeightG,
    lotCosts.find((c) => c.item_id === l.itemId && c.purity_id === l.purityId && c.location_id === l.locationId)?.average_rate ?? '0')));

  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'sales_invoice', 1, { branchId, date: new Date(docDate) });
  const totals = (k: keyof PricedLine) => sum(priced.map((p) => p[k] as Decimal));
  const invoice = await repo<{ id: string; doc_number: string }>(tx, 'sales_invoice').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, customer_id: customer.id, status: 'posted', channel: 'counter',
    salesperson_id: input.salespersonId ?? tx.context.userId, discount_approved_by: approvedBy, place_of_supply_code: customer.state_code,
    notes: input.notes ?? null,
    metal_amount: add(totals('metalAmount'), totals('wastageAmount')),
    making_amount: add(totals('makingAmount'), sum(services.rows.map((s) => s.amount))), stone_amount: totals('stoneAmount'),
    other_charges: totals('hallmarkAmount'), discount_amount: totals('discountAmount'),
    taxable_amount: add(totals('taxableAmount'), sum(services.rows.map((s) => s.amount))),
    cgst_amount: add(totals('cgstAmount'), sum(services.rows.map((s) => s.cgst))),
    sgst_amount: add(totals('sgstAmount'), sum(services.rows.map((s) => s.sgst))),
    igst_amount: add(totals('igstAmount'), sum(services.rows.map((s) => s.igst))), round_off: roundOff,
    total_amount: grand, total_gross_weight: sum(lines.map((l) => l.gross)), total_net_weight: totals('netWeightG'),
    total_fine_weight: totals('fineWeightG'), paid_amount: paid, balance_amount: balance, posted_at: new Date(), posted_by: tx.context.userId,
  });

  const making = (p: PricedLine) => p.snapshot.making;
  const invLines = await repo<{ id: string }>(tx, 'sales_invoice_line').insertMany(lines.map((l, i) => {
    const p = priced[i]!;
    const basis = making(p)?.basis;
    return {
      sales_invoice_id: invoice.id, line_number: i + 1, item_id: l.itemId, purity_id: l.purityId, piece_id: l.pieceId, location_id: l.locationId,
      description: l.description, hsn_code: p.snapshot.hsnCode, quantity: l.quantity, gross_weight: l.gross, stone_weight: l.stone,
      other_weight: l.other, net_weight: p.netWeightG, fine_weight: p.fineWeightG, rate_per_gram: p.snapshot.ratePerGram,
      metal_amount: p.metalAmount, making_basis: basis === 'per_gram' || basis === 'percent' ? basis : 'flat',
      making_rate: making(p)?.rate ?? '0', making_amount: p.makingAmount, wastage_percent: p.snapshot.wastage?.basis === 'percent' ? p.snapshot.wastage.rate ?? '0' : '0',
      wastage_weight: p.wastageWeightG, wastage_amount: p.wastageAmount, stone_amount: p.stoneAmount, hallmark_charge: p.hallmarkAmount,
      discount_amount: p.discountAmount, taxable_amount: p.taxableAmount, gst_rate: p.taxBreakup[0]?.ratePercent ?? '0',
      cgst_amount: p.cgstAmount, sgst_amount: p.sgstAmount, igst_amount: p.igstAmount, line_total: p.lineTotal, cost_value: costs[i],
      pricing_snapshot: JSON.stringify({ ...p.snapshot, taxBreakup: p.taxBreakup }),
    };
  }));
  /* Labour lines sit on the same bill, after the goods, with no weight and no stock behind them. */
  if (services.rows.length) {
    const svcItem = await serviceItem(tx);
    await repo(tx, 'sales_invoice_line').insertMany(services.rows.map((s, i) => ({
      sales_invoice_id: invoice.id, line_number: lines.length + i + 1, item_id: svcItem, purity_id: null, piece_id: null,
      location_id: null, description: s.description, hsn_code: s.sacCode, quantity: '1',
      gross_weight: '0', stone_weight: '0', other_weight: '0', net_weight: '0', fine_weight: '0',
      rate_per_gram: '0', metal_amount: '0', making_basis: 'flat', making_rate: s.amount, making_amount: s.amount,
      wastage_percent: '0', wastage_weight: '0', wastage_amount: '0', stone_amount: '0', hallmark_charge: '0',
      discount_amount: '0', taxable_amount: s.amount, gst_rate: s.gstRate,
      cgst_amount: s.cgst, sgst_amount: s.sgst, igst_amount: s.igst, line_total: s.total, cost_value: '0',
      pricing_snapshot: JSON.stringify({ kind: 'service', sacCode: s.sacCode, gstRate: s.gstRate }),
    })));
  }
  if (tenders.length) {
    await repo(tx, 'sales_payment').insertMany(tenders.map((t) => ({
      sales_invoice_id: invoice.id, payment_method_id: t.method.id, mode: t.method.kind, amount: t.amount, reference: t.reference ?? null,
      account_id: t.method.account_id,
    })));
  }

  await recordMovements(tx, lines.map((l, i): MovementInput => ({
    direction: 'out', reason: 'sale', tracking: l.tracking, itemId: l.itemId, purityId: l.purityId, locationId: l.locationId, pieceId: l.pieceId,
    quantity: l.pieceId ? '1' : '0', grossWeight: l.gross, netWeight: priced[i]!.netWeightG, fineWeight: priced[i]!.fineWeightG, value: costs[i],
    sourceType: 'sales_invoice', sourceId: invoice.id, sourceLineId: invLines[i]!.id, note: docNumber,
  })));
  const soldPieces = lines.flatMap((l) => (l.pieceId ? [l.pieceId] : []));
  if (soldPieces.length) {
    await tx.query(`update stock_piece set status = 'sold', sold_at = now(), updated_at = now(), updated_by = $2 where id = any($1::uuid[])`,
      [soldPieces, tx.context.userId]);
  }
  const memoLines = lines.flatMap((l) => (l.memoLineId ? [l.memoLineId] : []));
  if (memoLines.length) await settleMemoLines(tx, memoLines, invoice.id);

  const cost = sum(costs);
  const serviceAmount = sum(services.rows.map((s) => s.amount));
  const ps = await postingSettings(tx);
  const money: MoneyEntry[] = [
    ...tenders.map((t) => CREDIT_KINDS.includes(t.method.kind)
      ? { accountCode: '2400', partyId: customer.id, debit: t.amount, narration: `${t.method.kind === 'old_gold' ? `Old gold ${t.reference ?? ''}` : 'Advance'} used on ${docNumber}` }
      : { ...t.method.account, debit: t.amount, narration: `${t.method.name}${t.reference ? ` ${t.reference}` : ''}` }),
    ...tenders.flatMap((t) => modeCharges(ps, t.method, t.amount, docNumber!)),
    { accountCode: '1100', partyId: customer.id, debit: balance, narration: `Bill ${docNumber}`, againstType: 'sales_invoice', againstId: invoice.id },
    ...revenueEntries(ps, {
      metal: totals('metalAmount'), wastage: totals('wastageAmount'), making: totals('makingAmount'), stone: totals('stoneAmount'),
      hallmark: totals('hallmarkAmount'), discount: totals('discountAmount'), taxable: totals('taxableAmount'),
    }, `Bill ${docNumber}`),
    ...(compare(serviceAmount, '0') > 0 ? [{ accountCode: '4100', credit: serviceAmount, narration: 'Labour and services' }] : []),
    ...gstEntries('output', {
      cgst: add(totals('cgstAmount'), sum(services.rows.map((s) => s.cgst))),
      sgst: add(totals('sgstAmount'), sum(services.rows.map((s) => s.sgst))),
      igst: add(totals('igstAmount'), sum(services.rows.map((s) => s.igst))),
    }, 'credit', `Bill ${docNumber}`),
    ...compositionEntries(ps, add(totals('taxableAmount'), serviceAmount), `Bill ${docNumber}`),
    line('4900', roundOff, 'credit', 'Round off'),
    { accountCode: '5100', debit: cost, narration: 'Cost of goods sold' },
    { accountCode: '1200', credit: cost, narration: 'Stock sold' },
  ];
  const metal: MetalEntry[] = lines.map((l, i) => ({ accountCode: '1210', metalId: l.metalId, purityId: l.purityId, grossWeight: l.gross,
    weightOut: priced[i]!.fineWeightG, ratePerGram: priced[i]!.snapshot.ratePerGram, narration: `Sale ${docNumber}` }));
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'sale', voucherDate: docDate, branchId, sourceType: 'sales_invoice', sourceId: invoice.id,
    narration: `Bill ${docNumber} to ${customer.name}`, money, metal,
  });
  await tx.query(`update sales_invoice set voucher_id = $2 where id = $1`, [invoice.id, voucherId]);
  if (oldGoldIntake) await tx.query(`update old_gold_intake set applied_to_invoice_id = $2, updated_at = now() where id = $1`, [oldGoldIntake.id, invoice.id]);
  if (redeemed.length) {
    await tx.query(`update scheme_redemption set sales_invoice_id = $2, updated_at = now() where id = any($1::uuid[])`,
      [redeemed.map((r) => r.id), invoice.id]);
  }
  if (input.orderId) await markOrderBilled(tx, input.orderId, invoice.id);
  return { ...(await invoiceDetail(tx, invoice.id)), warnings: [...new Set(priced.flatMap((p) => p.warnings))] };
}

export async function invoiceDetail(tx: Tx, id: string) {
  const [invoice, lines, payments, returns] = await Promise.all([
    tx.one(`select si.*, p.name as customer_name, p.code as customer_code, p.phone as customer_phone, p.gstin as customer_gstin, p.pan as customer_pan,
                   p.address_line1 as customer_address, p.city as customer_city,
                   b.name as branch_name, b.gstin as branch_gstin, b.address_line1 as branch_address, b.city as branch_city, b.phone as branch_phone,
                   u.full_name as salesperson_name, ap.full_name as approved_by_name
              from sales_invoice si join party p on p.id = si.customer_id join branch b on b.id = si.branch_id
              left join app_user u on u.id = si.salesperson_id left join app_user ap on ap.id = si.discount_approved_by
             where si.id = $1`, [id]),
    tx.query(`select l.*, i.name as item_name, pu.code as purity_code, sp.tag_number, sp.huid
                from sales_invoice_line l join item i on i.id = l.item_id left join purity pu on pu.id = l.purity_id
                left join stock_piece sp on sp.id = l.piece_id where l.sales_invoice_id = $1 order by l.line_number`, [id]),
    tx.query(`select sp.*, pm.name as method_name from sales_payment sp left join payment_method pm on pm.id = sp.payment_method_id
               where sp.sales_invoice_id = $1 order by sp.received_at`, [id]),
    tx.query(`select id, doc_number, doc_date, total_amount, settlement from sales_return where sales_invoice_id = $1 and status = 'posted' order by doc_date`, [id]),
  ]);
  return { ...invoice, lines, payments, returns };
}

/** Undo a bill entered by mistake: everything reverses and the pieces go back on the shelf. */
export async function cancelInvoice(tx: Tx, id: string, reason: string) {
  const inv = await tx.one<{ doc_number: string; status: string; voucher_id: string | null; irn_status: string }>(
    `select doc_number, status, voucher_id, irn_status from sales_invoice where id = $1 for update`, [id]);
  if (inv.status !== 'posted') throw new BusinessRuleError(`${inv.doc_number} is already ${inv.status}.`, 'not_posted');
  if (inv.irn_status === 'generated') {
    throw new BusinessRuleError('This bill has an e-invoice (IRN). Cancel it on the GST portal first — within 24 hours.', 'irn_cancel_required');
  }
  const returned = await tx.maybeOne<{ doc_number: string }>(`select doc_number from sales_return where sales_invoice_id = $1 and status = 'posted' limit 1`, [id]);
  if (returned) throw new BusinessRuleError(`Goods on ${inv.doc_number} were returned on ${returned.doc_number}; it can no longer be cancelled.`, 'invoice_returned');
  const receipts = await tx.maybeOne<{ doc_number: string }>(
    `select doc_number from customer_receipt where status = 'posted' and allocations @> jsonb_build_array(jsonb_build_object('invoiceId', $1::text)) limit 1`, [id]);
  if (receipts) throw new BusinessRuleError(`Receipt ${receipts.doc_number} was paid against ${inv.doc_number}. Cancel the receipt first.`, 'invoice_has_receipts');

  await reverseMovementsFor(tx, 'sales_invoice', id, `Cancelled: ${reason}`);
  if (inv.voucher_id) await reverseVoucher(tx, inv.voucher_id, reason);
  // Old gold handed over on this bill goes back to the customer with it.
  for (const og of await tx.query<{ id: string }>(`select id from old_gold_intake where applied_to_invoice_id = $1 and channel = 'counter' and status = 'posted'`, [id])) {
    await cancelIntake(tx, og.id, `Bill cancelled: ${reason}`, true);
  }
  await tx.query(
    `update stock_piece set status = 'in_stock', sold_at = null, updated_at = now(), updated_by = $2
      where id in (select piece_id from sales_invoice_line where sales_invoice_id = $1 and piece_id is not null)`, [id, tx.context.userId]);
  // Pieces that came off an approval memo go back to it; a memo this bill closed opens again.
  await tx.query(
    `update approval_memo set status = 'open', updated_at = now()
      where status = 'closed' and id in (select approval_memo_id from approval_memo_line where sales_invoice_id = $1)`, [id]);
  await tx.query(
    `update stock_piece p set status = 'on_memo' from approval_memo_line ml join approval_memo m on m.id = ml.approval_memo_id
      where ml.sales_invoice_id = $1 and p.id = ml.piece_id and m.status = 'open'`, [id]);
  await tx.query(`update approval_memo_line set sales_invoice_id = null where sales_invoice_id = $1`, [id]);
  return tx.one(
    `update sales_invoice set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
      where id = $1 returning *`, [id, tx.context.userId, reason]);
}

/* ------------------------------------------------------------------ return */

export interface SalesReturnInput {
  invoiceId: string;
  lines: { invoiceLineId: string; netWeight?: Decimal }[];
  settlement: 'refund' | 'credit_note';
  refundPaymentMethodId?: string;
  deduction?: Decimal;
  locationId?: string;
  reason?: 'defect' | 'size' | 'dislike' | 'wrong_item' | 'other';
  notes?: string;
}

/**
 * A customer brings goods back. The value comes back in proportion (price,
 * GST and cost), first clearing anything still owed on the bill, then as a
 * refund or a credit note the customer spends on a new bill (an exchange).
 */
export async function createSalesReturn(tx: Tx, input: SalesReturnInput) {
  const branchId = branchOf(tx);
  if (input.lines.length === 0) throw new ValidationError('Choose what is coming back.');
  const inv = await tx.one<{ id: string; doc_number: string; status: string; customer_id: string; branch_id: string; balance_amount: Decimal; total_amount: Decimal }>(
    `select id, doc_number, status, customer_id, branch_id, balance_amount, total_amount from sales_invoice where id = $1 for update`, [input.invoiceId]);
  if (inv.status !== 'posted') throw new BusinessRuleError(`${inv.doc_number} is ${inv.status}.`, 'not_posted');
  const customer = await activeCustomer(tx, inv.customer_id);
  if (input.settlement === 'credit_note' && isWalkIn(customer)) {
    throw new BusinessRuleError('A walk-in bill is refunded, not kept as a credit note (there is no one to hold it). Choose Refund.', 'walk_in_not_allowed');
  }
  const src = await tx.query<{ id: string; line_number: number; item_id: string; purity_id: string; metal_id: string; piece_id: string | null; tracking: 'lot' | 'piece';
    location_id: string; gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; returned_net_weight: Decimal; taxable_amount: Decimal;
    metal_amount: Decimal; making_amount: Decimal; wastage_amount: Decimal; stone_amount: Decimal; hallmark_charge: Decimal; discount_amount: Decimal;
    cgst_amount: Decimal; sgst_amount: Decimal; igst_amount: Decimal; line_total: Decimal; cost_value: Decimal; tag_number: string | null; item_name: string }>(
    `select l.*, i.tracking, i.name as item_name, pu.metal_id, sp.tag_number
       from sales_invoice_line l join item i on i.id = l.item_id join purity pu on pu.id = l.purity_id left join stock_piece sp on sp.id = l.piece_id
      where l.sales_invoice_id = $1 for update of l`, [inv.id]);
  const srcById = new Map(src.map((s) => [s.id, s]));
  const location = input.locationId
    ? await tx.maybeOne<{ id: string }>(`select id from stock_location where id = $1 and branch_id = $2 and is_active and kind <> 'transit'`, [input.locationId, branchId])
    : null;
  if (input.locationId && !location) throw new BusinessRuleError('Choose an active location at this branch for the returned goods.', 'location_invalid');

  const parts = input.lines.map((l) => {
    const s = srcById.get(l.invoiceLineId);
    if (!s) throw new BusinessRuleError(`That line is not on ${inv.doc_number}.`, 'line_mismatch');
    const left = sub(s.net_weight, s.returned_net_weight);
    const net = s.piece_id ? s.net_weight : g(l.netWeight ?? left);
    if (!(compare(left, '0') > 0)) throw new BusinessRuleError(`${s.tag_number ?? s.item_name} was already returned.`, 'already_returned');
    if (!(compare(net, '0') > 0) || compare(net, left) > 0) throw new BusinessRuleError(`At most ${fixed(left, 3)} g of ${s.item_name} can come back.`, 'weight_exceeds');
    const share = div(net, s.net_weight);
    const piece = (v: Decimal) => (s.piece_id ? v : rs(mul(v, share)));
    return { s, net, share, gross: s.piece_id ? s.gross_weight : g(mul(s.gross_weight, share)), fine: s.piece_id ? s.fine_weight : g(mul(s.fine_weight, share)),
      taxable: piece(s.taxable_amount), gst: piece(add(s.cgst_amount, add(s.sgst_amount, s.igst_amount))), value: piece(s.line_total), cost: piece(s.cost_value),
      cgst: piece(s.cgst_amount), sgst: piece(s.sgst_amount), igst: piece(s.igst_amount),
      metal: piece(s.metal_amount), making: piece(s.making_amount), wastage: piece(s.wastage_amount), stone: piece(s.stone_amount),
      hallmark: piece(s.hallmark_charge), discount: piece(s.discount_amount),
      locationId: location?.id ?? s.location_id };
  });

  // The return that brings back everything still on the bill takes back the bill's own total (its round-off
  // included), less earlier returns, so a fully returned bill is left owing nothing, not a few paise.
  const backNow = new Map<string, Decimal>();
  for (const p of parts) backNow.set(p.s.id, add(backNow.get(p.s.id) ?? '0', p.net));
  const completes = src.every((s) => compare(add(s.returned_net_weight, backNow.get(s.id) ?? '0'), s.net_weight) >= 0);
  const earlier = completes
    ? (await tx.one<{ total: Decimal }>(`select coalesce(sum(total_amount), 0)::text as total from sales_return where sales_invoice_id = $1 and status = 'posted'`, [inv.id])).total
    : '0';
  const value = completes ? sub(inv.total_amount, earlier) : sum(parts.map((p) => p.value));
  const deduction = rs(input.deduction ?? '0');
  if (compare(deduction, '0') < 0 || compare(deduction, value) > 0) throw new ValidationError(`The deduction must be between ₹0 and ${inr(value)}.`);
  const due = sub(value, deduction);
  const adjusted = compare(inv.balance_amount, due) < 0 ? inv.balance_amount : due;
  const back = sub(due, adjusted);
  const refunding = input.settlement === 'refund' && compare(back, '0') > 0;
  if (refunding && !input.refundPaymentMethodId) throw new BusinessRuleError(`Choose how the ${inr(back)} is refunded.`, 'refund_method_required');
  const refundMethod = refunding ? await paymentAccount(tx, input.refundPaymentMethodId!, branchId) : null;
  if (refundMethod && ['credit', 'advance', 'old_gold', 'scheme'].includes(refundMethod.kind)) {
    throw new BusinessRuleError(`${refundMethod.name} cannot pay a refund. Choose cash, card, UPI or bank.`, 'payment_method_invalid');
  }
  if (refundMethod && refundMethod.kind === 'cash' && compare(back, CASH_LIMIT) >= 0) {
    throw new BusinessRuleError(`A cash refund of ${inr(back)} is not allowed (₹2 lakh or more). Refund by bank.`, 'cash_limit');
  }

  const docDate = await businessDate(tx);
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'sales_return', 1, { branchId, date: new Date(docDate) });
  const ret = await repo<{ id: string }>(tx, 'sales_return').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, customer_id: customer.id, status: 'posted', sales_invoice_id: inv.id,
    settlement: input.settlement, reason: input.reason ?? 'other', notes: input.notes ?? null, refund_payment_method_id: refundMethod?.id ?? null,
    taxable_amount: sum(parts.map((p) => p.taxable)), cgst_amount: sum(parts.map((p) => p.gst)), total_amount: value,
    deduction_amount: deduction, refund_amount: back, adjusted_amount: adjusted,
    total_gross_weight: sum(parts.map((p) => p.gross)), total_net_weight: sum(parts.map((p) => p.net)), total_fine_weight: sum(parts.map((p) => p.fine)),
    posted_at: new Date(), posted_by: tx.context.userId,
  });
  const retLines = await repo<{ id: string }>(tx, 'sales_return_line').insertMany(parts.map((p, i) => ({
    sales_return_id: ret.id, line_number: i + 1, sales_invoice_line_id: p.s.id, item_id: p.s.item_id, purity_id: p.s.purity_id,
    piece_id: p.s.piece_id, location_id: p.locationId, quantity: 1, gross_weight: p.gross, net_weight: p.net, fine_weight: p.fine,
    taxable_amount: p.taxable, line_total: p.value, cost_value: p.cost,
  })));
  await tx.query(
    `update sales_invoice_line l set returned_net_weight = l.returned_net_weight + x.net
       from jsonb_to_recordset($1::jsonb) as x(id uuid, net numeric) where l.id = x.id`,
    [JSON.stringify(parts.map((p) => ({ id: p.s.id, net: p.net })))]);
  if (compare(adjusted, '0') > 0) {
    await tx.query(`update sales_invoice set balance_amount = balance_amount - $2, updated_at = now() where id = $1`, [inv.id, adjusted]);
  }

  await recordMovements(tx, parts.map((p, i): MovementInput => ({
    direction: 'in', reason: 'sales_return', tracking: p.s.tracking, itemId: p.s.item_id, purityId: p.s.purity_id, locationId: p.locationId,
    pieceId: p.s.piece_id, quantity: p.s.piece_id ? '1' : '0', grossWeight: p.gross, netWeight: p.net, fineWeight: p.fine, value: p.cost,
    sourceType: 'sales_return', sourceId: ret.id, sourceLineId: retLines[i]!.id, note: docNumber,
  })), { allowNegative: true });
  const pieces = parts.flatMap((p) => (p.s.piece_id ? [{ id: p.s.piece_id, locationId: p.locationId }] : []));
  if (pieces.length) {
    await tx.query(
      `update stock_piece p set status = 'in_stock', sold_at = null, location_id = x.location_id, updated_at = now(), updated_by = $2
         from jsonb_to_recordset($1::jsonb) as x(id uuid, location_id uuid) where p.id = x.id`,
      [JSON.stringify(pieces.map((p) => ({ id: p.id, location_id: p.locationId }))), tx.context.userId]);
  }

  const cost = sum(parts.map((p) => p.cost));
  const ps = await postingSettings(tx);
  const total = (k: 'metal' | 'making' | 'wastage' | 'stone' | 'hallmark' | 'discount' | 'taxable' | 'cgst' | 'sgst' | 'igst') => sum(parts.map((p) => p[k]));
  const money: MoneyEntry[] = [
    ...revenueEntries(ps, {
      metal: total('metal'), making: total('making'), wastage: total('wastage'), stone: total('stone'),
      hallmark: total('hallmark'), discount: total('discount'), taxable: total('taxable'),
    }, `Return ${docNumber}`, true),
    ...gstEntries('output', { cgst: total('cgst'), sgst: total('sgst'), igst: total('igst') }, 'debit', `Return ${docNumber}`),
    ...compositionEntries(ps, total('taxable'), `Return ${docNumber}`, true),
    { accountCode: ps.revenueSplit === 'single' ? '4000' : '4400', credit: deduction, narration: 'Return deduction' },
    { accountCode: '1100', partyId: customer.id, credit: adjusted, narration: `Return ${docNumber} against ${inv.doc_number}`, againstType: 'sales_invoice', againstId: inv.id },
    refundMethod
      ? { ...refundMethod.account, credit: back, narration: `Refund by ${refundMethod.name}` }
      : { accountCode: '2400', partyId: customer.id, credit: back, narration: `Credit note ${docNumber}` },
    { accountCode: '1200', debit: cost, narration: 'Stock returned' },
    { accountCode: '5100', credit: cost, narration: 'Cost of returned goods' },
  ];
  // What the bill's round-off and exact value differ by is written off to round off.
  const gap = sub(sum(money.map((m) => m.debit ?? '0')), sum(money.map((m) => m.credit ?? '0')));
  if (!isZero(gap)) money.push(compare(gap, '0') > 0 ? { accountCode: '4900', credit: gap, narration: 'Round off' } : { accountCode: '4900', debit: neg(gap), narration: 'Round off' });
  const metal: MetalEntry[] = parts.map((p) => ({ accountCode: '1210', metalId: p.s.metal_id, purityId: p.s.purity_id, grossWeight: p.gross,
    weightIn: p.fine, narration: `Return ${docNumber}` }));
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'sales_return', voucherDate: docDate, branchId, sourceType: 'sales_return', sourceId: ret.id,
    narration: `Return ${docNumber} from ${customer.name}`, money, metal,
  });
  return tx.one(`update sales_return set voucher_id = $2 where id = $1 returning *`, [ret.id, voucherId]);
}

/* ----------------------------------------------------------------- receipt */

/** Money from a customer: clears their oldest bills first; anything more is kept as advance. */
export async function createReceipt(tx: Tx, input: { customerId: string; amount: Decimal; paymentMethodId: string; reference?: string; notes?: string }) {
  const branchId = branchOf(tx);
  const customer = named(await activeCustomer(tx, input.customerId), 'A receipt');
  const amount = rs(input.amount);
  if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount received.');
  const method = await paymentAccount(tx, input.paymentMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) throw new BusinessRuleError(`${method.name} cannot be used to receive money.`, 'payment_method_invalid');
  if (method.requires_reference && !input.reference?.trim()) throw new BusinessRuleError(`${method.name} needs a reference (UTR, cheque number).`, 'reference_required');
  const docDate = await businessDate(tx);
  if (method.kind === 'cash') await checkCashLimit(tx, customer, amount, docDate);
  if (method.max_amount && compare(amount, method.max_amount) > 0) throw new BusinessRuleError(`${method.name} allows at most ${inr(method.max_amount)} at once.`, 'payment_limit');

  const open = await tx.query<{ id: string; doc_number: string; balance_amount: Decimal }>(
    `select id, doc_number, balance_amount from sales_invoice
      where customer_id = $1 and status = 'posted' and balance_amount > 0 order by doc_date, doc_number for update`, [customer.id]);
  let left = amount;
  const allocations: { invoiceId: string; docNumber: string; amount: Decimal }[] = [];
  for (const inv of open) {
    if (!(compare(left, '0') > 0)) break;
    const take = compare(inv.balance_amount, left) < 0 ? inv.balance_amount : left;
    allocations.push({ invoiceId: inv.id, docNumber: inv.doc_number, amount: take });
    left = sub(left, take);
  }
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'customer_receipt', 1, { branchId, date: new Date(docDate) });
  const receipt = await repo<{ id: string }>(tx, 'customer_receipt').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, customer_id: customer.id, payment_method_id: method.id, amount,
    reference: input.reference ?? null, allocations: JSON.stringify(allocations), advance_amount: left, notes: input.notes ?? null,
  });
  if (allocations.length) {
    await tx.query(
      `update sales_invoice s set balance_amount = s.balance_amount - x.amount, paid_amount = s.paid_amount + x.amount, updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x("invoiceId" uuid, amount numeric) where s.id = x."invoiceId"`, [JSON.stringify(allocations)]);
  }
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'receipt', voucherDate: docDate, branchId, sourceType: 'customer_receipt', sourceId: receipt.id,
    narration: `Receipt ${docNumber} from ${customer.name}`,
    money: [
      { ...method.account, debit: amount, narration: `${method.name}${input.reference ? ` ${input.reference}` : ''}` },
      ...allocations.map((a) => ({ accountCode: '1100', partyId: customer.id, credit: a.amount, narration: `Against ${a.docNumber}`,
        againstType: 'sales_invoice', againstId: a.invoiceId })),
      { accountCode: '2400', partyId: customer.id, credit: left, narration: 'Advance received' },
      ...modeCharges(await postingSettings(tx), method, amount, docNumber!),
    ],
  });
  return tx.one(`update customer_receipt set voucher_id = $2 where id = $1 returning *`, [receipt.id, voucherId]);
}

export async function cancelReceipt(tx: Tx, id: string, reason: string) {
  const r = await tx.one<{ doc_number: string; status: string; voucher_id: string | null; customer_id: string; advance_amount: Decimal;
    allocations: { invoiceId: string; amount: Decimal }[] }>(`select * from customer_receipt where id = $1 for update`, [id]);
  if (r.status !== 'posted') throw new BusinessRuleError(`${r.doc_number} is already cancelled.`, 'not_posted');
  if (compare(r.advance_amount, '0') > 0) {
    const { advance } = await customerBalance(tx, r.customer_id);
    if (compare(advance, r.advance_amount) < 0) throw new BusinessRuleError(`The advance from ${r.doc_number} was already used on a bill.`, 'advance_used');
  }
  if (r.voucher_id) await reverseVoucher(tx, r.voucher_id, reason);
  if (r.allocations.length) {
    await tx.query(
      `update sales_invoice s set balance_amount = s.balance_amount + x.amount, paid_amount = s.paid_amount - x.amount, updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x("invoiceId" uuid, amount numeric) where s.id = x."invoiceId"`, [JSON.stringify(r.allocations)]);
  }
  return tx.one(`update customer_receipt set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1 returning *`, [id, reason]);
}

/* ------------------------------------------------------------ approval memo */

export async function createMemo(tx: Tx, input: { customerId: string; pieceIds: string[]; dueDate: string; notes?: string }) {
  const branchId = branchOf(tx);
  const customer = named(await activeCustomer(tx, input.customerId), 'Sending on approval');
  const ids = [...new Set(input.pieceIds)];
  if (ids.length === 0) throw new ValidationError('Scan the pieces going on approval.');
  const docDate = await businessDate(tx);
  if (input.dueDate < docDate) throw new BusinessRuleError('The return date cannot be before today.', 'due_date_invalid');
  const pieces = await tx.query<{ id: string; tag_number: string; status: string; branch_id: string; gross_weight: Decimal }>(
    `select p.id, p.tag_number, p.status, l.branch_id, p.gross_weight from stock_piece p join stock_location l on l.id = p.location_id
      where p.id = any($1::uuid[]) for update of p`, [ids]);
  if (pieces.length !== ids.length) throw new BusinessRuleError('Some of those pieces do not exist.', 'not_found');
  const wrong = pieces.filter((p) => p.status !== 'in_stock' || p.branch_id !== branchId);
  if (wrong.length) throw new BusinessRuleError(`Not in stock at this branch: ${wrong.map((p) => p.tag_number).join(', ')}.`, 'piece_not_in_stock');
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'approval_memo', 1, { branchId, date: new Date(docDate) });
  const memo = await repo<{ id: string }>(tx, 'approval_memo').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, customer_id: customer.id, due_date: input.dueDate,
    notes: input.notes ?? null, piece_count: pieces.length, gross_weight: sum(pieces.map((p) => p.gross_weight)),
  });
  await repo(tx, 'approval_memo_line').insertMany(ids.map((pieceId) => ({ approval_memo_id: memo.id, piece_id: pieceId })));
  await tx.query(`update stock_piece set status = 'on_memo', updated_at = now(), updated_by = $2 where id = any($1::uuid[])`, [ids, tx.context.userId]);
  return memoDetail(tx, memo.id);
}

/** Pieces coming back from approval go straight back on the shelf. */
export async function returnMemoPieces(tx: Tx, memoId: string, pieceIds: string[]) {
  const memo = await tx.one<{ doc_number: string; status: string }>(`select doc_number, status from approval_memo where id = $1 for update`, [memoId]);
  if (memo.status !== 'open') throw new BusinessRuleError(`${memo.doc_number} is closed.`, 'memo_closed');
  const lines = await tx.query<{ id: string; piece_id: string }>(
    `update approval_memo_line set returned_at = now()
      where approval_memo_id = $1 and piece_id = any($2::uuid[]) and returned_at is null and sales_invoice_id is null returning id, piece_id`,
    [memoId, pieceIds]);
  if (lines.length !== new Set(pieceIds).size) throw new BusinessRuleError(`Some of those pieces are not out on ${memo.doc_number}.`, 'memo_piece_mismatch');
  await tx.query(`update stock_piece set status = 'in_stock', updated_at = now(), updated_by = $2 where id = any($1::uuid[])`,
    [lines.map((l) => l.piece_id), tx.context.userId]);
  await closeMemoIfDone(tx, memoId);
  return memoDetail(tx, memoId);
}

async function settleMemoLines(tx: Tx, lineIds: string[], invoiceId: string) {
  const memos = await tx.query<{ approval_memo_id: string }>(
    `update approval_memo_line set sales_invoice_id = $2 where id = any($1::uuid[]) returning approval_memo_id`, [lineIds, invoiceId]);
  for (const id of new Set(memos.map((m) => m.approval_memo_id))) await closeMemoIfDone(tx, id);
}

async function closeMemoIfDone(tx: Tx, memoId: string) {
  await tx.query(
    `update approval_memo set status = 'closed', updated_at = now()
      where id = $1 and not exists (select 1 from approval_memo_line where approval_memo_id = $1 and returned_at is null and sales_invoice_id is null)`,
    [memoId]);
}

export async function memoDetail(tx: Tx, id: string) {
  const [memo, lines] = await Promise.all([
    tx.one(`select m.*, p.name as customer_name, p.phone as customer_phone from approval_memo m join party p on p.id = m.customer_id where m.id = $1`, [id]),
    tx.query(`select ml.*, sp.tag_number, sp.huid, sp.gross_weight, sp.net_weight, i.name as item_name, pu.code as purity_code, si.doc_number as invoice_number
                from approval_memo_line ml join stock_piece sp on sp.id = ml.piece_id join item i on i.id = sp.item_id
                left join purity pu on pu.id = sp.purity_id left join sales_invoice si on si.id = ml.sales_invoice_id
               where ml.approval_memo_id = $1 order by sp.tag_number`, [id]),
  ]);
  return { ...memo, lines };
}
