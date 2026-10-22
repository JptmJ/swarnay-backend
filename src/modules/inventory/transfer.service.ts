/**
 * Moving stock between locations.
 *
 * Within a branch it is done at once. Between branches it is two steps: the
 * sender dispatches (stock leaves their books into the receiving branch's
 * TRANSIT location), the receiver counts it in. Until then everyone can see
 * exactly what is on the road. A dispatch not yet received can be cancelled,
 * which brings it back.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError } from '../../core/errors/app-error.js';
import { add, type Decimal } from '../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { recordMovements, type MovementInput } from './stock.service.js';
import { lotMovements, type LotLine } from './adjustment.service.js';
import { postStockValue } from '../accounts/stock-posting.js';

interface Location { id: string; branch_id: string; name: string; kind: string; is_active: boolean }

/** The receiving branch's transit location, created the first time it is needed. */
async function transitLocation(tx: Tx, branchId: string): Promise<string> {
  const found = await tx.maybeOne<{ id: string }>(
    `select id from stock_location where branch_id = $1 and kind = 'transit' and deleted_at is null order by created_at limit 1`, [branchId]);
  if (found) return found.id;
  const row = await repo<{ id: string }>(tx, 'stock_location').insert({ branch_id: branchId, code: 'TRANSIT', name: 'In transit', kind: 'transit' });
  return row.id;
}

type Line = { pieceId: string | null; itemId: string; purityId: string | null; quantity: Decimal; gross: Decimal; net: Decimal; fine: Decimal; value: Decimal; tracking: 'lot' | 'piece' };

function moves(lines: Line[], from: string, to: string, transferId: string, docNumber: string): MovementInput[] {
  return lines.flatMap((l) => (['out', 'in'] as const).map((direction) => ({
    direction, reason: direction === 'out' ? 'transfer_out' as const : 'transfer_in' as const, tracking: l.tracking,
    itemId: l.itemId, purityId: l.purityId, locationId: direction === 'out' ? from : to, pieceId: l.pieceId,
    quantity: l.quantity, grossWeight: l.gross, netWeight: l.net, fineWeight: l.fine, value: l.value,
    sourceType: 'stock_transfer', sourceId: transferId, note: docNumber,
  })));
}

export async function dispatchTransfer(tx: Tx, input: {
  fromLocationId: string; toLocationId: string; pieceIds?: string[]; lots?: Omit<LotLine, 'locationId'>[]; note?: string;
}) {
  if (input.fromLocationId === input.toLocationId) throw new BusinessRuleError('Pick a different location to send to.', 'transfer_same_location');
  const locations = await tx.query<Location>(
    `select id, branch_id, name, kind, is_active from stock_location where id = any($1::uuid[]) and deleted_at is null`,
    [[input.fromLocationId, input.toLocationId]]);
  const from = locations.find((l) => l.id === input.fromLocationId);
  const to = locations.find((l) => l.id === input.toLocationId);
  if (!from || !to || !to.is_active) throw new BusinessRuleError('That location does not exist or is inactive.', 'not_found');
  if (from.kind === 'transit' || to.kind === 'transit') throw new BusinessRuleError('Transit locations are managed by transfers themselves.', 'transfer_transit_location');

  const pieceIds = [...new Set(input.pieceIds ?? [])];
  const pieces = pieceIds.length ? await tx.query<{
    id: string; tag_number: string; status: string; location_id: string; item_id: string; purity_id: string;
    gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; cost_value: Decimal;
  }>(`select id, tag_number, status, location_id, item_id, purity_id, gross_weight, net_weight, fine_weight, cost_value
        from stock_piece where id = any($1::uuid[]) for update`, [pieceIds]) : [];
  if (pieces.length !== pieceIds.length) throw new BusinessRuleError('Some of those pieces do not exist.', 'not_found');
  const wrong = pieces.filter((p) => p.status !== 'in_stock' || p.location_id !== from.id);
  if (wrong.length) {
    throw new BusinessRuleError(`Not in stock at ${from.name}: ${wrong.map((p) => p.tag_number).join(', ')}.`, 'piece_not_at_location');
  }
  const lots = await lotMovements(tx, (input.lots ?? []).map((l) => ({ ...l, locationId: from.id })), 'out');
  if (pieces.length + lots.length === 0) throw new BusinessRuleError('Add at least one piece or lot to send.', 'transfer_empty');

  const lines: Line[] = [
    ...pieces.map((p) => ({ pieceId: p.id, itemId: p.item_id, purityId: p.purity_id, quantity: '1', gross: p.gross_weight, net: p.net_weight, fine: p.fine_weight, value: p.cost_value, tracking: 'piece' as const })),
    ...lots.map((l) => ({ pieceId: null, itemId: l.itemId, purityId: l.purityId ?? null, quantity: '0', gross: l.grossWeight!, net: l.netWeight!, fine: l.fineWeight!, value: l.value!, tracking: 'lot' as const })),
  ];
  const sameBranch = from.branch_id === to.branch_id;
  const landing = sameBranch ? to.id : await transitLocation(tx, to.branch_id);
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'stock_transfer', 1, { branchId: from.branch_id });
  const transfer = await repo<{ id: string; doc_number: string }>(tx, 'stock_transfer').insert({
    doc_number: docNumber, from_branch_id: from.branch_id, from_location_id: from.id, to_branch_id: to.branch_id,
    to_location_id: to.id, status: sameBranch ? 'received' : 'in_transit', piece_count: pieces.length,
    gross_weight: lines.reduce((s, l) => add(s, l.gross), '0'), note: input.note ?? null,
    dispatched_by: tx.context.userId,
    ...(sameBranch ? { received_at: new Date(), received_by: tx.context.userId } : {}),
  });
  await repo(tx, 'stock_transfer_line').insertMany(lines.map((l) => ({
    stock_transfer_id: transfer.id, piece_id: l.pieceId, item_id: l.itemId, purity_id: l.purityId,
    quantity: l.quantity, gross_weight: l.gross, net_weight: l.net, fine_weight: l.fine, value: l.value,
  })));
  await recordMovements(tx, moves(lines, from.id, landing, transfer.id, transfer.doc_number));
  // Between branches the goods leave this branch's books into transit until the other branch receives them.
  if (!sameBranch) {
    await postStockValue(tx, {
      voucherType: 'branch_transfer', counterCode: '1600', sourceType: 'stock_transfer', sourceId: transfer.id,
      narration: `${transfer.doc_number} sent to ${to.name}`,
      moves: lines.map((l) => ({ direction: 'out' as const, locationId: from.id, purityId: l.purityId, grossWeight: l.gross, fineWeight: l.fine, value: l.value })),
    });
  }
  if (pieceIds.length) {
    await tx.query(`update stock_piece set location_id = $2, status = $3, updated_at = now(), updated_by = $4 where id = any($1::uuid[])`,
      [pieceIds, landing, sameBranch ? 'in_stock' : 'in_transit', tx.context.userId]);
  }
  return transfer;
}

async function openTransfer(tx: Tx, id: string) {
  const transfer = await tx.one<{ id: string; doc_number: string; status: string; from_location_id: string; to_location_id: string; to_branch_id: string }>(
    `select * from stock_transfer where id = $1 for update`, [id]);
  if (transfer.status !== 'in_transit') throw new BusinessRuleError(`${transfer.doc_number} is already ${transfer.status}.`, 'transfer_not_in_transit');
  const lines = await tx.query<{ piece_id: string | null; item_id: string; purity_id: string | null; quantity: Decimal; gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; value: Decimal }>(
    `select * from stock_transfer_line where stock_transfer_id = $1`, [id]);
  return {
    transfer, transit: await transitLocation(tx, transfer.to_branch_id),
    lines: lines.map((l): Line => ({
      pieceId: l.piece_id, itemId: l.item_id, purityId: l.purity_id, quantity: l.quantity, gross: l.gross_weight,
      net: l.net_weight, fine: l.fine_weight, value: l.value, tracking: l.piece_id ? 'piece' : 'lot',
    })),
  };
}

/** Moves the goods out of transit to wherever they end up, and closes the transfer. */
async function land(tx: Tx, id: string, status: 'received' | 'cancelled') {
  const { transfer, transit, lines } = await openTransfer(tx, id);
  const target = status === 'received' ? transfer.to_location_id : transfer.from_location_id;
  // A reversal or a delivery must always go through — the goods physically exist.
  await recordMovements(tx, moves(lines, transit, target, transfer.id, transfer.doc_number), { allowNegative: true });
  await postStockValue(tx, {
    voucherType: 'branch_transfer', counterCode: '1600', sourceType: 'stock_transfer', sourceId: transfer.id,
    narration: `${transfer.doc_number} ${status === 'received' ? 'received' : 'cancelled, back in stock'}`,
    moves: lines.map((l) => ({ direction: 'in' as const, locationId: target, purityId: l.purityId, grossWeight: l.gross, fineWeight: l.fine, value: l.value })),
  });
  const pieceIds = lines.flatMap((l) => (l.pieceId ? [l.pieceId] : []));
  if (pieceIds.length) {
    await tx.query(`update stock_piece set location_id = $2, status = 'in_stock', updated_at = now(), updated_by = $3 where id = any($1::uuid[])`,
      [pieceIds, target, tx.context.userId]);
  }
  return tx.one(
    `update stock_transfer set status = $2, received_at = now(), received_by = $3, updated_at = now(), updated_by = $3
      where id = $1 returning *`, [id, status, tx.context.userId]);
}

export const receiveTransfer = (tx: Tx, id: string) => land(tx, id, 'received');
export const cancelTransfer = (tx: Tx, id: string) => land(tx, id, 'cancelled');
