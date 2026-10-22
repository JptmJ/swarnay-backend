/**
 * Module 3 — Stock.
 *
 * The model is a journal, not a set of counters. Nothing ever writes "the
 * balance is now X"; every change appends a row to `stock_movement` saying what
 * moved, and the balance is the sum of those rows. `stock_balance` is a cache
 * of that sum, updated in the same transaction, and it can always be rebuilt
 * from the journal if it ever disagrees.
 *
 * That choice is what makes "why is 4 grams missing?" answerable at 9pm on a
 * Saturday, which in this trade is the question that actually gets asked.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

/** How the making written on a tag is charged: per gram of metal, per piece, or a % of the metal value. */
export const TAG_MAKING_BASES = ['per_gram', 'flat', 'percent'] as const;

export const PIECE_STATUSES = [
  'in_stock',
  'on_memo',
  'sold',
  'in_transit',
  'with_karigar',
  'in_repair',
  'melted',
  'written_off',
] as const;

export const stockPieceTable = defineTable({
  name: 'stock_piece',
  module: 'inventory',
  comment: 'One row per physically tagged item. Only used by items with tracking = piece.',
  columns: {
    tag_number: col.text({ notNull: true, comment: 'What is printed on the label.' }),
    item_id: col.fk('item', { notNull: true }),
    purity_id: col.fk('purity'),
    location_id: col.fk('stock_location', { notNull: true }),
    status: col.enum(PIECE_STATUSES, { notNull: true, default: "'in_stock'" }),

    /** Weights, all in grams. gross = net metal + stones + findings. */
    gross_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true, default: '0', comment: 'Metal only — what purity applies to.' }),
    stone_weight: col.weight({ notNull: true, default: '0' }),
    other_weight: col.weight({ notNull: true, default: '0' }),
    fine_weight: col.weight({ notNull: true, default: '0', comment: 'net_weight x purity — the pure metal content.' }),

    stone_count: col.int(),
    /** Hallmarking Unique ID — six characters, mandatory on hallmarked pieces. */
    huid: col.text(),
    hallmark_centre: col.text(),

    /** What this piece cost to acquire or make. Drives valuation and margin. */
    cost_value: col.money({ notNull: true, default: '0' }),
    making_cost: col.money({ notNull: true, default: '0' }),
    stone_cost: col.money({ notNull: true, default: '0' }),

    /** Selling terms written on the tag. When set they win over Masters → Formulas at the counter; blank means the formula applies. */
    making_basis: col.enum(TAG_MAKING_BASES),
    making_rate: col.rate({ comment: '₹/g, ₹/piece or % of metal value, per making_basis.' }),
    wastage_percent: col.rate({ comment: '% of net weight charged as extra metal at the day rate.' }),

    design_id: col.uuid({ comment: 'Filled in once Module 2 exists.' }),
    supplier_id: col.fk('party'),
    received_at: col.timestamptz({ notNull: true, default: 'now()' }),
    sold_at: col.timestamptz(),
    /** Days in stock is the single most useful retail number; derived from received_at. */
    image_urls: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    attributes: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    /** The purchase lot this piece was tagged from, which says whose it was and on what terms. */
    tagging_lot_id: col.fk('tagging_lot'),
    /** Null = still in the print queue. */
    label_printed_at: col.timestamptz(),
    label_print_count: col.int({ notNull: true, default: '0' }),
    /**
     * Booked on a customer's order. The piece stays in stock — the shop still
     * owns it and it is still counted and valued — but it is promised, so it
     * cannot be booked again and the counter will only bill it to that order.
     */
    reserved_order_id: col.fk('retail_order'),
    reserved_at: col.timestamptz(),
  },
  uniques: [{ columns: ['tag_number'] }],
  indexes: [
    { columns: ['id'] },
    { columns: ['item_id'] },
    { columns: ['location_id', 'status'] },
    // One HUID per piece in stock. A melted or written-off piece releases its HUID.
    { name: 'ux_stock_piece_huid', columns: ['huid'], unique: true, where: "huid is not null and status not in ('melted', 'written_off')" },
    { columns: ['status', 'received_at'] },
    { columns: ['reserved_order_id'], where: 'reserved_order_id is not null' },
    { columns: ['id'], name: 'ix_stock_piece_print_queue', where: 'label_printed_at is null' },
    // Search as you type on tag number and HUID. Global for the same reason as party's: RLS still filters.
    { name: 'gx_stock_piece_tag_trgm', columns: ['tag_number'], method: 'gin', opclass: 'gin_trgm_ops', global: true },
    { name: 'gx_stock_piece_huid_trgm', columns: ['huid'], method: 'gin', opclass: 'gin_trgm_ops', global: true },
  ],
});

/**
 * Pieces bought but not yet tagged — "12 rings, 84.500 g" from one inward line.
 * Their weight and cost are already in stock (the inward raised them); Tagging
 * turns them into pieces one by one, each taking its share of the cost by
 * weight. Closing the lot posts any small weighing difference as an adjustment.
 */
export const taggingLotTable = defineTable({
  name: 'tagging_lot',
  module: 'inventory',
  columns: {
    goods_receipt_line_id: col.fk('goods_receipt_line', { notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    location_id: col.fk('stock_location', { notNull: true }),
    item_id: col.fk('item', { notNull: true }),
    purity_id: col.fk('purity', { notNull: true }),
    supplier_id: col.fk('party', { notNull: true }),
    pieces_expected: col.int({ notNull: true }),
    gross_expected: col.weight({ notNull: true }),
    net_expected: col.weight({ notNull: true }),
    fine_expected: col.weight({ notNull: true }),
    cost_value: col.money({ notNull: true, default: '0' }),
    pieces_tagged: col.int({ notNull: true, default: '0' }),
    gross_tagged: col.weight({ notNull: true, default: '0' }),
    net_tagged: col.weight({ notNull: true, default: '0' }),
    fine_tagged: col.weight({ notNull: true, default: '0' }),
    cost_tagged: col.money({ notNull: true, default: '0' }),
    status: col.enum(['open', 'closed'], { notNull: true, default: "'open'" }),
    closed_at: col.timestamptz(),
    close_note: col.text(),
  },
  indexes: [{ columns: ['status', 'branch_id'] }, { columns: ['goods_receipt_line_id'] }],
});

/**
 * Moving stock between locations. Within a branch it completes at once; between
 * branches it goes in transit (to the destination's transit location) until the
 * other branch receives it.
 */
export const stockTransferTable = defineTable({
  name: 'stock_transfer',
  module: 'inventory',
  columns: {
    doc_number: col.text({ notNull: true }),
    from_branch_id: col.fk('branch', { notNull: true }),
    from_location_id: col.fk('stock_location', { notNull: true }),
    to_branch_id: col.fk('branch', { notNull: true }),
    to_location_id: col.fk('stock_location', { notNull: true }),
    status: col.enum(['in_transit', 'received', 'cancelled'], { notNull: true }),
    piece_count: col.int({ notNull: true, default: '0' }),
    gross_weight: col.weight({ notNull: true, default: '0' }),
    note: col.text(),
    dispatched_at: col.timestamptz({ notNull: true, default: 'now()' }),
    dispatched_by: col.fk('app_user'),
    received_at: col.timestamptz(),
    received_by: col.fk('app_user'),
  },
  uniques: [{ columns: ['doc_number'] }],
  indexes: [{ columns: ['status', 'to_branch_id'] }, { columns: ['id'] }],
});

export const stockTransferLineTable = defineTable({
  name: 'stock_transfer_line',
  module: 'inventory',
  columns: {
    stock_transfer_id: col.fk('stock_transfer', { notNull: true, onDelete: 'cascade' }),
    piece_id: col.fk('stock_piece', { comment: 'Set for a tagged piece; lots carry item, purity and weights.' }),
    item_id: col.fk('item', { notNull: true }),
    purity_id: col.fk('purity'),
    quantity: col.numeric(14, 3, { notNull: true, default: '0' }),
    gross_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true, default: '0' }),
    fine_weight: col.weight({ notNull: true, default: '0' }),
    value: col.money({ notNull: true, default: '0' }),
  },
  indexes: [{ columns: ['stock_transfer_id'] }],
});

export const ADJUSTMENT_REASONS = ['shortage', 'damage', 'loss', 'write_off', 'found', 'weighing_correction', 'stock_count', 'tagging_difference'] as const;

/** A stock correction. Its movements are its lines; posting is final. */
export const stockAdjustmentTable = defineTable({
  name: 'stock_adjustment',
  module: 'inventory',
  columns: {
    doc_number: col.text({ notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    reason: col.enum(ADJUSTMENT_REASONS, { notNull: true }),
    note: col.text({ notNull: true }),
    source_type: col.text({ comment: 'stock_count or stock_piece when posted from those.' }),
    source_id: col.uuid(),
    piece_count: col.int({ notNull: true, default: '0' }),
    net_weight_in: col.weight({ notNull: true, default: '0' }),
    net_weight_out: col.weight({ notNull: true, default: '0' }),
    value: col.money({ notNull: true, default: '0', comment: 'Net value change at cost; negative is a loss.' }),
  },
  uniques: [{ columns: ['doc_number'] }],
  indexes: [{ columns: ['id'] }],
});

/** A physical count of one location: tags are scanned, lots are weighed. */
export const stockCountTable = defineTable({
  name: 'stock_count',
  module: 'inventory',
  columns: {
    doc_number: col.text({ notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    location_id: col.fk('stock_location', { notNull: true }),
    status: col.enum(['open', 'posted', 'cancelled'], { notNull: true, default: "'open'" }),
    note: col.text(),
    posted_at: col.timestamptz(),
    posted_by: col.fk('app_user'),
    adjustment_id: col.fk('stock_adjustment'),
  },
  uniques: [{ columns: ['doc_number'] }],
  indexes: [{ columns: ['location_id', 'status'] }, { columns: ['id'] }],
});

export const stockCountLineTable = defineTable({
  name: 'stock_count_line',
  module: 'inventory',
  columns: {
    stock_count_id: col.fk('stock_count', { notNull: true, onDelete: 'cascade' }),
    kind: col.enum(['piece', 'lot'], { notNull: true }),
    /** piece: what was scanned, and what it turned out to be. */
    tag_number: col.text(),
    piece_id: col.fk('stock_piece'),
    outcome: col.enum(['found', 'elsewhere', 'unknown', 'lot'], { notNull: true }),
    /** lot: the weight actually on the scale. */
    item_id: col.fk('item'),
    purity_id: col.fk('purity'),
    counted_net_weight: col.weight(),
  },
  uniques: [{ columns: ['stock_count_id', 'tag_number'] }],
  indexes: [
    { columns: ['stock_count_id'] },
    { name: 'ux_stock_count_line_lot', columns: ['stock_count_id', 'item_id', 'purity_id'], unique: true, where: "kind = 'lot'" },
  ],
});

export const MOVEMENT_DIRECTIONS = ['in', 'out'] as const;
export const MOVEMENT_REASONS = [
  'opening',
  'purchase',
  'purchase_return',
  'sale',
  'sales_return',
  'transfer_out',
  'transfer_in',
  'production_issue',
  'production_receipt',
  'old_gold_intake',
  'melting',
  'refining',
  'adjustment',
  'memo_out',
  'memo_in',
  'metal_payment',
] as const;

export const stockMovementTable = defineTable({
  name: 'stock_movement',
  module: 'inventory',
  comment: 'Append-only. Never updated, never deleted — a mistake is corrected by a reversing row.',
  columns: {
    moved_at: col.timestamptz({ notNull: true, default: 'now()' }),
    direction: col.enum(MOVEMENT_DIRECTIONS, { notNull: true }),
    reason: col.enum(MOVEMENT_REASONS, { notNull: true }),

    item_id: col.fk('item', { notNull: true }),
    purity_id: col.fk('purity'),
    location_id: col.fk('stock_location', { notNull: true }),
    piece_id: col.fk('stock_piece', { comment: 'Set for piece-tracked items, null for bulk metal.' }),

    quantity: col.numeric(14, 3, { notNull: true, default: '0', comment: 'Piece count, or units for consumables.' }),
    gross_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true, default: '0' }),
    fine_weight: col.weight({ notNull: true, default: '0' }),
    value: col.money({ notNull: true, default: '0' }),

    /** Which document caused this. Not a FK: the target table varies. */
    source_type: col.text({ notNull: true }),
    source_id: col.uuid({ notNull: true }),
    source_line_id: col.uuid(),

    /** Set on the reversing row when a posted document is cancelled. */
    reverses_movement_id: col.fk('stock_movement'),
    note: col.text(),
  },
  indexes: [
    { columns: ['item_id', 'purity_id', 'location_id', 'moved_at'] },
    { columns: ['source_type', 'source_id'] },
    { columns: ['piece_id'] },
    { columns: ['moved_at'] },
  ],
  checks: [
    { name: 'nothing_negative', expression: 'quantity >= 0 and gross_weight >= 0 and net_weight >= 0' },
  ],
});

export const stockBalanceTable = defineTable({
  name: 'stock_balance',
  module: 'inventory',
  comment: 'A running total, kept in step with stock_movement inside the same transaction.',
  columns: {
    item_id: col.fk('item', { notNull: true }),
    purity_id: col.fk('purity'),
    location_id: col.fk('stock_location', { notNull: true }),

    quantity: col.numeric(14, 3, { notNull: true, default: '0' }),
    gross_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true, default: '0' }),
    fine_weight: col.weight({ notNull: true, default: '0' }),
    value: col.money({ notNull: true, default: '0' }),
    /** value / net_weight, kept alongside so valuation reports do not recompute it. */
    average_rate: col.money({ notNull: true, default: '0' }),
    last_movement_at: col.timestamptz(),
  },
  uniques: [{ columns: ['item_id', 'purity_id', 'location_id'], nullsNotDistinct: true }],
  indexes: [{ columns: ['location_id'] }],
});
