/** Master Data & Rate Hub — the reference data every other module points at. */
import { z } from 'zod';
import { defineRoute } from '../core/http/route-registry.js';
import { defineCrud } from './crud.js';
import { transaction, type Tx } from '../core/db/client.js';
import { repo } from '../core/db/repository.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors/app-error.js';
import { recordAudit } from '../core/audit.js';
import { param } from '../core/http/middleware.js';
import {
  assertBranchAllowance, assertBranchCodeFree, seedBranchLocations, type BranchKind,
} from '../modules/tenancy/branch.service.js';
import { compare } from '../core/util/decimal.js';
import { normalizePhone } from '../modules/identity/auth.service.js';
import { nextDocumentNumber } from '../modules/numbering/numbering.service.js';
import { boolParam, decimal, errorEnvelope, gstin, money, pan, phone, record, uuid } from './schemas.js';

const TODAY = '2026-09-18';
const MASTERS_DAY = '2026-09-29';
const seed = [{ date: TODAY, kind: 'added' as const, note: 'Initial master endpoints.' }];
const B = '/api/master';
type Row = Record<string, unknown>;

/* ---------------------------------------------------------- shared rules */

const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v);

/** GSTIN starts with the state code, and the state code decides CGST+SGST versus IGST. */
export function withGstState(v: Row): Row {
  const out = { ...v };
  for (const key of ['gstin', 'pan', 'code']) if (typeof out[key] === 'string') out[key] = upper(out[key]);
  if (typeof out.gstin === 'string' && out.gstin) out.state_code = out.gstin.slice(0, 2);
  if (typeof out.phone === 'string' && out.phone.trim()) out.phone = normalizePhone(out.phone);
  return out;
}

/** Only one row may carry a flag (head office, default purity); setting it clears the rest of its group. */
async function claimFlag(tx: Tx, table: string, flag: string, where = 'true', params: unknown[] = []): Promise<void> {
  await tx.query(`update ${table} set ${flag} = false, updated_at = now() where ${flag} and ${where}`, params);
}

/* ------------------------------------------------------------- branches */

defineCrud({
  basePath: B, resource: 'branches', table: 'branch', module: 'master', label: 'branch',
  permission: 'master.branch', searchColumns: ['code', 'name', 'city'], defaultOrder: 'is_head_office desc, code',
  filters: { kind: z.enum(['showroom', 'factory', 'warehouse', 'office']).optional(), is_active: boolParam.optional() },
  changelog: [...seed, { date: MASTERS_DAY, kind: 'changed', note: 'Added is_head_office (one per business). state_code is set from the GSTIN. Code, address, email and GSTIN can be edited. The last active branch cannot be deactivated.' }],
  createSchema: z.object({
    code: z.string().min(1).max(20), name: z.string().min(1),
    kind: z.enum(['showroom', 'factory', 'warehouse', 'office']).default('showroom'),
    gstin: gstin.optional().describe('Its first two digits become state_code.'),
    state_code: z.string().max(2).optional().describe('Only needed without a GSTIN.'),
    address_line1: z.string().optional(), city: z.string().optional(), state: z.string().optional(),
    pincode: z.string().optional(), phone: phone.optional(), email: z.string().email().optional(),
    is_head_office: z.boolean().default(false).describe('Principal place of business. Setting it moves it from any other branch.'),
  }),
  updateSchema: z.object({
    code: z.string().min(1).max(20).optional(), name: z.string().min(1).optional(),
    gstin: gstin.nullish(), state_code: z.string().max(2).nullish(),
    address_line1: z.string().nullish(), city: z.string().nullish(), state: z.string().nullish(),
    pincode: z.string().nullish(), phone: phone.nullish(), email: z.string().email().nullish(),
    is_head_office: z.boolean().optional(), is_active: z.boolean().optional(),
  }),
  hooks: {
    /*
     * The same three steps the console's own branch creation takes, through
     * `branch.service`: the plan's branch allowance, a free code, and the stock
     * locations afterwards. A branch added here used to get no locations at all,
     * so the first sale at it would fail.
     */
    beforeCreate: async (tx, v) => {
      await assertBranchAllowance(tx);
      await assertBranchCodeFree(tx, String(v.code));
      if (v.is_head_office) await claimFlag(tx, 'branch', 'is_head_office');
      return withGstState(v);
    },
    afterCreate: async (tx, created, values) => {
      await seedBranchLocations(tx, String(created.id), (values.kind as BranchKind) ?? 'showroom');
    },
    beforeUpdate: async (tx, v, current) => {
      if (v.code && String(v.code).toLowerCase() !== String(current.code).toLowerCase()) {
        await assertBranchCodeFree(tx, String(v.code), String(current.id));
      }
      if (v.is_head_office && !current.is_head_office) await claimFlag(tx, 'branch', 'is_head_office');
      if (v.is_active === false && current.is_active) {
        const others = await tx.one<{ n: number }>(
          `select count(*)::int n from branch where is_active and deleted_at is null and id <> $1`, [current.id]);
        if (others.n === 0) throw new BusinessRuleError('This is the only active branch. Add or activate another before deactivating it.', 'last_branch');
      }
      return withGstState(v);
    },
  },
});

/* ------------------------------------------------- customers & suppliers */

const partyFields = {
  name: z.string().min(1).describe('Customer name is required.'),
  party_type: z.enum(['individual', 'business']).default('individual'),
  phone: phone.optional().describe('10-digit Indian numbers are stored as +91XXXXXXXXXX.'),
  email: z.string().email().optional(),
  gstin: gstin.optional().describe('Its first two digits become state_code.'), pan: pan.optional(),
  state_code: z.string().max(2).optional(),
  address_line1: z.string().optional(), city: z.string().optional(), state: z.string().optional(),
  pincode: z.string().optional(), credit_limit: money.optional(), credit_days: z.number().int().min(0).optional(),
  date_of_birth: z.string().optional(), anniversary: z.string().optional(), notes: z.string().optional(),
};
export const partyShape = z.object({
  code: z.string().min(1).max(30).optional().describe('Leave out to get the next code, e.g. C000124.'),
  is_customer: z.boolean().default(false), is_supplier: z.boolean().default(false),
  ...partyFields,
});
export const customerOrSupplier = [(v: { is_customer: boolean; is_supplier: boolean }) => v.is_customer || v.is_supplier,
  { message: 'Mark the party as a customer, a supplier, or both.' }] as const;
const partyCreate = partyShape.refine(...customerOrSupplier);

export async function prepareParty(tx: Tx, v: Row): Promise<Row> {
  return withGstState({ ...v, code: v.code ?? (await nextDocumentNumber(tx, 'party')).number });
}

defineCrud({
  basePath: B, resource: 'parties', table: 'party', module: 'master', label: 'customer or supplier',
  permission: 'master.customer', searchColumns: ['name', 'phone', 'code'], defaultOrder: 'name', keyset: { column: 'name' },
  listSelect: `*,
    (select coalesce(sum(si.total_amount), 0)::text from sales_invoice si
      where si.customer_id = party.id and si.status = 'posted') as lifetime_spend,
    (select count(*)::int from scheme_account sa
      where sa.customer_id = party.id and sa.status = 'active') as active_schemes`,
  filters: {
    is_customer: boolParam.optional(), is_supplier: boolParam.optional(),
    is_active: boolParam.optional(), city: z.string().optional(), gstin: gstin.optional(),
  },
  changelog: [
    ...seed,
    { date: TODAY, kind: 'changed', note: 'One table serves customers and suppliers; filter with is_customer / is_supplier.' },
    { date: MASTERS_DAY, kind: 'changed', note: 'code is optional (the next C000001-style code is used). Phones are stored as +91XXXXXXXXXX, state_code comes from the GSTIN. Lists carry lifetime_spend and active_schemes.' },
  ],
  createSchema: partyCreate,
  updateSchema: z.object(Object.fromEntries(Object.entries({
    ...partyFields, is_customer: z.boolean(), is_supplier: z.boolean(),
    kyc_status: z.enum(['none', 'pending', 'verified', 'rejected']), is_active: z.boolean(),
  }).map(([k, s]) => [k, (s as z.ZodType).nullish()]))),
  hooks: {
    beforeCreate: prepareParty,
    beforeUpdate: (_tx, v) => withGstState(v),
  },
});

/* ------------------------------------------------------------ products */

defineCrud({
  basePath: B, resource: 'items', table: 'item', module: 'master', label: 'item',
  permission: 'master.item', searchColumns: ['code', 'name', 'hsn_code'], defaultOrder: 'code', keyset: { column: 'code' },
  filters: {
    nature: z.enum(['raw_metal', 'finished', 'stone', 'consumable', 'service']).optional(),
    tracking: z.enum(['lot', 'piece']).optional(), is_active: boolParam.optional(), category_id: uuid.optional(),
  },
  changelog: [...seed, { date: TODAY, kind: 'added', note: '`tracking` decides whether stock is counted in pieces or grams.' }],
  createSchema: z.object({
    code: z.string().min(1).max(40), name: z.string().min(1),
    nature: z.enum(['raw_metal', 'finished', 'stone', 'consumable', 'service']).default('finished'),
    tracking: z.enum(['lot', 'piece']).default('piece')
      .describe('piece = individually tagged and counted. lot = bulk metal, measured in grams only.'),
    category_id: uuid.optional(), metal_id: uuid.optional(), default_purity_id: uuid.optional(),
    hsn_code: z.string().optional().describe('7113 for jewellery articles.'),
    uom: z.enum(['gram', 'piece', 'carat', 'millilitre']).default('gram'),
  }),
  updateSchema: z.object({
    name: z.string().min(1).optional(), category_id: uuid.nullish(), default_purity_id: uuid.nullish(),
    hsn_code: z.string().nullish(), is_active: z.boolean().optional(),
  }),
});

/** jsonb must be sent as JSON text — node-pg turns JS arrays into Postgres arrays. */
const jsonArrays = (v: Row): Row => {
  const out = { ...v };
  for (const key of ['sub_categories', 'applicable_metals']) if (Array.isArray(out[key])) out[key] = JSON.stringify(out[key]);
  return out;
};

async function checkMakingRule(tx: Tx, v: Row): Promise<Row> {
  if (v.making_rule_id) {
    const rule = await tx.maybeOne<{ applies_to: string }>(
      `select applies_to from price_rule where id = $1 and deleted_at is null`, [v.making_rule_id]);
    if (rule?.applies_to !== 'making') throw new ValidationError('Choose a making-charge rule for the category.');
  }
  return jsonArrays(v);
}

const categoryFields = {
  name: z.string().min(1), hsn_code: z.string().regex(/^\d{4,8}$/, 'HSN codes are 4 to 8 digits.'),
  sub_categories: z.array(z.string().trim().min(1).max(60)).max(50).describe('Names shown under the category.'),
  applicable_metals: z.array(z.string().trim().toUpperCase()).max(10).describe('Metal codes. Empty = any metal.'),
  making_rule_id: uuid.describe('Default making-charge rule.'),
  sort_order: z.number().int(),
};

defineCrud({
  basePath: B, resource: 'categories', table: 'item_category', module: 'master', label: 'category',
  permission: 'master.item', searchColumns: ['code', 'name'], defaultOrder: 'sort_order, name',
  filters: { is_active: boolParam.optional() },
  changelog: [...seed, { date: MASTERS_DAY, kind: 'changed', note: 'Added sub_categories, applicable_metals and making_rule_id. Code can be edited.' }],
  createSchema: z.object({
    code: z.string().min(1).max(30), parent_id: uuid.optional(),
    ...categoryFields,
    hsn_code: categoryFields.hsn_code.optional(),
    sub_categories: categoryFields.sub_categories.default([]),
    applicable_metals: categoryFields.applicable_metals.default([]),
    making_rule_id: categoryFields.making_rule_id.optional(),
    sort_order: categoryFields.sort_order.default(0),
  }),
  updateSchema: z.object({
    code: z.string().min(1).max(30).optional(), name: categoryFields.name.optional(),
    hsn_code: categoryFields.hsn_code.nullish(), sub_categories: categoryFields.sub_categories.optional(),
    applicable_metals: categoryFields.applicable_metals.optional(), making_rule_id: categoryFields.making_rule_id.nullish(),
    sort_order: categoryFields.sort_order.optional(), is_active: z.boolean().optional(),
  }),
  hooks: {
    beforeCreate: (tx, v) => checkMakingRule(tx, { ...v, code: upper(v.code) }),
    beforeUpdate: (tx, v) => checkMakingRule(tx, v.code ? { ...v, code: upper(v.code) } : v),
  },
});

/* -------------------------------------------------------------- metals */

const purityDisplay = {
  notation: z.enum(['karat', 'fineness', 'percentage']).describe('How it is written: 22K, 916 or 91.6%.'),
  default_unit: z.enum(['g', 'kg', 'tola', 'oz']).describe('Unit forms start in. Stored weights are always grams.'),
  is_default: z.boolean().describe('Pre-selected for its metal. Setting it moves it from the metal’s other purities.'),
  description: z.string().max(200),
};

/** Karat is worked out from fineness for gold, to the whole karat the trade uses (91.6% → 22K), so the two never disagree. */
async function preparePurity(tx: Tx, v: Row, metalId: string): Promise<Row> {
  const out = { ...v };
  if (out.is_default) await claimFlag(tx, 'purity', 'is_default', 'metal_id = $1', [metalId]);
  if (out.fineness_percent !== undefined) {
    const metal = await tx.one<{ code: string }>(`select code from metal where id = $1`, [metalId]);
    out.karat = metal.code === 'GOLD' ? String(Math.round((Number(out.fineness_percent) * 24) / 100)) : null;
  }
  return out;
}

defineCrud({
  basePath: B, resource: 'purities', table: 'purity', module: 'master', label: 'purity',
  permission: 'master.purity', searchColumns: ['code', 'name'], defaultOrder: 'sort_order, code',
  filters: { metal_id: uuid.optional(), is_active: boolParam.optional() },
  changelog: [...seed, { date: MASTERS_DAY, kind: 'changed', note: 'Added notation, default_unit, is_default (one per metal) and description. code is optional; karat is derived from fineness for gold.' }],
  createSchema: z.object({
    metal_id: uuid, name: z.string().min(1),
    code: z.string().min(1).max(20).optional().describe('e.g. 22K. Left out: taken from the name.'),
    fineness_percent: decimal.describe('91.600 for 22K. Everything calculates from this.'),
    is_hallmarkable: z.boolean().default(true),
    sort_order: z.number().int().optional().describe('Left out: placed after the metal’s other purities.'),
    notation: purityDisplay.notation.default('karat'), default_unit: purityDisplay.default_unit.default('g'),
    is_default: purityDisplay.is_default.default(false), description: purityDisplay.description.optional(),
  }),
  updateSchema: z.object({
    name: z.string().min(1).optional(), fineness_percent: decimal.optional(),
    is_hallmarkable: z.boolean().optional(), is_active: z.boolean().optional(), sort_order: z.number().int().optional(),
    notation: purityDisplay.notation.optional(), default_unit: purityDisplay.default_unit.optional(),
    is_default: purityDisplay.is_default.optional(), description: purityDisplay.description.nullish(),
  }),
  hooks: {
    beforeCreate: async (tx, v) => preparePurity(tx, {
      ...v,
      code: upper(v.code ?? String(v.name).replace(/[^A-Za-z0-9]/g, '').slice(0, 20)),
      sort_order: v.sort_order ?? (await tx.one<{ next: number }>(
        `select coalesce(max(sort_order), 0) + 1 as next from purity where metal_id = $1`, [v.metal_id])).next,
    }, String(v.metal_id)),
    beforeUpdate: (tx, v, current) => preparePurity(tx, v, String(current.metal_id)),
  },
});

defineCrud({
  basePath: B, resource: 'metals', table: 'metal', module: 'master', label: 'metal',
  permission: 'master.purity', searchColumns: ['code', 'name'], defaultOrder: 'sort_order', changelog: seed,
  createSchema: z.object({ code: z.string().min(1).max(20), name: z.string().min(1),
    hsn_code: z.string().optional(), sort_order: z.number().int().default(0) }),
  updateSchema: z.object({ name: z.string().min(1).optional(), is_active: z.boolean().optional() }),
});

/* ------------------------------------------------------------ karigars */

const karigarFields = {
  name: z.string().min(1), workshop_name: z.string(),
  engagement: z.enum(['in_house', 'external']),
  speciality: z.string().describe('e.g. "Bridal Sets", "Kundan Meena".'),
  phone, address: z.string(), pan, gstin,
  standard_ghat_percent: decimal.describe('Agreed metal loss allowance, in percent.'),
  labour_rate_per_gram: money,
};
export const karigarCreate = z.object({
  code: z.string().min(1).max(30).optional().describe('Leave out to get the next code, e.g. K0012.'),
  ...Object.fromEntries(Object.entries(karigarFields).map(([k, s]) => [k, k === 'name' ? s : (s as z.ZodType).optional()])),
  engagement: karigarFields.engagement.default('external'),
});

export async function prepareKarigar(tx: Tx, v: Row): Promise<Row> {
  return withGstState({ ...v, code: v.code ?? (await nextDocumentNumber(tx, 'karigar')).number });
}

defineCrud({
  basePath: B, resource: 'karigars', table: 'karigar', module: 'master', label: 'karigar',
  permission: 'master.karigar', searchColumns: ['code', 'name', 'workshop_name', 'speciality'], defaultOrder: 'name',
  keyset: { column: 'name' },
  listSelect: `*, (select count(*)::int from retail_order o where o.karigar_id = karigar.id and o.status = 'active') as active_orders`,
  filters: { engagement: z.enum(['in_house', 'external']).optional(), is_active: boolParam.optional() },
  changelog: [
    ...seed,
    { date: TODAY, kind: 'added', note: 'Karigar master with ghat (metal loss) allowance.' },
    { date: MASTERS_DAY, kind: 'changed', note: 'Paged by name with a cursor; carries active_orders. code is optional. Every field can be edited.' },
  ],
  createSchema: karigarCreate,
  updateSchema: z.object({
    ...Object.fromEntries(Object.entries(karigarFields).map(([k, s]) => [k, (s as z.ZodType).nullish()])),
    is_active: z.boolean().optional(),
  }),
  hooks: {
    beforeCreate: prepareKarigar,
    // A cleared allowance or labour rate means none, which is stored as 0.
    beforeUpdate: (_tx, v) => withGstState({
      ...v,
      ...(v.standard_ghat_percent === null ? { standard_ghat_percent: '0' } : {}),
      ...(v.labour_rate_per_gram === null ? { labour_rate_per_gram: '0' } : {}),
    }),
  },
});

/* ---------------------------------------------------- stock locations */

defineCrud({
  basePath: B, resource: 'locations', table: 'stock_location', module: 'master', label: 'stock location',
  permission: 'master.branch', searchColumns: ['code', 'name'], defaultOrder: 'code',
  filters: { branch_id: uuid.optional(), kind: z.enum(['counter', 'vault', 'window', 'floor', 'transit', 'karigar']).optional() },
  changelog: seed,
  createSchema: z.object({ branch_id: uuid, code: z.string().min(1).max(20), name: z.string().min(1),
    kind: z.enum(['counter', 'vault', 'window', 'floor', 'transit', 'karigar']).default('counter'),
    is_default: z.boolean().default(false) }),
  updateSchema: z.object({ name: z.string().min(1).optional(), is_default: z.boolean().optional(), is_active: z.boolean().optional() }),
});

/* ------------------------------------------------------------ rate hub */

const RATES_DAY = '2026-10-10';

defineRoute({
  method: 'get', path: '/api/master/rates/current', module: 'master',
  summary: 'Today’s rate for every active purity',
  description:
    'One row per active purity, with its latest rate (a branch rate beats the shared one) and the last rate before today, for the day’s change. A purity with no rate yet has null rate fields — POS refuses to bill it with `rate_missing`.\n\n' +
    'Send `configured=true` for the Rates screen: only the metal + purity pairs the shop has set a rate for. `is_today` is false for a rate last set before today (shop time zone), so the screen can ask for today’s rate.',
  permission: 'master.rates.view',
  query: z.object({
    branchId: uuid.optional(),
    configured: boolParam.optional().describe('true = only purities that have a rate.'),
  }),
  responses: [{ status: 200, description: 'Current rates.', schema: z.object({ rates: z.array(z.object({
    purity_id: uuid, purity_code: z.string(), purity_name: z.string(), fineness_percent: decimal,
    metal_id: uuid, metal_code: z.string(), metal_name: z.string(),
    id: uuid.nullable(), rate_per_gram: money.nullable(), buying_rate_per_gram: money.nullable(),
    effective_from: z.string().nullable(), source: z.string().nullable(),
    previous_rate_per_gram: money.nullable().describe('Last rate set before today (shop time zone).'),
    rate_branch_id: uuid.nullable().describe('Null = the rate is shared by every branch.'),
    set_by_name: z.string().nullable().describe('Who set the current rate.'),
    is_today: z.boolean().describe('The current rate was set today.'),
  })) }) }],
  changelog: [
    ...seed,
    { date: TODAY, kind: 'changed', note: 'Branch rates now override the shared rate.' },
    { date: MASTERS_DAY, kind: 'changed', note: 'One row per active purity, including purities with no rate yet. Adds metal_name, purity_name, source and previous_rate_per_gram.' },
    { date: RATES_DAY, kind: 'added', note: '`configured=true` lists only purities with a rate. Adds rate_branch_id, set_by_name and is_today. Removed rates are left out.' },
  ],
  handler: async (req) => {
    const q = req.query as { branchId?: string; configured?: boolean };
    return transaction(async (tx) => ({
      rates: await tx.query(
        `select p.id as purity_id, p.code as purity_code, p.name as purity_name, p.fineness_percent,
                m.id as metal_id, m.code as metal_code, m.name as metal_name,
                r.id, r.rate_per_gram, r.buying_rate_per_gram, r.effective_from, r.source,
                r.branch_id as rate_branch_id, u.full_name as set_by_name,
                coalesce(r.effective_from >= t.day_start, false) as is_today,
                prev.rate_per_gram as previous_rate_per_gram
           from purity p
           join metal m on m.id = p.metal_id and m.is_active
           cross join (select date_trunc('day', now() at time zone timezone) at time zone timezone as day_start
                         from tenant where id = $2) t
           left join lateral (
             select id, rate_per_gram, buying_rate_per_gram, effective_from, source, branch_id, created_by from metal_rate
              where purity_id = p.id and effective_from <= now() and retired_at is null and (branch_id = $1 or branch_id is null)
              order by effective_from desc, branch_id nulls last limit 1) r on true
           left join app_user u on u.id = r.created_by
           left join lateral (
             select rate_per_gram from metal_rate
              where purity_id = p.id and effective_from < t.day_start and retired_at is null and (branch_id = $1 or branch_id is null)
              order by effective_from desc, branch_id nulls last limit 1) prev on true
          where p.is_active ${q.configured ? 'and r.id is not null' : ''}
          order by m.sort_order, p.sort_order, p.code`,
        [q.branchId ?? req.ctx?.branchId ?? null, tx.context.tenantId]),
    }));
  },
});

defineRoute({
  method: 'post', path: '/api/master/rates', module: 'master',
  summary: 'Set today’s rate for a metal and purity',
  description:
    'A new rate is a new row — rates are never edited. Yesterday’s invoices keep pointing at yesterday’s rate, so an old bill can always be explained. Setting a rate for a purity that was removed puts it back on the list. Every screen that picks a metal and purity — billing, orders, old gold, purchase, schemes — uses the latest rate set here.',
  permission: 'master.rates.create',
  body: z.object({
    metal_id: uuid, purity_id: uuid.optional().describe('Omit for a pure-metal rate.'),
    rate_per_gram: money.describe('Sale / billing rate.'),
    buying_rate_per_gram: money.optional().describe('Purchase / buying rate — what you pay for old gold. Normally lower.'),
    branch_id: uuid.optional().describe('Omit to broadcast to every branch.'),
    effective_from: z.string().datetime().optional().describe('Defaults to now.'),
  }),
  responses: [
    { status: 201, description: 'Rate broadcast.', schema: record },
    { status: 400, description: 'Buying rate above selling rate, or the purity belongs to another metal.', schema: errorEnvelope },
    { status: 422, description: 'Rate must be greater than zero, or the metal / purity is switched off.', schema: errorEnvelope },
  ],
  changelog: [
    ...seed,
    { date: RATES_DAY, kind: 'changed', note: 'Refuses a metal or purity that is switched off, and puts a removed purity back on the rate list.' },
  ],
  handler: async (req, res) => {
    const { metal_id, purity_id, rate_per_gram, buying_rate_per_gram, branch_id } = req.body;
    if (branch_id && !req.accessInfo!.branches.some((b) => b.id === branch_id)) {
      throw new ForbiddenError('You cannot set rates for that branch.');
    }
    if (buying_rate_per_gram && compare(buying_rate_per_gram, rate_per_gram) > 0) {
      throw new ValidationError('The buying rate cannot be higher than the selling rate.');
    }
    const rate = await transaction(async (tx) => {
      const metal = await tx.maybeOne<{ name: string; is_active: boolean }>(`select name, is_active from metal where id = $1`, [metal_id]);
      if (!metal) throw new ValidationError('That metal does not exist.');
      if (!metal.is_active) throw new BusinessRuleError(`${metal.name} is switched off in Masters → Purity.`, 'check_failed');
      if (purity_id) {
        const purity = await tx.maybeOne<{ metal_id: string; code: string; is_active: boolean }>(
          `select metal_id, code, is_active from purity where id = $1`, [purity_id]);
        if (!purity || purity.metal_id !== metal_id) {
          throw new ValidationError('That purity does not belong to the selected metal.');
        }
        if (!purity.is_active) throw new BusinessRuleError(`${purity.code} is switched off in Masters → Purity.`, 'check_failed');
      }
      const row = await repo(tx, 'metal_rate').insert(req.body) as { id: string };
      await recordAudit(tx, 'metal_rate.set', 'metal_rate', row.id, { metal_id, purity_id, rate_per_gram, buying_rate_per_gram, branch_id });
      return row;
    });
    res.status(201).json(rate);
  },
});

defineRoute({
  method: 'delete', path: '/api/master/rates/:purityId', module: 'master',
  summary: 'Remove a metal + purity from the rate list',
  description:
    'Nothing is deleted: its rates stay in history and on every bill that used them, but no new price is taken from them, so billing that purity is refused with `rate_missing` until a rate is set again. Applies to every branch.',
  permission: 'master.rates.delete',
  params: z.object({ purityId: uuid }),
  responses: [
    { status: 200, description: 'Removed.', schema: z.object({ retired: z.number() }) },
    { status: 404, description: 'That purity has no rate on the list.', schema: errorEnvelope },
  ],
  changelog: [{ date: RATES_DAY, kind: 'added', note: 'Remove a rate from the list without losing its history.' }],
  handler: async (req) => transaction(async (tx) => {
    const purityId = param(req, 'purityId');
    const rows = await tx.query<{ id: string }>(
      `update metal_rate set retired_at = now(), updated_at = now(), updated_by = $2
        where purity_id = $1 and retired_at is null returning id`, [purityId, tx.context.userId]);
    if (!rows.length) throw new NotFoundError('Rate for that purity');
    await recordAudit(tx, 'metal_rate.retire', 'purity', purityId, { rows: rows.length });
    return { retired: rows.length };
  }),
});

defineRoute({
  method: 'get', path: '/api/master/rates/history', module: 'master',
  summary: 'Rate history for a purity',
  description: 'Every rate set in the window, newest first, including removed ones (`retired_at` set) and who set each.',
  permission: 'master.rates.view',
  query: z.object({ purityId: uuid, days: z.coerce.number().int().min(1).max(365).default(30) }),
  responses: [{ status: 200, description: 'Rates, newest first.', schema: z.object({ rows: z.array(record) }) }],
  changelog: [
    ...seed,
    { date: RATES_DAY, kind: 'changed', note: 'Adds buying rate, branch, retired_at and set_by_name.' },
  ],
  handler: async (req) => transaction(async (tx) => {
    const q = req.query as unknown as { purityId: string; days: number };
    return { rows: await tx.query(
      `select r.id, r.rate_per_gram, r.buying_rate_per_gram, r.effective_from, r.source, r.retired_at,
              r.branch_id, b.name as branch_name, u.full_name as set_by_name
         from metal_rate r left join branch b on b.id = r.branch_id left join app_user u on u.id = r.created_by
        where r.purity_id = $1 and r.effective_from > now() - make_interval(days => $2)
        order by r.effective_from desc`, [q.purityId, q.days]) };
  }),
});
