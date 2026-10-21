/**
 * `npm run db:seed` — demo businesses with realistic data, for local testing.
 *
 *   npm run db:seed                -- create the demo tenants (skips ones that exist)
 *   npm run db:seed -- --fresh     -- delete the demo tenants first, then create them again
 *
 * It builds each tenant exactly the way the super admin panel does:
 *
 *   Super Admin ──► Tenant ──► Branches ──► Users (owner, one admin + one sales per branch)
 *
 * so the demo data always has the same shape as real data. Run
 * `npm run seed:superadmin` once before this — every tenant is created by the
 * super admin, and this script refuses to run without one.
 *
 * Never point this at production: --fresh deletes data.
 */
import '../bootstrap.js';
import { closePool, checkConnection, pool } from '../core/db/pool.js';
import { asPlatform, asTenant } from '../core/db/client.js';
import { syncSchema } from '../core/db/schema/sync.js';
import { isProduction } from '../core/config/env.js';
import { createBranch, createTenant, createTenantUser } from '../modules/platform/provisioning.service.js';
import { createOrder } from '../modules/orders/orders.service.js';
import { checkout } from '../modules/sales/sales.service.js';
import { createInward } from '../modules/purchase/purchase.service.js';
import { repo } from '../core/db/repository.js';
import { logger } from '../core/util/logger.js';
import type { Tx } from '../core/db/client.js';
import type { TenantKind } from '../modules/tenancy/module-catalog.js';

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);
const today = () => new Date().toISOString().slice(0, 10);
const daysAway = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** Every demo login uses this password. */
const DEMO_PASSWORD = 'demo12345';

interface BranchSeed { code: string; name: string; city: string; state: string; stateCode: string }

interface TenantSeed {
  code: string; legalName: string; displayName: string;
  kind: TenantKind;
  stateCode: string; gstin: string;
  /** The first branch is the head office. */
  branches: BranchSeed[];
  theme: string;
}

const TENANTS: TenantSeed[] = [
  {
    code: 'aarohi', legalName: 'Aarohi Heritage Jewellers Pvt Ltd', displayName: 'Aarohi Heritage Jewellers',
    kind: 'retailer', stateCode: '27', gstin: '27AABCA1234K1ZP', theme: 'deep-forest',
    branches: [
      { code: 'ZB', name: 'Zaveri Bazaar Flagship', city: 'Mumbai', state: 'Maharashtra', stateCode: '27' },
      { code: 'BW', name: 'Bandra West Boutique', city: 'Mumbai', state: 'Maharashtra', stateCode: '27' },
      { code: 'CP', name: 'Connaught Place Vault & Lounge', city: 'New Delhi', state: 'Delhi', stateCode: '07' },
    ],
  },
  {
    code: 'tanishka', legalName: 'Tanishka Royal Gems LLP', displayName: 'Tanishka Royal Gems',
    kind: 'both', stateCode: '08', gstin: '08AACCT5678M1Z4', theme: 'royal-ruby',
    branches: [{ code: 'MIR', name: 'M.I. Road Showroom', city: 'Jaipur', state: 'Rajasthan', stateCode: '08' }],
  },
];

const CATEGORIES = [
  { code: 'RING', name: 'Rings', hsn: '7113' },
  { code: 'NECK', name: 'Necklaces / Chokers', hsn: '7113' },
  { code: 'BANG', name: 'Bangles / Kada', hsn: '7113' },
  { code: 'CHAIN', name: 'Chains', hsn: '7113' },
  { code: 'EARR', name: 'Earrings / Jhumkas', hsn: '7113' },
  { code: 'COIN', name: 'Coins & Bars', hsn: '7118' },
  { code: 'PUJA', name: 'Puja Articles & Utensils', hsn: '7114' },
];

const KARIGARS = [
  { code: 'KAR-1', name: 'Master Shyam Soni', speciality: 'Bridal Sets', workshop: 'Shyam Soni Works', ghat: '1.5', rate: '480' },
  { code: 'KAR-2', name: 'Farooq Zariwala', speciality: 'Kundan Meena', workshop: 'Zariwala Fine Mounts', ghat: '2.0', rate: '620' },
  { code: 'KAR-3', name: 'Ramesh Goldsmith', speciality: 'Chains & Bangles', workshop: 'Rajasthan Heritage Crafts', ghat: '1.2', rate: '390' },
];

const CUSTOMERS = [
  { code: 'C-001', name: 'Ananya Sharma', phone: '9820011223', city: 'Mumbai', state: 'Maharashtra', stateCode: '27' },
  { code: 'C-002', name: 'Vikramaditya Singhania', phone: '9820044556', city: 'Mumbai', state: 'Maharashtra', stateCode: '27' },
  { code: 'C-003', name: 'Meenakshi Sundaram', phone: '9840077889', city: 'Chennai', state: 'Tamil Nadu', stateCode: '33' },
  { code: 'C-004', name: 'Ishita Mehta', phone: '9820099001', city: 'Mumbai', state: 'Maharashtra', stateCode: '27' },
  { code: 'C-005', name: 'Nirali Shah', phone: '9820033445', city: 'Surat', state: 'Gujarat', stateCode: '24' },
  { code: 'C-006', name: 'Kavya Trivedi', phone: '9898011223', city: 'Ahmedabad', state: 'Gujarat', stateCode: '24' },
  { code: 'C-007', name: 'Sanjay Deshmukh', phone: '9823011223', city: 'Pune', state: 'Maharashtra', stateCode: '27' },
  { code: 'C-008', name: 'Sunita Parekh', phone: '9820066778', city: 'Mumbai', state: 'Maharashtra', stateCode: '27' },
];

const SUPPLIERS = [
  { code: 'S-001', name: 'MMTC-PAMP India', city: 'New Delhi', stateCode: '07', gstin: '07AAACM1234F1Z5' },
  { code: 'S-002', name: 'Mumbai Bullion Traders', city: 'Mumbai', stateCode: '27', gstin: '27AABCU9603R1ZM' },
];

interface Login { email: string; role: string; branch: string }

/**
 * Step 1 — the tenant, its branches and its people, created through the same
 * service functions the super admin's API calls.
 */
async function createDemoTenant(seed: TenantSeed, superAdminId: string) {
  const [head, ...others] = seed.branches;
  const logins: Login[] = [];

  // The tenant comes with its head-office branch, roles, accounts, purities and the owner.
  const ownerEmail = `owner@${seed.code}.test`;
  const { tenantId, branchId } = await createTenant({
    code: seed.code, legalName: seed.legalName, displayName: seed.displayName,
    kind: seed.kind, gstin: seed.gstin, stateCode: seed.stateCode,
    admin: { email: ownerEmail, fullName: `${seed.displayName} Owner`, password: DEMO_PASSWORD },
    branch: { code: head!.code, name: head!.name, city: head!.city, state: head!.state, stateCode: head!.stateCode, kind: 'showroom' },
  }, superAdminId);
  logins.push({ email: ownerEmail, role: 'owner', branch: 'all branches' });

  const branches = [{ ...head!, id: branchId as string }];
  for (const b of others) {
    const created = await createBranch(tenantId as string, {
      code: b.code, name: b.name, kind: 'showroom', city: b.city, state: b.state, stateCode: b.stateCode, gstin: seed.gstin,
    }, superAdminId);
    branches.push({ ...b, id: created.id as string });
  }

  // Every branch gets one admin and one sales executive.
  for (const b of branches) {
    for (const role of ['admin', 'sales'] as const) {
      const email = `${role}.${b.code.toLowerCase()}@${seed.code}.test`;
      await createTenantUser(tenantId as string, {
        email, fullName: `${b.name} ${role === 'admin' ? 'Admin' : 'Sales'}`,
        password: DEMO_PASSWORD, roleCode: role, branchId: b.id,
      }, { actorPlatformUserId: superAdminId });
      logins.push({ email, role, branch: b.code });
    }
  }

  await asTenant(tenantId as string, async (tx) => {
    // Real users must change their password at first sign-in; demo users shouldn't have to.
    await tx.query(`update app_user set must_change_password = false`);
    await tx.query(`update tenant_theme set preset_key = $1`, [seed.theme]);
  });

  logger.info({ tenant: seed.code, branches: branches.length, users: logins.length }, 'tenant, branches and users created');
  return { tenantId: tenantId as string, headBranchId: branchId as string, logins };
}

/** Step 2 — masters: categories, karigars, customers, suppliers, rates, items, a scheme. */
async function seedMasters(tenantId: string, seed: TenantSeed) {
  await asTenant(tenantId, async (tx) => {
    const categories = new Map<string, string>();
    for (const [i, c] of CATEGORIES.entries()) {
      const row = await repo(tx, 'item_category').insert({ code: c.code, name: c.name, hsn_code: c.hsn, sort_order: i });
      categories.set(c.code, (row as { id: string }).id);
    }

    for (const k of KARIGARS) {
      await repo(tx, 'karigar').insert({
        code: k.code, name: k.name, workshop_name: k.workshop, speciality: k.speciality,
        engagement: 'external', standard_ghat_percent: k.ghat, labour_rate_per_gram: k.rate, is_active: true,
      });
    }

    const parties = new Map<string, string>();
    for (const c of CUSTOMERS) {
      const row = await repo(tx, 'party').insert({
        code: c.code, name: c.name, is_customer: true, party_type: 'individual',
        phone: c.phone, city: c.city, state: c.state, state_code: c.stateCode,
        kyc_status: 'verified', is_active: true,
      });
      parties.set(c.code, (row as { id: string }).id);
    }
    for (const s of SUPPLIERS) {
      const row = await repo(tx, 'party').insert({
        code: s.code, name: s.name, is_supplier: true, party_type: 'business',
        city: s.city, state_code: s.stateCode, gstin: s.gstin, credit_days: 30, is_active: true,
      });
      parties.set(s.code, (row as { id: string }).id);
    }

    const metals = await tx.query<{ id: string; code: string }>(`select id, code from metal`);
    const purities = await tx.query<{ id: string; code: string; metal_id: string }>(`select id, code, metal_id from purity`);
    const gold = metals.find((m) => m.code === 'GOLD')!;
    const silver = metals.find((m) => m.code === 'SILVER')!;
    const p22 = purities.find((p) => p.code === '22K')!;
    const p18 = purities.find((p) => p.code === '18K')!;
    const p999 = purities.find((p) => p.code === '999' && p.metal_id === silver.id)!;

    // Today's broadcast rates
    for (const [purity, sell, buy] of [[p22, '6860', '6640'], [p18, '5615', '5420'], [p999, '88', '84']] as const) {
      await repo(tx, 'metal_rate').insert({
        metal_id: purity.metal_id, purity_id: purity.id,
        rate_per_gram: sell, buying_rate_per_gram: buy, source: 'manual',
      });
    }

    const items = new Map<string, string>();
    const itemDefs = [
      { code: 'GOLD-22K-BULK', name: '22K Gold (bulk)', tracking: 'lot', nature: 'raw_metal', metal: gold.id, purity: p22.id, cat: null, making: '0' },
      { code: 'RING-22K', name: 'Gold Ring 22K', tracking: 'piece', nature: 'finished', metal: gold.id, purity: p22.id, cat: 'RING', making: '520' },
      { code: 'NECK-22K', name: 'Bridal Necklace Set 22K', tracking: 'piece', nature: 'finished', metal: gold.id, purity: p22.id, cat: 'NECK', making: '680' },
      { code: 'BANG-22K', name: 'Antique Kada 22K', tracking: 'piece', nature: 'finished', metal: gold.id, purity: p22.id, cat: 'BANG', making: '610' },
      { code: 'CHAIN-22K', name: 'Gents Gold Chain 22K', tracking: 'piece', nature: 'finished', metal: gold.id, purity: p22.id, cat: 'CHAIN', making: '450' },
      { code: 'EARR-18K', name: 'Diamond Accent Jhumkas 18K', tracking: 'piece', nature: 'finished', metal: gold.id, purity: p18.id, cat: 'EARR', making: '890' },
      { code: 'COIN-24K', name: 'Gold Coin 10g', tracking: 'piece', nature: 'finished', metal: gold.id, purity: purities.find((p) => p.code === '24K')!.id, cat: 'COIN', making: '150' },
      { code: 'PUJA-925', name: 'Silver Puja Thali 925', tracking: 'piece', nature: 'finished', metal: silver.id, purity: p999.id, cat: 'PUJA', making: '45' },
    ];
    for (const d of itemDefs) {
      const row = await repo(tx, 'item').insert({
        code: d.code, name: d.name, nature: d.nature, tracking: d.tracking,
        category_id: d.cat ? categories.get(d.cat) : null, metal_id: d.metal,
        default_purity_id: d.purity, hsn_code: '7113', uom: 'gram', is_active: true,
      });
      items.set(d.code, (row as { id: string }).id);
    }
    // Making per item and 8% wastage on pieces, as Masters → Formulas rules.
    const itemRules = itemDefs.flatMap((d) => [
      ...(Number(d.making) > 0 ? [{ code: `MK-${d.code}`, name: `${d.name} making`, applies_to: 'making', basis: 'per_gram', rate: d.making, item_id: items.get(d.code) }] : []),
      ...(d.tracking === 'piece' ? [{ code: `WS-${d.code}`, name: `${d.name} wastage`, applies_to: 'wastage', basis: 'percent', rate: '8', item_id: items.get(d.code) }] : []),
    ]);
    if (itemRules.length) await repo(tx, 'price_rule').insertMany(itemRules);

    // a scheme plan
    await repo(tx, 'scheme_plan').insert({
      code: 'SN-11P1', name: 'Swarna Nidhi 11+1', description: 'Pay 11 monthly installments, the 12th is on us.',
      metal_id: gold.id, accrual_basis: 'rupee', tenure_months: 11, installment_amount: '5000',
      bonus_installments: '1', max_missed_installments: '2', grace_period_days: 7,
      allow_partial_redemption: false, allow_cash_redemption: false, is_active: true,
    });

    logger.info({ tenant: seed.code }, 'masters seeded');
  });
}

/** Buy bulk metal, tag a few pieces, raise orders, and bill one sale. */
async function seedTransactions(tenantId: string, branchId: string) {
  await asTenant(tenantId, async (tx: Tx) => {
    const id = async (sql: string, p: unknown[] = []) =>
      (await tx.one<{ id: string }>(sql, p)).id;

    const supplier = await id(`select id from party where code = 'S-002'`);
    const bulk = await id(`select id from item where code = 'GOLD-22K-BULK'`);
    const p22 = await id(`select id from purity where code = '22K'`);
    const vault = await id(`select id from stock_location where branch_id = $1 order by (kind='vault') desc limit 1`, [branchId]);
    const counter = await id(`select id from stock_location where branch_id = $1 order by (kind='counter') desc limit 1`, [branchId]);

    // Documents are raised at a branch.
    (tx.context as { branchId: string | null }).branchId = branchId;

    // 1. buy 500g of 22K, with the bill
    await createInward(tx, {
      supplierId: supplier, locationId: vault,
      lines: [{ itemId: bulk, purityId: p22, grossWeight: '500.000', metalBasis: 'rupee', ratePerGram: '6640' }],
      bill: { supplierInvoiceNumber: 'MBT/2026/4471', supplierInvoiceDate: today() },
    });

    // 2. tag finished pieces (raises stock through the tagging service)
    const { tagAll } = await import('../modules/tagging/tagging.service.js');
    const pieces: string[] = [];
    const tagged = [
      { item: 'RING-22K', gross: '8.450', stone: '0.350', huid: 'X9A7K2', cost: '58000' },
      { item: 'NECK-22K', gross: '62.800', stone: '4.200', huid: 'B3M8P5', cost: '420000' },
      { item: 'BANG-22K', gross: '34.200', stone: '0', huid: 'K7Q2W9', cost: '232000' },
      { item: 'CHAIN-22K', gross: '22.600', stone: '0', huid: 'R4T6Y1', cost: '152000' },
    ];
    for (const [i, t] of tagged.entries()) {
      const itemId = await id(`select id from item where code = $1`, [t.item]);
      const [piece] = await tagAll(tx, [{
        itemId, purityId: p22, locationId: counter, tagNumber: `TAG-882${10 + i}`,
        grossWeight: t.gross, stoneWeight: t.stone,
        huid: t.huid, hallmarkCentre: 'BIS Mumbai AHC-1042',
        costValue: t.cost,
      }], 'opening');
      pieces.push(piece!.id);
    }

    // 3. one order of each type, spread across their pipelines
    const c = async (code: string) => id(`select id from party where code = $1`, [code]);
    const ring = await id(`select id from item where code = 'RING-22K'`);

    await createOrder(tx, {
      orderType: 'booking', customerId: await c('C-004'), branchId,
      orderDate: today(), expectedDeliveryDate: daysAway(6), rateLockType: 'today',
      lockedRatePerGram: '6860', advanceAmount: '25000',
      lines: [{ title: '22K Diamond Accent Bangle', lineMode: 'booking', itemId: ring, purityId: p22,
        grossWeight: '18.500', ratePerGram: '6860', makingRate: '610', wastagePercent: '8' }],
      notes: 'Customer prefers evening pickup after final polishing check.',
    });

    await createOrder(tx, {
      orderType: 'repair', customerId: await c('C-005'), branchId,
      orderDate: today(), expectedDeliveryDate: daysAway(3),
      repairItemDescription: 'Antique 22K necklace with damaged rear clasp and slight chain deformation.',
      repairIssueDescription: 'Clasp broken, chain slightly bent near the third link.',
      repairIssueTypes: ['clasp', 'chain'],
      notes: 'Preserve original antique finish and avoid aggressive polishing.',
    });

    await createOrder(tx, {
      orderType: 'wedding', customerId: await c('C-006'), branchId,
      orderDate: today(), expectedDeliveryDate: daysAway(45),
      eventDate: daysAway(52), eventType: 'Wedding',
      advanceAmount: '250000',
      lines: [
        { title: 'Bridal Necklace Set', lineMode: 'custom', itemId: ring, purityId: p22, grossWeight: '92.500', ratePerGram: '6860', makingRate: '680', wastagePercent: '9' },
        { title: 'Matching Family Bangles', lineMode: 'custom', itemId: ring, purityId: p22, grossWeight: '48.000', ratePerGram: '6860', makingRate: '610', wastagePercent: '8' },
        { title: 'Groom Chain', lineMode: 'booking', itemId: ring, purityId: p22, grossWeight: '26.400', ratePerGram: '6860', makingRate: '450', wastagePercent: '7' },
      ],
      notes: 'Bridal set requires first priority and separate presentation packaging.',
    });

    await createOrder(tx, {
      orderType: 'custom', customerId: await c('C-007'), branchId,
      orderDate: today(), expectedDeliveryDate: daysAway(21),
      requirementDescription: 'Gents gold chain, 22K, byzantine link, approximately 40g.',
      sizeSpecifications: '22 inch, 6mm width', budgetMin: '250000', budgetMax: '320000',
      manufacturingRoute: 'external',
    });

    await createOrder(tx, {
      orderType: 'corporate', customerId: await c('C-003'), branchId,
      orderDate: today(), expectedDeliveryDate: daysAway(30),
      companyName: 'Aurum Hospitality Pvt Ltd', companyGstin: '27AAGCA7788Q1Z9',
      poReference: 'AHPL/PO/2026/0412', creditTerms: 'net_30',
      brandingNotes: 'Each box needs the client monogram on the outer sleeve only.',
      lines: [{ title: 'Executive Gold Coin Gift Box', lineMode: 'custom', itemId: ring, purityId: p22,
        quantity: '25', grossWeight: '10.000', ratePerGram: '6860', makingRate: '150' }],
    });

    // 4. bill one ring, part cash and part UPI; the rest stays on the customer
    await checkout(tx, {
      customerId: await c('C-001'), lines: [{ pieceId: pieces[0] }],
      tenders: [
        { paymentMethodId: await id(`select id from payment_method where code = 'CASH'`), amount: '30000' },
        { paymentMethodId: await id(`select id from payment_method where code = 'UPI'`), amount: '32000', reference: 'UPI99321' },
      ],
    });

    // 5. old gold taken in: credited to the customer to spend on a bill
    const { createIntake } = await import('../modules/oldgold/oldgold.service.js');
    await createIntake(tx, {
      customerId: await c('C-008'), settlement: 'exchange',
      lines: [{ description: 'Old 22K bangle pair, worn', metalId: await id(`select id from metal where code='GOLD'`),
        grossWeight: '22.000', stoneWeight: '1.800', dirtWeight: '0.800', testMethod: 'xrf', testedPurityPercent: '78.200',
        declaredPurityPercent: '91.600', testInstrument: 'Bruker S1 TITAN XRF' }],
    });

    logger.info({ tenantId }, 'transactions seeded');
  });
}

/**
 * Deletes the demo tenants and everything that belongs to them.
 *
 * Rather than keeping a hand-written list of tables in the right order, it
 * finds every table with a `tenant_id` and keeps deleting: a table that still
 * has rows pointing at it fails this pass and succeeds on a later one, once its
 * children are gone. Each delete runs inside a savepoint so one failure doesn't
 * abort the whole transaction.
 */
async function wipeDemoTenants(): Promise<void> {
  await asPlatform(async (tx) => {
    const codes = TENANTS.map((t) => t.code);
    const rows = await tx.query<{ id: string }>(`select id from tenant where code = any($1::text[])`, [codes]);
    if (!rows.length) return;
    const ids = rows.map((r) => r.id);

    const tables = await tx.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = current_schema() and column_name = 'tenant_id' and table_name <> 'tenant'`);
    let remaining = tables.map((t) => t.table_name);

    for (let pass = 1; remaining.length > 0; pass++) {
      const failed: string[] = [];
      for (const table of remaining) {
        await tx.query('savepoint wipe');
        try {
          await tx.query(`delete from "${table}" where tenant_id = any($1::uuid[])`, [ids]);
          await tx.query('release savepoint wipe');
        } catch {
          await tx.query('rollback to savepoint wipe');
          failed.push(table);
        }
      }
      if (failed.length === remaining.length) {
        throw new Error(`Could not delete demo data from: ${failed.join(', ')}`);
      }
      remaining = failed;
    }

    await tx.query(`delete from platform_audit_log where target_tenant_id = any($1::uuid[])`, [ids]);
    await tx.query(`delete from tenant where id = any($1::uuid[])`, [ids]);
    logger.warn({ tenants: codes }, 'demo tenants deleted');
  });
}

async function main(): Promise<void> {
  if (isProduction) {
    console.error('\nRefusing to seed demo data while NODE_ENV=production.\n');
    process.exitCode = 1;
    return;
  }

  await checkConnection();
  await syncSchema(pool, 'safe');

  const superAdmin = await asPlatform((tx) => tx.maybeOne<{ id: string }>(
    `select id from platform_user where is_active = true and deleted_at is null order by created_at limit 1`));
  if (!superAdmin) {
    console.error(`
There is no super admin yet, and every tenant is created by one. Run this first:

  npm run seed:superadmin -- --password='...'
`);
    process.exitCode = 1;
    return;
  }

  if (has('fresh')) await wipeDemoTenants();

  const existing = await asPlatform((tx) => tx.query<{ code: string }>(
    `select code from tenant where code = any($1::text[]) and deleted_at is null`, [TENANTS.map((t) => t.code)]));
  const skip = new Set(existing.map((r) => r.code));

  const logins: Array<Login & { tenant: string }> = [];
  for (const seed of TENANTS) {
    if (skip.has(seed.code)) {
      console.log(`  ${seed.code}: already exists — skipped (use --fresh to recreate it)`);
      continue;
    }
    const { tenantId, headBranchId, logins: created } = await createDemoTenant(seed, superAdmin.id);
    await seedMasters(tenantId, seed);
    await seedTransactions(tenantId, headBranchId);
    logins.push(...created.map((l) => ({ ...l, tenant: seed.code })));
  }

  if (!logins.length) {
    console.log('\nNothing new to create.\n');
    return;
  }

  const first = logins[0]!;
  console.log(`
Demo tenants ready. Every password is ${DEMO_PASSWORD}

  ${'tenant'.padEnd(10)} ${'role'.padEnd(7)} ${'branch'.padEnd(14)} email
${logins.map((l) => `  ${l.tenant.padEnd(10)} ${l.role.padEnd(7)} ${l.branch.padEnd(14)} ${l.email}`).join('\n')}

  curl -s localhost:4000/api/auth/login -H 'content-type: application/json' \\
    -d '{"tenantCode":"${first.tenant}","identifier":"${first.email}","password":"${DEMO_PASSWORD}"}'

  Docs: http://localhost:4000/dev-docs
`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(closePool);
