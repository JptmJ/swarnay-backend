/**
 * Stock & Tagging.
 *
 * Stock is what the books say is on the shelf: tagged pieces one by one, and
 * lots (bulk metal, findings) by weight. It comes in by tagging (and, later,
 * purchase), moves by transfers, and is corrected only by adjustments and
 * stock counts — never edited.
 */
import { z } from 'zod';
import { defineRoute, queryOf } from '../core/http/route-registry.js';
import { transaction, type Tx } from '../core/db/client.js';
import { recordAudit } from '../core/audit.js';
import { param } from '../core/http/middleware.js';
import { BusinessRuleError } from '../core/errors/app-error.js';
import { compare, div, mul } from '../core/util/decimal.js';
import { newId } from '../core/util/id.js';
import { rebuildBalances, recordMovements } from '../modules/inventory/stock.service.js';
import { adjustStock, MANUAL_REASONS } from '../modules/inventory/adjustment.service.js';
import { postStockValue } from '../modules/accounts/stock-posting.js';
import { cancelTransfer, dispatchTransfer, receiveTransfer } from '../modules/inventory/transfer.service.js';
import { cancelCount, countResult, postCount, removeCountLine, scanTags, startCount, weighLot } from '../modules/inventory/count.service.js';
import { assignHuid, correctPieceWeights, preparePieces, setPiecePricing, tagAll, tagPieces, type TagMakingBasis, type TagPieceInput } from '../modules/tagging/tagging.service.js';
import { PIECE_STATUSES, TAG_MAKING_BASES } from '../modules/inventory/inventory.schema.js';
import { defineCrud, decodeCursor, encodeCursor } from './crud.js';
import { errorEnvelope, idParam, record, uuid, weight, money, decimal, boolParam } from './schemas.js';

const DAY = '2026-09-29';
const added = (note: string) => [{ date: DAY, kind: 'added' as const, note }];
const cursorPage = z.object({
  cursor: z.string().optional().describe('From the previous page’s nextCursor.'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const page = (schema: z.ZodType) => z.object({ rows: z.array(schema), nextCursor: z.string().nullable() });

/** Newest first by id (ids are time-ordered), one extra row to know if there is more. */
async function newestFirst(tx: Tx, sql: (where: string, limit: string) => string, clauses: string[], params: unknown[], q: { cursor?: string; limit?: number }, alias: string) {
  const limit = Number(q.limit ?? 50);
  if (q.cursor) { params.push(decodeCursor(q.cursor).id); clauses.push(`${alias}.id < $${params.length}::uuid`); }
  params.push(limit + 1);
  const rows = await tx.query<Record<string, unknown> & { id: string }>(
    sql(clauses.length ? `where ${clauses.join(' and ')}` : '', `$${params.length}`), params);
  const more = rows.length > limit;
  if (more) rows.pop();
  return { rows, nextCursor: more ? encodeCursor(null, rows[rows.length - 1]!.id) : null };
}

/* ------------------------------------------------------------ summary */

defineRoute({
  method: 'get', path: '/api/stock/summary', module: 'stock',
  summary: 'Stock totals for the header cards',
  description: 'Per metal: pieces, gross, net and fine weight and cost value on hand (goods in transit excluded), plus the tag print queue (whole branch, and tagged by you), hallmarkable pieces without a HUID, transfers on the road to this branch and open counts.',
  permission: 'stock.view',
  query: z.object({ branchId: uuid.optional() }),
  responses: [{ status: 200, description: 'Totals.', schema: record }],
  changelog: added('One call for the Stock and Tagging headers.'),
  handler: async (req) => transaction(async (tx) => {
    const { branchId } = queryOf<{ branchId?: string }>(req);
    return tx.one(
      `select coalesce((select json_agg(t order by t.metal) from (
                select coalesce(m.name, 'Other') as metal,
                       sum(case when i.tracking = 'piece' then b.quantity else 0 end)::int as pieces,
                       sum(b.gross_weight) as gross_weight, sum(b.net_weight) as net_weight,
                       sum(b.fine_weight) as fine_weight, sum(b.value) as value
                  from stock_balance b join item i on i.id = b.item_id join stock_location l on l.id = b.location_id
                  left join metal m on m.id = i.metal_id
                 where l.kind <> 'transit' and (b.quantity <> 0 or b.net_weight <> 0) and ($1::uuid is null or l.branch_id = $1)
                 group by m.name) t), '[]') as metals,
              (select json_build_object('branch', count(*), 'mine', count(*) filter (where p.created_by = $2))
                 from stock_piece p join stock_location l on l.id = p.location_id
                where p.label_printed_at is null and p.status in ('in_stock', 'in_transit') and ($1::uuid is null or l.branch_id = $1)) as print_queue,
              (select count(*)::int from stock_piece p join stock_location l on l.id = p.location_id join purity pu on pu.id = p.purity_id
                where p.huid is null and p.status = 'in_stock' and pu.is_hallmarkable and ($1::uuid is null or l.branch_id = $1)) as awaiting_huid,
              (select count(*)::int from stock_transfer where status = 'in_transit' and ($1::uuid is null or to_branch_id = $1)) as in_transit,
              (select count(*)::int from stock_count where status = 'open' and ($1::uuid is null or branch_id = $1)) as open_counts`,
      [branchId ?? null, tx.context.userId]);
  }),
});

/* ------------------------------------------------------------- pieces */

const pieceSelect = `
  select p.id, p.tag_number, p.status, p.huid, p.gross_weight, p.stone_weight, p.other_weight, p.net_weight, p.fine_weight,
         p.stone_count, p.stone_cost, p.cost_value, p.making_basis, p.making_rate, p.wastage_percent, p.received_at, p.label_printed_at, p.label_print_count,
         p.item_id, i.code as item_code, i.name as item_name, c.name as category_name,
         p.purity_id, pu.code as purity_code, pu.metal_id, p.location_id, l.name as location_name, l.branch_id, b.name as branch_name,
         (current_date - p.received_at::date) as days_in_stock
    from stock_piece p join item i on i.id = p.item_id left join item_category c on c.id = i.category_id
    left join purity pu on pu.id = p.purity_id join stock_location l on l.id = p.location_id join branch b on b.id = l.branch_id`;

defineRoute({
  method: 'get', path: '/api/stock/pieces', module: 'stock',
  summary: 'Tagged pieces',
  description: 'Newest first, a page at a time. `search` matches tag number, HUID or item name. `unprinted=true` is the tag print queue; `mine=true` keeps pieces you tagged.',
  permission: 'stock.view',
  query: z.object({
    search: z.string().trim().optional(), status: z.enum(PIECE_STATUSES).optional(),
    branchId: uuid.optional(), locationId: uuid.optional(), itemId: uuid.optional(), purityId: uuid.optional(),
    unprinted: boolParam.optional(), mine: boolParam.optional(),
  }).merge(cursorPage),
  responses: [{ status: 200, description: 'Pieces.', schema: page(record) }],
  changelog: [{ date: DAY, kind: 'changed', note: 'Cursor pages; searches item name too; purity, unprinted and mine filters; category and print columns.' }],
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | boolean | undefined> & { cursor?: string; limit?: number }>(req);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.search) {
      params.push(`%${q.search}%`);
      clauses.push(`(p.tag_number ilike $${params.length} or p.huid ilike $${params.length} or p.item_id in (select id from item where name ilike $${params.length}))`);
    }
    for (const [key, col] of [['status', 'p.status'], ['locationId', 'p.location_id'], ['itemId', 'p.item_id'], ['purityId', 'p.purity_id'], ['branchId', 'l.branch_id']] as const) {
      if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
    }
    if (q.unprinted) clauses.push(`p.label_printed_at is null and p.status in ('in_stock', 'in_transit')`);
    if (q.mine) { params.push(tx.context.userId); clauses.push(`p.created_by = $${params.length}`); }
    return newestFirst(tx, (where, limit) => `${pieceSelect} ${where} order by p.id desc limit ${limit}`, clauses, params, q, 'p');
  }),
});

defineRoute({
  method: 'get', path: '/api/stock/pieces/:id', module: 'stock',
  summary: 'One piece with its history',
  description: 'The piece, every stock movement it made, and its HUID history.',
  permission: 'stock.view', params: idParam,
  responses: [{ status: 200, description: 'The piece.', schema: record }, { status: 404, description: 'Not found.', schema: errorEnvelope }],
  changelog: added('Piece detail for the side drawer.'),
  handler: async (req) => transaction(async (tx) => {
    const id = param(req, 'id');
    const [piece, movements, huids] = await Promise.all([
      tx.one(`${pieceSelect} where p.id = $1`, [id]),
      tx.query(`select sm.moved_at, sm.direction, sm.reason, sm.source_type, sm.note, l.name as location_name
                  from stock_movement sm join stock_location l on l.id = sm.location_id where sm.piece_id = $1 order by sm.moved_at, sm.id`, [id]),
      tx.query(`select huid, hallmark_centre_name, superseded_at, supersede_reason, created_at from huid_assignment where piece_id = $1 order by created_at`, [id]),
    ]);
    return { ...piece, movements, huids };
  }),
});

defineRoute({
  method: 'post', path: '/api/stock/pieces/:id/huid', module: 'tagging',
  summary: 'Add or replace a piece’s HUID',
  description: 'The old HUID is kept in the history as superseded.',
  permission: 'tagging.update', params: idParam,
  body: z.object({ huid: z.string().trim().min(1), hallmarkCentre: z.string().trim().optional() }),
  responses: [{ status: 200, description: 'Updated piece.', schema: record }, { status: 422, description: 'Bad format, taken, or not in stock.', schema: errorEnvelope }],
  changelog: added('HUID after hallmarking.'),
  handler: async (req) => transaction((tx) => assignHuid(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: '/api/stock/pieces/:id/weights', module: 'stock',
  summary: 'Correct a piece’s weights',
  description: 'For a weighing mistake. Posts a weighing-correction adjustment so stock follows. Owner and branch admin only.',
  permission: 'stock.adjustment.post', params: idParam,
  body: z.object({ grossWeight: weight, stoneWeight: weight.optional(), otherWeight: weight.optional(), note: z.string().trim().min(3).max(500) }),
  responses: [{ status: 200, description: 'Updated piece.', schema: record }, { status: 422, description: 'Not in stock or weights do not add up.', schema: errorEnvelope }],
  changelog: added('Re-weigh a piece.'),
  handler: async (req) => transaction((tx) => correctPieceWeights(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: '/api/stock/pieces/:id/pricing', module: 'stock',
  summary: 'Change the making and wastage on a tag',
  description: 'A repricing, or a mistake at tagging. Send nulls to hand the piece back to Masters → Formulas.',
  permission: 'tagging.create', params: idParam,
  body: z.object({ makingBasis: z.enum(TAG_MAKING_BASES).nullable(), makingRate: decimal.nullable(), wastagePercent: decimal.nullable() }),
  responses: [{ status: 200, description: 'Updated piece.', schema: record }, { status: 422, description: 'Not in stock, or making/wastage out of range.', schema: errorEnvelope }],
  changelog: [{ date: '2026-09-30', kind: 'added', note: 'Making and wastage on the tag.' }],
  handler: async (req) => transaction((tx) => setPiecePricing(tx, param(req, 'id'), req.body)),
});

/* ---------------------------------------------------- lots & journal */

defineRoute({
  method: 'get', path: '/api/stock/balances', module: 'stock',
  summary: 'Stock by item, purity and location',
  description: '`tracking=lot` is the Lots view: bulk metal and findings by weight, valued at average cost.',
  permission: 'stock.view',
  query: z.object({
    branchId: uuid.optional(), locationId: uuid.optional(), itemId: uuid.optional(),
    tracking: z.enum(['lot', 'piece']).optional(), search: z.string().trim().optional(),
  }),
  responses: [{ status: 200, description: 'Balances that are not zero.', schema: z.object({ rows: z.array(record) }) }],
  changelog: [{ date: DAY, kind: 'changed', note: 'tracking and search filters; zero rows are always left out.' }],
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | undefined>>(req);
    const clauses = ['(sb.quantity <> 0 or sb.net_weight <> 0)']; const params: unknown[] = [];
    for (const [key, col] of [['branchId', 'l.branch_id'], ['locationId', 'sb.location_id'], ['itemId', 'sb.item_id'], ['tracking', 'i.tracking']] as const) {
      if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
    }
    if (q.search) { params.push(`%${q.search}%`); clauses.push(`(i.name ilike $${params.length} or i.code ilike $${params.length})`); }
    return { rows: await tx.query(
      `select sb.item_id, i.code as item_code, i.name as item_name, i.tracking, sb.purity_id, p.code as purity_code,
              sb.location_id, l.name as location_name, l.kind as location_kind, l.branch_id, b.name as branch_name,
              sb.quantity, sb.gross_weight, sb.net_weight, sb.fine_weight, sb.value, sb.average_rate, sb.last_movement_at
         from stock_balance sb join item i on i.id = sb.item_id
         join stock_location l on l.id = sb.location_id join branch b on b.id = l.branch_id
         left join purity p on p.id = sb.purity_id
        where ${clauses.join(' and ')}
        order by b.name, l.name, i.name, p.code`, params) };
  }),
});

defineRoute({
  method: 'get', path: '/api/stock/movements', module: 'stock',
  summary: 'The stock journal',
  description: 'Append-only, newest first. This is how you answer “where did those 4 grams go”.',
  permission: 'stock.view',
  query: z.object({
    itemId: uuid.optional(), locationId: uuid.optional(), pieceId: uuid.optional(),
    sourceType: z.string().optional(), sourceId: uuid.optional(),
  }).merge(cursorPage),
  responses: [{ status: 200, description: 'Movements.', schema: page(record) }],
  changelog: [{ date: DAY, kind: 'changed', note: 'Cursor pages instead of a date range.' }],
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<Record<string, string | undefined> & { cursor?: string; limit?: number }>(req);
    const clauses: string[] = []; const params: unknown[] = [];
    for (const [key, col] of [['itemId', 'sm.item_id'], ['locationId', 'sm.location_id'], ['pieceId', 'sm.piece_id'],
      ['sourceType', 'sm.source_type'], ['sourceId', 'sm.source_id']] as const) {
      if (q[key]) { params.push(q[key]); clauses.push(`${col} = $${params.length}`); }
    }
    return newestFirst(tx, (where, limit) =>
      `select sm.*, i.name as item_name, pu.code as purity_code, l.name as location_name, sp.tag_number
         from stock_movement sm join item i on i.id = sm.item_id join stock_location l on l.id = sm.location_id
         left join purity pu on pu.id = sm.purity_id left join stock_piece sp on sp.id = sm.piece_id
        ${where} order by sm.id desc limit ${limit}`, clauses, params, q, 'sm');
  }),
});

defineRoute({
  method: 'post', path: '/api/stock/balances/rebuild', module: 'stock',
  summary: 'Rebuild balances from the journal',
  description: 'Recomputes every balance from stock_movement. Nothing should need this, which is why it exists.',
  permission: 'stock.adjustment.post',
  responses: [{ status: 200, description: 'Rebuilt.', schema: z.object({ ok: z.boolean(), rebuilt: z.number() }) }],
  changelog: [{ date: DAY, kind: 'changed', note: 'Needs stock.adjustment.post.' }],
  handler: async () => ({ ok: true, rebuilt: await transaction(rebuildBalances) }),
});

/* ------------------------------------------------------ opening stock */

const cell = (s: z.ZodType) => z.preprocess((v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/,/g, '').trim() || undefined : v), s);
const text = cell(z.string().optional());
const IMPORTS = {
  pieces: z.object({
    item_code: cell(z.string()), purity: cell(z.string()), gross_weight: cell(weight),
    stone_weight: cell(weight.optional()), other_weight: cell(weight.optional()),
    stone_count: cell(z.coerce.number().int().min(0).optional()), huid: text, hallmark_centre: text,
    tag_number: text, cost_value: cell(money.optional()),
    making_basis: cell(z.enum(TAG_MAKING_BASES).optional()), making_rate: cell(decimal.optional()), wastage_percent: cell(decimal.optional()),
  }),
  lots: z.object({
    item_code: cell(z.string()), purity: cell(z.string()), net_weight: cell(weight),
    gross_weight: cell(weight.optional()), cost_value: cell(money.optional()),
  }),
};

defineRoute({
  method: 'post', path: '/api/stock/import/:kind', module: 'stock',
  summary: 'Opening stock in bulk',
  description:
    'kind: pieces (one row per tagged piece; blank tag_number takes the next tag) or lots (one row per item + purity, by weight). Every row goes into `locationId`. Up to 1,000 rows a call; good rows are saved, bad ones come back with their spreadsheet row. Items and purities are named by code.',
  permission: 'stock.opening.create',
  params: z.object({ kind: z.enum(['pieces', 'lots']) }),
  body: z.object({
    locationId: uuid,
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
    firstRow: z.number().int().min(1).default(2).describe('Spreadsheet row of rows[0].'),
  }),
  responses: [{ status: 200, description: 'What happened to each row.', schema: z.object({
    received: z.number(), inserted: z.number(), failed: z.array(z.object({ row: z.number(), message: z.string() })),
  }) }],
  changelog: added('Opening stock import for pieces and lots.'),
  handler: async (req) => transaction(async (tx) => {
    const kind = param(req, 'kind') as keyof typeof IMPORTS;
    const { locationId, rows, firstRow } = req.body as { locationId: string; rows: Record<string, unknown>[]; firstRow: number };
    const location = await tx.maybeOne(`select 1 from stock_location where id = $1 and is_active and deleted_at is null and kind <> 'transit'`, [locationId]);
    if (!location) throw new BusinessRuleError('Pick an active stock location.', 'not_found');
    const [items, purities] = await Promise.all([
      tx.query<{ code: string; id: string; tracking: string; metal_id: string | null; name: string }>(`select upper(code) as code, id, tracking, metal_id, name from item where deleted_at is null and is_active`),
      tx.query<{ code: string; id: string; metal_id: string; fineness: string }>(`select upper(code) as code, id, metal_id, fineness_percent as fineness from purity where is_active`),
    ]);
    const itemByCode = new Map(items.map((i) => [i.code, i]));
    const failed: { row: number; message: string }[] = [];
    const parsed: { row: number; data: Record<string, string | number | undefined>; item: (typeof items)[number]; purity: (typeof purities)[number] }[] = [];
    rows.forEach((raw, i) => {
      const row = firstRow + i;
      const r = IMPORTS[kind].safeParse(raw);
      if (!r.success) { const issue = r.error.issues[0]!; return failed.push({ row, message: `${issue.path.join('.') || 'row'}: ${issue.message}` }); }
      const data = r.data as Record<string, string | number | undefined>;
      const item = itemByCode.get(String(data.item_code).toUpperCase());
      if (!item) return failed.push({ row, message: `Item "${data.item_code}" does not exist.` });
      const purity = purities.find((p) => p.code === String(data.purity).toUpperCase() && (!item.metal_id || p.metal_id === item.metal_id));
      if (!purity) return failed.push({ row, message: `Purity "${data.purity}" does not exist for ${item.name}.` });
      parsed.push({ row, data, item, purity });
    });

    let inserted = 0;
    if (kind === 'pieces') {
      const inputs: TagPieceInput[] = parsed.map(({ data, item, purity }) => ({
        itemId: item.id, purityId: purity.id, locationId, grossWeight: String(data.gross_weight),
        stoneWeight: data.stone_weight as string | undefined, otherWeight: data.other_weight as string | undefined,
        stoneCount: data.stone_count as number | undefined, huid: data.huid as string | undefined,
        hallmarkCentre: data.hallmark_centre as string | undefined, tagNumber: data.tag_number as string | undefined,
        costValue: data.cost_value as string | undefined,
        makingBasis: data.making_basis as TagMakingBasis | undefined, makingRate: data.making_rate as string | undefined,
        wastagePercent: data.wastage_percent as string | undefined,
      }));
      const { ready, errors } = await preparePieces(tx, inputs, (i) => `row ${parsed[i]!.row}`);
      errors.forEach((e) => failed.push({ row: parsed[e.index]!.row, message: e.message }));
      inserted = (await tagPieces(tx, ready.map((r) => r.piece), 'opening')).length;
    } else {
      const good = parsed.filter(({ row, data, item }) => {
        if (item.tracking !== 'lot') return !failed.push({ row, message: `${item.name} is tagged piece by piece — use the pieces import.` });
        if (!(compare(String(data.net_weight), '0') > 0)) return !failed.push({ row, message: 'net_weight must be more than 0.' });
        return true;
      });
      const sourceId = newId();
      await recordMovements(tx, good.map(({ data, item, purity }) => ({
        direction: 'in' as const, reason: 'opening' as const, tracking: 'lot' as const, itemId: item.id, purityId: purity.id, locationId,
        grossWeight: String(data.gross_weight ?? data.net_weight), netWeight: String(data.net_weight),
        fineWeight: div(mul(String(data.net_weight), purity.fineness), '100'), value: String(data.cost_value ?? '0'),
        sourceType: 'stock_opening', sourceId, note: 'Opening stock',
      })));
      await postStockValue(tx, {
        voucherType: 'opening', counterCode: '3900', sourceType: 'stock_opening', sourceId, narration: `Opening stock, ${good.length} lot line(s)`,
        moves: good.map(({ data, purity }) => ({ direction: 'in' as const, locationId, purityId: purity.id,
          grossWeight: String(data.gross_weight ?? data.net_weight), fineWeight: div(mul(String(data.net_weight), purity.fineness), '100'),
          value: String(data.cost_value ?? '0') })),
      });
      inserted = good.length;
    }
    await recordAudit(tx, `stock.import.${kind}`, 'stock_location', locationId, { received: rows.length, inserted, failed: failed.length, firstRow });
    return { received: rows.length, inserted, failed: failed.sort((a, b) => a.row - b.row) };
  }),
});

/* ---------------------------------------------------------- transfers */

const transferSelect = `
  select t.*, fb.name as from_branch_name, fl.name as from_location_name, tb.name as to_branch_name, tl.name as to_location_name
    from stock_transfer t join branch fb on fb.id = t.from_branch_id join stock_location fl on fl.id = t.from_location_id
    join branch tb on tb.id = t.to_branch_id join stock_location tl on tl.id = t.to_location_id`;
const lotLine = z.object({ itemId: uuid, purityId: uuid, netWeight: weight, grossWeight: weight.optional() });

defineRoute({
  method: 'get', path: '/api/stock/transfers', module: 'stock',
  summary: 'Transfers',
  description: '`branchId` matches either end.',
  permission: 'stock.view',
  query: z.object({ status: z.enum(['in_transit', 'received', 'cancelled']).optional(), branchId: uuid.optional() }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page(record) }],
  changelog: added('Transfer register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<{ status?: string; branchId?: string; cursor?: string; limit?: number }>(req);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.status) { params.push(q.status); clauses.push(`t.status = $${params.length}`); }
    if (q.branchId) { params.push(q.branchId); clauses.push(`(t.from_branch_id = $${params.length} or t.to_branch_id = $${params.length})`); }
    return newestFirst(tx, (where, limit) => `${transferSelect} ${where} order by t.id desc limit ${limit}`, clauses, params, q, 't');
  }),
});

defineRoute({
  method: 'get', path: '/api/stock/transfers/:id', module: 'stock',
  summary: 'One transfer with its lines',
  permission: 'stock.view', params: idParam,
  responses: [{ status: 200, description: 'The transfer.', schema: record }],
  changelog: added('Transfer detail.'),
  handler: async (req) => transaction(async (tx) => {
    const id = param(req, 'id');
    const [transfer, lines] = await Promise.all([
      tx.one(`${transferSelect} where t.id = $1`, [id]),
      tx.query(`select tl.*, i.name as item_name, pu.code as purity_code, sp.tag_number
                  from stock_transfer_line tl join item i on i.id = tl.item_id left join purity pu on pu.id = tl.purity_id
                  left join stock_piece sp on sp.id = tl.piece_id where tl.stock_transfer_id = $1 order by sp.tag_number, i.name`, [id]),
    ]);
    return { ...transfer, lines };
  }),
});

defineRoute({
  method: 'post', path: '/api/stock/transfers', module: 'stock',
  summary: 'Send stock to another location',
  description: 'Inside a branch it completes at once. To another branch it stays in transit until that branch receives it.',
  permission: 'stock.transfer.create',
  body: z.object({
    fromLocationId: uuid, toLocationId: uuid,
    pieceIds: z.array(uuid).max(2000).optional(), lots: z.array(lotLine).max(200).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  responses: [{ status: 201, description: 'The transfer.', schema: record }, { status: 422, description: 'Piece not at that location, or not enough of a lot.', schema: errorEnvelope }],
  changelog: added('Two-step branch transfers.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => dispatchTransfer(tx, req.body))); },
});

defineRoute({
  method: 'post', path: '/api/stock/transfers/:id/receive', module: 'stock',
  summary: 'Receive a transfer', description: 'The receiving branch confirms the goods arrived.',
  permission: 'stock.transfer.post', params: idParam,
  responses: [{ status: 200, description: 'Received.', schema: record }, { status: 422, description: 'Not in transit.', schema: errorEnvelope }],
  changelog: added('Receive.'),
  handler: async (req) => transaction((tx) => receiveTransfer(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: '/api/stock/transfers/:id/cancel', module: 'stock',
  summary: 'Cancel a transfer on the road', description: 'The goods go back to where they were sent from.',
  permission: 'stock.transfer.cancel', params: idParam,
  responses: [{ status: 200, description: 'Cancelled.', schema: record }, { status: 422, description: 'Not in transit.', schema: errorEnvelope }],
  changelog: added('Cancel.'),
  handler: async (req) => transaction((tx) => cancelTransfer(tx, param(req, 'id'))),
});

/* -------------------------------------------------------- adjustments */

defineRoute({
  method: 'get', path: '/api/stock/adjustments', module: 'stock',
  summary: 'Adjustments',
  permission: 'stock.view',
  query: z.object({ branchId: uuid.optional() }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page(record) }],
  changelog: added('Adjustment register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<{ branchId?: string; cursor?: string; limit?: number }>(req);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.branchId) { params.push(q.branchId); clauses.push(`a.branch_id = $${params.length}`); }
    return newestFirst(tx, (where, limit) =>
      `select a.*, b.name as branch_name, u.full_name as created_by_name
         from stock_adjustment a join branch b on b.id = a.branch_id left join app_user u on u.id = a.created_by
        ${where} order by a.id desc limit ${limit}`, clauses, params, q, 'a');
  }),
});

defineRoute({
  method: 'post', path: '/api/stock/adjustments', module: 'stock',
  summary: 'Adjust stock',
  description: 'shortage, damage, loss and write_off take pieces (written off) and lot weight out; found adds lot weight. One branch per adjustment, a note is required, and it cannot be edited. Owner and branch admin only.',
  permission: 'stock.adjustment.post',
  body: z.object({
    reason: z.enum(MANUAL_REASONS), note: z.string().trim().min(3).max(500),
    pieceIds: z.array(uuid).max(1000).optional(), lots: z.array(lotLine.extend({ locationId: uuid })).max(200).optional(),
  }),
  responses: [{ status: 201, description: 'Posted.', schema: record }, { status: 422, description: 'Piece not in stock, not enough of a lot, or two branches.', schema: errorEnvelope }],
  changelog: added('Manual adjustments with a reason.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => adjustStock(tx, req.body))); },
});

/* -------------------------------------------------------- stock count */

defineRoute({
  method: 'get', path: '/api/stock/counts', module: 'stock',
  summary: 'Stock counts',
  permission: 'stock.view',
  query: z.object({ branchId: uuid.optional(), status: z.enum(['open', 'posted', 'cancelled']).optional() }).merge(cursorPage),
  responses: [{ status: 200, description: 'Newest first.', schema: page(record) }],
  changelog: added('Count register.'),
  handler: async (req) => transaction(async (tx) => {
    const q = queryOf<{ branchId?: string; status?: string; cursor?: string; limit?: number }>(req);
    const clauses: string[] = []; const params: unknown[] = [];
    if (q.branchId) { params.push(q.branchId); clauses.push(`c.branch_id = $${params.length}`); }
    if (q.status) { params.push(q.status); clauses.push(`c.status = $${params.length}`); }
    return newestFirst(tx, (where, limit) =>
      `select c.*, l.name as location_name, b.name as branch_name,
              (select count(*)::int from stock_count_line x where x.stock_count_id = c.id) as lines
         from stock_count c join stock_location l on l.id = c.location_id join branch b on b.id = c.branch_id
        ${where} order by c.id desc limit ${limit}`, clauses, params, q, 'c');
  }),
});

defineRoute({
  method: 'post', path: '/api/stock/counts', module: 'stock',
  summary: 'Start counting a location',
  permission: 'stock.count.create',
  body: z.object({ locationId: uuid, note: z.string().trim().max(500).optional() }),
  responses: [{ status: 201, description: 'The count.', schema: record }, { status: 422, description: 'Already being counted.', schema: errorEnvelope }],
  changelog: added('Start a count.'),
  handler: async (req, res) => { res.status(201).json(await transaction((tx) => startCount(tx, req.body))); },
});

defineRoute({
  method: 'get', path: '/api/stock/counts/:id', module: 'stock',
  summary: 'A count against the books',
  description: 'Every piece as found, missing, elsewhere or unknown; every lot with book and counted weight.',
  permission: 'stock.view', params: idParam,
  responses: [{ status: 200, description: 'The count.', schema: record }],
  changelog: added('Count result.'),
  handler: async (req) => transaction((tx) => countResult(tx, param(req, 'id'))),
});

defineRoute({
  method: 'post', path: '/api/stock/counts/:id/scan', module: 'stock',
  summary: 'Scan tags',
  description: 'Send one tag per scan, or many pasted at once. A tag already scanned is ignored.',
  permission: 'stock.count.create', params: idParam,
  body: z.object({ tags: z.array(z.string().trim().min(1).max(60)).min(1).max(2000) }),
  responses: [{ status: 200, description: 'What each tag turned out to be.', schema: z.object({ rows: z.array(record) }) }],
  changelog: added('Scan.'),
  handler: async (req) => transaction(async (tx) => ({ rows: await scanTags(tx, param(req, 'id'), req.body.tags) })),
});

defineRoute({
  method: 'post', path: '/api/stock/counts/:id/lots', module: 'stock',
  summary: 'Record a lot’s weight on the scale',
  permission: 'stock.count.create', params: idParam,
  body: z.object({ itemId: uuid, purityId: uuid, netWeight: weight }),
  responses: [{ status: 200, description: 'The line.', schema: record }],
  changelog: added('Weigh a lot.'),
  handler: async (req) => transaction((tx) => weighLot(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'delete', path: '/api/stock/counts/:id/lines/:lineId', module: 'stock',
  summary: 'Remove a scanned tag or weighed lot',
  permission: 'stock.count.create', params: z.object({ id: uuid, lineId: uuid }),
  responses: [{ status: 204, description: 'Removed.' }],
  changelog: added('Undo a scan.'),
  handler: async (req, res) => { await transaction((tx) => removeCountLine(tx, param(req, 'id'), param(req, 'lineId'))); res.status(204).end(); },
});

defineRoute({
  method: 'post', path: '/api/stock/counts/:id/post', module: 'stock',
  summary: 'Post a count',
  description: 'Moves pieces found here from other locations of the branch, sets weighed lots to the scale weight, and writes off missing pieces only if `writeOffMissing`. One stock-count adjustment. Owner and branch admin only.',
  permission: 'stock.count.post', params: idParam,
  body: z.object({ writeOffMissing: z.boolean().default(false), note: z.string().trim().min(3).max(500) }),
  responses: [{ status: 200, description: 'Posted.', schema: record }, { status: 422, description: 'Not open.', schema: errorEnvelope }],
  changelog: added('Post a count.'),
  handler: async (req) => transaction((tx) => postCount(tx, param(req, 'id'), req.body)),
});

defineRoute({
  method: 'post', path: '/api/stock/counts/:id/cancel', module: 'stock',
  summary: 'Cancel a count', description: 'Nothing changes in stock.',
  permission: 'stock.count.create', params: idParam,
  responses: [{ status: 200, description: 'Cancelled.', schema: record }],
  changelog: added('Cancel a count.'),
  handler: async (req) => transaction((tx) => cancelCount(tx, param(req, 'id'))),
});

/* ------------------------------------------------------------ tagging */

const pieceInput = z.object({
  itemId: uuid, purityId: uuid, locationId: uuid,
  grossWeight: weight.describe('As on the scale.'), stoneWeight: weight.optional(), otherWeight: weight.optional(),
  stoneCount: z.number().int().min(0).optional(), stoneValue: money.optional(),
  huid: z.string().trim().optional(), hallmarkCentre: z.string().trim().optional(),
  costValue: money.optional(), makingCost: money.optional(), supplierId: uuid.optional(),
  tagNumber: z.string().trim().max(40).optional().describe('Leave out to take the next tag number.'),
  makingBasis: z.enum(TAG_MAKING_BASES).optional().describe('How the tag’s making is charged. With makingRate it wins over Masters → Formulas.'),
  makingRate: decimal.optional().describe('₹/g, ₹/piece, or % of metal value.'),
  wastagePercent: decimal.optional().describe('% of net weight charged as extra metal. Blank uses the formula.'),
  taggingLotId: uuid.optional().describe('A purchase lot waiting in Tagging: the piece takes its location, supplier and a share of its cost.'),
});

defineRoute({
  method: 'post', path: '/api/tagging/pieces', module: 'tagging',
  summary: 'Tag pieces',
  description: 'Creates the pieces, their HUID records and their opening stock, all or nothing. The pieces join the tag print queue.',
  permission: 'tagging.create',
  body: z.object({ pieces: z.array(pieceInput).min(1).max(200) }),
  responses: [
    { status: 201, description: 'Tagged pieces, in the order sent.', schema: z.object({ rows: z.array(record) }) },
    { status: 422, description: 'A piece is invalid; `details.errors` lists each by index.', schema: errorEnvelope },
  ],
  changelog: [{ date: DAY, kind: 'changed', note: 'Takes a batch of pieces; HUIDs and tag numbers are checked for duplicates; origin removed (purchase will tag its own).' }],
  handler: async (req, res) => {
    const rows = await transaction((tx) => tagAll(tx, req.body.pieces, 'opening'));
    res.status(201).json({ rows });
  },
});

defineRoute({
  method: 'post', path: '/api/tagging/print', module: 'tagging',
  summary: 'Print tags',
  description: 'Logs the print against the design used, takes the pieces out of the print queue, and returns the values for each label. The browser draws and prints them. A queue print refuses pieces already printed (someone else printed them a moment ago) and names who and when; `reprint: true` prints a tag again on purpose.',
  permission: 'tagging.create',
  body: z.object({ templateId: uuid, pieceIds: z.array(uuid).min(1).max(500), reprint: z.boolean().default(false) }),
  responses: [
    { status: 200, description: 'Label values keyed like the designer’s fields.', schema: z.object({ jobId: uuid, labels: z.array(record) }) },
    { status: 422, description: '`tag_already_printed`: `details.tags` lists them. Nothing is printed.', schema: errorEnvelope },
  ],
  changelog: [...added('Browser tag printing.'), { date: DAY, kind: 'changed', note: 'Queue prints can no longer print a tag twice; reprint is explicit.' }],
  handler: async (req) => transaction(async (tx) => {
    const { templateId, pieceIds, reprint } = req.body as { templateId: string; pieceIds: string[]; reprint: boolean };
    // Claim the pieces first. Of two people printing the same tag at once, the second waits here and is then refused.
    const claimed = await tx.query<{ id: string }>(
      `update stock_piece set label_printed_at = now(), label_print_count = label_print_count + 1
        where id = any($1::uuid[]) ${reprint ? '' : 'and label_printed_at is null'} returning id`, [pieceIds]);
    if (claimed.length < pieceIds.length) {
      const got = new Set(claimed.map((r) => r.id));
      const taken = await tx.query<{ tag_number: string; by: string | null; at: string }>(
        `select p.tag_number, u.full_name as by, to_char(p.label_printed_at at time zone t.timezone, 'DD Mon HH24:MI') as at
           from stock_piece p join tenant t on t.id = p.tenant_id
           left join lateral (select j.queued_by from tag_print_job_item x join tag_print_job j on j.id = x.tag_print_job_id
                               where x.piece_id = p.id order by j.printed_at desc limit 1) last on true
           left join app_user u on u.id = last.queued_by
          where p.id = any($1::uuid[]) order by p.tag_number`, [pieceIds.filter((id) => !got.has(id))]);
      if (taken.length === 0) throw new BusinessRuleError('Some of those pieces do not exist.', 'not_found');
      throw new BusinessRuleError(
        `Already printed: ${taken.map((p) => `${p.tag_number} by ${p.by ?? 'someone'} at ${p.at}`).join(', ')}. Nothing was printed — refresh the queue; to print one again, use Print Tag on the piece in Stock.`,
        'tag_already_printed', { tags: taken.map((p) => p.tag_number) });
    }
    const labels = await tx.query<{ pieceId: string; branchId: string; tag: object; item: object; branch: object }>(
      `select p.id as "pieceId", l.branch_id as "branchId",
              json_build_object('id', p.tag_number, 'barcode', p.tag_number, 'qrCode', p.tag_number) as tag,
              json_build_object('grossWeightG', p.gross_weight, 'stoneWeightG', p.stone_weight, 'netWeightG', p.net_weight,
                                'purity', pu.code, 'huid', coalesce(p.huid, ''), 'category', coalesce(c.name, i.name), 'name', i.name) as item,
              json_build_object('shortName', b.code, 'name', b.name, 'phone', coalesce(b.phone, '')) as branch
         from stock_piece p join item i on i.id = p.item_id left join item_category c on c.id = i.category_id
         left join purity pu on pu.id = p.purity_id join stock_location l on l.id = p.location_id join branch b on b.id = l.branch_id
        where p.id = any($1::uuid[]) order by p.tag_number`, [pieceIds]);
    const job = await tx.one<{ id: string }>(
      `insert into tag_print_job (id, tenant_id, tag_template_id, branch_id, status, piece_count, queued_by, printed_at, created_by, updated_by)
       values ($1, $2, $3, $4, 'printed', $5, $6, now(), $6, $6) returning id`,
      [newId(), tx.context.tenantId, templateId, labels[0]!.branchId, labels.length, tx.context.userId]);
    await tx.query(
      `insert into tag_print_job_item (id, tenant_id, tag_print_job_id, piece_id, rendered_payload, printed, created_by, updated_by)
       select gen_random_uuid(), $1, $2, x.piece_id, x.payload, true, $3, $3
         from jsonb_to_recordset($4::jsonb) as x(piece_id uuid, payload jsonb)`,
      [tx.context.tenantId, job.id, tx.context.userId, JSON.stringify(labels.map((l) => ({ piece_id: l.pieceId, payload: { tag: l.tag, item: l.item, branch: l.branch } })))]);
    return { jobId: job.id, labels: labels.map(({ branchId: _, ...l }) => l) };
  }),
});

/* Tag designs: saved from Settings → Format & Print Designer, chosen when printing. */
const oneDefault = async (tx: Tx, values: Record<string, unknown>, id?: unknown) => {
  if (values.is_default) await tx.query(`update tag_template set is_default = false where is_default and id is distinct from $1`, [id ?? null]);
  // jsonb goes in as text: pg would send a JS array as a Postgres array.
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, k === 'page' || k === 'bindings' ? JSON.stringify(v) : v]));
};
const templateShape = {
  name: z.string().trim().min(1).max(100),
  page: z.record(z.string(), z.unknown()).describe('Size and margins in mm, as the designer keeps them.'),
  canvas_json: z.string().max(2_000_000).describe('The Fabric canvas.'),
  bindings: z.array(z.record(z.string(), z.unknown())).describe('Which field each text object prints.'),
  is_default: z.boolean().optional(), is_active: z.boolean().optional(),
};
defineCrud({
  resource: 'templates', basePath: '/api/tagging', table: 'tag_template', module: 'tagging', label: 'tag design',
  permission: 'tagging.template',
  createSchema: z.object({ code: z.string().trim().min(1).max(60), ...templateShape }),
  updateSchema: z.object(templateShape).partial(),
  defaultOrder: 'is_default desc, name',
  changelog: added('Tag designs shared by the designer and printing.'),
  hooks: { beforeCreate: (tx, v) => oneDefault(tx, v), beforeUpdate: (tx, v, current) => oneDefault(tx, v, current.id) },
});
