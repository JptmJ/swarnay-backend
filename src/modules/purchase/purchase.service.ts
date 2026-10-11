/**
 * Module 5.1 — buying stock.
 *
 * Every document posts as soon as it is saved, in one transaction: stock, the
 * supplier's balance (rupees and fine metal) and the books move together or not
 * at all. A mistake is undone by cancelling (a mirror entry), never by editing.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, fixed, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { recordMovements, reverseMovementsFor, type MovementInput } from '../inventory/stock.service.js';
import { postVoucher, reverseVoucher, type MetalEntry, type MoneyEntry } from '../accounts/ledger.service.js';
import { businessDate } from '../../core/util/business-date.js';

const g = (v: Decimal) => round(v, 3);
const rs = (v: Decimal) => round(v, 2);
const neg = (v: Decimal) => sub('0', v);

/* ------------------------------------------------------------------ shared */

interface Supplier { id: string; name: string; state_code: string | null; gstin: string | null }

async function activeSupplier(tx: Tx, supplierId: string): Promise<Supplier> {
  const s = await tx.maybeOne<Supplier & { is_supplier: boolean; is_active: boolean }>(
    `select id, name, state_code, gstin, is_supplier, is_active from party where id = $1 and deleted_at is null`, [supplierId]);
  if (!s) throw new NotFoundError('Supplier', supplierId);
  if (!s.is_supplier) throw new BusinessRuleError(`${s.name} is not marked as a supplier. Tick Supplier on the party in Masters.`, 'not_a_supplier');
  if (!s.is_active) throw new BusinessRuleError(`${s.name} is inactive.`, 'party_inactive');
  return s;
}

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

/** A document's date: the one given (never after the shop's today), or the shop's today. */
async function docDateOf(tx: Tx, given?: string): Promise<string> {
  const now = await businessDate(tx);
  if (given && given > now) throw new BusinessRuleError('The date cannot be in the future.', 'future_date');
  return given ?? now;
}

/** Rupees a supplier is owed on 2000 (credit − debit) and fine metal per metal on 2010. */
export async function supplierBalance(tx: Tx, supplierId: string) {
  return tx.one<{ rupees: Decimal; metals: { metal_id: string; metal: string; fine: Decimal; rate: Decimal | null }[] }>(
    `select coalesce((select sum(e.credit - e.debit) from ledger_entry e join account a on a.id = e.account_id
                       where a.code = '2000' and e.party_id = $1), 0)::text as rupees,
            coalesce((select json_agg(x order by x.metal) from (
               select m.id as metal_id, m.name as metal, sum(e.weight_in - e.weight_out)::text as fine,
                      (sum(e.weight_in * e.rate_per_gram) / nullif(sum(e.weight_in), 0))::numeric(14,2)::text as rate
                 from metal_ledger_entry e join account a on a.id = e.account_id join metal m on m.id = e.metal_id
                where a.code = '2010' and e.party_id = $1
                group by m.id, m.name having sum(e.weight_in - e.weight_out) <> 0) x), '[]') as metals`,
    [supplierId]);
}

/* ------------------------------------------------------------------ inward */

export interface InwardLineInput {
  itemId: string;
  purityId: string;
  /** Piece items: how many pieces arrived. They wait in Tagging. */
  pieces?: number;
  grossWeight: Decimal;
  stoneWeight?: Decimal;
  otherWeight?: Decimal;
  declaredWeight?: Decimal;
  metalBasis: 'rupee' | 'fine';
  /** Rupee basis: the agreed rate per gram of this purity. Fine basis: the value per gram for stock (defaults to today's buying rate). */
  ratePerGram?: Decimal;
  /** Fine basis: % of net weight owed back as pure metal. Defaults to the purity's fineness. */
  touchPercent?: Decimal;
  makingBasis?: 'per_gram' | 'flat' | 'percent';
  makingRate?: Decimal;
  stoneAmount?: Decimal;
  purchaseOrderLineId?: string;
}

export interface BillInput {
  /** Blank when the seller gave no numbered bill: our own purchase number stands in. */
  supplierInvoiceNumber?: string;
  supplierInvoiceDate: string;
  dueDate?: string;
  /** Type the GST exactly as printed on the supplier's bill when it differs from the calculated one. */
  gstAmount?: Decimal;
}

export interface InwardInput {
  supplierId: string;
  docDate?: string;
  locationId: string;
  purchaseOrderId?: string;
  referenceNumber?: string;
  notes?: string;
  lines: InwardLineInput[];
  bill?: BillInput;
  /** A direct purchase: the bill is required and the goods and bill stay one record. */
  direct?: boolean;
}

/** Value per gram of each purity for stock: today's buying rate, else the selling rate, from the purity or the pure rate. */
async function valuationRates(tx: Tx, purityIds: string[]): Promise<Map<string, Decimal>> {
  const rows = await tx.query<{ purity_id: string; rate: Decimal | null }>(
    `select p.id as purity_id,
            coalesce(own.rate, pure.rate * p.fineness_percent / 100)::numeric(14,2)::text as rate
       from purity p
       left join lateral (select coalesce(buying_rate_per_gram, rate_per_gram) as rate from metal_rate
                           where purity_id = p.id and effective_from <= now() and retired_at is null and (branch_id = $2 or branch_id is null)
                           order by effective_from desc, branch_id nulls last limit 1) own on true
       left join lateral (select coalesce(buying_rate_per_gram, rate_per_gram) as rate from metal_rate
                           where metal_id = p.metal_id and purity_id is null and effective_from <= now() and retired_at is null and (branch_id = $2 or branch_id is null)
                           order by effective_from desc, branch_id nulls last limit 1) pure on true
      where p.id = any($1::uuid[])`, [purityIds, tx.context.branchId]);
  return new Map(rows.filter((r) => r.rate).map((r) => [r.purity_id, r.rate!]));
}

interface PricedInwardLine {
  input: InwardLineInput;
  item: { id: string; name: string; tracking: 'lot' | 'piece'; metal_id: string | null; hsn: string | null };
  purity: { id: string; code: string; metal_id: string; fineness: Decimal };
  pieces: number; net: Decimal; fine: Decimal; rate: Decimal; touch: Decimal | null; fineOwed: Decimal;
  metalAmount: Decimal; makingAmount: Decimal; stoneAmount: Decimal; cost: Decimal;
  /** What the supplier is owed in rupees for this line. */
  rupeesOwed: Decimal;
}

async function priceInward(tx: Tx, lines: InwardLineInput[]): Promise<PricedInwardLine[]> {
  const ids = (pick: (l: InwardLineInput) => string) => [...new Set(lines.map(pick))];
  const [items, purities, rates] = await Promise.all([
    tx.query<{ id: string; name: string; tracking: 'lot' | 'piece'; metal_id: string | null; hsn: string | null; is_active: boolean }>(
      `select i.id, i.name, i.tracking, i.metal_id, coalesce(i.hsn_code, c.hsn_code) as hsn, i.is_active
         from item i left join item_category c on c.id = i.category_id where i.id = any($1::uuid[]) and i.deleted_at is null`, [ids((l) => l.itemId)]),
    tx.query<{ id: string; code: string; metal_id: string; fineness: Decimal }>(
      `select id, code, metal_id, fineness_percent as fineness from purity where id = any($1::uuid[]) and is_active`, [ids((l) => l.purityId)]),
    valuationRates(tx, ids((l) => l.purityId)),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  const purityById = new Map(purities.map((p) => [p.id, p]));

  return lines.map((l, index) => {
    const n = lines.length > 1 ? `Line ${index + 1}: ` : '';
    const fail = (message: string, code: string): never => { throw new BusinessRuleError(n + message, code); };
    const item = itemById.get(l.itemId);
    if (!item || !item.is_active) fail('That item does not exist or is inactive.', 'item_invalid');
    const purity = purityById.get(l.purityId);
    if (!purity) fail('That purity does not exist or is inactive.', 'purity_invalid');
    if (item!.metal_id && item!.metal_id !== purity!.metal_id) fail(`${purity!.code} is for a different metal than ${item!.name}.`, 'purity_metal_mismatch');
    const pieces = item!.tracking === 'piece' ? (l.pieces ?? 0) : 0;
    if (item!.tracking === 'piece' && (!Number.isInteger(pieces) || pieces < 1)) fail(`Enter how many pieces of ${item!.name} arrived.`, 'pieces_required');
    if (!(compare(l.grossWeight, '0') > 0)) fail('Gross weight must be more than 0 g.', 'weight_required');
    const net = g(sub(sub(l.grossWeight, l.stoneWeight ?? '0'), l.otherWeight ?? '0'));
    if (compare(net, '0') < 0) fail('Stone and other weight add up to more than the gross weight.', 'weights_inconsistent');

    const rate = l.ratePerGram ?? (l.metalBasis === 'fine' ? rates.get(l.purityId) : undefined);
    if (!rate || !(compare(rate, '0') > 0)) {
      fail(l.metalBasis === 'rupee'
        ? `Enter the supplier's rate per gram for ${purity!.code}.`
        : `No rate is set for ${purity!.code} to value this stock. Enter today's rate in Masters → Rates, or type a rate on the line.`, 'rate_required');
    }
    const touch = l.metalBasis === 'fine' ? (l.touchPercent ?? purity!.fineness) : null;
    if (touch !== null && !(compare(touch, '0') > 0 && compare(touch, '100') <= 0)) fail('Touch must be more than 0% and at most 100%.', 'touch_invalid');

    const metalAmount = rs(mul(net, rate!));
    const makingRate = l.makingRate ?? '0';
    const makingAmount = rs(l.makingBasis === 'flat' ? mul(makingRate, String(Math.max(pieces, 1)))
      : l.makingBasis === 'percent' ? div(mul(metalAmount, makingRate), '100') : mul(net, makingRate));
    const stoneAmount = rs(l.stoneAmount ?? '0');
    const cost = sum([metalAmount, makingAmount, stoneAmount]);
    const fineOwed = touch ? g(div(mul(net, touch), '100')) : '0';
    return {
      input: l, item: item!, purity: purity!, pieces, net, rate: rate!, touch, fineOwed,
      fine: g(div(mul(net, purity!.fineness), '100')), metalAmount, makingAmount, stoneAmount, cost,
      rupeesOwed: l.metalBasis === 'fine' ? add(makingAmount, stoneAmount) : cost,
    };
  });
}

/** Fine metal owed, added up per metal. */
const fineByMetal = (lines: { metalId: string; fine: Decimal }[]) => {
  const totals = new Map<string, Decimal>();
  for (const l of lines) if (!isZero(l.fine)) totals.set(l.metalId, add(totals.get(l.metalId) ?? '0', l.fine));
  return [...totals].map(([metalId, fine]) => ({ metalId, fine }));
};

export async function createInward(tx: Tx, input: InwardInput) {
  if (input.lines.length === 0) throw new ValidationError('Add at least one line.');
  if (input.direct && !input.bill) throw new BusinessRuleError("A direct purchase needs the supplier's bill number and date.", 'bill_required');
  const branchId = branchOf(tx);
  const docDate = await docDateOf(tx, input.docDate);
  const supplier = await activeSupplier(tx, input.supplierId);
  const location = await tx.maybeOne<{ id: string }>(
    `select id from stock_location where id = $1 and branch_id = $2 and is_active and deleted_at is null and kind <> 'transit'`,
    [input.locationId, branchId]);
  if (!location) throw new BusinessRuleError('Choose an active stock location at this branch for the goods.', 'location_invalid');

  if (input.purchaseOrderId) {
    const po = await tx.maybeOne<{ supplier_id: string; status: string; doc_number: string }>(
      `select supplier_id, status, doc_number from purchase_order where id = $1 for update`, [input.purchaseOrderId]);
    if (!po) throw new NotFoundError('Purchase order', input.purchaseOrderId);
    if (po.supplier_id !== supplier.id) throw new BusinessRuleError(`${po.doc_number} is for a different supplier.`, 'po_supplier_mismatch');
    if (po.status !== 'confirmed') throw new BusinessRuleError(`${po.doc_number} is ${po.status}; only an open order can be received.`, 'po_not_open');
    const lineIds = input.lines.flatMap((l) => (l.purchaseOrderLineId ? [l.purchaseOrderLineId] : []));
    if (lineIds.length) {
      const own = await tx.query<{ id: string }>(
        `select id from purchase_order_line where id = any($1::uuid[]) and purchase_order_id = $2`, [lineIds, input.purchaseOrderId]);
      if (own.length !== new Set(lineIds).size) throw new BusinessRuleError(`Some lines are not on ${po.doc_number}.`, 'po_line_mismatch');
    }
  }

  const priced = await priceInward(tx, input.lines);
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'goods_receipt', 1, { branchId, date: new Date(docDate) });
  const fineOwed = fineByMetal(priced.map((p) => ({ metalId: p.purity.metal_id, fine: p.fineOwed })));

  const inward = await repo<{ id: string; doc_number: string }>(tx, 'goods_receipt').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, supplier_id: supplier.id, status: 'posted',
    location_id: location.id, purchase_order_id: input.purchaseOrderId ?? null, is_direct: !!input.direct,
    reference_number: input.referenceNumber ?? null, notes: input.notes ?? null,
    metal_amount: sum(priced.map((p) => p.metalAmount)), making_amount: sum(priced.map((p) => p.makingAmount)),
    stone_amount: sum(priced.map((p) => p.stoneAmount)), taxable_amount: sum(priced.map((p) => p.cost)),
    total_amount: sum(priced.map((p) => p.cost)),
    total_gross_weight: sum(priced.map((p) => p.input.grossWeight)), total_net_weight: sum(priced.map((p) => p.net)),
    total_fine_weight: sum(priced.map((p) => p.fine)), fine_owed: JSON.stringify(fineOwed),
    posted_at: new Date(), posted_by: tx.context.userId,
  });

  const lines = await repo<{ id: string }>(tx, 'goods_receipt_line').insertMany(priced.map((p, i) => ({
    goods_receipt_id: inward.id, line_number: i + 1, item_id: p.item.id, purity_id: p.purity.id, location_id: location.id,
    hsn_code: p.item.hsn, purchase_order_line_id: p.input.purchaseOrderLineId ?? null,
    quantity: p.pieces || 1, gross_weight: p.input.grossWeight, stone_weight: p.input.stoneWeight ?? '0',
    other_weight: p.input.otherWeight ?? '0', net_weight: p.net, fine_weight: p.fine, declared_weight: p.input.declaredWeight ?? null,
    metal_basis: p.input.metalBasis, touch_percent: p.touch, fine_owed: p.fineOwed, rate_per_gram: p.rate,
    metal_amount: p.metalAmount, making_basis: p.input.makingBasis ?? 'per_gram', making_rate: p.input.makingRate ?? '0',
    making_amount: p.makingAmount, stone_amount: p.stoneAmount, taxable_amount: p.cost, line_total: p.cost, cost_value: p.cost,
  })));

  // Pieces wait in Tagging; their weight and cost are in stock from now.
  const pieceLines = priced.map((p, i) => ({ p, lineId: lines[i]!.id })).filter(({ p }) => p.item.tracking === 'piece');
  if (pieceLines.length) {
    await repo(tx, 'tagging_lot').insertMany(pieceLines.map(({ p, lineId }) => ({
      goods_receipt_line_id: lineId, branch_id: branchId, location_id: location.id, item_id: p.item.id, purity_id: p.purity.id,
      supplier_id: supplier.id, pieces_expected: p.pieces, gross_expected: p.input.grossWeight, net_expected: p.net,
      fine_expected: p.fine, cost_value: p.cost,
    })));
  }

  await recordMovements(tx, priced.map((p, i) => ({
    direction: 'in' as const, reason: 'purchase' as const, tracking: p.item.tracking, itemId: p.item.id, purityId: p.purity.id,
    locationId: location.id, quantity: String(p.pieces), grossWeight: p.input.grossWeight, netWeight: p.net, fineWeight: p.fine,
    value: p.cost, sourceType: 'goods_receipt', sourceId: inward.id, sourceLineId: lines[i]!.id, note: inward.doc_number,
  })));

  const fineLines = priced.filter((p) => p.input.metalBasis === 'fine');
  const money: MoneyEntry[] = [
    { accountCode: '1200', debit: sum(priced.map((p) => p.cost)), narration: 'Stock received' },
    { accountCode: '2000', partyId: supplier.id, credit: sum(priced.map((p) => p.rupeesOwed)), narration: `Inward ${inward.doc_number}`,
      againstType: 'goods_receipt', againstId: inward.id },
    { accountCode: '2010', partyId: supplier.id, credit: sum(fineLines.map((p) => p.metalAmount)), narration: `Metal owed, ${inward.doc_number}` },
  ];
  const metal: MetalEntry[] = [
    ...priced.map((p) => ({ accountCode: '1210', metalId: p.purity.metal_id, purityId: p.purity.id, grossWeight: p.input.grossWeight,
      weightIn: p.fine, ratePerGram: p.rate, narration: `Inward ${inward.doc_number}` })),
    ...fineLines.map((p) => ({ accountCode: '2010', partyId: supplier.id, metalId: p.purity.metal_id, purityId: p.purity.id,
      weightIn: p.fineOwed, ratePerGram: rs(div(p.metalAmount, p.fineOwed)), narration: `Metal owed, ${inward.doc_number}` })),
  ];
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'purchase', voucherDate: docDate, branchId, sourceType: 'goods_receipt', sourceId: inward.id,
    narration: `${input.direct ? 'Direct purchase' : 'Goods inward'} ${inward.doc_number} from ${supplier.name}`, money, metal,
  });
  await tx.query(`update goods_receipt set voucher_id = $2 where id = $1`, [inward.id, voucherId]);

  if (input.purchaseOrderId) await rollUpOrder(tx, input.purchaseOrderId);
  const bill = input.bill ? await createBill(tx, { supplierId: supplier.id, inwardIds: [inward.id], ...input.bill, docDate }) : null;
  return { ...(await inwardDetail(tx, inward.id)), bill };
}

/** Received quantities on the order's lines, and the order closes when everything has arrived. */
async function rollUpOrder(tx: Tx, orderId: string) {
  await tx.query(
    `update purchase_order_line l set
        received_quantity = coalesce(r.quantity, 0), received_weight = coalesce(r.weight, 0)
       from (select l2.id, sum(gl.quantity) as quantity, sum(gl.gross_weight) as weight
               from purchase_order_line l2
               left join goods_receipt_line gl on gl.purchase_order_line_id = l2.id
               left join goods_receipt gr on gr.id = gl.goods_receipt_id and gr.status = 'posted'
              where l2.purchase_order_id = $1 and (gr.id is not null or gl.id is null)
              group by l2.id) r
      where l.id = r.id`, [orderId]);
  await tx.query(
    `update purchase_order set status = case
        when not exists (select 1 from purchase_order_line where purchase_order_id = $1 and received_weight < gross_weight) then 'closed'
        else 'confirmed' end, updated_at = now()
      where id = $1 and status in ('confirmed', 'closed')`, [orderId]);
}

export async function inwardDetail(tx: Tx, id: string) {
  const [inward, lines] = await Promise.all([
    tx.one(`select gr.*, p.name as supplier_name, l.name as location_name, po.doc_number as purchase_order_number,
                   pi.doc_number as bill_number, pi.supplier_invoice_number, pi.supplier_invoice_date,
                   pi.cgst_amount + pi.sgst_amount + pi.igst_amount as gst_amount, pi.total_amount as bill_total
              from goods_receipt gr join party p on p.id = gr.supplier_id join stock_location l on l.id = gr.location_id
              left join purchase_order po on po.id = gr.purchase_order_id left join purchase_invoice pi on pi.id = gr.purchase_invoice_id
             where gr.id = $1`, [id]),
    tx.query(`select gl.*, i.name as item_name, i.tracking, pu.code as purity_code,
                     t.id as tagging_lot_id, t.pieces_tagged, t.status as lot_status
                from goods_receipt_line gl join item i on i.id = gl.item_id join purity pu on pu.id = gl.purity_id
                left join tagging_lot t on t.goods_receipt_line_id = gl.id
               where gl.goods_receipt_id = $1 order by gl.line_number`, [id]),
  ]);
  return { ...inward, lines };
}

/**
 * Undo an inward that was a mistake: allowed while nothing from it is billed, tagged, returned or sold.
 * A direct purchase goes with its bill: both are cancelled together.
 */
export async function cancelInward(tx: Tx, id: string, reason: string) {
  const inward = await tx.one<{ id: string; doc_number: string; status: string; purchase_invoice_id: string | null; is_direct: boolean;
    voucher_id: string | null; purchase_order_id: string | null }>(`select * from goods_receipt where id = $1 for update`, [id]);
  if (inward.status !== 'posted') throw new BusinessRuleError(`${inward.doc_number} is already ${inward.status}.`, 'not_posted');
  if (inward.purchase_invoice_id && !inward.is_direct) throw new BusinessRuleError(`${inward.doc_number} is billed. Cancel the supplier bill first.`, 'inward_billed');
  const used = await tx.one<{ tagged: number; returned: number }>(
    `select (select coalesce(sum(t.pieces_tagged), 0)::int from tagging_lot t join goods_receipt_line gl on gl.id = t.goods_receipt_line_id
              where gl.goods_receipt_id = $1) as tagged,
            (select count(*)::int from purchase_return where goods_receipt_id = $1 and status = 'posted') as returned`, [id]);
  if (used.tagged) throw new BusinessRuleError(`${used.tagged} piece(s) from ${inward.doc_number} are already tagged. Return them to the supplier instead.`, 'inward_tagged');
  if (used.returned) throw new BusinessRuleError(`Goods from ${inward.doc_number} were already returned. Cancel the return first.`, 'inward_returned');

  // Refuses (not enough stock) when the goods were already sold or moved.
  await reverseMovementsFor(tx, 'goods_receipt', id, `Cancelled: ${reason}`, true);
  if (inward.voucher_id) await reverseVoucher(tx, inward.voucher_id, reason);
  await tx.query(
    `update tagging_lot set status = 'closed', closed_at = now(), close_note = $2
      where goods_receipt_line_id in (select id from goods_receipt_line where goods_receipt_id = $1)`, [id, `Inward cancelled: ${reason}`]);
  const row = await tx.one(
    `update goods_receipt set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
      where id = $1 returning *`, [id, tx.context.userId, reason]);
  if (inward.is_direct && inward.purchase_invoice_id) await cancelBill(tx, inward.purchase_invoice_id, reason);
  if (inward.purchase_order_id) await rollUpOrder(tx, inward.purchase_order_id);
  return row;
}

/* -------------------------------------------------------------------- bill */

/** CGST + SGST within the state, IGST from another state. */
async function gstSplit(tx: Tx, branchId: string, supplier: Supplier, gst: Decimal) {
  const branch = await tx.one<{ state_code: string | null }>(`select state_code from branch where id = $1`, [branchId]);
  const interState = Boolean(branch.state_code && supplier.state_code && branch.state_code !== supplier.state_code);
  const half = rs(div(gst, '2'));
  return interState
    ? { cgst_amount: '0', sgst_amount: '0', igst_amount: gst }
    : { cgst_amount: half, sgst_amount: sub(gst, half), igst_amount: '0' };
}

export async function createBill(tx: Tx, input: BillInput & { supplierId: string; inwardIds: string[]; docDate?: string }) {
  const branchId = branchOf(tx);
  const supplier = await activeSupplier(tx, input.supplierId);
  const typed = input.supplierInvoiceNumber?.trim();
  await docDateOf(tx, input.supplierInvoiceDate);
  if (typed) {
    const taken = await tx.maybeOne<{ doc_number: string }>(
      `select doc_number from purchase_invoice where supplier_id = $1 and lower(supplier_invoice_number) = lower($2) and status = 'posted'`, [supplier.id, typed]);
    if (taken) throw new BusinessRuleError(`${supplier.name}'s bill ${typed} is already entered as ${taken.doc_number}.`, 'bill_duplicate');
  }

  const inwards = await tx.query<{ id: string; doc_number: string; supplier_id: string; status: string; purchase_invoice_id: string | null; taxable_amount: Decimal }>(
    `select id, doc_number, supplier_id, status, purchase_invoice_id, taxable_amount from goods_receipt where id = any($1::uuid[]) for update`, [input.inwardIds]);
  if (inwards.length !== new Set(input.inwardIds).size || inwards.length === 0) throw new BusinessRuleError('Choose the inwards this bill covers.', 'inward_required');
  for (const w of inwards) {
    if (w.supplier_id !== supplier.id) throw new BusinessRuleError(`${w.doc_number} is from a different supplier.`, 'inward_supplier_mismatch');
    if (w.status !== 'posted') throw new BusinessRuleError(`${w.doc_number} is ${w.status}.`, 'not_posted');
    if (w.purchase_invoice_id) throw new BusinessRuleError(`${w.doc_number} is already billed.`, 'inward_billed');
  }

  // GST as the lines' HSN rates say, unless the supplier's printed figure is typed in.
  const calc = await tx.one<{ gst: Decimal }>(
    `select coalesce(sum(gl.cost_value * coalesce(r.gst_rate, 0) / 100), 0)::numeric(14,2)::text as gst
       from goods_receipt_line gl
       left join lateral (select gst_rate from hsn_gst_rate where hsn_code = gl.hsn_code and component = 'metal'
                           and effective_from <= $2::date and (effective_to is null or effective_to >= $2::date)
                           order by effective_from desc limit 1) r on true
      where gl.goods_receipt_id = any($1::uuid[])`, [input.inwardIds, input.supplierInvoiceDate]);
  // A supplier without a GSTIN cannot charge GST: none unless the bill's figure is typed.
  const gst = input.gstAmount ?? (supplier.gstin ? calc.gst : '0');
  if (compare(gst, '0') < 0) throw new ValidationError('GST cannot be negative.');
  const taxable = sum(inwards.map((w) => w.taxable_amount));
  const docDate = await docDateOf(tx, input.docDate);
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'purchase_invoice', 1, { branchId, date: new Date(docDate) });
  const number = typed || docNumber!;

  const bill = await repo<{ id: string; doc_number: string }>(tx, 'purchase_invoice').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, supplier_id: supplier.id, status: 'posted',
    supplier_invoice_number: number, supplier_invoice_date: input.supplierInvoiceDate, due_date: input.dueDate ?? null,
    taxable_amount: taxable, ...(await gstSplit(tx, branchId, supplier, gst)), total_amount: add(taxable, gst),
    posted_at: new Date(), posted_by: tx.context.userId,
  });
  await tx.query(`update goods_receipt set purchase_invoice_id = $2, updated_at = now() where id = any($1::uuid[])`, [input.inwardIds, bill.id]);
  if (compare(gst, '0') > 0) {
    const { voucherId } = await postVoucher(tx, {
      voucherType: 'purchase', voucherDate: input.supplierInvoiceDate, branchId, sourceType: 'purchase_invoice', sourceId: bill.id,
      narration: `GST on ${supplier.name} bill ${number}`,
      money: [
        { accountCode: '1300', debit: gst, narration: 'GST input credit' },
        { accountCode: '2000', partyId: supplier.id, credit: gst, narration: `GST, bill ${number}`, againstType: 'purchase_invoice', againstId: bill.id },
      ],
    });
    await tx.query(`update purchase_invoice set voucher_id = $2 where id = $1`, [bill.id, voucherId]);
  }
  return tx.one(`select * from purchase_invoice where id = $1`, [bill.id]);
}

export async function cancelBill(tx: Tx, id: string, reason: string) {
  const bill = await tx.one<{ doc_number: string; status: string; voucher_id: string | null }>(`select * from purchase_invoice where id = $1 for update`, [id]);
  if (bill.status !== 'posted') throw new BusinessRuleError(`${bill.doc_number} is already ${bill.status}.`, 'not_posted');
  const direct = await tx.maybeOne<{ doc_number: string }>(
    `select doc_number from goods_receipt where purchase_invoice_id = $1 and is_direct and status = 'posted'`, [id]);
  if (direct) throw new BusinessRuleError(`${bill.doc_number} is a direct purchase (${direct.doc_number}). Cancel the purchase, which undoes the goods and the bill together.`, 'bill_is_direct');
  if (bill.voucher_id) await reverseVoucher(tx, bill.voucher_id, reason);
  // Inwards still in stock go back to "bill awaited"; a cancelled direct purchase keeps its bill for the record.
  await tx.query(`update goods_receipt set purchase_invoice_id = null, updated_at = now() where purchase_invoice_id = $1 and status = 'posted'`, [id]);
  return tx.one(
    `update purchase_invoice set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now()
      where id = $1 returning *`, [id, tx.context.userId, reason]);
}

/* ------------------------------------------------------------------ return */

export interface ReturnLineInput {
  goodsReceiptLineId: string;
  /** Untagged pieces still waiting in Tagging, and their weight. */
  pieces?: number;
  grossWeight?: Decimal;
  /** Lot items: net weight going back. */
  netWeight?: Decimal;
}

/**
 * Goods back to the supplier. Every line is taken back on the terms it was
 * bought on, in proportion to its net weight: rupees owed, fine metal owed and
 * (if billed) GST all come down by the same share.
 */
export async function createReturn(tx: Tx, input: {
  goodsReceiptId: string; reason?: string; notes?: string; docDate?: string;
  /** Tagged pieces, as scanned; each is matched to the inward line it was tagged from. */
  pieceIds?: string[];
  lines?: ReturnLineInput[];
}) {
  const branchId = branchOf(tx);
  const docDate = await docDateOf(tx, input.docDate);
  const lineInputs = input.lines ?? [];
  if (lineInputs.length === 0 && !input.pieceIds?.length) throw new ValidationError('Choose what goes back.');
  const inward = await tx.one<{ id: string; doc_number: string; status: string; supplier_id: string; purchase_invoice_id: string | null }>(
    `select id, doc_number, status, supplier_id, purchase_invoice_id from goods_receipt where id = $1 for update`, [input.goodsReceiptId]);
  if (inward.status !== 'posted') throw new BusinessRuleError(`${inward.doc_number} is ${inward.status}.`, 'not_posted');
  const supplier = await activeSupplier(tx, inward.supplier_id);

  const src = await tx.query<{ id: string; goods_receipt_id: string; item_id: string; tracking: 'lot' | 'piece'; purity_id: string; metal_id: string;
    fineness: Decimal; location_id: string; gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; metal_basis: 'rupee' | 'fine';
    fine_owed: Decimal; metal_amount: Decimal; cost_value: Decimal; hsn_code: string | null; lot_id: string | null; lot_status: string | null;
    lot_pieces: number | null; lot_gross: Decimal | null; lot_net: Decimal | null; lot_cost: Decimal | null; lot_pieces_tagged: number | null;
    lot_gross_tagged: Decimal | null; lot_net_tagged: Decimal | null; lot_cost_tagged: Decimal | null }>(
    `select gl.*, i.tracking, pu.metal_id, pu.fineness_percent as fineness, t.id as lot_id, t.status as lot_status,
            t.pieces_expected as lot_pieces, t.gross_expected as lot_gross, t.net_expected as lot_net, t.cost_value as lot_cost,
            t.pieces_tagged as lot_pieces_tagged, t.gross_tagged as lot_gross_tagged, t.net_tagged as lot_net_tagged, t.cost_tagged as lot_cost_tagged
       from goods_receipt_line gl join item i on i.id = gl.item_id join purity pu on pu.id = gl.purity_id
       left join tagging_lot t on t.goods_receipt_line_id = gl.id
      where gl.goods_receipt_id = $1 order by gl.line_number for update of gl`, [inward.id]);
  const srcById = new Map(src.map((s) => [s.id, s]));

  const allPieceIds = [...new Set(input.pieceIds ?? [])];
  const pieces = allPieceIds.length ? await tx.query<{ id: string; tag_number: string; status: string; lot_line: string | null; location_id: string;
    gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; cost_value: Decimal }>(
    `select p.id, p.tag_number, p.status, t.goods_receipt_line_id as lot_line, p.location_id, p.gross_weight, p.net_weight, p.fine_weight, p.cost_value
       from stock_piece p left join tagging_lot t on t.id = p.tagging_lot_id where p.id = any($1::uuid[]) for update of p`, [allPieceIds]) : [];
  const pieceById = new Map(pieces.map((p) => [p.id, p]));

  type Out = { srcLine: (typeof src)[number]; net: Decimal; gross: Decimal; fine: Decimal; qty: number; stockValue: Decimal; pieceId: string | null; locationId: string };
  const outs: Out[] = [];
  const lotUpdates: { lotId: string; pieces: number; gross: Decimal; net: Decimal; fine: Decimal; cost: Decimal }[] = [];
  for (const pid of allPieceIds) {
    const p = pieceById.get(pid);
    const s = p?.lot_line ? srcById.get(p.lot_line) : undefined;
    if (!p || !s) throw new BusinessRuleError(`${p?.tag_number ?? 'That piece'} was not received on ${inward.doc_number}.`, 'piece_mismatch');
    if (p.status !== 'in_stock') throw new BusinessRuleError(`${p.tag_number} is not in stock.`, 'piece_not_in_stock');
    outs.push({ srcLine: s, net: p.net_weight, gross: p.gross_weight, fine: p.fine_weight, qty: 1, stockValue: p.cost_value, pieceId: p.id, locationId: p.location_id });
  }
  for (const l of lineInputs) {
    const s = srcById.get(l.goodsReceiptLineId);
    if (!s) throw new BusinessRuleError(`That line is not on ${inward.doc_number}.`, 'line_mismatch');
    if (l.pieces) {
      if (!s.lot_id || s.lot_status !== 'open') throw new BusinessRuleError('Those pieces are no longer waiting in Tagging.', 'lot_closed');
      const leftPieces = s.lot_pieces! - s.lot_pieces_tagged!;
      const leftGross = sub(s.lot_gross!, s.lot_gross_tagged!);
      if (!Number.isInteger(l.pieces) || l.pieces < 1 || l.pieces > leftPieces) {
        throw new BusinessRuleError(`Only ${leftPieces} untagged piece(s) are left from this line.`, 'pieces_exceed');
      }
      const gross = l.grossWeight ?? (l.pieces === leftPieces ? leftGross : '');
      if (!gross || !(compare(gross, '0') > 0) || compare(gross, leftGross) > 0) {
        throw new BusinessRuleError(`Enter the weight going back (at most ${fixed(leftGross, 3)} g untagged).`, 'weight_exceeds');
      }
      const share = div(gross, leftGross);
      const net = g(mul(sub(s.lot_net!, s.lot_net_tagged!), share));
      const cost = rs(mul(sub(s.lot_cost!, s.lot_cost_tagged!), share));
      const fine = g(div(mul(net, s.fineness), '100'));
      outs.push({ srcLine: s, net, gross: g(gross), fine, qty: l.pieces, stockValue: cost, pieceId: null, locationId: s.location_id });
      lotUpdates.push({ lotId: s.lot_id, pieces: l.pieces, gross: g(gross), net, fine, cost });
    }
    if (l.netWeight) {
      if (s.tracking !== 'lot') throw new BusinessRuleError('Choose the pieces going back, not a weight.', 'pieces_required');
      if (!(compare(l.netWeight, '0') > 0) || compare(l.netWeight, s.net_weight) > 0) {
        throw new BusinessRuleError(`Enter a weight above 0 g and at most the ${fixed(s.net_weight, 3)} g received.`, 'weight_exceeds');
      }
      const share = div(l.netWeight, s.net_weight);
      outs.push({ srcLine: s, net: l.netWeight, gross: g(mul(s.gross_weight, share)), fine: g(div(mul(l.netWeight, s.fineness), '100')),
        qty: 0, stockValue: rs(mul(s.cost_value, share)), pieceId: null, locationId: s.location_id });
    }
  }
  if (outs.length === 0) throw new ValidationError('Choose what goes back.');

  // What comes off the supplier's balance: the bought terms, in proportion to net weight.
  const terms = outs.map((o) => {
    const share = isZero(o.srcLine.net_weight) ? '0' : div(o.net, o.srcLine.net_weight);
    const fineOwed = o.srcLine.metal_basis === 'fine' ? g(mul(o.srcLine.fine_owed, share)) : '0';
    const metalValue = o.srcLine.metal_basis === 'fine' ? rs(mul(o.srcLine.metal_amount, share)) : '0';
    const rupees = sub(rs(mul(o.srcLine.cost_value, share)), metalValue);
    return { ...o, fineOwed, metalValue, rupees };
  });
  const gst = inward.purchase_invoice_id
    ? (await tx.one<{ gst: Decimal }>(
      `select coalesce(sum(x.value * coalesce(r.gst_rate, 0) / 100), 0)::numeric(14,2)::text as gst
         from jsonb_to_recordset($1::jsonb) as x(hsn text, value numeric)
         left join lateral (select gst_rate from hsn_gst_rate where hsn_code = x.hsn and component = 'metal'
                             and effective_from <= current_date and (effective_to is null or effective_to >= current_date)
                             order by effective_from desc limit 1) r on true`,
      [JSON.stringify(terms.map((t) => ({ hsn: t.srcLine.hsn_code, value: add(t.rupees, t.metalValue) })))])).gst
    : '0';

  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'purchase_return', 1, { branchId, date: new Date(docDate) });
  const fineOwed = fineByMetal(terms.map((t) => ({ metalId: t.srcLine.metal_id, fine: t.fineOwed })));
  const ret = await repo<{ id: string; doc_number: string }>(tx, 'purchase_return').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, supplier_id: supplier.id, status: 'posted',
    goods_receipt_id: inward.id, reason: input.reason ?? 'other', notes: input.notes ?? null,
    taxable_amount: sum(terms.map((t) => t.stockValue)), ...(await gstSplit(tx, branchId, supplier, gst)),
    total_amount: add(sum(terms.map((t) => add(t.rupees, t.metalValue))), gst),
    total_gross_weight: sum(terms.map((t) => t.gross)), total_net_weight: sum(terms.map((t) => t.net)), total_fine_weight: sum(terms.map((t) => t.fine)),
    fine_owed: JSON.stringify(fineOwed), posted_at: new Date(), posted_by: tx.context.userId,
  });
  const retLines = await repo<{ id: string }>(tx, 'purchase_return_line').insertMany(terms.map((t, i) => ({
    purchase_return_id: ret.id, line_number: i + 1, goods_receipt_line_id: t.srcLine.id, item_id: t.srcLine.item_id,
    purity_id: t.srcLine.purity_id, piece_id: t.pieceId, location_id: t.locationId, quantity: t.qty || 1, gross_weight: t.gross,
    net_weight: t.net, fine_weight: t.fine, metal_basis: t.srcLine.metal_basis, fine_owed: t.fineOwed, cost_value: t.stockValue,
    taxable_amount: add(t.rupees, t.metalValue), line_total: add(t.rupees, t.metalValue),
  })));

  await recordMovements(tx, terms.map((t, i): MovementInput => ({
    direction: 'out', reason: 'purchase_return', tracking: t.srcLine.tracking, itemId: t.srcLine.item_id, purityId: t.srcLine.purity_id,
    locationId: t.locationId, pieceId: t.pieceId, quantity: String(t.qty), grossWeight: t.gross, netWeight: t.net, fineWeight: t.fine,
    value: t.stockValue, sourceType: 'purchase_return', sourceId: ret.id, sourceLineId: retLines[i]!.id, note: ret.doc_number,
  })));
  const returnedPieces = terms.flatMap((t) => (t.pieceId ? [t.pieceId] : []));
  if (returnedPieces.length) {
    await tx.query(`update stock_piece set status = 'written_off', updated_at = now(), updated_by = $2 where id = any($1::uuid[])`,
      [returnedPieces, tx.context.userId]);
  }
  for (const u of lotUpdates) {
    await tx.query(
      `update tagging_lot set pieces_expected = pieces_expected - $2, gross_expected = gross_expected - $3, net_expected = net_expected - $4,
              fine_expected = fine_expected - $5, cost_value = cost_value - $6, updated_at = now(),
              status = case when pieces_expected - $2 = pieces_tagged then 'closed' else status end,
              closed_at = case when pieces_expected - $2 = pieces_tagged then now() else closed_at end
        where id = $1`, [u.lotId, u.pieces, u.gross, u.net, u.fine, u.cost]);
  }

  // Supplier balance comes down on the bought terms; stock leaves at what it cost. Any gap is a metal gain or loss.
  const rupees = sum(terms.map((t) => t.rupees));
  const metalValue = sum(terms.map((t) => t.metalValue));
  const stockValue = sum(terms.map((t) => t.stockValue));
  const gap = sub(add(rupees, metalValue), stockValue);
  const money: MoneyEntry[] = [
    { accountCode: '2000', partyId: supplier.id, debit: add(rupees, gst), narration: `Return ${ret.doc_number}`, againstType: 'purchase_return', againstId: ret.id },
    { accountCode: '2010', partyId: supplier.id, debit: metalValue, narration: `Metal returned, ${ret.doc_number}` },
    { accountCode: '1200', credit: stockValue, narration: 'Stock returned to supplier' },
    { accountCode: '1300', credit: gst, narration: 'GST input reversed' },
    compare(gap, '0') >= 0 ? { accountCode: '4200', credit: gap, narration: 'Return valuation difference' }
      : { accountCode: '4200', debit: neg(gap), narration: 'Return valuation difference' },
  ];
  const metal: MetalEntry[] = [
    ...terms.map((t) => ({ accountCode: '1210', metalId: t.srcLine.metal_id, purityId: t.srcLine.purity_id, grossWeight: t.gross,
      weightOut: t.fine, narration: `Return ${ret.doc_number}` })),
    ...terms.filter((t) => !isZero(t.fineOwed)).map((t) => ({ accountCode: '2010', partyId: supplier.id, metalId: t.srcLine.metal_id,
      purityId: t.srcLine.purity_id, weightOut: t.fineOwed, narration: `Metal returned, ${ret.doc_number}` })),
  ];
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'purchase_return', voucherDate: docDate, branchId, sourceType: 'purchase_return', sourceId: ret.id,
    narration: `Return ${ret.doc_number} to ${supplier.name}`, money, metal,
  });
  await tx.query(`update purchase_return set voucher_id = $2 where id = $1`, [ret.id, voucherId]);
  return tx.one(`select * from purchase_return where id = $1`, [ret.id]);
}

/* -------------------------------------------------------------- settlement */

export interface SettlementInput {
  supplierId: string;
  kind: 'payment' | 'metal' | 'rate_fix';
  docDate?: string;
  /** payment */
  amount?: Decimal;
  paymentMethodId?: string;
  reference?: string;
  /** metal: the lot the metal comes from */
  itemId?: string;
  purityId?: string;
  locationId?: string;
  netWeight?: Decimal;
  /** rate_fix */
  metalId?: string;
  fineWeight?: Decimal;
  ratePerGram?: Decimal;
  notes?: string;
}

/** The money account a payment method lands in: its own, else Cash in Hand for cash and Bank for the rest. */
export async function paymentAccount(tx: Tx, methodId: string, branchId: string) {
  const m = await tx.maybeOne<{ id: string; name: string; kind: string; account_id: string | null; requires_reference: boolean;
    max_amount: Decimal | null; is_active: boolean; offered: boolean }>(
    `select m.id, m.name, m.kind, m.account_id, m.requires_reference, m.max_amount, m.is_active,
            (not exists (select 1 from payment_method_branch b where b.payment_method_id = m.id)
             or exists (select 1 from payment_method_branch b where b.payment_method_id = m.id and b.branch_id = $2)) as offered
       from payment_method m where m.id = $1 and m.deleted_at is null`, [methodId, branchId]);
  if (!m || !m.is_active) throw new BusinessRuleError('That payment method does not exist or is inactive.', 'payment_method_invalid');
  if (!m.offered) throw new BusinessRuleError(`${m.name} is not offered at this branch.`, 'payment_method_branch');
  return { ...m, account: m.account_id ? { accountId: m.account_id } : { accountCode: m.kind === 'cash' ? '1000' : '1010' } };
}

export async function createSettlement(tx: Tx, input: SettlementInput) {
  const branchId = branchOf(tx);
  const docDate = await docDateOf(tx, input.docDate);
  const supplier = await activeSupplier(tx, input.supplierId);
  const balance = await supplierBalance(tx, supplier.id);
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'supplier_settlement', 1, { branchId, date: new Date(docDate) });
  const base = { doc_number: docNumber, doc_date: docDate, branch_id: branchId, supplier_id: supplier.id, kind: input.kind, notes: input.notes ?? null };
  const narration = `${docNumber}, ${supplier.name}`;
  let row: { id: string };
  let money: MoneyEntry[];
  let metal: MetalEntry[] = [];

  if (input.kind === 'payment') {
    const amount = rs(input.amount ?? '0');
    if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount paid.');
    const method = await paymentAccount(tx, input.paymentMethodId ?? '', branchId);
    if (method.requires_reference && !input.reference?.trim()) throw new BusinessRuleError(`${method.name} needs a reference (UTR, cheque number).`, 'reference_required');
    if (method.max_amount && compare(amount, method.max_amount) > 0) {
      throw new BusinessRuleError(`${method.name} allows at most ₹${method.max_amount} in one payment.`, 'payment_limit');
    }
    row = await repo<{ id: string }>(tx, 'supplier_settlement').insert({ ...base, payment_method_id: method.id, amount, reference: input.reference ?? null });
    money = [
      { accountCode: '2000', partyId: supplier.id, debit: amount, narration, againstType: 'supplier_settlement', againstId: row.id },
      { ...method.account, credit: amount, narration: `Paid by ${method.name}` },
    ];
  } else {
    const metalId = input.kind === 'metal'
      ? (await tx.maybeOne<{ metal_id: string }>(`select metal_id from purity where id = $1`, [input.purityId ?? null]))?.metal_id
      : input.metalId;
    const owed = balance.metals.find((m) => m.metal_id === metalId);
    if (!metalId || !owed || !(compare(owed.fine, '0') > 0)) {
      throw new BusinessRuleError(`No fine metal of that kind is owed to ${supplier.name}.`, 'no_metal_owed');
    }
    const rate = owed.rate ?? '0';
    let fine: Decimal;
    let stockValue = '0';
    if (input.kind === 'metal') {
      const lot = await tx.maybeOne<{ tracking: string; name: string; fineness: Decimal; average_rate: Decimal | null }>(
        `select i.tracking, i.name, pu.fineness_percent as fineness, b.average_rate
           from item i join purity pu on pu.id = $2
           left join stock_balance b on b.item_id = i.id and b.purity_id = pu.id and b.location_id = $3
          where i.id = $1`, [input.itemId ?? null, input.purityId ?? null, input.locationId ?? null]);
      if (!lot) throw new BusinessRuleError('Choose the metal lot to give.', 'lot_required');
      if (lot.tracking !== 'lot') throw new BusinessRuleError(`${lot.name} is tagged piece by piece; give metal from a lot item (bullion, fine gold).`, 'item_is_piece_tracked');
      const net = g(input.netWeight ?? '0');
      if (!(compare(net, '0') > 0)) throw new ValidationError('Enter the weight given.');
      fine = g(div(mul(net, lot.fineness), '100'));
      stockValue = rs(mul(net, lot.average_rate ?? '0'));
      if (compare(fine, owed.fine) > 0) {
        throw new BusinessRuleError(`${fixed(net, 3)} g is ${fixed(fine, 3)} g fine, more than the ${fixed(owed.fine, 3)} g fine owed to ${supplier.name}.`, 'metal_exceeds_owed');
      }
      row = await repo<{ id: string }>(tx, 'supplier_settlement').insert({ ...base, metal_id: metalId, item_id: input.itemId, purity_id: input.purityId,
        location_id: input.locationId, net_weight: net, fine_weight: fine, amount: stockValue });
      await recordMovements(tx, [{ direction: 'out', reason: 'metal_payment', tracking: 'lot', itemId: input.itemId!, purityId: input.purityId!,
        locationId: input.locationId!, grossWeight: net, netWeight: net, fineWeight: fine, value: stockValue,
        sourceType: 'supplier_settlement', sourceId: row.id, note: docNumber }]);
      metal = [{ accountCode: '1210', metalId, purityId: input.purityId, grossWeight: net, weightOut: fine, narration }];
    } else {
      fine = g(input.fineWeight ?? '0');
      if (!(compare(fine, '0') > 0)) throw new ValidationError('Enter the fine weight to fix.');
      if (!(compare(input.ratePerGram ?? '0', '0') > 0)) throw new ValidationError('Enter the agreed rate per fine gram.');
      if (compare(fine, owed.fine) > 0) throw new BusinessRuleError(`Only ${fixed(owed.fine, 3)} g fine is owed to ${supplier.name}.`, 'metal_exceeds_owed');
      stockValue = rs(mul(fine, input.ratePerGram!));
      row = await repo<{ id: string }>(tx, 'supplier_settlement').insert({ ...base, metal_id: metalId, fine_weight: fine,
        rate_per_gram: input.ratePerGram, amount: stockValue });
    }
    // Metal owed is carried at what it was valued at when bought; the rest is gain or loss.
    const carried = rs(mul(fine, rate));
    const gap = sub(carried, stockValue);
    money = [
      { accountCode: '2010', partyId: supplier.id, debit: carried, narration },
      input.kind === 'metal'
        ? { accountCode: '1200', credit: stockValue, narration: 'Metal given to supplier' }
        : { accountCode: '2000', partyId: supplier.id, credit: stockValue, narration: `Rate fixed at ₹${input.ratePerGram}/g`, againstType: 'supplier_settlement', againstId: row.id },
      compare(gap, '0') >= 0 ? { accountCode: '4200', credit: gap, narration: 'Metal settlement difference' }
        : { accountCode: '4200', debit: neg(gap), narration: 'Metal settlement difference' },
    ];
    metal.push({ accountCode: '2010', partyId: supplier.id, metalId, weightOut: fine, ratePerGram: rate, narration });
  }

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'payment', voucherDate: docDate, branchId, sourceType: 'supplier_settlement', sourceId: row.id, narration, money, metal,
  });
  return tx.one(`update supplier_settlement set voucher_id = $2 where id = $1 returning *`, [row.id, voucherId]);
}

export async function cancelSettlement(tx: Tx, id: string, reason: string) {
  const s = await tx.one<{ doc_number: string; status: string; voucher_id: string | null }>(`select * from supplier_settlement where id = $1 for update`, [id]);
  if (s.status !== 'posted') throw new BusinessRuleError(`${s.doc_number} is already cancelled.`, 'not_posted');
  await reverseMovementsFor(tx, 'supplier_settlement', id, `Cancelled: ${reason}`);
  if (s.voucher_id) await reverseVoucher(tx, s.voucher_id, reason);
  return tx.one(`update supplier_settlement set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1 returning *`, [id, reason]);
}

/* ----------------------------------------------------------- purchase order */

export async function createOrder(tx: Tx, input: { supplierId: string; docDate?: string; expectedDate?: string; notes?: string;
  lines: { itemId: string; purityId: string; quantity?: number; grossWeight: Decimal; ratePerGram?: Decimal; notes?: string }[] }) {
  const branchId = branchOf(tx);
  const supplier = await activeSupplier(tx, input.supplierId);
  if (input.lines.length === 0) throw new ValidationError('Add at least one line.');
  const docDate = await docDateOf(tx, input.docDate);
  if (input.lines.some((l) => !(compare(l.grossWeight, '0') > 0))) throw new ValidationError('Each line needs a weight above 0 g.');
  // The same checks as receiving the goods, so an order never asks for something that cannot arrive.
  const found = await tx.one<{ items: { id: string; name: string; metal_id: string | null; is_active: boolean }[]; purities: { id: string; code: string; metal_id: string }[] }>(
    `select (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'metal_id', metal_id, 'is_active', is_active)), '[]')
               from item where id = any($1::uuid[]) and deleted_at is null) as items,
            (select coalesce(json_agg(json_build_object('id', id, 'code', code, 'metal_id', metal_id)), '[]')
               from purity where id = any($2::uuid[]) and is_active) as purities`,
    [input.lines.map((l) => l.itemId), input.lines.map((l) => l.purityId)]);
  input.lines.forEach((l, i) => {
    const n = input.lines.length > 1 ? `Line ${i + 1}: ` : '';
    const item = found.items.find((x) => x.id === l.itemId);
    const purity = found.purities.find((x) => x.id === l.purityId);
    if (!item || !item.is_active) throw new BusinessRuleError(`${n}That item does not exist or is inactive.`, 'item_invalid');
    if (!purity) throw new BusinessRuleError(`${n}That purity does not exist or is inactive.`, 'purity_invalid');
    if (item.metal_id && item.metal_id !== purity.metal_id) throw new BusinessRuleError(`${n}${purity.code} is for a different metal than ${item.name}.`, 'purity_metal_mismatch');
  });
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'purchase_order', 1, { branchId, date: new Date(docDate) });
  const order = await repo<{ id: string }>(tx, 'purchase_order').insert({
    doc_number: docNumber, doc_date: docDate, branch_id: branchId, supplier_id: supplier.id, status: 'confirmed',
    expected_date: input.expectedDate ?? null, notes: input.notes ?? null,
    total_gross_weight: sum(input.lines.map((l) => l.grossWeight)),
  });
  await repo(tx, 'purchase_order_line').insertMany(input.lines.map((l, i) => ({
    purchase_order_id: order.id, line_number: i + 1, item_id: l.itemId, purity_id: l.purityId, quantity: l.quantity ?? 1,
    gross_weight: l.grossWeight, net_weight: l.grossWeight, rate_per_gram: l.ratePerGram ?? '0', notes: l.notes ?? null,
  })));
  return tx.one(`select * from purchase_order where id = $1`, [order.id]);
}

export async function closeOrder(tx: Tx, id: string, status: 'closed' | 'cancelled', reason: string) {
  const po = await tx.one<{ doc_number: string; status: string }>(`select doc_number, status from purchase_order where id = $1 for update`, [id]);
  if (po.status !== 'confirmed') throw new BusinessRuleError(`${po.doc_number} is already ${po.status}.`, 'po_not_open');
  if (status === 'cancelled') {
    const received = await tx.maybeOne(`select 1 from goods_receipt where purchase_order_id = $1 and status = 'posted'`, [id]);
    if (received) throw new BusinessRuleError(`Goods were already received on ${po.doc_number}. Close it instead of cancelling.`, 'po_received');
  }
  return tx.one(
    `update purchase_order set status = $2, cancel_reason = $3, cancelled_at = case when $2 = 'cancelled' then now() end, updated_at = now()
      where id = $1 returning *`, [id, status, reason]);
}
