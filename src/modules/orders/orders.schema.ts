/**
 * Custom Orders & Karigar.
 *
 * One `retail_order` table covers all five order types rather than five tables,
 * because they share 80% of their fields and every list, board and report wants
 * them together. The 20% that differs lives in type-specific columns that are
 * null for the other types, and the stage machine comes from `order_pipeline`.
 *
 * Validation the frontend already enforces is mirrored here as CHECK
 * constraints, so a bad row cannot arrive through any other route either.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';
import { ALL_STAGE_KEYS, ORDER_TYPES, RATE_LOCK_TYPES } from './order-pipelines.js';

export const ORDER_STATUSES = ['draft', 'active', 'completed', 'cancelled'] as const;

/** Per-tenant override of the built-in stage list for an order type. */
export const orderPipelineTable = defineTable({
  name: 'order_pipeline',
  module: 'orders',
  comment: 'Config-driven Kanban stages. Absent rows fall back to the built-in defaults.',
  columns: {
    order_type: col.enum(ORDER_TYPES, { notNull: true }),
    /** [{ key, label, terminal?, external?, slaHours? }] in board order. */
    stages: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['order_type'] }],
});

export const retailOrderTable = defineTable({
  name: 'retail_order',
  module: 'orders',
  comment: 'All five order types. Type-specific fields are null for the others.',
  columns: {
    order_number: col.text({ notNull: true }),
    order_type: col.enum(ORDER_TYPES, { notNull: true }),
    status: col.enum(ORDER_STATUSES, { notNull: true, default: "'draft'" }),
    /** Current Kanban column. Valid values depend on order_type. */
    stage: col.enum(ALL_STAGE_KEYS, { notNull: true }),

    branch_id: col.fk('branch', { notNull: true }),
    customer_id: col.fk('party', { notNull: true }),
    salesperson_id: col.fk('app_user'),
    /** Who is making it — set once the order reaches a production stage. */
    karigar_id: col.fk('karigar'),

    order_date: col.date({ notNull: true }),
    expected_delivery_date: col.date({ notNull: true }),
    delivered_at: col.timestamptz(),
    /** Flipped by a scheduled check; drives the "SLA risk" dashboard alert. */
    is_sla_breached: col.bool({ notNull: true, default: 'false' }),

    /* --- rate lock (all types) --- */
    /** booking = the rate the day it was taken; delivery = the rate the day it is billed; fixed = agreed and typed in. */
    rate_lock_type: col.enum(RATE_LOCK_TYPES, { notNull: true, default: "'booking'" }),
    locked_rate_per_gram: col.money({ comment: 'The gold rate held for this order (booking and fixed locks).' }),
    rate_locked_at: col.timestamptz(),
    rate_lock_expires_at: col.timestamptz({ comment: 'From orders.rate_lock.days. Null = held until delivered.' }),
    /** What the bill actually used, written when the order is billed. */
    rate_source_used: col.enum(['booking', 'delivery', 'fixed'], {}),
    rate_override_by: col.fk('app_user', { comment: 'Who switched the rate at delivery, if anyone did.' }),

    /* --- money --- */
    metal_amount: col.money({ notNull: true, default: '0' }),
    making_amount: col.money({ notNull: true, default: '0' }),
    stone_amount: col.money({ notNull: true, default: '0' }),
    discount_amount: col.money({ notNull: true, default: '0' }),
    taxable_amount: col.money({ notNull: true, default: '0' }),
    cgst_amount: col.money({ notNull: true, default: '0' }),
    sgst_amount: col.money({ notNull: true, default: '0' }),
    igst_amount: col.money({ notNull: true, default: '0' }),
    total_amount: col.money({ notNull: true, default: '0' }),
    advance_amount: col.money({ notNull: true, default: '0' }),
    /** Credits linked from other modules, applied against the balance. */
    old_gold_credit: col.money({ notNull: true, default: '0' }),
    scheme_credit: col.money({ notNull: true, default: '0' }),
    balance_amount: col.money({ notNull: true, default: '0' }),

    total_gross_weight: col.weight({ notNull: true, default: '0' }),
    total_net_weight: col.weight({ notNull: true, default: '0' }),

    /* --- custom / made-to-order --- */
    requirement_description: col.text(),
    size_specifications: col.text(),
    budget_min: col.money(),
    budget_max: col.money(),
    design_approval: col.enum(['pending', 'approved', 'revision_requested'], {}),
    manufacturing_route: col.enum(['in_house', 'external'], {}),
    external_manufacturer_id: col.fk('party'),
    production_status: col.enum(
      ['not_started', 'sent_to_manufacturer', 'quote_received', 'in_production', 'completed'],
      {},
    ),

    /* --- repair --- */
    repair_item_description: col.text(),
    repair_issue_description: col.text(),
    /** ["clasp","chain","stone_loose","polish"] */
    repair_issue_types: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    under_warranty: col.bool({ notNull: true, default: 'false' }),
    original_invoice_number: col.text({ comment: 'Links a warranty repair back to the sale.' }),
    /** Overrides orders.repair.invoice_type for this one repair. */
    repair_invoice_type: col.enum(['service', 'goods'], {}),
    /** Labour quoted for the repair, before GST. */
    repair_service_charge: col.money({ notNull: true, default: '0' }),
    /** Agreed with the customer before work starts; a repair waits here until then. */
    estimate_approved_at: col.timestamptz(),
    estimate_approved_by_name: col.text(),

    /* --- wedding / corporate --- */
    event_date: col.date(),
    event_type: col.text(),
    company_name: col.text(),
    company_gstin: col.text(),
    po_reference: col.text(),
    credit_terms: col.enum(['net_15', 'net_30', 'custom'], {}),
    credit_terms_note: col.text(),
    branding_notes: col.text(),

    notes: col.text(),
    cancelled_at: col.timestamptz(),
    cancel_reason: col.text(),
    /** Set when the order is billed out through POS. */
    sales_invoice_id: col.fk('sales_invoice'),
    /**
     * The order's number in the software it was imported from. Importing the
     * same file again skips rows whose reference is already here.
     */
    external_reference: col.text({ comment: 'Order number from the previous software, for imported orders.' }),
  },
  uniques: [{ columns: ['order_number'] }],
  indexes: [
    { name: 'ux_retail_order_external_reference', columns: ['external_reference'], unique: true, where: 'external_reference is not null' },
    { columns: ['order_type', 'stage'] },
    { columns: ['customer_id', 'order_date'] },
    { columns: ['branch_id', 'order_date'] },
    { columns: ['status', 'expected_delivery_date'] },
    { columns: ['karigar_id'], where: 'karigar_id is not null' },
    { columns: ['expected_delivery_date'], where: "status = 'active'" },
  ],
  checks: [
    { name: 'budget_range', expression: 'budget_min is null or budget_max is null or budget_min <= budget_max' },
    { name: 'advance_within_total', expression: 'advance_amount <= total_amount + 0.01' },
    {
      name: 'amounts_not_negative',
      expression:
        'metal_amount >= 0 and making_amount >= 0 and stone_amount >= 0 and total_amount >= 0 and advance_amount >= 0',
    },
    {
      name: 'corporate_needs_po',
      expression: "order_type <> 'corporate' or (company_name is not null and po_reference is not null)",
    },
    { name: 'repair_needs_item', expression: "order_type <> 'repair' or repair_item_description is not null" },
  ],
});

export const orderLineTable = defineTable({
  name: 'order_line',
  module: 'orders',
  comment: 'A wedding order mixes ready-stock bookings and made-to-order pieces line by line.',
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    line_number: col.int({ notNull: true }),
    /** booking = reserve existing stock; custom = make it. */
    line_mode: col.enum(['booking', 'custom'], { notNull: true, default: "'booking'" }),
    title: col.text({ notNull: true }),
    design_specification: col.text(),
    item_id: col.fk('item'),
    piece_id: col.fk('stock_piece', { comment: 'Set when a specific tagged piece is reserved.' }),
    purity_id: col.fk('purity'),
    category_id: col.fk('item_category'),

    quantity: col.numeric(14, 3, { notNull: true, default: '1' }),
    gross_weight: col.weight({ notNull: true, default: '0' }),
    stone_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true, default: '0' }),

    rate_per_gram: col.money({ notNull: true, default: '0' }),
    metal_amount: col.money({ notNull: true, default: '0' }),
    making_basis: col.enum(['per_gram', 'percent', 'flat'], { notNull: true, default: "'per_gram'" }),
    making_rate: col.rate({ notNull: true, default: '0' }),
    making_amount: col.money({ notNull: true, default: '0' }),
    wastage_percent: col.rate({ notNull: true, default: '0' }),
    stone_amount: col.money({ notNull: true, default: '0' }),
    discount_amount: col.money({ notNull: true, default: '0' }),
    taxable_amount: col.money({ notNull: true, default: '0' }),
    gst_rate: col.rate({ notNull: true, default: '0' }),
    cgst_amount: col.money({ notNull: true, default: '0' }),
    sgst_amount: col.money({ notNull: true, default: '0' }),
    igst_amount: col.money({ notNull: true, default: '0' }),
    line_total: col.money({ notNull: true, default: '0' }),

    hsn_code: col.text(),
    special_instructions: col.text(),
    /** Work that cannot be priced yet: line_total is what the customer was quoted, GST comes with the bill. */
    is_estimate: col.bool({ notNull: true, default: 'false' }),
  },
  uniques: [{ columns: ['retail_order_id', 'line_number'] }],
  indexes: [{ columns: ['piece_id'], where: 'piece_id is not null' }],
  checks: [
    { name: 'quantity_positive', expression: 'quantity > 0' },
    { name: 'net_within_gross', expression: 'net_weight <= gross_weight' },
    { name: 'title_not_blank', expression: "length(btrim(title)) > 0" },
  ],
});

/** The order timeline. Every stage move lands here, forward or backward. */
export const orderStageEventTable = defineTable({
  name: 'order_stage_event',
  module: 'orders',
  timestamps: false,
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    at: col.timestamptz({ notNull: true, default: 'now()' }),
    from_stage: col.text(),
    to_stage: col.text({ notNull: true }),
    direction: col.enum(['forward', 'backward', 'same'], { notNull: true, default: "'forward'" }),
    /** Backward moves are unusual, so the reason is required for them. */
    reason: col.text(),
    note: col.text(),
    actor_user_id: col.fk('app_user'),
    karigar_id: col.fk('karigar'),
  },
  indexes: [{ columns: ['retail_order_id', 'at'] }],
});

export const orderAttachmentTable = defineTable({
  name: 'order_attachment',
  module: 'orders',
  comment: 'Reference images for custom work, condition photos for repairs.',
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    kind: col.enum(['reference', 'intake_photo', 'design', 'cad', 'delivery_proof', 'document'], {
      notNull: true,
      default: "'reference'",
    }),
    file_name: col.text({ notNull: true }),
    /** Object-storage key. The bytes never go in Postgres. */
    storage_key: col.text({ notNull: true }),
    content_type: col.text(),
    size_bytes: col.bigint(),
    caption: col.text(),
    sort_order: col.int({ notNull: true, default: '0' }),
  },
  indexes: [{ columns: ['retail_order_id', 'kind'] }],
});

/**
 * Repair intake requires the customer to acknowledge condition before the item
 * leaves the counter — signature, or a verified OTP reference.
 */
export const orderAcknowledgementTable = defineTable({
  name: 'order_acknowledgement',
  module: 'orders',
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    method: col.enum(['signature', 'otp'], { notNull: true }),
    /** Storage key of the captured signature image. */
    signature_storage_key: col.text(),
    otp_reference: col.text({ comment: 'The reference returned by the OTP provider, not the code.' }),
    acknowledged_at: col.timestamptz({ notNull: true, default: 'now()' }),
    acknowledged_by_name: col.text(),
  },
  uniques: [{ columns: ['retail_order_id'] }],
  checks: [
    {
      name: 'method_evidence_present',
      expression:
        "(method = 'signature' and signature_storage_key is not null) or (method = 'otp' and otp_reference is not null)",
    },
  ],
});

export const orderPaymentTable = defineTable({
  name: 'order_payment',
  module: 'orders',
  comment: 'Advances taken against an order. Posted when saved: the money in, the customer credited.',
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    /** From Masters → Payment Modes, so reference and limit rules apply as at the counter. */
    payment_method_id: col.fk('payment_method', { notNull: true }),
    amount: col.money({ notNull: true }),
    reference: col.text(),
    doc_date: col.date({ notNull: true }),
    received_at: col.timestamptz({ notNull: true, default: 'now()' }),
    receipt_number: col.text({ notNull: true }),
    status: col.enum(['posted', 'cancelled'], { notNull: true, default: "'posted'" }),
    voucher_id: col.fk('voucher'),
    cancelled_at: col.timestamptz(),
    cancel_reason: col.text(),
    notes: col.text(),
  },
  uniques: [{ columns: ['receipt_number'] }],
  indexes: [{ columns: ['retail_order_id'] }, { columns: ['doc_date'] }],
  checks: [{ name: 'amount_positive', expression: 'amount > 0' }],
});

/**
 * Jewellery a karigar is holding: shop metal issued to be made into something,
 * or the customer's own piece sent out for repair.
 *
 * Issuing moves fine metal from stock (1210) to the karigar (1220) — or, for the
 * customer's own metal, only onto this card, because the shop never owned it.
 * Receiving brings it back, works out the ghat against what was agreed, and
 * books the labour.
 */
export const karigarJobTable = defineTable({
  name: 'karigar_job',
  module: 'orders',
  comment: 'Metal and work with a karigar: issued, received back, ghat and wages settled.',
  columns: {
    job_number: col.text({ notNull: true }),
    karigar_id: col.fk('karigar', { notNull: true }),
    branch_id: col.fk('branch', { notNull: true }),
    retail_order_id: col.fk('retail_order', { comment: 'Null for stock work with no customer order behind it.' }),
    kind: col.enum(['making', 'repair'], { notNull: true, default: "'making'" }),
    status: col.enum(['issued', 'received', 'cancelled'], { notNull: true, default: "'issued'" }),
    /** shop = metal out of our stock; customer = the customer's own item, which we never owned. */
    metal_source: col.enum(['shop', 'customer'], { notNull: true, default: "'shop'" }),

    issued_on: col.date({ notNull: true }),
    due_date: col.date(),
    received_on: col.date(),

    metal_id: col.fk('metal', { notNull: true }),
    purity_id: col.fk('purity'),
    item_id: col.fk('item', { comment: 'The lot the metal left, when it came from stock.' }),
    issued_from_location_id: col.fk('stock_location'),
    issued_gross_weight: col.weight({ notNull: true, default: '0' }),
    issued_net_weight: col.weight({ notNull: true, default: '0' }),
    issued_fine_weight: col.weight({ notNull: true, default: '0' }),
    issued_stone_weight: col.weight({ notNull: true, default: '0' }),
    issued_value: col.money({ notNull: true, default: '0', comment: 'Cost of shop metal issued; 0 for the customer’s own.' }),

    /** What was agreed before the work started. */
    ghat_percent: col.rate({ notNull: true, default: '0' }),
    labour_basis: col.enum(['per_gram', 'flat', 'percent'], { notNull: true, default: "'per_gram'" }),
    labour_rate: col.rate({ notNull: true, default: '0' }),

    received_gross_weight: col.weight({ notNull: true, default: '0' }),
    received_net_weight: col.weight({ notNull: true, default: '0' }),
    received_fine_weight: col.weight({ notNull: true, default: '0' }),
    received_stone_weight: col.weight({ notNull: true, default: '0' }),
    ghat_allowed_fine: col.weight({ notNull: true, default: '0' }),
    ghat_actual_fine: col.weight({ notNull: true, default: '0' }),
    ghat_excess_fine: col.weight({ notNull: true, default: '0', comment: 'Lost above the allowance.' }),
    excess_ghat_handling: col.enum(['recover', 'absorb'], {}),
    excess_ghat_value: col.money({ notNull: true, default: '0' }),
    labour_amount: col.money({ notNull: true, default: '0' }),

    received_into_location_id: col.fk('stock_location'),
    piece_id: col.fk('stock_piece', { comment: 'Set once what came back is tagged into stock.' }),
    issue_voucher_id: col.fk('voucher'),
    receive_voucher_id: col.fk('voucher'),
    notes: col.text(),
    cancelled_at: col.timestamptz(),
    cancel_reason: col.text(),
  },
  uniques: [{ columns: ['job_number'] }],
  indexes: [
    { columns: ['karigar_id', 'status'] },
    { columns: ['retail_order_id'], where: 'retail_order_id is not null' },
    { columns: ['status', 'due_date'] },
  ],
  checks: [
    { name: 'issued_weight_positive', expression: 'issued_gross_weight >= 0 and issued_fine_weight >= 0' },
    { name: 'customer_metal_has_no_value', expression: "metal_source <> 'customer' or issued_value = 0" },
    { name: 'shop_metal_leaves_a_location', expression: "metal_source <> 'shop' or status = 'cancelled' or issued_from_location_id is not null" },
  ],
});

/**
 * The customer's own jewellery while it is in the shop's hands — a repair, or
 * metal they brought for a new piece. It is never stock, because the shop does
 * not own it, but it must be findable: who brought it, what it weighed, where
 * it is now, and when it went back.
 */
export const orderCustodyItemTable = defineTable({
  name: 'order_custody_item',
  module: 'orders',
  comment: 'Customer goods held by the shop. Tracked, never valued as stock.',
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    line_number: col.int({ notNull: true }),
    /** Written on the paper tag tied to the item, so it can be found in the drawer. */
    token_number: col.text({ notNull: true }),
    description: col.text({ notNull: true }),
    metal_id: col.fk('metal'),
    purity_id: col.fk('purity'),
    tested_purity_percent: col.purity({ comment: 'When it was tested at intake.' }),
    gross_weight: col.weight({ notNull: true, default: '0' }),
    stone_weight: col.weight({ notNull: true, default: '0' }),
    net_weight: col.weight({ notNull: true, default: '0' }),
    /** What the customer says it is worth, for a dispute or an insurance claim. */
    declared_value: col.money(),
    condition_notes: col.text(),
    where_kept: col.text({ comment: 'Safe, drawer, counter — wherever the shop keeps it.' }),
    status: col.enum(['received', 'with_karigar', 'ready', 'returned', 'written_off'], {
      notNull: true, default: "'received'",
    }),
    karigar_job_id: col.fk('karigar_job'),
    received_on: col.date({ notNull: true }),
    returned_on: col.date(),
    returned_to_name: col.text(),
    notes: col.text(),
  },
  uniques: [{ columns: ['retail_order_id', 'line_number'] }],
  indexes: [{ columns: ['status'] }, { columns: ['token_number'] }],
  checks: [
    { name: 'custody_net_within_gross', expression: 'net_weight <= gross_weight' },
    { name: 'returned_has_date', expression: "status <> 'returned' or returned_on is not null" },
  ],
});

/** Messages sent to the customer about the order — the frontend shows these on the detail page. */
export const orderCommunicationTable = defineTable({
  name: 'order_communication',
  module: 'orders',
  columns: {
    retail_order_id: col.fk('retail_order', { notNull: true, onDelete: 'cascade' }),
    channel: col.enum(['sms', 'whatsapp', 'email', 'call', 'in_person'], { notNull: true, default: "'whatsapp'" }),
    direction: col.enum(['outbound', 'inbound'], { notNull: true, default: "'outbound'" }),
    message: col.text({ notNull: true }),
    sent_at: col.timestamptz({ notNull: true, default: 'now()' }),
    delivery_status: col.enum(['queued', 'sent', 'delivered', 'read', 'failed'], {
      notNull: true, default: "'queued'",
    }),
    actor_user_id: col.fk('app_user'),
  },
  indexes: [{ columns: ['retail_order_id', 'sent_at'] }],
});
