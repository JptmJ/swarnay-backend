/**
 * Module 10 — the reference data every transaction points at.
 *
 * Two shape decisions worth knowing:
 *
 * 1. `party` is one table for customers AND suppliers, with flags. In this
 *    trade the same firm is routinely both — you buy findings from a jeweller
 *    on Monday and sell them a bangle on Friday — and one row means one ledger
 *    and one balance instead of two that have to be reconciled by hand.
 *
 * 2. `item` carries a `tracking` mode. Raw metal is tracked in grams as a pool
 *    ("lot"); a tagged finished piece is tracked as one unique object
 *    ("piece"). Almost every difference between raw-material stock and
 *    showroom stock falls out of this one field.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const BRANCH_KINDS = ['showroom', 'factory', 'warehouse', 'office'] as const;

export const branchTable = defineTable({
  name: 'branch',
  module: 'masters',
  softDelete: true,
  comment: 'A physical location. Stock always sits at a branch, never at "the company".',
  columns: {
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    kind: col.enum(BRANCH_KINDS, { notNull: true, default: "'showroom'" }),
    /** Each branch can have its own GST registration (Module 10.6). */
    gstin: col.text(),
    state_code: col.text({ comment: 'GST state code — decides CGST+SGST versus IGST.' }),
    address_line1: col.text(),
    address_line2: col.text(),
    city: col.text(),
    state: col.text(),
    pincode: col.text(),
    phone: col.text(),
    email: col.text(),
    /** Principal place of business for GST. One per business. */
    is_head_office: col.bool({ notNull: true, default: 'false' }),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['code'] }],
  indexes: [{ name: 'ux_branch_head_office', columns: ['is_head_office'], unique: true, where: 'is_head_office and deleted_at is null' }],
});

/** Storage locations inside a branch: counter, vault, window, karigar table. */
export const LOCATION_KINDS = ['counter', 'vault', 'window', 'floor', 'transit', 'karigar'] as const;

export const stockLocationTable = defineTable({
  name: 'stock_location',
  module: 'masters',
  softDelete: true,
  columns: {
    branch_id: col.fk('branch', { notNull: true }),
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    kind: col.enum(LOCATION_KINDS, { notNull: true, default: "'counter'" }),
    is_default: col.bool({ notNull: true, default: 'false' }),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['branch_id', 'code'] }],
});

export const metalTable = defineTable({
  name: 'metal',
  module: 'masters',
  comment: 'Gold, silver, platinum. Kept as data so a tenant can add one.',
  columns: {
    code: col.text({ notNull: true, comment: 'GOLD, SILVER, PLATINUM' }),
    name: col.text({ notNull: true }),
    /** Everything is stored in grams; this is only for display. */
    default_display_unit: col.enum(['gram', 'tola', 'kilo', 'carat'], { notNull: true, default: "'gram'" }),
    hsn_code: col.text(),
    is_active: col.bool({ notNull: true, default: 'true' }),
    sort_order: col.int({ notNull: true, default: '0' }),
  },
  uniques: [{ columns: ['code'] }],
});

export const purityTable = defineTable({
  name: 'purity',
  module: 'masters',
  comment: 'Module 10.1 — 22K gold is one row: fineness 91.600, karat 22.',
  columns: {
    metal_id: col.fk('metal', { notNull: true }),
    code: col.text({ notNull: true, comment: 'e.g. 22K, 18K, 916, 995' }),
    name: col.text({ notNull: true }),
    /** The number everything calculates from: 91.600 means 91.6% pure. */
    fineness_percent: col.purity({ notNull: true }),
    karat: col.numeric(5, 2, { comment: 'Null for silver and platinum.' }),
    /** Hallmarking applies to some purities and not others. */
    is_hallmarkable: col.bool({ notNull: true, default: 'true' }),
    /** How the purity is written on screens and bills: 22K, 916 or 91.6%. */
    notation: col.enum(['karat', 'fineness', 'percentage'], { notNull: true, default: "'karat'" }),
    default_unit: col.enum(['g', 'kg', 'tola', 'oz'], { notNull: true, default: "'g'" }),
    /** Pre-selected on forms for its metal. One per metal. */
    is_default: col.bool({ notNull: true, default: 'false' }),
    description: col.text(),
    is_active: col.bool({ notNull: true, default: 'true' }),
    sort_order: col.int({ notNull: true, default: '0' }),
  },
  uniques: [{ columns: ['metal_id', 'code'] }],
  indexes: [{ name: 'ux_purity_default', columns: ['metal_id'], unique: true, where: 'is_default' }],
  checks: [
    { name: 'fineness_range', expression: 'fineness_percent > 0 and fineness_percent <= 100' },
  ],
});

export const itemCategoryTable = defineTable({
  name: 'item_category',
  module: 'masters',
  columns: {
    parent_id: col.fk('item_category'),
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    hsn_code: col.text(),
    sub_categories: col.jsonb({ notNull: true, default: "'[]'::jsonb", comment: 'Names, e.g. ["Temple", "Antique"].' }),
    applicable_metals: col.jsonb({ notNull: true, default: "'[]'::jsonb", comment: 'Metal codes, e.g. ["GOLD", "SILVER"]. Empty = any.' }),
    making_rule_id: col.fk('price_rule', { comment: 'Default making-charge rule for the category.' }),
    sort_order: col.int({ notNull: true, default: '0' }),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['code'] }],
});

export const ITEM_TRACKING = ['lot', 'piece'] as const;
export const ITEM_NATURES = ['raw_metal', 'finished', 'stone', 'consumable', 'service'] as const;

export const itemTable = defineTable({
  name: 'item',
  module: 'masters',
  softDelete: true,
  comment: 'The product master. One row per thing you can buy, make or sell.',
  columns: {
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    nature: col.enum(ITEM_NATURES, { notNull: true, default: "'finished'" }),
    /** lot = pooled and weighed; piece = individually tagged and unique. */
    tracking: col.enum(ITEM_TRACKING, { notNull: true, default: "'piece'" }),
    category_id: col.fk('item_category'),
    metal_id: col.fk('metal'),
    default_purity_id: col.fk('purity'),
    hsn_code: col.text(),
    /** For stones and consumables that are counted, not weighed. */
    uom: col.enum(['gram', 'piece', 'carat', 'millilitre'], { notNull: true, default: "'gram'" }),
    is_active: col.bool({ notNull: true, default: 'true' }),
    attributes: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
  },
  uniques: [{ columns: ['code'] }],
  indexes: [{ columns: ['nature'] }, { columns: ['category_id'] }],
});

export const partyTable = defineTable({
  name: 'party',
  module: 'masters',
  softDelete: true,
  comment: 'Customers and suppliers. The same firm is often both, so one row serves both.',
  columns: {
    code: col.text({ notNull: true }),
    name: col.text({ notNull: true }),
    is_customer: col.bool({ notNull: true, default: 'false' }),
    is_supplier: col.bool({ notNull: true, default: 'false' }),
    party_type: col.enum(['individual', 'business'], { notNull: true, default: "'individual'" }),
    phone: col.text(),
    email: col.text(),
    gstin: col.text(),
    pan: col.text(),
    state_code: col.text({ comment: 'Decides CGST+SGST versus IGST against the branch.' }),
    address_line1: col.text(),
    address_line2: col.text(),
    city: col.text(),
    state: col.text(),
    pincode: col.text(),
    /** Credit control (Module 9.3). */
    credit_limit: col.money(),
    credit_days: col.int(),
    /** KYC (Module 10.4) — the documents themselves live in object storage. */
    kyc_status: col.enum(['none', 'pending', 'verified', 'rejected'], { notNull: true, default: "'none'" }),
    date_of_birth: col.date(),
    anniversary: col.date(),
    notes: col.text(),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['code'] }],
  indexes: [
    { columns: ['name'] },
    { columns: ['phone'] },
    // Fuzzy search ("ramesh", "98765"). Global because a GIN index can't hold tenant_id's uuid
    // without btree_gin; RLS still filters to the tenant. Revisit with btree_gin at large scale.
    { name: 'gx_party_name_trgm', columns: ['name'], method: 'gin', opclass: 'gin_trgm_ops', global: true },
    { name: 'gx_party_phone_trgm', columns: ['phone'], method: 'gin', opclass: 'gin_trgm_ops', global: true },
    { name: 'gx_party_code_trgm', columns: ['code'], method: 'gin', opclass: 'gin_trgm_ops', global: true },
    { columns: ['is_customer'], where: 'is_customer = true' },
    { columns: ['is_supplier'], where: 'is_supplier = true' },
  ],
  checks: [
    { name: 'is_customer_or_supplier', expression: 'is_customer = true or is_supplier = true' },
  ],
});

export const DOCUMENT_TYPES = ['invoice', 'advance_receipt', 'old_gold_voucher', 'scheme_receipt', 'girvi_pawn_ticket'] as const;
export const PAPER_SIZES = ['A4', 'A5', 'Thermal_80mm', 'Thermal_3inch'] as const;
export const HEADER_STYLES = ['logo_top', 'letterhead_preprinted', 'minimal'] as const;

/** Print settings for one kind of document: paper, header, what is shown, and the terms printed at the foot. */
export const documentFormatTable = defineTable({
  name: 'document_format',
  module: 'masters',
  columns: {
    code: col.text({ notNull: true }),
    doc_type: col.enum(DOCUMENT_TYPES, { notNull: true }),
    title: col.text({ notNull: true }),
    paper_size: col.enum(PAPER_SIZES, { notNull: true, default: "'A4'" }),
    header_style: col.enum(HEADER_STYLES, { notNull: true, default: "'logo_top'" }),
    numbering_doc_type: col.text({ comment: 'The numbering series whose number prints on it, e.g. sales_invoice.' }),
    field_toggles: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    terms: col.text({ notNull: true, default: "''" }),
  },
  uniques: [{ columns: ['code'] }],
});

/** Module 12.6 — the daily rate every price on every document is derived from. */
export const metalRateTable = defineTable({
  name: 'metal_rate',
  module: 'masters',
  comment: 'Historic rates are never edited — a new rate is a new row, so old invoices stay explainable.',
  columns: {
    metal_id: col.fk('metal', { notNull: true }),
    purity_id: col.fk('purity', { comment: 'Null means the rate is for 100% pure metal.' }),
    effective_from: col.timestamptz({ notNull: true, default: 'now()' }),
    /** Rate per gram of this purity, in the tenant's base currency. */
    rate_per_gram: col.money({ notNull: true }),
    buying_rate_per_gram: col.money({ comment: 'What the shop pays for old gold — normally lower.' }),
    source: col.enum(['manual', 'feed'], { notNull: true, default: "'manual'" }),
    branch_id: col.fk('branch', { comment: 'Null means the rate applies to every branch.' }),
    /**
     * Set when the shop removes this metal + purity from its rate list. The
     * rate itself is never changed — retired rows stay for history, but no
     * price is taken from them. Adding the purity again starts a fresh row.
     */
    retired_at: col.timestamptz({ comment: 'Removed from the rate list. Kept for history; never used for pricing.' }),
  },
  indexes: [
    { columns: ['metal_id', 'purity_id', 'effective_from'] },
    { columns: ['purity_id', 'effective_from'], where: 'retired_at is null' },
  ],
  checks: [{ name: 'rate_positive', expression: 'rate_per_gram > 0' }],
});
