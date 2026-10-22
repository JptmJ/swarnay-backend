/**
 * Opening stock: what is in the showcase and the safe on the cut-over day.
 *
 * Pieces keep the tag numbers printed on them in the old software, so the
 * labels already hanging on the jewellery scan straight away, and their HUIDs.
 * They go in through the same tagging service as a piece tagged by hand —
 * stock movement, HUID record and opening voucher together — so the stock
 * screens, the valuation and the balance sheet agree from the first day.
 *
 * Bulk metal (lots) is counted in grams per item and purity, as the Stock
 * screen's own opening import does.
 */
import { z } from 'zod';
import type { Tx } from '../../../core/db/client.js';
import { compare, div, mul, round, sub, type Decimal } from '../../../core/util/decimal.js';
import { recordMovements, reverseMovementsFor } from '../../inventory/stock.service.js';
import { postStockValue } from '../../accounts/stock-posting.js';
import { HUID_PATTERN, preparePieces, tagPieces, tagPricingProblem, type TagMakingBasis, type TagPieceInput } from '../../tagging/tagging.service.js';
import type { ItemRow, PurityRow } from '../lookups.js';
import type { CommitResult, EntityDef, FieldDef, Issue, JobContext, LookupValue, PreparedRow } from '../types.js';
import {
  branchField, branchFor, bumpSeriesPast, locationField, locationFor, movedAtFor, postingHelp, postingOptions,
  reverseImportVouchers, undoneSuffix,
} from './shared.js';

const itemField: FieldDef = { key: 'item', label: 'Item', type: 'lookup', lookup: 'item', required: true,
  synonyms: ['item', 'item name', 'item code', 'product', 'product name', 'design', 'article', 'description', 'ornament'], example: 'Gold Ring 22K' };
const categoryField: FieldDef = { key: 'category', label: 'Category', type: 'lookup', lookup: 'category',
  synonyms: ['category', 'group', 'item group', 'product group'], description: 'Only used for items the import has to create.' };
const metalField: FieldDef = { key: 'metal', label: 'Metal', type: 'lookup', lookup: 'metal', synonyms: ['metal', 'metal type'] };
const purityField: FieldDef = { key: 'purity', label: 'Purity', type: 'lookup', lookup: 'purity', required: true,
  synonyms: ['purity', 'karat', 'carat', 'kt', 'touch', 'tunch', 'fineness', 'quality'], example: '22K' };

const createMissing = {
  key: 'createMissingItems', label: 'Make missing items',
  description: 'An item the file names that is not in the masters is created (with its category, if the file gives one). Off: such rows are refused.',
};

/** The item a stock row names, made if allowed, and its purity. */
async function itemAndPurity(
  tx: Tx, v: Record<string, unknown>, ctx: JobContext, issues: Issue[], rowNumber: number, tracking: 'piece' | 'lot',
): Promise<{ item: ItemRow; purity: PurityRow } | null> {
  const l = ctx.lookups;
  const itemText = v.item as LookupValue;
  let metalId: string | null = null;
  if (v.metal) {
    const m = l.metal(v.metal as LookupValue);
    if (m.kind !== 'found') { ctx.unknown('metal', (v.metal as LookupValue).text, rowNumber); issues.push({ level: 'error', field: 'metal', message: `Metal "${(v.metal as LookupValue).text}" is not one this shop deals in.` }); return null; }
    metalId = m.row.id;
  }
  const found = l.item(itemText);
  if (found.kind === 'ambiguous') {
    issues.push({ level: 'error', field: 'item', message: `"${itemText.text}" matches ${found.count} items: ${found.names.join(', ')}. Use the item code, or choose in the value panel.` });
    return null;
  }
  const purityText = v.purity as LookupValue;
  const pur = l.purity(purityText, found.kind === 'found' ? found.row.metal_id ?? metalId : metalId);
  if (pur.kind !== 'found') {
    ctx.unknown('purity', purityText.text, rowNumber);
    issues.push({ level: 'error', field: 'purity', message: pur.kind === 'ambiguous'
      ? `Purity "${purityText.text}" could be ${pur.names.join(' or ')}. Give the metal, or choose in the value panel.`
      : `Purity "${purityText.text}" is not set up in Masters → Purities.` });
    return null;
  }
  let item: ItemRow;
  if (found.kind === 'found') {
    item = found.row;
    if (!item.is_active) { issues.push({ level: 'error', field: 'item', message: `${item.name} is switched off in the masters.` }); return null; }
    if (item.tracking !== tracking) {
      issues.push({ level: 'error', field: 'item', message: tracking === 'piece'
        ? `${item.name} is kept by weight, not tagged. Bring it in with "Opening stock by weight".`
        : `${item.name} is tagged piece by piece. Bring it in with "Opening stock: tagged pieces".` });
      return null;
    }
    if (item.metal_id && item.metal_id !== pur.row.metal_id) {
      issues.push({ level: 'error', field: 'purity', message: `${pur.row.code} is a purity of a different metal than ${item.name}.` });
      return null;
    }
  } else if (ctx.options.createMissingItems) {
    let categoryId: string | null = null;
    if (v.category) {
      const cat = l.category(v.category as LookupValue);
      categoryId = cat.kind === 'found' ? cat.row.id : await l.ensureCategory(tx, ctx, (v.category as LookupValue).text);
    }
    item = await l.ensureItem(tx, ctx, { name: itemText.text, tracking, metalId: pur.row.metal_id, purityId: pur.row.id, categoryId });
  } else {
    ctx.unknown('item', itemText.text, rowNumber);
    issues.push({ level: 'error', field: 'item', message: `Item "${itemText.text}" is not in the masters. Import items first, or allow missing items to be made.` });
    return null;
  }
  return { item, purity: pur.row };
}

/* ================================================================= pieces */

interface PiecePlan { input: TagPieceInput; tag?: string }

export const openingPieces: EntityDef = {
  key: 'opening_pieces', label: 'Opening stock: tagged pieces', group: 'stock', order: 70, posts: true, chunk: 400,
  description: 'Every tagged piece in the showcase and the safe, one row each: item, purity, weights, HUID, tag number and cost. Old tag numbers are kept, so labels already on the jewellery scan as they are.',
  needs: ['item', 'category', 'metal', 'purity', 'branch', 'location', 'party'],
  options: z.object({
    ...postingOptions, createMissingItems: z.boolean().default(true), locationId: z.string().uuid().optional(),
  }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp, createMissing,
    { key: 'locationId', label: 'Stock location', description: 'Where pieces go when the row does not name a location. Defaults to the branch’s counter.' }],
  fields: [
    { key: 'tag_number', label: 'Tag number', type: 'code', synonyms: ['tag', 'tag no', 'tag number', 'barcode', 'label', 'tag id', 'sr no', 'piece no', 'stock no'],
      description: 'Kept exactly as printed. Blank takes the next number from Masters → Bill Numbers.' },
    itemField, purityField, metalField, categoryField,
    { key: 'gross_weight', label: 'Gross weight', type: 'weight', required: true, synonyms: ['gross', 'gross wt', 'gr wt', 'gwt', 'g wt', 'total weight', 'weight', 'wt'], example: '12.350' },
    { key: 'stone_weight', label: 'Stone weight', type: 'weight', synonyms: ['stone', 'stone wt', 'st wt', 'less', 'less wt', 'less weight', 'diamond wt', 'dia wt'] },
    { key: 'other_weight', label: 'Other weight', type: 'weight', synonyms: ['other wt', 'beads', 'moti wt', 'kundan wt', 'wax'] },
    { key: 'net_weight', label: 'Net weight', type: 'weight', synonyms: ['net', 'net wt', 'nwt', 'n wt', 'metal wt'], description: 'Checked against gross less stones. With no stone weight given, the difference is taken as stones.' },
    { key: 'stone_count', label: 'Stones (pieces)', type: 'int', synonyms: ['stone pcs', 'no of stones', 'stone count', 'dia pcs', 'pcs'] },
    { key: 'stone_value', label: 'Stone value', type: 'money', synonyms: ['stone amount', 'stone rate', 'stone value', 'diamond value', 'dia amt'] },
    { key: 'huid', label: 'HUID', type: 'code', synonyms: ['huid', 'huid no', 'hallmark id', 'hallmark uid', 'bis huid'] },
    { key: 'hallmark_centre', label: 'Hallmarking centre', type: 'text', synonyms: ['hallmark centre', 'ahc', 'hallmark center', 'assaying centre'] },
    { key: 'cost_value', label: 'Cost', type: 'money', synonyms: ['cost', 'cost value', 'purchase value', 'purchase amount', 'value', 'amount', 'stock value'] },
    { key: 'making_basis', label: 'Making charged', type: 'enum', synonyms: ['making type', 'mc type', 'labour type', 'making on'],
      options: [
        { value: 'per_gram', label: 'Per gram', synonyms: ['gram', 'per gm', 'pg', 'rate per gram', 'weight', '/g'] },
        { value: 'flat', label: 'Per piece', synonyms: ['piece', 'flat', 'fixed', 'per pc', 'lumpsum', 'lump sum'] },
        { value: 'percent', label: '% of metal', synonyms: ['percent', 'percentage', '%', 'pct'] },
      ] },
    { key: 'making_rate', label: 'Making rate', type: 'decimal', synonyms: ['making', 'mc', 'making charge', 'making charges', 'labour', 'labour rate', 'majuri'] },
    { key: 'wastage_percent', label: 'Wastage %', type: 'percent', synonyms: ['wastage', 'va', 'value addition', 'wastage %', 'westage'] },
    { key: 'supplier', label: 'Supplier', type: 'lookup', lookup: 'party', soft: true, synonyms: ['supplier', 'vendor', 'party', 'purchased from'] },
    branchField, locationField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<PiecePlan>[] = [];
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues }); continue; }
      const v = row.values;
      const label = `${v.tag_number ? `${v.tag_number} · ` : ''}${(v.item as LookupValue).text} · ${v.gross_weight} g`;

      // Weights: gross, less stones and other, is the metal. A net weight with no stone weight tells us the stones.
      const gross = v.gross_weight as Decimal;
      let stone = v.stone_weight as Decimal | undefined;
      const other = v.other_weight as Decimal | undefined;
      const net = v.net_weight as Decimal | undefined;
      if (!(compare(gross, '0') > 0)) issues.push({ level: 'error', field: 'gross_weight', message: 'Gross weight must be more than 0 g.' });
      if (net !== undefined) {
        if (compare(net, gross) > 0) issues.push({ level: 'error', field: 'net_weight', message: `Net weight ${net} g is more than the gross ${gross} g.` });
        else if (stone === undefined && other === undefined) stone = sub(gross, net);
        else {
          const expected = sub(sub(gross, stone ?? '0'), other ?? '0');
          if (Math.abs(Number(sub(expected, net))) > 0.005) {
            issues.push({ level: 'error', field: 'net_weight', message: `Gross ${gross} less stones ${stone ?? 0} and other ${other ?? 0} is ${expected} g, not the ${net} g given.` });
          }
        }
      }
      if (compare(sub(sub(gross, stone ?? '0'), other ?? '0'), '0') < 0) {
        issues.push({ level: 'error', field: 'stone_weight', message: 'Stones and other weight come to more than the gross weight.' });
      }

      const tag = v.tag_number as string | undefined;
      if (tag) {
        const first = ctx.seen.get(`tag:${tag}`);
        if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', field: 'tag_number', message: `Tag ${tag} is also on row ${first}.` });
        else ctx.seen.set(`tag:${tag}`, row.rowNumber);
      }
      let huid = v.huid as string | undefined;
      if (huid) {
        huid = huid.replace(/[\s-]/g, '');
        if (!HUID_PATTERN.test(huid)) {
          issues.push({ level: 'warning', field: 'huid', message: `HUID "${huid}" is not 6 letters or digits; left blank.` });
          huid = undefined;
        } else {
          const first = ctx.seen.get(`huid:${huid}`);
          if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', field: 'huid', message: `HUID ${huid} is also on row ${first}.` });
          else ctx.seen.set(`huid:${huid}`, row.rowNumber);
        }
      }
      let supplierId: string | undefined;
      if (v.supplier) {
        const s = ctx.lookups.party(v.supplier as LookupValue, { role: 'supplier' });
        if (s.kind === 'found') supplierId = s.row.id;
        else issues.push({ level: 'warning', field: 'supplier', message: `Supplier "${(v.supplier as LookupValue).text}" is not in the masters; left blank.` });
      }
      const pricing = { makingBasis: v.making_basis as TagMakingBasis | undefined, makingRate: v.making_rate as string | undefined, wastagePercent: v.wastage_percent as string | undefined };
      const pricingProblem = tagPricingProblem(pricing);
      if (pricingProblem) issues.push({ level: 'error', field: 'making_rate', message: pricingProblem });

      // Only a row that is otherwise sound gets its item looked up — and made, if missing — so a bad row never creates one.
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      const ip = await itemAndPurity(tx, v, ctx, issues, row.rowNumber, 'piece');
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      const location = branch ? locationFor(v, ctx, branch, 'counter', issues, row.rowNumber) : null;
      if (!ip || !location) { out.push({ row, action: 'insert', issues, label }); continue; }

      if (!issues.some((i) => i.level === 'error')) {
        const fine = round(div(mul(sub(sub(gross, stone ?? '0'), other ?? '0'), ip.purity.fineness), '100'), 3);
        ctx.total('pieces', '1'); ctx.total('gross_weight', gross); ctx.total('fine_weight', fine);
        if (v.cost_value) ctx.total('cost_value', v.cost_value as Decimal);
      }
      out.push({
        row, action: 'insert', issues, label,
        plan: {
          tag,
          input: {
            itemId: ip.item.id, purityId: ip.purity.id, locationId: location.id, grossWeight: gross,
            stoneWeight: stone, otherWeight: other, stoneCount: v.stone_count as number | undefined,
            stoneValue: v.stone_value as Decimal | undefined, huid, hallmarkCentre: v.hallmark_centre as string | undefined,
            costValue: v.cost_value as Decimal | undefined, supplierId, tagNumber: tag, ...pricing,
          },
        },
      });
    }

    // Tag numbers and HUIDs the shop already has, in one look.
    const tags = out.flatMap((p) => (p.plan?.tag ? [p.plan.tag] : []));
    const huids = out.flatMap((p) => (p.plan?.input.huid ? [p.plan.input.huid] : []));
    if (tags.length || huids.length) {
      const taken = await tx.one<{ tags: string[]; huids: string[] }>(
        `select (select coalesce(json_agg(tag_number), '[]') from stock_piece where tag_number = any($1::text[])) as tags,
                (select coalesce(json_agg(huid), '[]') from stock_piece where huid = any($2::text[]) and status not in ('melted', 'written_off')) as huids`,
        [tags, huids]);
      const usedTags = new Set(taken.tags);
      const usedHuids = new Set(taken.huids);
      for (const p of out) {
        if (p.plan?.tag && usedTags.has(p.plan.tag)) p.issues.push({ level: 'error', field: 'tag_number', message: `Tag ${p.plan.tag} is already on a piece in this shop.` });
        if (p.plan?.input.huid && usedHuids.has(p.plan.input.huid)) p.issues.push({ level: 'error', field: 'huid', message: `HUID ${p.plan.input.huid} is already on a piece in this shop.` });
      }
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const inputs = rows.map((r) => (r.plan as PiecePlan).input);
    const { ready, errors } = await preparePieces(tx, inputs, (i) => `row ${rows[i]!.row.rowNumber}`);
    const results: CommitResult[] = errors.map((e) => ({ rowId: rows[e.index]!.row.id, ok: false, issues: [{ level: 'error' as const, message: e.message }] }));
    const created = await tagPieces(tx, ready.map((r) => r.piece), 'opening', { type: 'data_import', id: ctx.batchId },
      { voucherDate: ctx.asOf, movedAt: movedAtFor(ctx) });
    created.forEach((piece, i) => {
      results.push({ rowId: rows[ready[i]!.index]!.row.id, ok: true, action: 'insert', targetTable: 'stock_piece', targetId: piece.id });
    });
    return results;
  },

  async finish(tx, ctx) {
    const tags = await tx.query<{ tag_number: string }>(
      `select p.tag_number from import_row r join stock_piece p on p.id = r.target_id
        where r.batch_id = $1 and r.status = 'imported'`, [ctx.batchId]);
    const note = await bumpSeriesPast(tx, 'tag', tags.map((t) => t.tag_number));
    return note ? [note] : [];
  },

  async canUndo(tx, rows, { batchId }) {
    const ids = rows.flatMap((r) => (r.target_id ? [r.target_id] : []));
    const moved = await tx.query<{ tag_number: string; status: string }>(
      `select p.tag_number, p.status from stock_piece p
        where p.id = any($1::uuid[])
          and (p.status <> 'in_stock' or p.reserved_order_id is not null
               or exists (select 1 from stock_movement m where m.piece_id = p.id
                           and not (m.source_type = 'data_import' and m.source_id = $2)))
        limit 6`, [ids, batchId]);
    if (!moved.length) return null;
    return `Some of these pieces have been sold, moved, booked or sent out since the import (${moved.slice(0, 5).map((m) => m.tag_number).join(', ')}${moved.length > 5 ? '…' : ''}). Undo those first, or correct the stock with an adjustment instead.`;
  },

  async undo(tx, rows, { batchId, reason }) {
    const ids = rows.flatMap((r) => (r.target_id ? [r.target_id] : []));
    await reverseMovementsFor(tx, 'data_import', batchId, reason);
    // The pieces stay in the history, written off; their tag numbers and HUIDs are freed for a corrected import.
    await tx.query(
      `update stock_piece set status = 'written_off', tag_number = tag_number || $2, updated_at = now() where id = any($1::uuid[])`,
      [ids, undoneSuffix(batchId)]);
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};

/* =================================================================== lots */

interface LotPlan { itemId: string; purityId: string; locationId: string; net: Decimal; gross: Decimal; fine: Decimal; cost: Decimal }

export const openingLots: EntityDef = {
  key: 'opening_lots', label: 'Opening stock by weight', group: 'stock', order: 80, posts: true, chunk: 500,
  description: 'Bulk metal and loose stock counted in grams — bars, fine gold, old gold waiting to melt, findings — one row per item and purity.',
  needs: ['item', 'category', 'metal', 'purity', 'branch', 'location'],
  options: z.object({
    ...postingOptions, createMissingItems: z.boolean().default(true), locationId: z.string().uuid().optional(),
  }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp, createMissing,
    { key: 'locationId', label: 'Stock location', description: 'Where lots go when the row does not name a location. Defaults to the branch’s vault.' }],
  fields: [
    itemField, purityField, metalField, categoryField,
    { key: 'net_weight', label: 'Net weight', type: 'weight', required: true, synonyms: ['net', 'net wt', 'weight', 'wt', 'grams', 'qty', 'quantity', 'balance', 'closing', 'closing weight', 'stock'], example: '250.000' },
    { key: 'gross_weight', label: 'Gross weight', type: 'weight', synonyms: ['gross', 'gross wt'] },
    { key: 'cost_value', label: 'Cost', type: 'money', synonyms: ['cost', 'value', 'amount', 'stock value', 'closing value'] },
    branchField, locationField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<LotPlan>[] = [];
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues }); continue; }
      const v = row.values;
      const ip = await itemAndPurity(tx, v, ctx, issues, row.rowNumber, 'lot');
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      const location = branch ? locationFor(v, ctx, branch, 'vault', issues, row.rowNumber) : null;
      const net = v.net_weight as Decimal;
      const gross = (v.gross_weight as Decimal | undefined) ?? net;
      const label = `${(v.item as LookupValue).text} · ${net} g`;
      if (!ip || !location) { out.push({ row, action: 'insert', issues, label }); continue; }
      if (!(compare(net, '0') > 0)) issues.push({ level: 'error', field: 'net_weight', message: 'Net weight must be more than 0 g.' });
      if (compare(gross, net) < 0) issues.push({ level: 'error', field: 'gross_weight', message: 'Gross weight is less than the net weight.' });
      const key = `lot:${ip.item.id}|${ip.purity.id}|${location.id}`;
      const first = ctx.seen.get(key);
      if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', message: `The same item, purity and location is on row ${first}. Add the two together into one row.` });
      else ctx.seen.set(key, row.rowNumber);
      const fine = round(div(mul(net, ip.purity.fineness), '100'), 3);
      if (!issues.some((i) => i.level === 'error')) {
        ctx.total('net_weight', net); ctx.total('fine_weight', fine);
        if (v.cost_value) ctx.total('cost_value', v.cost_value as Decimal);
      }
      out.push({ row, action: 'insert', issues, label,
        plan: { itemId: ip.item.id, purityId: ip.purity.id, locationId: location.id, net, gross, fine, cost: (v.cost_value as Decimal | undefined) ?? '0' } });
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const plans = rows.map((r) => r.plan as LotPlan);
    const movedAt = movedAtFor(ctx);
    const ids = await recordMovements(tx, plans.map((p, i) => ({
      direction: 'in' as const, reason: 'opening' as const, tracking: 'lot' as const, itemId: p.itemId, purityId: p.purityId,
      locationId: p.locationId, grossWeight: p.gross, netWeight: p.net, fineWeight: p.fine, value: p.cost,
      sourceType: 'data_import', sourceId: ctx.batchId, sourceLineId: rows[i]!.row.id, note: 'Opening stock (data import)',
      ...(movedAt ? { movedAt } : {}),
    })));
    await postStockValue(tx, {
      voucherType: 'opening', counterCode: '3900', sourceType: 'data_import', sourceId: ctx.batchId, voucherDate: ctx.asOf,
      narration: `Opening stock by weight, ${plans.length} line(s) — ${ctx.title}`,
      moves: plans.map((p) => ({ direction: 'in' as const, locationId: p.locationId, purityId: p.purityId, grossWeight: p.gross, fineWeight: p.fine, value: p.cost })),
    });
    return rows.map((r, i) => ({ rowId: r.row.id, ok: true, action: 'insert' as const, targetTable: 'stock_movement', targetId: ids[i] ?? null }));
  },

  async undo(tx, rows, { batchId, reason }) {
    // Strict: if the metal has been sold or used since, the reversal is refused rather than driving stock below zero.
    await reverseMovementsFor(tx, 'data_import', batchId, reason, true);
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};
