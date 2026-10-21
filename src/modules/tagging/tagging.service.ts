/**
 * Module 4 — tagging a piece: its weights, purity, HUID and tag number.
 *
 * A tagged piece and its stock always move together: creating a piece writes
 * the matching stock movement in the same transaction, so a piece can never be
 * in the vault while the balance says it does not exist.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError } from '../../core/errors/app-error.js';
import { add, compare, div, fixed, mul, round, sub, type Decimal } from '../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { recordMovements, type MovementInput } from '../inventory/stock.service.js';
import { postAdjustment } from '../inventory/adjustment.service.js';
import { postStockValue } from '../accounts/stock-posting.js';
import { TAG_MAKING_BASES } from '../inventory/inventory.schema.js';

export interface TagPieceInput {
  itemId: string;
  purityId: string;
  locationId: string;
  grossWeight: Decimal;
  stoneWeight?: Decimal;
  otherWeight?: Decimal;
  stoneCount?: number;
  stoneValue?: Decimal;
  huid?: string;
  hallmarkCentre?: string;
  costValue?: Decimal;
  makingCost?: Decimal;
  supplierId?: string;
  /** Leave out to take the next number from Masters → Bill Numbers → Item Tag. */
  tagNumber?: string;
  /** A purchase lot waiting in Tagging. The piece takes the lot's item, purity, location, supplier and a share of its cost. */
  taggingLotId?: string;
  /** Selling terms on the tag; they win over Masters → Formulas at the counter. Leave out to use the formula. */
  makingBasis?: TagMakingBasis;
  makingRate?: Decimal;
  wastagePercent?: Decimal;
}

export type TagMakingBasis = (typeof TAG_MAKING_BASES)[number];

/** The making and wastage a tag may carry: a basis goes with a rate, and percentages stay within 100. */
export function tagPricingProblem(p: { makingBasis?: TagMakingBasis | null; makingRate?: Decimal | null; wastagePercent?: Decimal | null }): string | null {
  const hasRate = p.makingRate !== undefined && p.makingRate !== null && p.makingRate !== '';
  if (p.makingBasis && !hasRate) return 'Enter the making rate for the tag, or leave making blank to use the formula.';
  if (hasRate && !p.makingBasis) return 'Choose how the making is charged: per gram, per piece or % of metal.';
  if (hasRate && compare(p.makingRate!, '0') < 0) return 'Making cannot be negative.';
  if (p.makingBasis === 'percent' && hasRate && compare(p.makingRate!, '100') > 0) return 'Making as a % of metal cannot be more than 100%.';
  const w = p.wastagePercent;
  if (w !== undefined && w !== null && w !== '' && (compare(w, '0') < 0 || compare(w, '100') > 0)) return 'Wastage must be between 0 and 100%.';
  return null;
}

/** Why pieces without a purchase lot are appearing. Pieces from a lot are always purchases. */
export type TagOrigin = 'opening' | 'production_receipt' | 'sales_return';

interface Prepared extends TagPieceInput { net: Decimal; fine: Decimal; stone: Decimal; other: Decimal; fineness: Decimal }

interface LotRow {
  id: string; doc_number: string; status: string; item_id: string; purity_id: string; location_id: string; supplier_id: string;
  pieces_expected: number; pieces_tagged: number; gross_expected: Decimal; gross_tagged: Decimal; cost_value: Decimal; cost_tagged: Decimal;
}

export const HUID_PATTERN = /^[A-Z0-9]{6}$/;

/**
 * preparePieces catches a duplicate before saving. Two counters saving the same
 * tag number or HUID at the same instant are stopped by the database; this says which.
 */
const explainDuplicate = (saving: { huids: (string | undefined)[]; tags: (string | undefined)[] }) => (error: unknown): never => {
  const e = error as { code?: string; constraint?: string };
  // Row-level security keeps the clashing value out of the database's message, so name what was being saved.
  const list = (values: (string | undefined)[]) => values.filter(Boolean).join(', ');
  if (e.code === '23505' && e.constraint === 'ux_stock_piece_huid') {
    throw new BusinessRuleError(`HUID ${list(saving.huids)} was just saved on another piece by someone else.`, 'huid_taken');
  }
  if (e.code === '23505' && e.constraint?.endsWith('_tag_number')) {
    throw new BusinessRuleError(`Tag number ${list(saving.tags)} was just used for another piece by someone else.`, 'tag_number_taken');
  }
  throw error;
};

/**
 * Checks every piece before anything is written, and says what is wrong with
 * each one by its position — the tag form shows the first, an import shows all.
 */
export async function preparePieces(
  tx: Tx, inputs: TagPieceInput[], name: (index: number) => string = (i) => `piece ${i + 1}`,
): Promise<{ ready: { index: number; piece: Prepared }[]; errors: { index: number; message: string }[] }> {
  const ids = (pick: (i: TagPieceInput) => string | undefined) => [...new Set(inputs.map(pick).filter((v): v is string => Boolean(v)))];
  // Everything the checks need, in one round trip.
  const found = await tx.one<{
    items: { id: string; name: string; tracking: string; metal_id: string | null; is_active: boolean }[];
    purities: { id: string; metal_id: string; fineness_percent: Decimal }[];
    locations: string[]; huids: string[]; tags: string[]; lots: LotRow[];
  }>(
    `select
       (select coalesce(json_agg(json_build_object('id', id, 'name', name, 'tracking', tracking, 'metal_id', metal_id, 'is_active', is_active)), '[]')
          from item where id = any($1::uuid[]) and deleted_at is null) as items,
       (select coalesce(json_agg(json_build_object('id', id, 'metal_id', metal_id, 'fineness_percent', fineness_percent::text)), '[]')
          from purity where id = any($2::uuid[]) and is_active) as purities,
       (select coalesce(json_agg(id), '[]') from stock_location where id = any($3::uuid[]) and is_active and deleted_at is null) as locations,
       (select coalesce(json_agg(huid), '[]') from stock_piece where huid = any($4::text[]) and status not in ('melted', 'written_off')) as huids,
       (select coalesce(json_agg(tag_number), '[]') from stock_piece where tag_number = any($5::text[])) as tags,
       (select coalesce(json_agg(json_build_object('id', t.id, 'doc_number', gr.doc_number, 'status', t.status, 'item_id', t.item_id,
                 'purity_id', t.purity_id, 'location_id', t.location_id, 'supplier_id', t.supplier_id, 'pieces_expected', t.pieces_expected,
                 'pieces_tagged', t.pieces_tagged, 'gross_expected', t.gross_expected::text, 'gross_tagged', t.gross_tagged::text,
                 'cost_value', t.cost_value::text, 'cost_tagged', t.cost_tagged::text)), '[]')
          from tagging_lot t join goods_receipt_line gl on gl.id = t.goods_receipt_line_id join goods_receipt gr on gr.id = gl.goods_receipt_id
         where t.id = any($6::uuid[])) as lots`,
    [ids((i) => i.itemId), ids((i) => i.purityId), ids((i) => i.locationId), ids((i) => i.huid?.trim().toUpperCase()),
     ids((i) => i.tagNumber?.trim()), ids((i) => i.taggingLotId)]);
  const item = new Map(found.items.map((r) => [r.id, r]));
  const purity = new Map(found.purities.map((r) => [r.id, r]));
  const location = new Set(found.locations);
  const huids = new Set(found.huids);
  const tags = new Set(found.tags);
  const lots = new Map(found.lots.map((l) => [l.id, { ...l }]));

  const ready: { index: number; piece: Prepared }[] = [];
  const errors: { index: number; message: string }[] = [];
  /** First piece in this batch to use each HUID and tag number. */
  const batch = { huids: new Map<string, number>(), tags: new Map<string, number>() };
  inputs.forEach((input, index) => {
    const fail = (message: string) => errors.push({ index, message });
    const it = item.get(input.itemId);
    const pu = purity.get(input.purityId);
    if (!it || !it.is_active) return fail('That item does not exist or is inactive.');
    if (it.tracking !== 'piece') return fail(`${it.name} is counted by weight (a lot item) and is not tagged.`);
    if (!pu) return fail('That purity does not exist or is inactive.');
    if (it.metal_id && it.metal_id !== pu.metal_id) return fail(`That purity is for a different metal than ${it.name}.`);
    const lot = input.taggingLotId ? lots.get(input.taggingLotId) : undefined;
    if (input.taggingLotId && !lot) return fail('That purchase lot does not exist.');
    if (lot) {
      if (lot.status !== 'open') return fail(`The lot from ${lot.doc_number} is closed.`);
      if (lot.item_id !== input.itemId || lot.purity_id !== input.purityId) return fail(`The lot from ${lot.doc_number} is a different item or purity.`);
    } else if (!location.has(input.locationId)) return fail('That stock location does not exist or is inactive.');
    if (!(compare(input.grossWeight, '0') > 0)) return fail('Gross weight must be more than 0 g.');
    const pricing = tagPricingProblem(input);
    if (pricing) return fail(pricing);
    const stone = input.stoneWeight ?? '0';
    const other = input.otherWeight ?? '0';
    const net = sub(sub(input.grossWeight, stone), other);
    if (compare(net, '0') < 0) {
      return fail(`Stones (${stone} g) and other weight (${other} g) add up to more than the gross weight (${input.grossWeight} g).`);
    }
    const huid = input.huid?.trim().toUpperCase() || undefined;
    if (huid && !HUID_PATTERN.test(huid)) return fail('HUID is 6 letters or digits.');
    if (huid && huids.has(huid)) return fail(`HUID ${huid} is already on another piece.`);
    if (huid && batch.huids.has(huid)) return fail(`HUID ${huid} is repeated on ${name(batch.huids.get(huid)!)}.`);
    const tagNumber = input.tagNumber?.trim() || undefined;
    if (tagNumber && tags.has(tagNumber)) return fail(`Tag number ${tagNumber} is already used.`);
    if (tagNumber && batch.tags.has(tagNumber)) return fail(`Tag number ${tagNumber} is repeated on ${name(batch.tags.get(tagNumber)!)}.`);
    // A lot can't give more pieces or weight than arrived; each piece takes the lot's cost by weight, the last one what is left.
    let lotTerms: Partial<TagPieceInput> = {};
    if (lot) {
      const leftGross = sub(lot.gross_expected, lot.gross_tagged);
      if (lot.pieces_tagged >= lot.pieces_expected) {
        return fail(`All ${lot.pieces_expected} pieces from ${lot.doc_number} are tagged. Close the lot, or correct the inward if more arrived.`);
      }
      if (compare(input.grossWeight, leftGross) > 0) {
        return fail(`${fixed(input.grossWeight, 3)} g is more than the ${fixed(leftGross, 3)} g still untagged from ${lot.doc_number}.`);
      }
      const last = lot.pieces_tagged + 1 === lot.pieces_expected;
      const leftCost = sub(lot.cost_value, lot.cost_tagged);
      const cost = last ? leftCost : round(div(mul(leftCost, input.grossWeight), leftGross), 2);
      lot.pieces_tagged += 1;
      lot.gross_tagged = add(lot.gross_tagged, input.grossWeight);
      lot.cost_tagged = add(lot.cost_tagged, cost);
      lotTerms = { locationId: lot.location_id, supplierId: lot.supplier_id, costValue: cost };
    }
    if (huid) batch.huids.set(huid, index);
    if (tagNumber) batch.tags.set(tagNumber, index);
    ready.push({
      index,
      piece: { ...input, ...lotTerms, huid, tagNumber, stone, other, net, fineness: pu.fineness_percent, fine: div(mul(net, pu.fineness_percent), '100') },
    });
  });
  return { ready, errors };
}

/** Creates the pieces, their HUID records and the stock that comes with them. Returns them in input order. */
export async function tagPieces(
  tx: Tx, pieces: Prepared[], origin: TagOrigin, source?: { type: string; id: string },
  /** Stock brought over from another system is on the books from the cut-over day, not from today. */
  dated?: { voucherDate?: string; movedAt?: Date },
): Promise<Array<Record<string, unknown> & { id: string; tag_number: string }>> {
  if (pieces.length === 0) return [];
  const untagged = pieces.filter((p) => !p.tagNumber);
  const { numbers } = untagged.length ? await reserveDocumentNumbers(tx, 'tag', untagged.length) : { numbers: [] };
  untagged.forEach((p, i) => { p.tagNumber = numbers[i]; });

  const created = await repo<Record<string, unknown> & { id: string; tag_number: string }>(tx, 'stock_piece').insertMany(
    pieces.map((p) => ({
      tag_number: p.tagNumber,
      item_id: p.itemId,
      purity_id: p.purityId,
      location_id: p.locationId,
      gross_weight: p.grossWeight,
      stone_weight: p.stone,
      other_weight: p.other,
      net_weight: p.net,
      fine_weight: p.fine,
      stone_count: p.stoneCount ?? null,
      stone_cost: p.stoneValue ?? '0',
      huid: p.huid ?? null,
      hallmark_centre: p.hallmarkCentre ?? null,
      cost_value: p.costValue ?? '0',
      making_cost: p.makingCost ?? '0',
      making_basis: p.makingRate ? p.makingBasis ?? null : null,
      making_rate: p.makingBasis ? p.makingRate ?? null : null,
      wastage_percent: p.wastagePercent || null,
      supplier_id: p.supplierId ?? null,
      tagging_lot_id: p.taggingLotId ?? null,
      status: 'in_stock',
    })),
  ).catch(explainDuplicate({ huids: pieces.map((p) => p.huid), tags: pieces.map((p) => p.tagNumber) }));

  if (pieces.some((p) => p.huid)) {
    await repo(tx, 'huid_assignment').insertMany(created.flatMap((c, i) => {
      const p = pieces[i]!;
      return p.huid ? [{
        piece_id: c.id, huid: p.huid, hallmark_centre_name: p.hallmarkCentre ?? null,
        certified_purity_percent: p.fineness, assigned_by: tx.context.userId,
      }] : [];
    }));
  }

  // A piece from a lot was already in stock as part of the lot: it moves out of the lot and in as itself,
  // which leaves the totals unchanged and gives the piece its purchase in its history.
  await recordMovements(tx, created.flatMap((c, i): MovementInput[] => {
    const p = pieces[i]!;
    const move = {
      tracking: 'piece' as const, itemId: p.itemId, purityId: p.purityId, locationId: p.locationId, quantity: '1',
      grossWeight: p.grossWeight, netWeight: p.net, fineWeight: p.fine, value: p.costValue ?? '0', note: `Tagged ${c.tag_number}`,
      ...(dated?.movedAt ? { movedAt: dated.movedAt } : {}),
    };
    return p.taggingLotId
      ? [{ ...move, direction: 'out' as const, reason: 'purchase' as const, sourceType: 'tagging_lot', sourceId: p.taggingLotId },
         { ...move, direction: 'in' as const, reason: 'purchase' as const, pieceId: c.id, sourceType: 'tagging_lot', sourceId: p.taggingLotId }]
      : [{ ...move, direction: 'in' as const, reason: origin, pieceId: c.id, sourceType: source?.type ?? 'stock_piece', sourceId: source?.id ?? c.id }];
  }));

  // Stock the shop already had before it started on Swarnay: it enters the books against the opening balances.
  const fresh = pieces.filter((p) => !p.taggingLotId);
  if (origin === 'opening' && fresh.length) {
    await postStockValue(tx, {
      voucherType: 'opening', counterCode: '3900', sourceType: source?.type ?? 'stock_opening', sourceId: source?.id ?? created[0]!.id,
      narration: `Opening stock, ${fresh.length} piece(s)`, voucherDate: dated?.voucherDate,
      moves: fresh.map((p) => ({ direction: 'in' as const, locationId: p.locationId, purityId: p.purityId, grossWeight: p.grossWeight,
        fineWeight: p.fine, value: p.costValue ?? '0' })),
    });
  }

  const byLot = new Map<string, { pieces: number; gross: Decimal; net: Decimal; fine: Decimal; cost: Decimal }>();
  for (const p of pieces) {
    if (!p.taggingLotId) continue;
    const t = byLot.get(p.taggingLotId) ?? { pieces: 0, gross: '0', net: '0', fine: '0', cost: '0' };
    byLot.set(p.taggingLotId, { pieces: t.pieces + 1, gross: add(t.gross, p.grossWeight), net: add(t.net, p.net), fine: add(t.fine, p.fine), cost: add(t.cost, p.costValue ?? '0') });
  }
  if (byLot.size) {
    await tx.query(
      `update tagging_lot t set pieces_tagged = t.pieces_tagged + x.pieces, gross_tagged = t.gross_tagged + x.gross,
              net_tagged = t.net_tagged + x.net, fine_tagged = t.fine_tagged + x.fine, cost_tagged = t.cost_tagged + x.cost, updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(id uuid, pieces int, gross numeric, net numeric, fine numeric, cost numeric)
        where t.id = x.id`,
      [JSON.stringify([...byLot].map(([id, v]) => ({ id, ...v })))]);
    // Every piece tagged with nothing over or short: the lot is done. Any difference waits for someone to close it with a note.
    await tx.query(
      `update tagging_lot set status = 'closed', closed_at = now(), close_note = 'All pieces tagged', updated_at = now()
        where id = any($1::uuid[]) and pieces_tagged >= pieces_expected and gross_tagged = gross_expected and net_tagged = net_expected
          and fine_tagged = fine_expected and cost_tagged = cost_value`, [[...byLot.keys()]]);
  }
  return created;
}

/** Adds or replaces a piece's HUID — typically when it comes back from the hallmarking centre. */
export async function assignHuid(tx: Tx, pieceId: string, input: { huid: string; hallmarkCentre?: string }) {
  const huid = input.huid.trim().toUpperCase();
  if (!HUID_PATTERN.test(huid)) throw new BusinessRuleError('HUID is 6 letters or digits.', 'huid_invalid');
  const piece = await tx.one<{ id: string; huid: string | null; status: string; fineness: Decimal }>(
    `select p.id, p.huid, p.status, pu.fineness_percent as fineness
       from stock_piece p left join purity pu on pu.id = p.purity_id where p.id = $1 for update of p`, [pieceId]);
  if (['sold', 'melted', 'written_off'].includes(piece.status)) {
    throw new BusinessRuleError('This piece is no longer in stock.', 'piece_not_in_stock');
  }
  if (piece.huid === huid) return piece;
  const clash = await tx.maybeOne(
    `select 1 from stock_piece where huid = $1 and id <> $2 and status not in ('melted', 'written_off')`, [huid, pieceId]);
  if (clash) throw new BusinessRuleError(`HUID ${huid} is already on another piece.`, 'huid_taken');

  await tx.query(
    `update huid_assignment set superseded_at = now(), supersede_reason = 'Replaced by a new HUID'
      where piece_id = $1 and superseded_at is null`, [pieceId]);
  await repo(tx, 'huid_assignment').insert({
    piece_id: pieceId, huid, hallmark_centre_name: input.hallmarkCentre ?? null,
    certified_purity_percent: piece.fineness, assigned_by: tx.context.userId,
  });
  return tx.one(
    `update stock_piece set huid = $2, hallmark_centre = coalesce($3, hallmark_centre), updated_at = now(), updated_by = $4
      where id = $1 returning *`, [pieceId, huid, input.hallmarkCentre ?? null, tx.context.userId]).catch(explainDuplicate({ huids: [huid], tags: [] }));
}

/**
 * Changes the making and wastage written on a piece's tag — a repricing, or a
 * mistake at tagging. Blank values hand the piece back to Masters → Formulas.
 */
export async function setPiecePricing(
  tx: Tx, pieceId: string, input: { makingBasis?: TagMakingBasis | null; makingRate?: Decimal | null; wastagePercent?: Decimal | null },
) {
  const problem = tagPricingProblem(input);
  if (problem) throw new BusinessRuleError(problem, 'tag_pricing_invalid');
  const piece = await tx.one<{ status: string; tag_number: string }>(`select status, tag_number from stock_piece where id = $1 for update`, [pieceId]);
  if (!['in_stock', 'on_memo'].includes(piece.status)) {
    throw new BusinessRuleError(`${piece.tag_number} is ${piece.status.replace('_', ' ')}; only a piece in stock can be repriced.`, 'piece_not_in_stock');
  }
  const rate = input.makingBasis && input.makingRate ? input.makingRate : null;
  return tx.one(
    `update stock_piece set making_basis = $2, making_rate = $3, wastage_percent = $4, updated_at = now(), updated_by = $5 where id = $1 returning *`,
    [pieceId, rate ? input.makingBasis : null, rate, input.wastagePercent || null, tx.context.userId]);
}

/**
 * Corrects a piece's weights (a weighing mistake). Stock follows: the old
 * weights go out and the new ones come in, on one adjustment, at the same cost.
 */
export async function correctPieceWeights(
  tx: Tx, pieceId: string, input: { grossWeight: Decimal; stoneWeight?: Decimal; otherWeight?: Decimal; note: string },
) {
  const piece = await tx.one<{
    id: string; tag_number: string; item_id: string; purity_id: string; location_id: string; status: string;
    gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; cost_value: Decimal; fineness: Decimal; branch_id: string;
  }>(
    `select p.*, pu.fineness_percent as fineness, l.branch_id
       from stock_piece p join purity pu on pu.id = p.purity_id join stock_location l on l.id = p.location_id
      where p.id = $1 for update of p`, [pieceId]);
  if (piece.status !== 'in_stock') throw new BusinessRuleError('Only a piece in stock can be re-weighed.', 'piece_not_in_stock');
  const stone = input.stoneWeight ?? '0';
  const other = input.otherWeight ?? '0';
  const net = sub(sub(input.grossWeight, stone), other);
  if (!(compare(input.grossWeight, '0') > 0) || compare(net, '0') < 0) {
    throw new BusinessRuleError('Gross weight must be more than 0 g and cover the stones and other weight.', 'weights_inconsistent');
  }
  const fine = div(mul(net, piece.fineness), '100');
  const base = { tracking: 'piece' as const, itemId: piece.item_id, purityId: piece.purity_id, locationId: piece.location_id, pieceId, quantity: '1', value: piece.cost_value };
  await postAdjustment(tx, {
    branchId: piece.branch_id, reason: 'weighing_correction', note: `${piece.tag_number}: ${input.note}`,
    sourceType: 'stock_piece', sourceId: pieceId,
    movements: [
      { ...base, direction: 'out', grossWeight: piece.gross_weight, netWeight: piece.net_weight, fineWeight: piece.fine_weight },
      { ...base, direction: 'in', grossWeight: input.grossWeight, netWeight: net, fineWeight: fine },
    ],
  });
  return tx.one(
    `update stock_piece set gross_weight = $2, stone_weight = $3, other_weight = $4, net_weight = $5, fine_weight = $6,
            updated_at = now(), updated_by = $7
      where id = $1 returning *`,
    [pieceId, input.grossWeight, stone, other, net, fine, tx.context.userId]);
}

/**
 * Closes a purchase lot. Anything not tagged — a weighing difference, a piece
 * that was not there — leaves stock on one tagging-difference adjustment.
 */
export async function closeLot(tx: Tx, lotId: string, note: string) {
  const lot = await tx.one<{ id: string; status: string; doc_number: string; branch_id: string; item_id: string; purity_id: string; location_id: string;
    pieces: number; gross: Decimal; net: Decimal; fine: Decimal; cost: Decimal }>(
    `select t.id, t.status, gr.doc_number, t.branch_id, t.item_id, t.purity_id, t.location_id,
            t.pieces_expected - t.pieces_tagged as pieces, t.gross_expected - t.gross_tagged as gross, t.net_expected - t.net_tagged as net,
            t.fine_expected - t.fine_tagged as fine, t.cost_value - t.cost_tagged as cost
       from tagging_lot t join goods_receipt_line gl on gl.id = t.goods_receipt_line_id join goods_receipt gr on gr.id = gl.goods_receipt_id
      where t.id = $1 for update of t`, [lotId]);
  if (lot.status !== 'open') throw new BusinessRuleError(`The lot from ${lot.doc_number} is already closed.`, 'lot_closed');
  if (lot.pieces > 0 || compare(lot.gross, '0') > 0 || compare(lot.net, '0') > 0) {
    await postAdjustment(tx, {
      branchId: lot.branch_id, reason: 'tagging_difference', note: `${lot.doc_number}: ${note}`, sourceType: 'tagging_lot', sourceId: lot.id,
      movements: [{ direction: 'out', tracking: 'piece', itemId: lot.item_id, purityId: lot.purity_id, locationId: lot.location_id,
        quantity: String(lot.pieces), grossWeight: lot.gross, netWeight: lot.net, fineWeight: lot.fine, value: lot.cost }],
    });
  }
  return tx.one(`update tagging_lot set status = 'closed', closed_at = now(), close_note = $2, updated_at = now() where id = $1 returning *`, [lotId, note]);
}

/** Tags pieces all-or-nothing: the first problem stops the batch and names the row. */
export async function tagAll(tx: Tx, inputs: TagPieceInput[], origin: TagOrigin, source?: { type: string; id: string }) {
  const { ready, errors } = await preparePieces(tx, inputs);
  if (errors.length) {
    const e = errors[0]!;
    throw new BusinessRuleError(inputs.length > 1 ? `Piece ${e.index + 1}: ${e.message}` : e.message, 'piece_invalid', { errors });
  }
  return tagPieces(tx, ready.map((r) => r.piece), origin, source);
}
