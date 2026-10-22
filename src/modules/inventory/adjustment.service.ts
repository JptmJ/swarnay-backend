/**
 * Stock corrections. An adjustment is a numbered document whose lines are its
 * stock movements; posting it is final (a mistake is corrected by another one).
 * Only the owner and branch managers hold `stock.adjustment.post`.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError } from '../../core/errors/app-error.js';
import { add, compare, div, mul, sub, type Decimal } from '../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { recordMovements, type MovementInput } from './stock.service.js';
import { postStockValue } from '../accounts/stock-posting.js';
import type { ADJUSTMENT_REASONS } from './inventory.schema.js';

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export type AdjustmentMovement = Omit<MovementInput, 'reason' | 'sourceType' | 'sourceId' | 'note'>;

/** Writes the adjustment and its movements. Callers change piece statuses themselves. */
export async function postAdjustment(tx: Tx, input: {
  branchId: string; reason: AdjustmentReason; note: string;
  sourceType?: string; sourceId?: string; movements: AdjustmentMovement[];
}) {
  if (input.movements.length === 0) throw new BusinessRuleError('Nothing to adjust.', 'adjustment_empty');
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'stock_adjustment', 1, { branchId: input.branchId });
  let netIn = '0'; let netOut = '0'; let value = '0';
  const pieces = new Set<string>();
  for (const m of input.movements) {
    if (m.pieceId) pieces.add(m.pieceId);
    if (m.direction === 'in') { netIn = add(netIn, m.netWeight ?? '0'); value = add(value, m.value ?? '0'); }
    else { netOut = add(netOut, m.netWeight ?? '0'); value = sub(value, m.value ?? '0'); }
  }
  const adjustment = await repo<{ id: string; doc_number: string }>(tx, 'stock_adjustment').insert({
    doc_number: docNumber, branch_id: input.branchId, reason: input.reason, note: input.note,
    source_type: input.sourceType ?? null, source_id: input.sourceId ?? null,
    piece_count: pieces.size, net_weight_in: netIn, net_weight_out: netOut, value,
  });
  await recordMovements(tx, input.movements.map((m) => ({
    ...m, reason: 'adjustment' as const, sourceType: 'stock_adjustment', sourceId: adjustment.id,
    note: `${adjustment.doc_number}: ${input.note}`,
  })));
  // What was gained or lost reaches the books too, so Stock in Hand stays the stock in the safe.
  await postStockValue(tx, {
    voucherType: 'stock_journal', counterCode: '5910', sourceType: 'stock_adjustment', sourceId: adjustment.id,
    narration: `${adjustment.doc_number}: ${input.reason.replace(/_/g, ' ')}, ${input.note}`, moves: input.movements,
  });
  return adjustment;
}

/** What leaves stock for each manual reason; `found` is the only one that adds. */
const OUT_REASONS = ['shortage', 'damage', 'loss', 'write_off'] as const;
export const MANUAL_REASONS = [...OUT_REASONS, 'found'] as const;

export interface LotLine { itemId: string; purityId: string; locationId: string; netWeight: Decimal; grossWeight?: Decimal }

/** Lot lines valued at the location's average cost — which is what the books carry them at. */
export async function lotMovements(tx: Tx, lines: LotLine[], direction: 'in' | 'out'): Promise<AdjustmentMovement[]> {
  if (lines.length === 0) return [];
  const rows = await tx.query<{ item_id: string; tracking: string; name: string; purity_id: string; fineness: Decimal; location_id: string; average_rate: Decimal | null }>(
    `select i.id as item_id, i.tracking, i.name, pu.id as purity_id, pu.fineness_percent as fineness, x.location_id, b.average_rate
       from unnest($1::uuid[], $2::uuid[], $3::uuid[]) as x(item_id, purity_id, location_id)
       join item i on i.id = x.item_id join purity pu on pu.id = x.purity_id
       left join stock_balance b on b.item_id = x.item_id and b.purity_id = x.purity_id and b.location_id = x.location_id`,
    [lines.map((l) => l.itemId), lines.map((l) => l.purityId), lines.map((l) => l.locationId)]);
  return lines.map((l) => {
    const r = rows.find((x) => x.item_id === l.itemId && x.purity_id === l.purityId && x.location_id === l.locationId);
    if (!r) throw new BusinessRuleError('That item or purity does not exist.', 'not_found');
    if (r.tracking !== 'lot') throw new BusinessRuleError(`${r.name} is tagged piece by piece — pick the pieces instead.`, 'item_is_piece_tracked');
    if (!(compare(l.netWeight, '0') > 0)) throw new BusinessRuleError('Weight must be more than 0 g.', 'weight_required');
    return {
      direction, tracking: 'lot' as const, itemId: l.itemId, purityId: l.purityId, locationId: l.locationId,
      grossWeight: l.grossWeight ?? l.netWeight, netWeight: l.netWeight,
      fineWeight: div(mul(l.netWeight, r.fineness), '100'), value: mul(l.netWeight, r.average_rate ?? '0'),
    };
  });
}

/**
 * A manual adjustment from the Stock screen: tagged pieces out (they become
 * written off), and lots out or in by weight. Everything must be in one branch.
 */
export async function adjustStock(tx: Tx, input: {
  reason: (typeof MANUAL_REASONS)[number]; note: string; pieceIds?: string[]; lots?: LotLine[];
}) {
  const direction = input.reason === 'found' ? 'in' : 'out';
  const pieceIds = [...new Set(input.pieceIds ?? [])];
  if (direction === 'in' && pieceIds.length) {
    throw new BusinessRuleError('A found piece is tagged again from Tagging, not adjusted in.', 'found_piece');
  }
  const pieces = pieceIds.length ? await tx.query<{
    id: string; tag_number: string; status: string; item_id: string; purity_id: string; location_id: string; branch_id: string;
    gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; cost_value: Decimal;
  }>(
    `select p.id, p.tag_number, p.status, p.item_id, p.purity_id, p.location_id, l.branch_id,
            p.gross_weight, p.net_weight, p.fine_weight, p.cost_value
       from stock_piece p join stock_location l on l.id = p.location_id where p.id = any($1::uuid[]) for update of p`, [pieceIds]) : [];
  if (pieces.length !== pieceIds.length) throw new BusinessRuleError('Some of those pieces do not exist.', 'not_found');
  const notInStock = pieces.filter((p) => p.status !== 'in_stock');
  if (notInStock.length) {
    throw new BusinessRuleError(`Not in stock: ${notInStock.map((p) => p.tag_number).join(', ')}.`, 'piece_not_in_stock');
  }
  const lots = await lotMovements(tx, input.lots ?? [], direction);

  const locationIds = [...new Set([...pieces.map((p) => p.location_id), ...lots.map((l) => l.locationId)])];
  const branches = await tx.query<{ branch_id: string }>(
    `select distinct branch_id from stock_location where id = any($1::uuid[])`, [locationIds]);
  if (branches.length !== 1) throw new BusinessRuleError('An adjustment covers one branch at a time.', 'adjustment_branches');

  const adjustment = await postAdjustment(tx, {
    branchId: branches[0]!.branch_id, reason: input.reason, note: input.note,
    movements: [
      ...pieces.map((p) => ({
        direction: 'out' as const, tracking: 'piece' as const, itemId: p.item_id, purityId: p.purity_id,
        locationId: p.location_id, pieceId: p.id, quantity: '1', grossWeight: p.gross_weight,
        netWeight: p.net_weight, fineWeight: p.fine_weight, value: p.cost_value,
      })),
      ...lots,
    ],
  });
  if (pieces.length) {
    await tx.query(`update stock_piece set status = 'written_off', updated_at = now(), updated_by = $2 where id = any($1::uuid[])`,
      [pieceIds, tx.context.userId]);
  }
  return adjustment;
}
