/**
 * Setting up a new tenant.
 *
 * A tenant with no chart of accounts, no numbering series and no purities
 * cannot do anything at all — the first invoice would fail on four different
 * missing rows. So provisioning creates a working starting point, and the
 * tenant edits it from there.
 */
import type { Tx } from '../../core/db/client.js';
import { asPlatform, withTenant } from '../../core/db/client.js';
import { newId } from '../../core/util/id.js';
import { logger } from '../../core/util/logger.js';
import { ensureChart } from '../accounts/ledger.service.js';
import { DEFAULT_SERIES } from '../numbering/numbering.service.js';
import { seedSystemRoles } from '../identity/role-seed.js';
import { hashPassword } from '../identity/auth.service.js';
import { MODULE_CATALOG, type TenantKind } from './module-catalog.js';

export interface ProvisionInput {
  code: string;
  legalName: string;
  displayName?: string;
  kind: TenantKind;
  gstin?: string;
  stateCode?: string;
  owner: { email: string; fullName: string; password: string };
  firstBranch?: { code: string; name: string; kind?: 'showroom' | 'factory' | 'warehouse' | 'office' };
}

export async function provisionTenant(
  tx: Tx,
  tenantId: string,
  options: { legalName: string; displayName?: string; stateCode?: string; gstin?: string; kind?: TenantKind; firstBranch?: ProvisionInput['firstBranch'] },
): Promise<{ branchId: string }>;
export async function provisionTenant(input: ProvisionInput): Promise<{
  tenantId: string; branchId: string; ownerUserId: string;
}>;
export async function provisionTenant(
  first: Tx | ProvisionInput,
  second?: string | { legalName: string; displayName?: string; stateCode?: string; gstin?: string; kind?: TenantKind; firstBranch?: ProvisionInput['firstBranch'] },
  third?: { legalName: string; displayName?: string; stateCode?: string; gstin?: string; kind?: TenantKind; firstBranch?: ProvisionInput['firstBranch'] },
): Promise<{ branchId: string; tenantId?: string; ownerUserId?: string }> {
  if ('context' in first) {
    const tx = first as Tx;
    const options = third!;
    const kind = options?.kind ?? 'retailer';
    await enableModules(tx, kind);
    const branchId = await createFirstBranch(tx, {
      code: 'MAIN',
      legalName: options.legalName,
      displayName: options.displayName,
      kind,
      gstin: options.gstin,
      stateCode: options.stateCode,
      firstBranch: options.firstBranch,
      owner: { email: '', fullName: '', password: '' },
    });
    await createAccounts(tx);
    await createNumberingSeries(tx);
    await createMetalsAndPurities(tx);
    await createMasterDefaults(tx);
    return { branchId };
  }

  const input = first as ProvisionInput;
  const { tenantId, result } = await asPlatform(async (tx) => {
    const existing = await tx.maybeOne<{ id: string }>(
      `select id from tenant where lower(code) = lower($1)`, [input.code],
    );
    if (existing) throw new Error(`A tenant with code "${input.code}" already exists.`);

    const id = newId();
    await tx.query(
      `insert into tenant (id, code, legal_name, display_name, kind, status, gstin, activated_at)
       values ($1, $2, $3, $4, $5, 'active', $6, now())`,
      [id, input.code, input.legalName, input.displayName ?? input.legalName, input.kind, input.gstin ?? null],
    );

    const result = await withTenant(tx, id, async (ttx) => {
      await enableModules(ttx, input.kind);
      const branchId = await createFirstBranch(ttx, input);
      await createAccounts(ttx);
      await createNumberingSeries(ttx);
      await createMetalsAndPurities(ttx);
      await createMasterDefaults(ttx);
      await seedSystemRoles(ttx);
      const ownerUserId = await createOwner(ttx, input, branchId);
      return { branchId, ownerUserId };
    });
    return { tenantId: id, result };
  });

  logger.info({ tenantId, code: input.code, kind: input.kind }, 'Tenant provisioned');
  return { tenantId, ...result };
}

async function enableModules(tx: Tx, kind: TenantKind): Promise<void> {
  const applicable = MODULE_CATALOG.filter(
    (m) => m.appliesTo === 'both' || kind === 'both' || m.appliesTo === kind,
  );
  // Trials get a real deadline so the lock behaviour can actually be exercised.
  const trialEnds = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  for (const module of applicable) {
    await tx.query(
      `insert into tenant_module (id, tenant_id, module_key, enabled, licence, trial_ends_at, purchased_at)
       values ($1, $2, $3, true, $4, $5, $6)`,
      [
        newId(), tx.context.tenantId, module.key, module.defaultLicence,
        module.defaultLicence === 'trial' ? trialEnds : null,
        module.defaultLicence === 'purchased' ? new Date() : null,
      ],
    );
  }

  await tx.query(
    `insert into tenant_theme (id, tenant_id, preset_key, css_variables, is_active)
     values ($1, $2, 'deep-forest', '{}'::jsonb, true)`,
    [newId(), tx.context.tenantId],
  );
}

async function createFirstBranch(tx: Tx, input: ProvisionInput): Promise<string> {
  const branchId = newId();
  const branch = input.firstBranch ?? { code: 'MAIN', name: 'Main Branch' };

  await tx.query(
    `insert into branch (id, tenant_id, code, name, kind, gstin, state_code, is_head_office, is_active)
     values ($1, $2, $3, $4, $5, $6, $7, true, true)`,
    [
      branchId, tx.context.tenantId, branch.code, branch.name,
      branch.kind ?? (input.kind === 'manufacturer' ? 'factory' : 'showroom'),
      input.gstin ?? null, input.stateCode ?? null,
    ],
  );

  // Every branch needs somewhere for stock to sit, or the first purchase fails.
  const locations =
    input.kind === 'manufacturer'
      ? [
          { code: 'VAULT', name: 'Vault', kind: 'vault', is_default: true },
          { code: 'FLOOR', name: 'Production Floor', kind: 'floor', is_default: false },
        ]
      : [
          { code: 'COUNTER', name: 'Counter', kind: 'counter', is_default: true },
          { code: 'VAULT', name: 'Vault', kind: 'vault', is_default: false },
          { code: 'WINDOW', name: 'Display Window', kind: 'window', is_default: false },
        ];

  for (const location of locations) {
    await tx.query(
      `insert into stock_location (id, tenant_id, branch_id, code, name, kind, is_default, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, true)`,
      [newId(), tx.context.tenantId, branchId, location.code, location.name, location.kind, location.is_default],
    );
  }

  return branchId;
}

/** The standard chart: Tally-style groups with the ledgers a jewellery shop posts to. */
const createAccounts = (tx: Tx) => ensureChart(tx, true);

/** One shared counter per document type, so every branch draws unique numbers from it. */
async function createNumberingSeries(tx: Tx): Promise<void> {
  for (const series of DEFAULT_SERIES) {
    await tx.query(
      `insert into numbering_series
         (id, tenant_id, doc_type, branch_id, name, prefix, padding, reset_period, next_number, is_active)
       values ($1, $2, $3, null, $4, $5, $6, $7, 1, true)`,
      [
        newId(), tx.context.tenantId, series.doc_type, series.name, series.prefix,
        'padding' in series ? series.padding : 5,
        'reset_period' in series ? series.reset_period : 'financial_yearly',
      ],
    );
  }
}

/** The purities an Indian jeweller actually deals in, as a starting point. */
async function createMetalsAndPurities(tx: Tx): Promise<void> {
  const metals = [
    {
      code: 'GOLD', name: 'Gold', hsn: '7108', sort: 1,
      purities: [
        { code: '24K', name: '24 Karat (999)', fineness: '99.900', karat: '24', sort: 1 },
        { code: '22K', name: '22 Karat (916)', fineness: '91.600', karat: '22', sort: 2 },
        { code: '20K', name: '20 Karat', fineness: '83.300', karat: '20', sort: 3 },
        { code: '18K', name: '18 Karat (750)', fineness: '75.000', karat: '18', sort: 4 },
        { code: '14K', name: '14 Karat (585)', fineness: '58.500', karat: '14', sort: 5 },
      ],
    },
    {
      code: 'SILVER', name: 'Silver', hsn: '7106', sort: 2,
      purities: [
        { code: '999', name: 'Fine Silver (999)', fineness: '99.900', karat: null, sort: 1 },
        { code: '925', name: 'Sterling Silver (925)', fineness: '92.500', karat: null, sort: 2 },
      ],
    },
    {
      code: 'PLATINUM', name: 'Platinum', hsn: '7110', sort: 3,
      purities: [{ code: 'PT950', name: 'Platinum 950', fineness: '95.000', karat: null, sort: 1 }],
    },
  ];

  for (const metal of metals) {
    const metalId = newId();
    await tx.query(
      `insert into metal (id, tenant_id, code, name, hsn_code, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6, true)`,
      [metalId, tx.context.tenantId, metal.code, metal.name, metal.hsn, metal.sort],
    );

    for (const purity of metal.purities) {
      await tx.query(
        `insert into purity (id, tenant_id, metal_id, code, name, fineness_percent, karat, sort_order, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
        [newId(), tx.context.tenantId, metalId, purity.code, purity.name, purity.fineness, purity.karat, purity.sort],
      );
    }
  }
}

/**
 * The business's first Owner — every-branch access, must change the password
 * at first sign-in. seedSystemRoles() must have run first.
 */
async function createOwner(tx: Tx, input: ProvisionInput, _branchId: string): Promise<string> {
  const role = await tx.maybeOne<{ id: string }>(`select id from role where code = 'owner' and deleted_at is null`);
  if (!role) throw new Error('Owner role missing — seedSystemRoles() must run before createOwner().');
  const userId = newId();
  await tx.query(
    `insert into app_user
       (id, tenant_id, email, full_name, password_hash, default_branch_id, must_change_password, is_active)
     values ($1, $2, $3, $4, $5, null, true, true)`,
    [userId, tx.context.tenantId, input.owner.email.toLowerCase(), input.owner.fullName,
     await hashPassword(input.owner.password)],
  );
  await tx.query(
    `insert into user_role (id, tenant_id, user_id, role_id, branch_id) values ($1, $2, $3, $4, null)`,
    [newId(), tx.context.tenantId, userId, role.id],
  );
  return userId;
}

/**
 * Categories, GST defaults and the usual tenders. Idempotent, so it also
 * backfills existing tenants. Every GST row says where it came from — the
 * tenant's CA should confirm them before the first invoice.
 */
export async function createMasterDefaults(tx: Tx): Promise<void> {
  const t = tx.context.tenantId;

  const categories = ['Rings', 'Chains', 'Necklaces', 'Bangles', 'Bracelets', 'Earrings', 'Pendants', 'Mangalsutra', 'Anklets', 'Nose Pins'];
  for (const [i, name] of categories.entries()) {
    await tx.query(
      `insert into item_category (id, tenant_id, code, name, hsn_code, sort_order, is_active)
       values ($1, $2, $3, $4, '7113', $5, true)
       on conflict (tenant_id, code) do nothing`,
      [newId(), t, name.toUpperCase().replace(/\s+/g, '_'), name, i + 1],
    );
  }

  const note = 'Default seeded by Swarnay — have your CA confirm before your first invoice.';
  const gst = [
    { code: '7113', type: 'hsn', component: 'metal', rate: '3', description: 'Articles of jewellery of precious metal' },
    { code: '7108', type: 'hsn', component: 'metal', rate: '3', description: 'Gold — bullion, bars, unwrought' },
    { code: '7106', type: 'hsn', component: 'metal', rate: '3', description: 'Silver — bullion, unwrought' },
    { code: '7110', type: 'hsn', component: 'metal', rate: '3', description: 'Platinum — unwrought' },
    { code: '9988', type: 'sac', component: 'making', rate: '5', description: 'Making charge billed as a separate job-work service' },
    { code: '9988', type: 'sac', component: 'service', rate: '5', description: 'Repair and alteration of jewellery' },
  ];
  for (const g of gst) {
    await tx.query(
      `insert into hsn_gst_rate (id, tenant_id, hsn_code, code_type, description, component, gst_rate, effective_from, source_note)
       values ($1, $2, $3, $4, $5, $6, $7, '2017-07-01', $8)
       on conflict (tenant_id, hsn_code, component, effective_from) do nothing`,
      [newId(), t, g.code, g.type, g.description, g.component, g.rate, note],
    );
  }

  const methods = [
    { code: 'CASH', name: 'Cash', kind: 'cash', ref: false, max: '199999.99' },
    { code: 'UPI', name: 'UPI', kind: 'upi', ref: true, max: null },
    { code: 'CARD', name: 'Card', kind: 'card', ref: true, max: null },
    { code: 'BANK', name: 'Bank Transfer (NEFT/RTGS/IMPS)', kind: 'bank_transfer', ref: true, max: null },
    { code: 'CHEQUE', name: 'Cheque', kind: 'cheque', ref: true, max: null },
    { code: 'OLDGOLD', name: 'Old Gold Exchange', kind: 'old_gold', ref: false, max: null },
    { code: 'SCHEME', name: 'Gold Scheme Redemption', kind: 'scheme', ref: false, max: null },
    { code: 'ADVANCE', name: 'Order Advance', kind: 'advance', ref: false, max: null },
  ];
  for (const [i, m] of methods.entries()) {
    await tx.query(
      `insert into payment_method (id, tenant_id, code, name, kind, requires_reference, max_amount, sort_order, is_active)
       values ($1, $2, $3, $4, $5, $6, $7, $8, true)
       on conflict (tenant_id, code) where deleted_at is null do nothing`,
      [newId(), t, m.code, m.name, m.kind, m.ref, m.max, i + 1],
    );
  }

  // Earlier tenants were seeded with jewellery/silverware codes on the metal itself.
  await tx.query(`update metal set hsn_code = '7108' where code = 'GOLD' and hsn_code = '7113'`);
  await tx.query(`update metal set hsn_code = '7106' where code = 'SILVER' and hsn_code = '7114'`);
}
