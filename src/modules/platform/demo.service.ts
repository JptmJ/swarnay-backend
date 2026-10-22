/**
 * Demo businesses, made from the super admin console with one number: how many.
 *
 * A demo is a real tenant, built through exactly the services the console and
 * the shop use — createTenant, createBranch, createStaffRole, createTenantUser,
 * then purchase, tagging, billing, orders, old gold, schemes, girvi and
 * accounts. Every figure on every screen therefore ties back to the ledger the
 * way it would for a real shop. Only the names, numbers and staff roles are
 * random: each demo gets its own branches, its own named staff roles with their
 * own ticks, and one password shared by everyone in it.
 *
 * A demo takes tens of seconds to fill, so the console asks for a *job* and
 * polls it. Jobs live in this process's memory: they hold the passwords, which
 * are shown once and never written down anywhere else.
 */
import { randomBytes, randomInt } from 'node:crypto';
import type { Tx } from '../../core/db/client.js';
import { asPlatform, asTenant } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError } from '../../core/errors/app-error.js';
import { add, compare, mul, round, sub, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { newId } from '../../core/util/id.js';
import { logger } from '../../core/util/logger.js';
import { nextDocumentNumber } from '../numbering/numbering.service.js';
import { permissionTree, type PermissionTreeNode } from '../identity/permission-catalog.js';
import { invalidateTenantModules } from '../tenancy/module-access.service.js';
import { createBranch, createTenant, createTenantUser } from './provisioning.service.js';
import { createStaffRole } from './tenant-roles.service.js';
import { audit } from './platform-auth.service.js';
import { createInward, createSettlement } from '../purchase/purchase.service.js';
import { tagAll } from '../tagging/tagging.service.js';
import { checkout, createMemo, createReceipt, quote } from '../sales/sales.service.js';
import { addOrderPayment, createOrder, moveStage, pipelineFor } from '../orders/orders.service.js';
import { createIntake } from '../oldgold/oldgold.service.js';
import { collect, enroll } from '../schemes/schemes.service.js';
import { repay, sanction, settlementQuote } from '../girvi/girvi.service.js';
import { createJournal } from '../accounts/journal.service.js';
import type { OrderType } from '../orders/order-pipelines.js';

/* ================================================================ random */

const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)]!;
const chance = (p: number): boolean => Math.random() < p;
const between = (min: number, max: number): number => min + Math.random() * (max - min);
const intBetween = (min: number, max: number): number => randomInt(min, max + 1);
const grams = (min: number, max: number): Decimal => between(min, max).toFixed(3);
const rupees = (min: number, max: number, step = 100): Decimal => String(Math.round(between(min, max) / step) * step);
const shuffle = <T>(list: readonly T[]): T[] => {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = randomInt(i + 1); [out[i], out[j]] = [out[j]!, out[i]!]; }
  return out;
};
const sample = <T>(list: readonly T[], n: number): T[] => shuffle(list).slice(0, Math.max(0, n));
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const letters = (n: number) => Array.from({ length: n }, () => pick([...LETTERS])).join('');
const digits = (n: number) => Array.from({ length: n }, () => String(randomInt(10))).join('');
/** A PAN in the right shape; the fourth letter says what kind of holder it is. */
const fakePan = (holder: 'P' | 'C' | 'F' = 'P') => `${letters(3)}${holder}${letters(1)}${digits(4)}${letters(1)}`;
const fakeGstin = (stateCode: string, holder: 'C' | 'F' = 'C') => `${stateCode}${fakePan(holder)}1Z${pick([...LETTERS, ...'0123456789'])}`;
const mobile = () => `${pick(['9', '8', '7'])}${digits(9)}`;
const reference = (prefix: string) => `${prefix}${digits(8)}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (date: string, days: number) => iso(new Date(new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000));
function addMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return iso(target);
}
/**
 * The first day of the Indian financial year `date` falls in. History is never
 * dated before it, so every back-dated document draws its number from the same
 * year's counter as the ones made today.
 */
const fyStart = (date: string) => {
  const year = Number(date.slice(0, 4));
  return Number(date.slice(5, 7)) >= 4 ? `${year}-04-01` : `${year - 1}-04-01`;
};
const notBefore = (date: string, floor: string) => (date < floor ? floor : date);

/** Easy to read out over the phone, and never shorter than the 8 the API asks for. */
function demoPassword(): string {
  const words = ['Gold', 'Ratna', 'Kanak', 'Moti', 'Heera', 'Sona', 'Panna', 'Neelam', 'Chandi', 'Kundan'];
  return `${pick(words)}-${digits(4)}-${randomBytes(2).toString('hex')}`;
}

/* ================================================================= pools */

const CITIES = [
  { city: 'Mumbai', state: 'Maharashtra', code: '27', pin: '400002', areas: ['Zaveri Bazaar', 'Borivali West', 'Dadar', 'Ghatkopar', 'Thane West'] },
  { city: 'Pune', state: 'Maharashtra', code: '27', pin: '411002', areas: ['Laxmi Road', 'Kothrud', 'Camp', 'Aundh'] },
  { city: 'Ahmedabad', state: 'Gujarat', code: '24', pin: '380001', areas: ['Manek Chowk', 'CG Road', 'Satellite', 'Maninagar'] },
  { city: 'Surat', state: 'Gujarat', code: '24', pin: '395001', areas: ['Ghod Dod Road', 'Varachha', 'Adajan', 'Vesu'] },
  { city: 'Jaipur', state: 'Rajasthan', code: '08', pin: '302003', areas: ['Johari Bazaar', 'MI Road', 'Vaishali Nagar', 'Malviya Nagar'] },
  { city: 'New Delhi', state: 'Delhi', code: '07', pin: '110005', areas: ['Karol Bagh', 'Chandni Chowk', 'Lajpat Nagar', 'Rajouri Garden'] },
  { city: 'Kolkata', state: 'West Bengal', code: '19', pin: '700012', areas: ['Bowbazar', 'Gariahat', 'Salt Lake', 'Shyambazar'] },
  { city: 'Chennai', state: 'Tamil Nadu', code: '33', pin: '600017', areas: ['T. Nagar', 'Mylapore', 'Anna Nagar', 'Purasawalkam'] },
  { city: 'Hyderabad', state: 'Telangana', code: '36', pin: '500001', areas: ['Abids', 'Banjara Hills', 'Kukatpally', 'Secunderabad'] },
  { city: 'Bengaluru', state: 'Karnataka', code: '29', pin: '560001', areas: ['Commercial Street', 'Jayanagar', 'Malleshwaram', 'Chickpet'] },
  { city: 'Indore', state: 'Madhya Pradesh', code: '23', pin: '452002', areas: ['Sarafa Bazaar', 'Vijay Nagar', 'Rajwada', 'Palasia'] },
  { city: 'Lucknow', state: 'Uttar Pradesh', code: '09', pin: '226018', areas: ['Aminabad', 'Chowk', 'Hazratganj', 'Gomti Nagar'] },
] as const;

const SHOP_FIRST = ['Shree', 'Navkar', 'Mahalaxmi', 'Kanak', 'Suvarna', 'Ratna', 'Om', 'Kalyan', 'Moti', 'Swarn', 'Padmavati', 'Jai Ambe', 'Royal', 'Heritage', 'Sona', 'Shubh', 'Laxmi Narayan', 'Kesar'];
const SHOP_LAST = ['Jewellers', 'Gold Palace', 'Ornaments', 'Gems & Jewels', 'Alankar', 'Jewel House', 'Abhushan', 'Gold & Diamonds'];
const FAMILIES = ['Soni', 'Zaveri', 'Mehta', 'Shah', 'Agarwal', 'Verma', 'Choksi', 'Jain', 'Kothari', 'Rastogi', 'Pethe', 'Chettiar', 'Sarraf'];
const WOMEN = ['Ananya', 'Priya', 'Kavya', 'Nirali', 'Ishita', 'Meera', 'Pooja', 'Sneha', 'Riya', 'Diya', 'Aarti', 'Sunita', 'Lakshmi', 'Fatima', 'Harpreet', 'Divya', 'Neha', 'Shreya'];
const MEN = ['Rahul', 'Amit', 'Vikram', 'Sanjay', 'Rohan', 'Arjun', 'Karan', 'Manish', 'Suresh', 'Imran', 'Gurpreet', 'Venkat', 'Aditya', 'Nikhil', 'Rajesh', 'Mohit', 'Harsh', 'Deepak'];
const SURNAMES = ['Sharma', 'Patel', 'Mehta', 'Shah', 'Iyer', 'Reddy', 'Gupta', 'Singh', 'Nair', 'Joshi', 'Desai', 'Kapoor', 'Trivedi', 'Bose', 'Khan', 'Kulkarni', 'Agarwal', 'Pillai', 'Chopra', 'Rao'];
const person = () => `${pick(chance(0.5) ? WOMEN : MEN)} ${pick(SURNAMES)}`;

const SUPPLIERS = [
  { name: 'MMTC-PAMP India', city: 'Gurugram', state: 'Haryana', code: '06' },
  { name: 'Mumbai Bullion Traders', city: 'Mumbai', state: 'Maharashtra', code: '27' },
  { name: 'Rajkot Chain Manufacturers', city: 'Rajkot', state: 'Gujarat', code: '24' },
  { name: 'Coimbatore Jewel Craft', city: 'Coimbatore', state: 'Tamil Nadu', code: '33' },
  { name: 'Kolkata Fine Ornaments', city: 'Kolkata', state: 'West Bengal', code: '19' },
  { name: 'Jaipur Kundan House', city: 'Jaipur', state: 'Rajasthan', code: '08' },
  { name: 'Hyderabad Pearl & Gold Co', city: 'Hyderabad', state: 'Telangana', code: '36' },
];

const KARIGARS = [
  { name: 'Master Shyam Soni', speciality: 'Bridal Sets', workshop: 'Shyam Soni Works' },
  { name: 'Farooq Zariwala', speciality: 'Kundan Meena', workshop: 'Zariwala Fine Mounts' },
  { name: 'Ramesh Goldsmith', speciality: 'Chains & Bangles', workshop: 'Heritage Crafts' },
  { name: 'Biswajit Karmakar', speciality: 'Filigree', workshop: 'Bengal Filigree Studio' },
  { name: 'Murugan Achari', speciality: 'Temple Jewellery', workshop: 'Achari Temple Works' },
  { name: 'Salim Kasai', speciality: 'Stone Setting', workshop: 'Kasai Setting House' },
];

type MakingBasis = 'per_gram' | 'percent' | 'flat';
interface PieceDef {
  code: string; name: string; category: string; purity: string; metal: 'GOLD' | 'SILVER';
  gross: [number, number]; stone?: [number, number]; stoneValue?: [number, number];
  making: [MakingBasis, number]; wastage: number;
  /** How often it turns up in a showcase. */
  weight: number;
}

/** What a showcase holds. Categories are the ones every shop is provisioned with. */
const PIECES: PieceDef[] = [
  { code: 'RING-22K', name: 'Gold Ring 22K', category: 'RINGS', purity: '22K', metal: 'GOLD', gross: [3.5, 9], making: ['per_gram', 520], wastage: 8, weight: 4 },
  { code: 'DRING-18K', name: 'Diamond Ladies Ring 18K', category: 'RINGS', purity: '18K', metal: 'GOLD', gross: [2.5, 6], stone: [0.1, 0.4], stoneValue: [8000, 35000], making: ['per_gram', 850], wastage: 10, weight: 2 },
  { code: 'CHAIN-22K', name: 'Gold Chain 22K', category: 'CHAINS', purity: '22K', metal: 'GOLD', gross: [8, 28], making: ['per_gram', 420], wastage: 6, weight: 3 },
  { code: 'NECK-22K', name: 'Temple Necklace 22K', category: 'NECKLACES', purity: '22K', metal: 'GOLD', gross: [24, 60], stone: [0.5, 2.5], stoneValue: [3000, 12000], making: ['per_gram', 680], wastage: 10, weight: 1 },
  { code: 'BANG-22K', name: 'Antique Bangle 22K', category: 'BANGLES', purity: '22K', metal: 'GOLD', gross: [12, 32], making: ['per_gram', 560], wastage: 8, weight: 2 },
  { code: 'BRAC-22K', name: 'Gents Bracelet 22K', category: 'BRACELETS', purity: '22K', metal: 'GOLD', gross: [10, 24], making: ['per_gram', 480], wastage: 7, weight: 1 },
  { code: 'EARR-22K', name: 'Jhumka Earrings 22K', category: 'EARRINGS', purity: '22K', metal: 'GOLD', gross: [4, 12], making: ['per_gram', 600], wastage: 9, weight: 3 },
  { code: 'PEND-18K', name: 'Diamond Pendant 18K', category: 'PENDANTS', purity: '18K', metal: 'GOLD', gross: [2, 5], stone: [0.1, 0.3], stoneValue: [6000, 25000], making: ['percent', 14], wastage: 0, weight: 2 },
  { code: 'MANG-22K', name: 'Mangalsutra 22K', category: 'MANGALSUTRA', purity: '22K', metal: 'GOLD', gross: [8, 20], making: ['per_gram', 500], wastage: 8, weight: 2 },
  { code: 'NOSE-18K', name: 'Nose Pin 18K', category: 'NOSE_PINS', purity: '18K', metal: 'GOLD', gross: [0.4, 1.2], making: ['flat', 450], wastage: 0, weight: 1 },
  { code: 'ANKL-925', name: 'Silver Anklet Pair 925', category: 'ANKLETS', purity: '925', metal: 'SILVER', gross: [20, 60], making: ['per_gram', 18], wastage: 5, weight: 2 },
];

/**
 * The staff roles a demo can draw from. Each names the modules it is about;
 * which areas and actions within them it actually gets is decided by the dice,
 * so no two demos grant quite the same thing — which is the point of staff
 * roles being defined per business.
 */
const ROLE_TEMPLATES = [
  { name: 'Counter Staff', description: 'Sells at the counter and takes old gold in exchange.', modules: ['pos'], extra: ['oldgold', 'schemes', 'orders', 'master'] },
  { name: 'Cashier', description: 'Takes payments and receipts.', modules: ['pos'], extra: ['schemes', 'girvi', 'accounts'] },
  { name: 'Accountant', description: 'Keeps the books and runs the reports.', modules: ['accounts'], extra: ['reports', 'pos', 'purchase'] },
  { name: 'Storekeeper', description: 'Receives, tags and counts stock.', modules: ['stock', 'tagging'], extra: ['purchase', 'master'] },
  { name: 'Sales Executive', description: 'Sells, books orders and enrols scheme members.', modules: ['pos', 'orders'], extra: ['schemes', 'oldgold'] },
  { name: 'Order Desk', description: 'Takes custom and repair orders and follows them through.', modules: ['orders'], extra: ['stock', 'master'] },
  { name: 'Girvi Desk', description: 'Appraises and lends against gold.', modules: ['girvi'], extra: ['accounts', 'master'] },
  { name: 'Scheme Collector', description: 'Collects monthly savings installments.', modules: ['schemes'], extra: ['pos'] },
] as const;

const THEMES = ['deep-forest', 'royal-ruby', 'sapphire-platinum', 'obsidian-luxury', 'rose-gold'];

/* ================================================================ shapes */

export interface DemoLogin {
  fullName: string; email: string;
  role: 'owner' | 'admin' | 'staff';
  roleName: string;
  branch: string;
}

export interface DemoAccount {
  tenantId: string; code: string; displayName: string; legalName: string; kind: string; city: string;
  /** Everyone in the demo signs in with this. Shown once. */
  password: string;
  branches: Array<{ code: string; name: string }>;
  roles: Array<{ name: string; permissions: string[] }>;
  logins: DemoLogin[];
  data: Record<string, number>;
  /** Parts of the sample data that could not be made; the account is usable without them. */
  warnings: string[];
  seconds: number;
}

type Step = (text: string) => void;

interface Branch { id: string; code: string; name: string; adminId: string | null; counter: string; vault: string }
interface Piece { id: string; item: string; def: PieceDef }
interface Built {
  tenantId: string; ownerId: string; branches: Branch[]; today: string; floor: string;
  stateCode: string; city: string; state: string;
  /** Tagged pieces still free to sell or promise, by branch. */
  showcase: Map<string, Piece[]>;
}

/* ======================================================= one demo account */

/**
 * Builds one demo business end to end. If the business itself, its people or
 * its masters cannot be made, everything made so far is deleted and the error
 * is thrown. A module whose sample data fails only adds a warning: the demo is
 * still worth having without its girvi loans.
 */
export async function createDemoTenant(actorId: string, ip?: string, step: Step = () => undefined): Promise<DemoAccount> {
  const started = Date.now();
  const place = pick(CITIES);
  const family = pick(FAMILIES);
  const displayName = `${pick(SHOP_FIRST)} ${pick(SHOP_LAST)}`;
  const legalName = pick([`${displayName} Pvt Ltd`, `${displayName} LLP`, `${family} & Sons ${pick(SHOP_LAST)}`]);
  const kind = chance(0.7) ? 'retailer' as const : 'both' as const;
  const password = demoPassword();
  const code = await freeCode();
  const domain = `${code}.test`;
  const gstin = fakeGstin(place.code);
  const areas = sample(place.areas, intBetween(1, 3));
  const branchSeeds = areas.map((area, i) => ({
    code: branchCode(area, i),
    name: i === 0 ? `${area} Flagship` : `${area} Showroom`,
  }));
  const ownerName = `${pick(MEN)} ${family}`;

  step('Creating the business');
  const created = await createTenant({
    code, legalName, displayName, kind, gstin, pan: gstin.slice(2, 12), stateCode: place.code,
    admin: { email: `owner@${domain}`, fullName: ownerName, password, phone: mobile() },
    branch: { code: branchSeeds[0]!.code, name: branchSeeds[0]!.name, city: place.city, state: place.state, stateCode: place.code, kind: 'showroom' },
  }, actorId, ip);
  const tenantId = created.tenantId as string;
  const warnings: string[] = [];
  const logins: DemoLogin[] = [{ fullName: ownerName, email: `owner@${domain}`, role: 'owner', roleName: 'Owner', branch: 'All branches' }];
  const roles: DemoAccount['roles'] = [];

  try {
    await asPlatform(async (tx) => {
      await tx.query(`update tenant set is_demo = true, metadata = metadata || $2::jsonb where id = $1`,
        [tenantId, JSON.stringify({ demo: { createdBy: actorId, createdAt: new Date().toISOString() } })]);
      await audit(tx, actorId, 'tenant.demo_create', { tenantId, targetType: 'tenant', targetId: tenantId, ip, changes: { code } });
    });

    step('Adding branches');
    const branchRows: Array<{ id: string; code: string; name: string }> = [{ id: created.branchId as string, ...branchSeeds[0]! }];
    for (const b of branchSeeds.slice(1)) {
      const row = await createBranch(tenantId, {
        code: b.code, name: b.name, kind: 'showroom', city: place.city, state: place.state,
        stateCode: place.code, gstin, pincode: place.pin, phone: mobile(),
      }, actorId, ip);
      branchRows.push({ id: row.id as string, ...b });
    }

    step('Creating staff roles with their permissions');
    const tree = permissionTree();
    for (const template of sample(ROLE_TEMPLATES, intBetween(2, 4))) {
      const permissions = pickPermissions(tree, template);
      const role = await createStaffRole(tenantId, { name: template.name, description: template.description, permissions }, actorId, ip);
      roles.push({ name: role.name, permissions: role.permissions });
    }
    const roleCodes = await asTenant(tenantId, (tx) => tx.query<{ code: string; name: string }>(
      `select code, name from role where role_type = 'staff' and deleted_at is null`));

    step('Creating users');
    const used = new Set<string>([`owner@${domain}`]);
    const branches: Branch[] = [];
    // One branch admin per branch, or now and then one admin who covers them all.
    const oneAdminForAll = branchRows.length > 1 && chance(0.25);
    let sharedAdmin: string | null = null;
    for (const [i, b] of branchRows.entries()) {
      let adminId = sharedAdmin;
      if (!oneAdminForAll || i === 0) {
        const name = person();
        const email = oneAdminForAll ? `admin@${domain}` : `admin.${b.code.toLowerCase()}@${domain}`;
        const user = await createTenantUser(tenantId, {
          email, fullName: name, password, phone: mobile(), roleCode: 'admin', branchId: oneAdminForAll ? null : b.id,
        }, { actorPlatformUserId: actorId, ip });
        used.add(email);
        logins.push({ fullName: name, email, role: 'admin', roleName: 'Branch Admin', branch: oneAdminForAll ? 'All branches' : b.name });
        adminId = user.id;
        if (oneAdminForAll) sharedAdmin = user.id;
      }
      for (let s = intBetween(1, 2); s > 0 && roleCodes.length; s--) {
        const role = pick(roleCodes);
        const name = person();
        const email = uniqueEmail(name, domain, used);
        await createTenantUser(tenantId, {
          email, fullName: name, password, phone: mobile(), roleCode: role.code, branchId: b.id,
        }, { actorPlatformUserId: actorId, ip });
        logins.push({ fullName: name, email, role: 'staff', roleName: role.name, branch: b.name });
      }
      branches.push({ ...b, adminId, counter: '', vault: '' });
    }

    const built = await asTenant(tenantId, async (tx) => {
      // A demo is for looking around, not for changing a password first.
      await tx.query(`update app_user set must_change_password = false`);
      await tx.query(`update tenant_theme set preset_key = $1`, [pick(THEMES)]);
      const locations = await tx.query<{ branch_id: string; kind: string; id: string }>(
        `select branch_id, kind, id from stock_location where is_active and deleted_at is null`);
      for (const b of branches) {
        b.counter = locations.find((l) => l.branch_id === b.id && l.kind === 'counter')?.id
          ?? locations.find((l) => l.branch_id === b.id)!.id;
        b.vault = locations.find((l) => l.branch_id === b.id && l.kind === 'vault')?.id ?? b.counter;
      }
      const today = await businessDate(tx);
      return {
        tenantId, ownerId: created.adminUserId as string, branches, today, floor: fyStart(today),
        stateCode: place.code, city: place.city, state: place.state, showcase: new Map<string, Piece[]>(),
      };
    });

    step('Loading masters: rates, items, formulas, customers, suppliers');
    const m = await asTenant(tenantId, (tx) => seedMasters(tx, built), built.ownerId);

    const phases: Array<[string, (tx: Tx, b: Branch, first: boolean) => Promise<void>]> = [
      ['Buying and tagging stock', (tx, b, first) => seedStock(tx, built, m, b, first, warnings)],
      ['Billing customers', (tx, b, first) => seedSales(tx, built, m, b, first, warnings)],
      ['Taking orders', (tx, b, first) => seedOrders(tx, built, m, b, first, warnings)],
      ['Taking in old gold', (tx, b, first) => seedOldGold(tx, m, b, first, warnings)],
      ['Enrolling scheme members', (tx, b) => seedSchemes(tx, built, m, b, warnings)],
      ['Lending against gold', (tx, b) => seedGirvi(tx, built, m, b, warnings)],
      ['Posting expenses', (tx, b, first) => seedAccounts(tx, m, b, first, warnings)],
    ];
    for (const [label, run] of phases) {
      for (const [i, b] of built.branches.entries()) {
        step(`${label}${built.branches.length > 1 ? ` · ${b.name}` : ''}`);
        try {
          await asTenant(tenantId, async (tx) => {
            tx.context.branchId = b.id;
            tx.context.userId = b.adminId ?? built.ownerId;
            await run(tx, b, i === 0);
          }, b.adminId ?? built.ownerId);
        } catch (error) {
          note(warnings, `${label} at ${b.name}`, error);
        }
      }
    }

    step('Counting what was made');
    const data = await asTenant(tenantId, (tx) => tx.one<Record<string, number>>(
      `select (select count(*) from party where is_customer and code <> 'WALKIN' and deleted_at is null)::int as customers,
              (select count(*) from party where is_supplier and deleted_at is null)::int as suppliers,
              (select count(*) from item where deleted_at is null and code <> 'SERVICE')::int as items,
              (select count(*) from stock_piece where status = 'in_stock')::int as pieces_in_stock,
              (select count(*) from sales_invoice)::int as invoices,
              (select count(*) from goods_receipt)::int as purchases,
              (select count(*) from retail_order)::int as orders,
              (select count(*) from old_gold_intake)::int as old_gold,
              (select count(*) from scheme_account)::int as scheme_members,
              (select count(*) from girvi_loan)::int as girvi_loans,
              (select count(*) from voucher)::int as vouchers`));

    logger.info({ tenantId, code, seconds: (Date.now() - started) / 1000, warnings: warnings.length }, 'Demo tenant created');
    return {
      tenantId, code, displayName, legalName, kind, city: place.city, password,
      branches: branchRows.map((b) => ({ code: b.code, name: b.name })),
      roles, logins, data, warnings,
      seconds: Math.round((Date.now() - started) / 1000),
    };
  } catch (error) {
    // Half a demo is worse than none: take it all away again.
    await deleteTenantData([tenantId]).catch((e) => logger.error({ err: e, tenantId }, 'Could not remove a failed demo'));
    throw error;
  }
}

/** demo-xxxx, retried until it is free. */
async function freeCode(): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const code = `demo-${randomBytes(3).toString('hex').slice(0, 5)}`;
    const taken = await asPlatform((tx) => tx.maybeOne(`select 1 from tenant where lower(code) = $1`, [code]));
    if (!taken) return code;
  }
  throw new BusinessRuleError('Could not find a free demo code. Try again.', 'demo_code_unavailable');
}

/** "Zaveri Bazaar" → ZB, "Aminabad" → AMI. Areas within a city never share a code. */
function branchCode(area: string, i: number): string {
  const words = area.replace(/[^A-Za-z ]/g, ' ').split(/\s+/).filter(Boolean);
  const code = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 3) : (words[0] ?? `BR${i + 1}`).slice(0, 3);
  return code.toUpperCase();
}

function uniqueEmail(name: string, domain: string, used: Set<string>): string {
  const base = name.toLowerCase().replace(/[^a-z ]/g, '').trim().replace(/\s+/g, '.');
  let email = `${base}@${domain}`;
  for (let n = 2; used.has(email); n++) email = `${base}${n}@${domain}`;
  used.add(email);
  return email;
}

function note(warnings: string[], where: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn({ err: error, where }, 'Demo data step skipped');
  const text = `${where}: ${message}`;
  if (!warnings.includes(text)) warnings.push(text);
}

/**
 * One document, inside a savepoint: if it is refused, the rest of the phase
 * carries on and the refusal becomes a warning instead of losing everything
 * the phase made before it.
 */
async function attempt<T>(tx: Tx, warnings: string[], what: string, fn: () => Promise<T>): Promise<T | null> {
  await tx.query('savepoint demo_step');
  try {
    const out = await fn();
    await tx.query('release savepoint demo_step');
    return out;
  } catch (error) {
    await tx.query('rollback to savepoint demo_step');
    note(warnings, what, error);
    return null;
  }
}

/* ============================================================ permissions */

/**
 * A plausible but random set of ticks for a role: sometimes the whole module,
 * otherwise some of its areas, each with its view rights and a random handful
 * of its actions — plus, now and then, a look into a neighbouring module.
 */
function pickPermissions(tree: PermissionTreeNode[], template: (typeof ROLE_TEMPLATES)[number]): string[] {
  const byKey = new Map(tree.map((m) => [m.key, m]));
  const out = new Set<string>();
  const isView = (action: string) => action === 'view' || action === 'list' || action.startsWith('view');

  for (const key of template.modules) {
    const node = byKey.get(key);
    if (!node) continue;
    if (chance(0.25)) { out.add(node.wildcard); continue; }
    for (const group of node.groups) {
      const own = group.key === node.key;
      if (!own && !chance(0.6)) continue;
      if (group.wildcard && chance(0.3)) { out.add(group.wildcard); continue; }
      const views = group.permissions.filter((p) => isView(p.action));
      const rest = group.permissions.filter((p) => !isView(p.action));
      for (const p of views) out.add(p.code);
      for (const p of sample(rest, intBetween(Math.min(1, rest.length), rest.length))) out.add(p.code);
    }
  }
  for (const key of sample(template.extra, intBetween(0, 2))) {
    const node = byKey.get(key);
    if (!node) continue;
    for (const p of node.groups.flatMap((g) => g.permissions).filter((p) => isView(p.action))) out.add(p.code);
  }
  if (out.size === 0) {
    const node = template.modules.map((k) => byKey.get(k)).find(Boolean) ?? tree[0]!;
    out.add(node.wildcard);
  }
  return [...out];
}

/* ================================================================ masters */

interface Masters {
  metal: Record<'GOLD' | 'SILVER', string>;
  purity: Record<string, { id: string; metalId: string; fineness: Decimal }>;
  /** Selling and buying rate per gram, by purity code. */
  rate: Record<string, { sell: Decimal; buy: Decimal }>;
  items: Record<string, { id: string; def?: PieceDef }>;
  categories: Record<string, string>;
  customers: Array<{ id: string; name: string; pan: string | null }>;
  suppliers: string[];
  karigars: string[];
  plans: string[];
  methods: Record<string, string>;
  accounts: Record<string, string>;
}

async function seedMasters(tx: Tx, built: Built): Promise<Masters> {
  const metals = await tx.query<{ id: string; code: string }>(`select id, code from metal`);
  const purities = await tx.query<{ id: string; code: string; metal_id: string; fineness_percent: Decimal }>(
    `select id, code, metal_id, fineness_percent from purity where is_active`);
  const metal = {
    GOLD: metals.find((r) => r.code === 'GOLD')!.id,
    SILVER: metals.find((r) => r.code === 'SILVER')!.id,
  };
  const purity: Masters['purity'] = Object.fromEntries(purities.map((p) => [p.code, { id: p.id, metalId: p.metal_id, fineness: p.fineness_percent }]));

  /*
   * Rates: today's board and its history back to the start of the year —
   * weekly, then daily for the last fortnight. Back-dated scheme installments
   * and loans are valued at the rate of their own day, so the history is
   * needed, not decoration. Gold drifts up towards today, as it tends to.
   */
  const k22 = Math.round(between(11_100, 11_800));
  const silver999 = Math.round(between(140, 165));
  const board = (factor: number): Record<string, number> => ({
    '24K': Math.round(k22 * 999 / 916 * factor), '22K': Math.round(k22 * factor), '18K': Math.round(k22 * 750 / 916 * factor),
    '14K': Math.round(k22 * 585 / 916 * factor), '999': Math.round(silver999 * factor), '925': Math.round(silver999 * 0.925 * factor),
  });
  const rate: Masters['rate'] = {};
  const rateRows: Record<string, unknown>[] = [];
  const span = Math.round((Date.parse(built.today) - Date.parse(built.floor)) / 86_400_000);
  const daysBack = [
    ...Array.from({ length: Math.floor(span / 7) }, (_, i) => span - i * 7).filter((d) => d > 14),
    ...Array.from({ length: Math.min(span, 14) + 1 }, (_, i) => Math.min(span, 14) - i),
  ];
  for (const back of daysBack) {
    const day = addDays(built.today, -back);
    const values = board(back === 0 ? 1 : 1 - back * 0.0006 + between(-0.012, 0.012));
    for (const [code, sell] of Object.entries(values)) {
      const p = purity[code];
      if (!p) continue;
      const buy = Math.round(sell * 0.965);
      rateRows.push({
        metal_id: p.metalId, purity_id: p.id, rate_per_gram: String(sell), buying_rate_per_gram: String(buy),
        source: 'manual', effective_from: back === 0 ? new Date().toISOString() : `${day}T04:30:00Z`,
      });
      if (back === 0) rate[code] = { sell: String(sell), buy: String(buy) };
    }
  }
  await repo(tx, 'metal_rate').insertMany(rateRows);

  /* Items: bulk metal, and the pieces a showcase holds, each with its making and wastage formula. */
  const cats = await tx.query<{ id: string; code: string }>(`select id, code from item_category`);
  const categories = Object.fromEntries(cats.map((c) => [c.code, c.id]));
  const items: Masters['items'] = {};
  const bulk = [
    { code: 'GOLD-22K-BULK', name: '22K Gold (bulk)', metal: metal.GOLD, purity: purity['22K']!.id },
    { code: 'SILVER-999-BULK', name: 'Fine Silver 999 (bulk)', metal: metal.SILVER, purity: purity['999']!.id },
  ];
  for (const b of bulk) {
    const row = await repo<{ id: string }>(tx, 'item').insert({
      code: b.code, name: b.name, nature: 'raw_metal', tracking: 'lot', metal_id: b.metal,
      default_purity_id: b.purity, hsn_code: '7113', uom: 'gram', is_active: true,
    });
    items[b.code] = { id: row.id };
  }
  for (const d of PIECES) {
    const row = await repo<{ id: string }>(tx, 'item').insert({
      code: d.code, name: d.name, nature: 'finished', tracking: 'piece', category_id: categories[d.category] ?? null,
      metal_id: metal[d.metal], default_purity_id: purity[d.purity]!.id, hsn_code: '7113', uom: 'gram', is_active: true,
    });
    items[d.code] = { id: row.id, def: d };
  }
  await repo(tx, 'price_rule').insertMany([
    ...PIECES.map((d) => ({
      code: `MK-${d.code}`, name: `${d.name} making`, applies_to: 'making', basis: d.making[0],
      rate: String(d.making[1]), item_id: items[d.code]!.id, effective_from: built.floor,
    })),
    ...PIECES.filter((d) => d.wastage > 0).map((d) => ({
      code: `WS-${d.code}`, name: `${d.name} wastage`, applies_to: 'wastage', basis: 'percent',
      rate: String(d.wastage), item_id: items[d.code]!.id, effective_from: built.floor,
    })),
    { code: 'HM-HUID', name: 'Hallmarking (HUID)', applies_to: 'hallmark', basis: 'flat', rate: '45', effective_from: built.floor },
  ]);

  /* People: customers, suppliers and karigars. */
  const phones = new Set<string>();
  const freshPhone = () => { let p = mobile(); while (phones.has(p)) p = mobile(); phones.add(p); return `+91${p}`; };
  const customers: Masters['customers'] = [];
  const customerCount = intBetween(14, 22);
  const codes = await reserveCodes(tx, 'party', customerCount + 4);
  for (let i = 0; i < customerCount; i++) {
    const name = person();
    const pan = chance(0.75) ? fakePan('P') : null;
    const row = await repo<{ id: string }>(tx, 'party').insert({
      code: codes.shift(), name, is_customer: true, party_type: 'individual', phone: freshPhone(),
      email: chance(0.4) ? `${name.toLowerCase().replace(/\s+/g, '.')}@example.com` : null,
      pan, city: built.city, state: built.state, state_code: built.stateCode,
      address_line1: `${intBetween(1, 240)}, ${pick(['Shanti Nagar', 'MG Road', 'Station Road', 'Gandhi Chowk', 'Park Street', 'Nehru Colony'])}`,
      date_of_birth: chance(0.6) ? `${intBetween(1965, 2001)}-${String(intBetween(1, 12)).padStart(2, '0')}-${String(intBetween(1, 28)).padStart(2, '0')}` : null,
      anniversary: chance(0.4) ? `${intBetween(1990, 2022)}-${String(intBetween(1, 12)).padStart(2, '0')}-${String(intBetween(1, 28)).padStart(2, '0')}` : null,
      kyc_status: pan ? 'verified' : pick(['none', 'pending']), is_active: true,
    });
    customers.push({ id: row.id, name, pan });
  }
  const suppliers: string[] = [];
  for (const s of sample(SUPPLIERS, intBetween(2, 4))) {
    const row = await repo<{ id: string }>(tx, 'party').insert({
      code: codes.shift(), name: s.name, is_supplier: true, party_type: 'business', phone: freshPhone(),
      gstin: fakeGstin(s.code), city: s.city, state: s.state, state_code: s.code, credit_days: pick([15, 30, 45]), is_active: true,
    });
    suppliers.push(row.id);
  }
  const karigars: string[] = [];
  for (const [i, k] of sample(KARIGARS, intBetween(2, 4)).entries()) {
    const row = await repo<{ id: string }>(tx, 'karigar').insert({
      code: `KAR-${i + 1}`, name: k.name, workshop_name: k.workshop, speciality: k.speciality, phone: freshPhone(),
      engagement: chance(0.7) ? 'external' : 'in_house', standard_ghat_percent: pick(['1.0', '1.5', '2.0']),
      labour_rate_per_gram: String(intBetween(35, 65) * 10), is_active: true,
    });
    karigars.push(row.id);
  }

  /* Savings plans: a rupee plan and a grams plan. */
  const plans: string[] = [];
  const monthly = pick(['2000', '3000', '5000', '10000']);
  plans.push((await repo<{ id: string }>(tx, 'scheme_plan').insert({
    code: 'SN-11P1', name: 'Swarna Nidhi 11+1', description: 'Pay 11 monthly installments; the 12th is on us.',
    metal_id: metal.GOLD, accrual_basis: 'rupee', tenure_months: 11, installment_amount: monthly,
    bonus_installments: '1', max_missed_installments: 2, grace_period_days: 7, is_active: true,
  })).id);
  plans.push((await repo<{ id: string }>(tx, 'scheme_plan').insert({
    code: 'GW-12', name: 'Gold Weight Plan', description: 'Every installment buys 22K gold at that day’s rate.',
    metal_id: metal.GOLD, purity_id: purity['22K']!.id, accrual_basis: 'weight', tenure_months: 12,
    installment_amount: pick(['2500', '5000']), bonus_percent: '5', making_charge_discount_percent: '25',
    max_missed_installments: 2, grace_period_days: 7, is_active: true,
  })).id);

  const methods = Object.fromEntries((await tx.query<{ id: string; code: string }>(
    `select id, code from payment_method where deleted_at is null`)).map((r) => [r.code, r.id]));
  const accounts = Object.fromEntries((await tx.query<{ id: string; code: string }>(
    `select id, code from account where deleted_at is null and not is_group`)).map((r) => [r.code, r.id]));

  return { metal, purity, rate, items, categories, customers, suppliers, karigars, plans, methods, accounts };
}

/** Party codes from the shop's own series, so the next customer added by hand follows on. */
async function reserveCodes(tx: Tx, docType: string, count: number): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push((await nextDocumentNumber(tx, docType)).number);
  return out;
}

/* ================================================================== stock */

async function seedStock(tx: Tx, built: Built, m: Masters, b: Branch, first: boolean, warnings: string[]): Promise<void> {
  const day = (n: number) => notBefore(addDays(built.today, -n), built.floor);

  /* Bulk metal bought with the supplier's bill. */
  if (first || chance(0.5)) {
    await attempt(tx, warnings, `Purchase at ${b.name}`, () => createInward(tx, {
      supplierId: pick(m.suppliers), locationId: b.vault, docDate: day(intBetween(8, 20)),
      lines: [{ itemId: m.items['GOLD-22K-BULK']!.id, purityId: m.purity['22K']!.id, grossWeight: grams(first ? 150 : 60, first ? 400 : 150), metalBasis: 'rupee', ratePerGram: m.rate['22K']!.buy }],
      bill: { supplierInvoiceNumber: `${letters(3)}/${built.today.slice(2, 4)}/${digits(4)}`, supplierInvoiceDate: day(intBetween(8, 20)) },
    }));
  }
  /* Finished pieces bought in, still waiting in Tagging as a purchase lot. */
  if (first || chance(0.4)) {
    const def = pick(PIECES.filter((d) => d.metal === 'GOLD' && !d.stone));
    const pieces = intBetween(3, 6);
    await attempt(tx, warnings, `Purchase of ${def.name} at ${b.name}`, () => createInward(tx, {
      supplierId: pick(m.suppliers), locationId: b.vault, docDate: day(intBetween(1, 6)),
      lines: [{
        itemId: m.items[def.code]!.id, purityId: m.purity[def.purity]!.id, pieces,
        grossWeight: (between(def.gross[0], def.gross[1]) * pieces).toFixed(3), metalBasis: 'rupee',
        ratePerGram: m.rate[def.purity]!.buy, makingBasis: 'per_gram', makingRate: String(Math.round(def.making[0] === 'per_gram' ? def.making[1] * 0.6 : 250)),
      }],
      bill: { supplierInvoiceDate: day(intBetween(1, 6)) },
    }));
  }

  /* The showcase: tagged opening stock, hallmarked where it is gold. */
  const deck = PIECES.flatMap((d) => Array.from({ length: d.weight }, () => d));
  const inputs = Array.from({ length: intBetween(10, 16) }, () => {
    const def = pick(deck);
    const gross = grams(def.gross[0], def.gross[1]);
    const stone = def.stone ? grams(def.stone[0], def.stone[1]) : undefined;
    const net = sub(gross, stone ?? '0');
    const stoneValue = def.stoneValue ? rupees(def.stoneValue[0], def.stoneValue[1]) : undefined;
    return {
      def,
      input: {
        itemId: m.items[def.code]!.id, purityId: m.purity[def.purity]!.id,
        locationId: chance(0.75) ? b.counter : b.vault, grossWeight: gross, stoneWeight: stone,
        stoneCount: stone ? intBetween(3, 24) : undefined, stoneValue,
        huid: def.metal === 'GOLD' ? `${letters(1)}${digits(1)}${letters(2)}${digits(2)}` : undefined,
        hallmarkCentre: def.metal === 'GOLD' ? `BIS ${built.city} AHC-${digits(4)}` : undefined,
        costValue: round(add(mul(net, m.rate[def.purity]!.buy), stoneValue ? mul(stoneValue, '0.7') : '0'), 2),
        supplierId: pick(m.suppliers),
      },
    };
  });
  const tagged = await attempt(tx, warnings, `Opening stock at ${b.name}`, () => tagAll(tx, inputs.map((x) => x.input), 'opening'));
  built.showcase.set(b.id, (tagged ?? []).map((p, i) => ({ id: (p as { id: string }).id, item: inputs[i]!.def.code, def: inputs[i]!.def })));
}

/* ================================================================== sales */

async function seedSales(tx: Tx, built: Built, m: Masters, b: Branch, first: boolean, warnings: string[]): Promise<void> {
  const stock = shuffle(built.showcase.get(b.id) ?? []);
  const take = (n: number) => stock.splice(0, n);
  const buyers = shuffle(m.customers);
  const bills = intBetween(3, first ? 6 : 4);

  for (let i = 0; i < bills && stock.length > 2; i++) {
    const walkIn = i === 0;
    const pieces = walkIn ? take(1).filter((p) => ['NOSE-18K', 'ANKL-925', 'RING-22K', 'EARR-22K'].includes(p.item)) : take(chance(0.3) ? 2 : 1);
    if (!pieces.length) continue;
    const buyer = walkIn ? null : buyers[i % buyers.length]!;
    const lines = pieces.map((p) => ({ pieceId: p.id }));
    const credit = !walkIn && i === 1;
    await attempt(tx, warnings, `Bill at ${b.name}`, async () => {
      let q = await quote(tx, { customerId: buyer?.id, lines });
      const discount = !walkIn && chance(0.3) && compare(q.totals.discountFree, '100') > 0 ? round(q.totals.discountFree, 0) : undefined;
      if (discount) q = await quote(tx, { customerId: buyer?.id, lines, discount });
      const grand = q.totals.grand;
      if (walkIn && compare(grand, '190000') >= 0) return null;
      const payable = credit ? round(mul(grand, between(0.55, 0.8).toFixed(2)), 0) : grand;
      const tenders = splitTenders(m, payable, walkIn);
      const bill = await checkout(tx, {
        customerId: buyer?.id, lines, tenders, discount, expectedTotal: grand,
        pan: buyer && !buyer.pan && compare(grand, '200000') >= 0 ? fakePan('P') : undefined,
        salespersonId: b.adminId ?? undefined,
      });
      if (credit && buyer) {
        await createReceipt(tx, {
          customerId: buyer.id, amount: round(mul(sub(grand, payable), '0.5'), 0),
          paymentMethodId: m.methods.UPI!, reference: reference('UPI'), notes: 'Part payment against the balance',
        });
      }
      return bill;
    });
  }

  /* A piece out on approval, due back in a few days. */
  const memoPiece = take(1)[0];
  if (memoPiece && buyers.length) {
    await attempt(tx, warnings, `Approval memo at ${b.name}`, () => createMemo(tx, {
      customerId: buyers[buyers.length - 1]!.id, pieceIds: [memoPiece.id], dueDate: addDays(built.today, intBetween(2, 5)),
      notes: 'Taken home to show the family',
    }));
  }
  built.showcase.set(b.id, stock);
}

/** Cash for a part (well under every cash limit), the rest by UPI, card or bank. */
function splitTenders(m: Masters, amount: Decimal, walkIn: boolean) {
  const cash = walkIn ? amount : String(Math.min(Number(amount), Math.round(between(5, 45)) * 1000));
  const rest = sub(amount, cash);
  const tenders: Array<{ paymentMethodId: string; amount: Decimal; reference?: string }> = [{ paymentMethodId: m.methods.CASH!, amount: cash }];
  if (compare(rest, '0') > 0) {
    const mode = pick(['UPI', 'CARD', 'BANK']);
    tenders.push({ paymentMethodId: m.methods[mode]!, amount: rest, reference: reference(mode) });
  }
  return tenders;
}

/* ================================================================= orders */

async function seedOrders(tx: Tx, built: Built, m: Masters, b: Branch, first: boolean, warnings: string[]): Promise<void> {
  const buyers = shuffle(m.customers);
  const stock = built.showcase.get(b.id) ?? [];
  const advance = (total: Decimal) => {
    const amount = round(mul(total, between(0.2, 0.35).toFixed(2)), 0);
    return compare(amount, '45000') <= 0
      ? { paymentMethodId: m.methods.CASH!, amount }
      : { paymentMethodId: m.methods.UPI!, amount, reference: reference('UPI') };
  };
  const ordered: Array<{ id: string; type: OrderType }> = [];
  const place = async (type: OrderType, body: Parameters<typeof createOrder>[1]) => {
    const order = await attempt(tx, warnings, `${type} order at ${b.name}`, async () => {
      // Priced first without money, so the advance is a share of the real total.
      const draft = await createOrder(tx, body) as unknown as { id: string; total_amount: Decimal };
      if (compare(draft.total_amount, '0') > 0 && type !== 'repair') {
        await addOrderPayment(tx, draft.id, advance(draft.total_amount));
      }
      return draft;
    });
    if (order) ordered.push({ id: order.id, type });
  };
  const k22 = m.purity['22K']!.id;
  const item = (code: string) => m.items[code]!.id;
  const orderDate = () => notBefore(addDays(built.today, -intBetween(0, 12)), built.floor);

  const booked = stock.pop();
  if (booked) {
    await place('booking', {
      orderType: 'booking', customerId: buyers[0]!.id, orderDate: orderDate(), expectedDeliveryDate: addDays(built.today, intBetween(3, 10)),
      rateLockType: 'booking',
      lines: [{ title: booked.def.name, lineMode: 'booking', itemId: item(booked.item), pieceId: booked.id, purityId: m.purity[booked.def.purity]!.id }],
      notes: 'Customer will collect after the festival.',
    });
  }
  await place('custom', {
    orderType: 'custom', customerId: buyers[1]!.id, orderDate: orderDate(), expectedDeliveryDate: addDays(built.today, intBetween(14, 30)),
    karigarId: pick(m.karigars), manufacturingRoute: 'external',
    requirementDescription: pick(['Gents kada with a matte finish and a name engraved inside.', 'Temple-style choker to match an existing pair of jhumkas.', 'Ladies ring with a single solitaire setting, size 12.']),
    sizeSpecifications: pick(['Size 12', '2.6 inch', '16 inch with 2 inch extension']),
    lines: [{ title: 'Custom piece', lineMode: 'custom', itemId: item(pick(['BANG-22K', 'NECK-22K', 'RING-22K'])), purityId: k22,
      grossWeight: grams(12, 35), makingBasis: 'per_gram', makingRate: String(intBetween(55, 75) * 10), wastagePercent: String(intBetween(7, 11)) }],
  });
  await place('repair', {
    orderType: 'repair', customerId: buyers[2]!.id, orderDate: orderDate(), expectedDeliveryDate: addDays(built.today, intBetween(2, 7)),
    repairItemDescription: pick(['22K chain with a broken lobster clasp.', 'Pair of jhumkas, one hook bent.', 'Bangle with a dent near the screw.']),
    repairIssueDescription: pick(['Clasp needs replacing.', 'Re-solder and polish.', 'Reshape and re-polish.']),
    repairIssueTypes: [pick(['clasp', 'solder', 'polish', 'resize'])], repairServiceCharge: rupees(300, 1500, 50),
    custodyItems: [{ description: 'Customer’s own piece', metalId: m.metal.GOLD, purityId: k22, grossWeight: grams(6, 20), whereKept: 'Repair tray', conditionNotes: 'Scratches on the back' }],
  });
  if (first) {
    await place('wedding', {
      orderType: 'wedding', customerId: buyers[3]!.id, orderDate: orderDate(), expectedDeliveryDate: addDays(built.today, intBetween(30, 50)),
      eventDate: addDays(built.today, intBetween(55, 80)), eventType: 'Wedding',
      lines: [
        { title: 'Bridal Necklace Set', lineMode: 'custom', itemId: item('NECK-22K'), purityId: k22, grossWeight: grams(70, 110), makingBasis: 'per_gram', makingRate: '680', wastagePercent: '9' },
        { title: 'Matching Bangles (pair)', lineMode: 'custom', itemId: item('BANG-22K'), purityId: k22, grossWeight: grams(35, 55), makingBasis: 'per_gram', makingRate: '600', wastagePercent: '8' },
      ],
      notes: 'Bridal set first; presentation box with the family monogram.',
    });
    if (chance(0.5)) {
      await place('corporate', {
        orderType: 'corporate', customerId: buyers[4]!.id, orderDate: orderDate(), expectedDeliveryDate: addDays(built.today, intBetween(20, 35)),
        companyName: pick(['Aurum Hospitality Pvt Ltd', 'Sunrise Pharma Ltd', 'Indus Tech Solutions']), companyGstin: fakeGstin(built.stateCode),
        poReference: `PO/${built.today.slice(0, 4)}/${digits(4)}`, creditTerms: 'net_30', brandingNotes: 'Client logo on the box sleeve only.',
        lines: [{ title: 'Gold coin gift box', lineMode: 'custom', itemId: item('RING-22K'), purityId: k22, quantity: String(intBetween(10, 40)), grossWeight: '2.000', makingBasis: 'per_gram', makingRate: '150' }],
      });
    }
  }

  /* Move some along their pipeline, never as far as delivery — that is done by billing. */
  for (const o of ordered) {
    const stages = await pipelineFor(tx, o.type);
    const steps = intBetween(0, Math.max(0, stages.length - 3));
    for (const stage of stages.slice(1, 1 + steps)) {
      if (stage.terminal) break;
      const moved = await attempt(tx, warnings, `Moving an order at ${b.name}`, () => moveStage(tx, o.id, stage.key, undefined, `Moved to ${stage.label}`));
      if (!moved) break;
    }
  }
}

/* =============================================================== old gold */

async function seedOldGold(tx: Tx, m: Masters, b: Branch, first: boolean, warnings: string[]): Promise<void> {
  const buyers = shuffle(m.customers);
  const line = (min: number, max: number) => ({
    description: pick(['Old bangle pair, worn', 'Broken chain', 'Single earring', 'Old ring, stone missing', 'Mangalsutra pendant']),
    metalId: m.metal.GOLD, grossWeight: grams(min, max), stoneWeight: chance(0.3) ? grams(0.2, 1.2) : undefined,
    dirtWeight: grams(0.05, 0.4), testMethod: 'xrf' as const, testedPurityPercent: between(78, 91.6).toFixed(3),
    declaredPurityPercent: '91.600', testInstrument: 'XRF analyser',
  });
  await attempt(tx, warnings, `Old gold exchange at ${b.name}`, () => createIntake(tx, {
    customerId: buyers[0]!.id, settlement: 'exchange', lines: [line(6, 22)], notes: 'Against a new purchase',
  }));
  if (first || chance(0.5)) {
    await attempt(tx, warnings, `Old gold buyback at ${b.name}`, () => createIntake(tx, {
      customerId: buyers[1]!.id, settlement: 'buyback', lines: [line(4, 10)],
      idProof: { type: 'aadhaar', number: `XXXX XXXX ${digits(4)}` },
      payout: { paymentMethodId: m.methods.BANK!, reference: reference('NEFT') },
    }));
  }
}

/* ================================================================ schemes */

async function seedSchemes(tx: Tx, built: Built, m: Masters, b: Branch, warnings: string[]): Promise<void> {
  const members = sample(m.customers, intBetween(2, 4));
  for (const member of members) {
    const monthsAgo = intBetween(1, 5);
    const enrolledOn = notBefore(addMonths(built.today, -monthsAgo), built.floor);
    await attempt(tx, warnings, `Scheme enrolment at ${b.name}`, async () => {
      const account = await enroll(tx, {
        schemePlanId: pick(m.plans), customerId: member.id, enrolledOn,
        nomineeName: person(), nomineeRelationship: pick(['Spouse', 'Son', 'Daughter', 'Mother']), nomineePhone: mobile(),
      }) as unknown as { id: string };
      // Every month up to now, sometimes leaving the latest one due.
      for (let k = 0; ; k++) {
        const due = addMonths(enrolledOn, k);
        if (due > built.today || (k > 0 && addMonths(enrolledOn, k + 1) > built.today && chance(0.4))) break;
        const upi = chance(0.5);
        await collect(tx, account.id, {
          paymentMethodId: upi ? m.methods.UPI! : m.methods.CASH!, reference: upi ? reference('UPI') : undefined, docDate: due,
        });
      }
      return account;
    });
  }
}

/* ================================================================== girvi */

async function seedGirvi(tx: Tx, built: Built, m: Masters, b: Branch, warnings: string[]): Promise<void> {
  const borrowers = sample(m.customers, intBetween(1, 2));
  for (const [i, borrower] of borrowers.entries()) {
    const gross = between(15, 45);
    const principal = String(Math.round(gross * 0.85 * Number(m.rate['22K']!.buy) * between(0.35, 0.5) / 1000) * 1000);
    const sanctionedOn = notBefore(addDays(built.today, -intBetween(20, 110)), built.floor);
    await attempt(tx, warnings, `Girvi loan at ${b.name}`, async () => {
      const loan = await sanction(tx, {
        customerId: borrower.id, sanctionedOn, principalAmount: principal,
        disbursalMethodId: m.methods.BANK!, disbursalReference: reference('NEFT'),
        borrowerIdType: 'aadhaar', borrowerIdNumber: `XXXX XXXX ${digits(4)}`, packetWitnessName: person(),
        collateral: [{
          description: pick(['Gold bangles (pair)', 'Gold chain with pendant', 'Necklace set', 'Two gold rings']),
          metalId: m.metal.GOLD, purityId: m.purity['22K']!.id, grossWeight: gross.toFixed(3),
          stoneWeight: chance(0.3) ? grams(0.5, 2) : undefined, testMethod: 'touchstone', conditionNotes: 'Normal wear',
        }],
      }) as unknown as { id: string };
      // The first borrower has paid the interest so far.
      if (i === 0 && sanctionedOn < addDays(built.today, -30)) {
        const { interestDue } = await settlementQuote(tx, loan.id);
        if (compare(interestDue, '1') > 0) {
          await repay(tx, loan.id, { amount: round(interestDue, 0), paymentMethodId: m.methods.UPI!, reference: reference('UPI'), notes: 'Interest to date' });
        }
      }
      return loan;
    });
  }
}

/* =============================================================== accounts */

async function seedAccounts(tx: Tx, m: Masters, b: Branch, first: boolean, warnings: string[]): Promise<void> {
  const expenses: Array<[string, string, Decimal, string]> = [
    ['5400', 'Shop rent for the month', rupees(first ? 45_000 : 25_000, first ? 95_000 : 55_000, 1000), 'BANK'],
    ['5430', 'Electricity bill', rupees(4_000, 15_000), 'UPI'],
    ['5420', 'Staff salaries', rupees(first ? 90_000 : 45_000, first ? 180_000 : 90_000, 1000), 'BANK'],
    ['5530', 'Boxes and pouches', rupees(1_500, 4_000), 'CASH'],
    ['5900', 'Tea and refreshments', rupees(400, 1_500, 50), 'CASH'],
  ];
  for (const [code, narration, amount, mode] of expenses) {
    const accountId = m.accounts[code];
    if (!accountId) continue;
    await attempt(tx, warnings, `${narration} at ${b.name}`, () => createJournal(tx, {
      docType: 'expense', accountId, amount, paymentMethodId: m.methods[mode]!,
      reference: mode === 'CASH' ? undefined : reference(mode), narration, payee: narration.split(' ')[0],
    }));
  }
  /* A part payment to the supplier the stock came from. */
  if (first) {
    const owed = await tx.query<{ party_id: string; due: Decimal }>(
      `select e.party_id, sum(e.credit - e.debit)::text as due
         from ledger_entry e join account a on a.id = e.account_id
        where a.code = '2000' and e.party_id is not null group by e.party_id having sum(e.credit - e.debit) > 0`);
    for (const row of owed.slice(0, 1)) {
      await attempt(tx, warnings, `Supplier payment at ${b.name}`, () => createSettlement(tx, {
        supplierId: row.party_id, kind: 'payment', amount: round(mul(row.due, between(0.3, 0.6).toFixed(2)), 0),
        paymentMethodId: m.methods.BANK!, reference: reference('RTGS'), notes: 'Part payment against the bill',
      }));
    }
  }
}

/* ================================================================ removal */

/**
 * Deletes tenants and everything that belongs to them.
 *
 * Rather than keep a hand-written list of tables in the right order, it finds
 * every table with a `tenant_id` and keeps deleting: a table whose rows are
 * still pointed at fails this pass and succeeds on a later one, once its
 * children are gone. Each delete runs in a savepoint so one failure does not
 * abort the transaction. The platform's own audit rows are kept, unlinked.
 */
export async function deleteTenantData(tenantIds: string[]): Promise<void> {
  if (!tenantIds.length) return;
  await asPlatform(async (tx) => {
    const tables = await tx.query<{ table_name: string }>(
      `select table_name from information_schema.columns
        where table_schema = current_schema() and column_name = 'tenant_id' and table_name <> 'tenant'`);
    let remaining = tables.map((t) => t.table_name);

    for (let pass = 1; remaining.length > 0; pass++) {
      const failed: string[] = [];
      for (const table of remaining) {
        // On the raw client: a refusal here is expected and retried, not an error worth logging.
        await tx.raw.query('savepoint wipe');
        try {
          await tx.raw.query(`delete from "${table}" where tenant_id = any($1::uuid[])`, [tenantIds]);
          await tx.raw.query('release savepoint wipe');
        } catch {
          await tx.raw.query('rollback to savepoint wipe');
          failed.push(table);
        }
      }
      if (failed.length === remaining.length) throw new Error(`Could not delete tenant data from: ${failed.join(', ')}`);
      remaining = failed;
    }

    await tx.query(`update platform_audit_log set target_tenant_id = null where target_tenant_id = any($1::uuid[])`, [tenantIds]);
    await tx.query(`delete from tenant where id = any($1::uuid[])`, [tenantIds]);
  });
  for (const id of tenantIds) invalidateTenantModules(id);
}

/** Deletes one demo business. A real business is refused: it is suspended or closed, never erased. */
export async function deleteDemoTenant(tenantId: string, actorId: string, ip?: string): Promise<void> {
  const tenant = await asPlatform((tx) => tx.maybeOne<{ code: string; display_name: string; is_demo: boolean }>(
    `select code, display_name, is_demo from tenant where id = $1`, [tenantId]));
  if (!tenant) throw new NotFoundError('Tenant', tenantId);
  if (!tenant.is_demo) {
    throw new BusinessRuleError(
      `${tenant.display_name} is a real business, not a demo. Suspend or close it instead — its records are never deleted.`,
      'tenant_not_demo');
  }
  await deleteTenantData([tenantId]);
  await asPlatform((tx) => audit(tx, actorId, 'tenant.demo_delete', {
    targetType: 'tenant', targetId: tenantId, ip, changes: { code: tenant.code, name: tenant.display_name },
  }));
  logger.info({ tenantId, code: tenant.code, actorId }, 'Demo tenant deleted');
}

/* =================================================================== jobs */

export const MAX_DEMOS_PER_JOB = 20;
const KEEP_FINISHED_MS = 60 * 60_000;

export interface DemoJob {
  id: string;
  operatorId: string;
  count: number;
  status: 'queued' | 'running' | 'done';
  startedAt: string;
  finishedAt: string | null;
  /** What is being made right now. */
  current: { index: number; step: string } | null;
  accounts: DemoAccount[];
  failures: Array<{ index: number; message: string }>;
  /** Asked to stop: the demo being made is finished, the rest are not started. */
  stopped: boolean;
}

const jobs = new Map<string, DemoJob>();
/** One demo at a time across the whole process, so two clicks cannot gang up on the database. */
let queue: Promise<void> = Promise.resolve();

function sweep(): void {
  const cutoff = Date.now() - KEEP_FINISHED_MS;
  for (const [id, job] of jobs) if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) jobs.delete(id);
}

export function startDemoJob(count: number, operatorId: string, ip?: string): DemoJob {
  sweep();
  const job: DemoJob = {
    id: newId(), operatorId, count, status: 'queued', startedAt: new Date().toISOString(), finishedAt: null,
    current: null, accounts: [], failures: [], stopped: false,
  };
  jobs.set(job.id, job);
  queue = queue.then(async () => {
    job.status = 'running';
    for (let index = 1; index <= count && !job.stopped; index++) {
      job.current = { index, step: 'Starting' };
      try {
        job.accounts.push(await createDemoTenant(operatorId, ip, (step) => { job.current = { index, step }; }));
      } catch (error) {
        logger.error({ err: error, jobId: job.id, index }, 'Demo tenant failed');
        job.failures.push({ index, message: error instanceof Error ? error.message : String(error) });
      }
    }
    job.status = 'done';
    job.current = null;
    job.finishedAt = new Date().toISOString();
  });
  return job;
}

/** A job is visible only to the operator who started it: it carries passwords. */
export function demoJob(id: string, operatorId: string): DemoJob {
  sweep();
  const job = jobs.get(id);
  if (!job || job.operatorId !== operatorId) {
    throw new NotFoundError('Demo job', id);
  }
  return job;
}

/**
 * Stops a job after the demo it is making. That one is finished rather than
 * cut off, because a half-made demo would only have to be deleted again.
 */
export function stopDemoJob(id: string, operatorId: string): DemoJob {
  const job = demoJob(id, operatorId);
  if (job.status !== 'done') job.stopped = true;
  return job;
}
