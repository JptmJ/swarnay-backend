/**
 * Platform-level tables. These are the only tables NOT scoped to a tenant —
 * they are the list of tenants itself.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const TENANT_KINDS = ['manufacturer', 'retailer', 'both'] as const;
export const TENANT_STATUSES = ['trial', 'active', 'suspended', 'closed'] as const;

export const tenantTable = defineTable({
  name: 'tenant',
  module: 'tenancy',
  tenantScoped: false,
  comment: 'One row per customer business. Everything else in the database points here.',
  columns: {
    code: col.text({ notNull: true, unique: true, comment: 'Short slug used in URLs and logs.' }),
    legal_name: col.text({ notNull: true }),
    display_name: col.text({ notNull: true }),
    /**
     * Drives which modules are visible. A retailer never sees the production
     * floor; a manufacturer never sees showroom counters.
     */
    kind: col.enum(TENANT_KINDS, { notNull: true, default: "'retailer'" }),
    status: col.enum(TENANT_STATUSES, { notNull: true, default: "'trial'" }),
    country: col.text({ notNull: true, default: "'IN'" }),
    base_currency: col.text({ notNull: true, default: "'INR'" }),
    timezone: col.text({ notNull: true, default: "'Asia/Kolkata'" }),
    gstin: col.text(),
    pan: col.text(),
    /** Free-form contact and billing details that no query ever filters on. */
    metadata: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    /**
     * How many branches this business may have, as sold. Null means no limit,
     * which is what every tenant starts on until a number is set.
     *
     * Checked when a branch is created, from the console and from inside the
     * shop alike — a shop that may add its own branches should not be able to
     * add thirty of them.
     */
    max_branches: col.int(),
    /**
     * Made by the console's "Demo accounts" button, filled with sample data.
     * Only a demo can be deleted outright — a real business is suspended or
     * closed, never erased.
     */
    is_demo: col.bool({ notNull: true, default: 'false' }),
    activated_at: col.timestamptz(),
  },
  indexes: [{ columns: ['status'] }],
  softDelete: true,
});

/**
 * Which of the 12 modules this tenant has switched on. Separate from `kind`
 * because two retailers of the same kind still buy different packages.
 */
export const LICENCE_STATES = ['included', 'purchased', 'trial', 'expired'] as const;

export const tenantModuleTable = defineTable({
  name: 'tenant_module',
  module: 'platform',
  comment: 'Which modules a tenant holds, and on what terms. Drives the module dock.',
  columns: {
    module_key: col.text({ notNull: true, comment: 'orders, stock, tagging, pos, oldgold, schemes, girvi, accounts, master, reports, settings, platform' }),
    enabled: col.bool({ notNull: true, default: 'true' }),
    licence: col.enum(LICENCE_STATES, { notNull: true, default: "'included'" }),
    /** Set for trial licences. Past this instant the module shows as locked. */
    trial_ends_at: col.timestamptz(),
    /** Set for purchased licences with a term. Null means perpetual. */
    expires_at: col.timestamptz(),
    purchased_at: col.timestamptz(),
    /** Sub-modules switched off individually, e.g. ["orders.repair"]. */
    disabled_submodules: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    settings: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
  },
  uniques: [{ columns: ['module_key'] }],
  indexes: [{ columns: ['licence'] }],
});

/*
 * Feature flags were here. The console could define and toggle them, globally or
 * per tenant, but nothing in the application ever read one — a control panel
 * over an empty socket — so the whole surface came out on 2026-10-04.
 *
 * The `feature_flag` table itself is deliberately left in the database: the
 * differ refuses to drop a table it no longer recognises, and that is the right
 * answer here. Nothing writes to it, and restoring the feature means restoring
 * this definition and the two routes rather than rebuilding the schema.
 */

/**
 * A platform operator temporarily acting inside a tenant, for support.
 *
 * Time-boxed on purpose, and every action taken during the window is written
 * to the audit log tagged with this session — so "support looked at my data"
 * is always answerable with exactly what and when.
 */
export const supportSessionTable = defineTable({
  name: 'support_session',
  module: 'platform',
  tenantScoped: false,
  columns: {
    tenant_id: col.fk('tenant', { notNull: true }),
    /**
     * The operator, who is a `platform_user` — not an `app_user`. This pointed
     * at `app_user` originally, which no operator has a row in, so the insert
     * could never satisfy it.
     */
    operator_user_id: col.fk('platform_user', { notNull: true }),
    reason: col.text({ notNull: true }),
    started_at: col.timestamptz({ notNull: true, default: 'now()' }),
    /** Hard stop. The token minted for the session carries this expiry too. */
    ends_at: col.timestamptz({ notNull: true }),
    ended_at: col.timestamptz(),
    /** Read-only support is the default; write access is an explicit escalation. */
    can_write: col.bool({ notNull: true, default: 'false' }),
    /**
     * SHA-256 of the session token. Stored hashed so a leaked database row
     * cannot be replayed as a live session, and checked on every request so
     * ending a session takes effect immediately rather than at token expiry.
     */
    token_hash: col.text(),
    ip_address: col.text(),
  },
  indexes: [
    { columns: ['tenant_id', 'started_at'] },
    { columns: ['operator_user_id'] },
    { columns: ['token_hash'], unique: true },
  ],
});

/** Module 12.4 — the five theme presets, plus per-tenant CSS variable overrides. */
export const tenantThemeTable = defineTable({
  name: 'tenant_theme',
  module: 'settings',
  comment: 'Theme Studio. preset_key matches the frontend theme ids.',
  columns: {
    preset_key: col.enum(
      ['deep-forest', 'royal-ruby', 'sapphire-platinum', 'obsidian-luxury', 'rose-gold', 'custom'],
      { notNull: true, default: "'deep-forest'" },
    ),
    /** Overrides on top of the preset, as CSS custom properties. */
    css_variables: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    logo_url: col.text(),
    logo_dark_url: col.text(),
    favicon_url: col.text(),
    /** Null branch_id is the tenant default; a row per branch overrides it. */
    branch_id: col.fk('branch'),
    is_active: col.bool({ notNull: true, default: 'true' }),
  },
  uniques: [{ columns: ['branch_id'], nullsNotDistinct: true }],
});

/**
 * A person's Dashboard layout. `role_code` rows are defaults the owner sets
 * for a role ('*' for everyone); a person without a layout of their own gets
 * their role's, then everyone's, then the built-in one.
 */
export const dashboardLayoutTable = defineTable({
  name: 'dashboard_layout',
  module: 'dashboard',
  columns: {
    user_id: col.fk('app_user', { onDelete: 'cascade', comment: 'Null when this is a role default.' }),
    role_code: col.text({ comment: 'Set instead of user_id for a role-level default.' }),
    /** Ordered widgets: [{ id, visible, order }]. Pinned reports are report_<ref>. */
    widgets: col.jsonb({ notNull: true, default: "'[]'::jsonb" }),
    /** Per-layout choices such as the sales chart's range: { salesTrendDays }. */
    widget_settings: col.jsonb({ notNull: true, default: "'{}'::jsonb" }),
    is_default: col.bool({ notNull: true, default: 'false' }),
  },
  uniques: [{ columns: ['user_id', 'role_code'], nullsNotDistinct: true }],
  checks: [
    { name: 'user_or_role', expression: '(user_id is not null) <> (role_code is not null)' },
  ],
});
