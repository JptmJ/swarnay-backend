/**
 * Finding the shop's own records from what an old file calls them.
 *
 * A file says "22CT", "Gold Chain 22K", "RAMESH PATEL" or "Cash-in-Hand"; the
 * import needs the purity, item, customer and ledger those mean. Everything is
 * loaded once per job and matched in memory, so a file of 50,000 rows costs a
 * handful of queries rather than 50,000 of them.
 *
 * A match is tried most-certain first: an id the operator chose by hand, then
 * the code, then the name — and for people, the phone with the name beside it,
 * because in a jewellery shop's book a whole family often shares one mobile.
 *
 * Records the import is allowed to make (a category, an item, a customer, a
 * ledger) are made here too: as placeholders while checking, for real while
 * importing, and either way remembered so the next row finds them.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { sub, type Decimal } from '../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { createAccount } from '../accounts/chart.service.js';
import { deriveCode, normKey, purityHint, squash } from './normalize.js';
import type { JobContext, LookupKind, LookupValue } from './types.js';

export interface MetalRow { id: string; code: string; name: string }
export interface PurityRow { id: string; metal_id: string; code: string; name: string; fineness: Decimal; karat: string | null; is_active: boolean }
export interface CategoryRow { id: string; code: string; name: string }
export interface ItemRow { id: string; code: string; name: string; tracking: 'lot' | 'piece'; metal_id: string | null; default_purity_id: string | null; category_id: string | null; is_active: boolean }
export interface BranchRow { id: string; code: string; name: string; is_head_office: boolean }
export interface LocationRow { id: string; branch_id: string; code: string; name: string; kind: string; is_default: boolean }
export interface PartyRow { id: string; code: string; name: string; phone: string | null; gstin: string | null; is_customer: boolean; is_supplier: boolean }
export interface KarigarRow { id: string; code: string; name: string; phone: string | null }
export interface PlanRow {
  id: string; code: string; name: string; metal_id: string; purity_id: string | null; accrual_basis: 'rupee' | 'weight';
  tenure_months: number; installment_amount: Decimal | null; minimum_installment: Decimal | null; is_flexible_amount: boolean;
  bonus_installments: Decimal; bonus_percent: Decimal; max_missed_installments: number; making_charge_discount_percent: Decimal;
  grace_period_days: number; is_active: boolean;
}
export interface AccountRow {
  id: string; code: string; name: string; tally_name: string | null; is_group: boolean; is_control: boolean;
  account_type: string; parent_id: string | null; is_active: boolean; ledger_kind: string;
}

export type Found<T> = { kind: 'found'; row: T } | { kind: 'ambiguous'; count: number; names: string[] } | { kind: 'missing' };

const METAL_WORDS: Record<string, string[]> = {
  GOLD: ['gold', 'au', 'sona', 'swarna', 'g'],
  SILVER: ['silver', 'ag', 'chandi', 'sterling', 's'],
  PLATINUM: ['platinum', 'pt'],
};

/** The placeholder id of a record that will be made when the import runs. */
export const isPlanned = (id: string | undefined | null): boolean => typeof id === 'string' && id.startsWith('new:');

function index<T>(rows: T[], ...keys: Array<(r: T) => string | null | undefined>): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const seen = new Set<string>();
    for (const key of keys) {
      const k = key(row);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      map.set(k, [...(map.get(k) ?? []), row]);
    }
  }
  return map;
}

const one = <T>(rows: T[] | undefined, name: (r: T) => string): Found<T> =>
  !rows?.length ? { kind: 'missing' }
    : rows.length === 1 ? { kind: 'found', row: rows[0]! }
      : { kind: 'ambiguous', count: rows.length, names: rows.slice(0, 4).map(name) };

export class Lookups {
  metals: MetalRow[] = [];
  purities: PurityRow[] = [];
  categories: CategoryRow[] = [];
  items: ItemRow[] = [];
  branches: BranchRow[] = [];
  locations: LocationRow[] = [];
  parties: PartyRow[] = [];
  karigars: KarigarRow[] = [];
  plans: PlanRow[] = [];
  accounts: AccountRow[] = [];
  /** Codes in use, so made-up codes never collide. */
  readonly codes = { item: new Set<string>(), category: new Set<string>(), plan: new Set<string>() };

  private byCode = new Map<string, Map<string, unknown[]>>();
  private byName = new Map<string, Map<string, unknown[]>>();
  private partyPhone = new Map<string, PartyRow[]>();
  private partyGstin = new Map<string, PartyRow[]>();
  private karigarPhone = new Map<string, KarigarRow[]>();
  private accountTally = new Map<string, AccountRow[]>();

  static async load(tx: Tx, needs: Iterable<LookupKind>): Promise<Lookups> {
    const want = new Set(needs);
    // Purities need their metals; items and stock need both.
    if (want.has('purity') || want.has('item') || want.has('plan')) want.add('metal');
    if (want.has('item')) { want.add('purity'); want.add('category'); }
    if (want.has('location')) want.add('branch');
    const l = new Lookups();
    const q = <T extends Record<string, unknown>>(kind: LookupKind, sql: string) =>
      (want.has(kind) ? tx.query<T>(sql) : Promise.resolve([] as T[]));
    [l.metals, l.purities, l.categories, l.items, l.branches, l.locations, l.parties, l.karigars, l.plans, l.accounts] = await Promise.all([
      q<MetalRow & Record<string, unknown>>('metal', `select id, code, name from metal where is_active order by sort_order`),
      q<PurityRow & Record<string, unknown>>('purity', `select id, metal_id, code, name, fineness_percent::text as fineness, karat::text as karat, is_active
                                     from purity order by is_active desc, sort_order`),
      q<CategoryRow & Record<string, unknown>>('category', `select id, code, name from item_category`),
      q<ItemRow & Record<string, unknown>>('item', `select id, code, name, tracking, metal_id, default_purity_id, category_id, is_active from item where deleted_at is null`),
      q<BranchRow & Record<string, unknown>>('branch', `select id, code, name, is_head_office from branch where deleted_at is null and is_active order by is_head_office desc, code`),
      q<LocationRow & Record<string, unknown>>('location', `select id, branch_id, code, name, kind, is_default from stock_location
                                       where deleted_at is null and is_active and kind <> 'transit'`),
      q<PartyRow & Record<string, unknown>>('party', `select id, code, name, phone, gstin, is_customer, is_supplier from party where deleted_at is null and code <> 'WALKIN'`),
      q<KarigarRow & Record<string, unknown>>('karigar', `select id, code, name, phone from karigar where deleted_at is null`),
      q<PlanRow & Record<string, unknown>>('plan', `select id, code, name, metal_id, purity_id, accrual_basis, tenure_months, installment_amount::text,
                                   minimum_installment::text, is_flexible_amount, bonus_installments::text, bonus_percent::text,
                                   max_missed_installments, making_charge_discount_percent::text, grace_period_days, is_active
                              from scheme_plan where deleted_at is null`),
      q<AccountRow & Record<string, unknown>>('account', `select id, code, name, tally_name, is_group, is_control, account_type, parent_id, is_active, ledger_kind
                                      from account where deleted_at is null`),
    ]);
    l.reindex();
    return l;
  }

  /** Builds the in-memory indexes once, after loading. */
  reindex(): void {
    const set = <T extends { code: string; name: string }>(kind: string, rows: T[]) => {
      this.byCode.set(kind, index(rows, (r) => squash(r.code)) as Map<string, unknown[]>);
      this.byName.set(kind, index(rows, (r) => normKey(r.name)) as Map<string, unknown[]>);
    };
    set('metal', this.metals); set('purity', this.purities); set('category', this.categories); set('item', this.items);
    set('branch', this.branches); set('party', this.parties); set('karigar', this.karigars); set('plan', this.plans);
    set('account', this.accounts);
    this.partyPhone = index(this.parties, (p) => phoneKey(p.phone));
    this.partyGstin = index(this.parties, (p) => p.gstin?.toUpperCase());
    this.karigarPhone = index(this.karigars, (k) => phoneKey(k.phone));
    this.accountTally = index(this.accounts, (a) => normKey(a.tally_name));
    for (const i of this.items) this.codes.item.add(i.code.toUpperCase());
    for (const c of this.categories) this.codes.category.add(c.code.toUpperCase());
    for (const p of this.plans) this.codes.plan.add(p.code.toUpperCase());
  }

  /**
   * Adds one record made during the job to the indexes. Rebuilding them all
   * instead would cost a pass over every customer for every customer created.
   */
  private remember(kind: 'category' | 'item' | 'party' | 'karigar' | 'account' | 'plan', row: { code: string; name: string } & Record<string, unknown>): void {
    const push = <T>(map: Map<string, T[]> | undefined, key: string | null | undefined, value: T) => {
      if (!map || !key) return;
      map.set(key, [...(map.get(key) ?? []), value]);
    };
    push(this.byCode.get(kind), squash(row.code), row);
    push(this.byName.get(kind), normKey(row.name), row);
    if (kind === 'party') {
      push(this.partyPhone, phoneKey(row.phone as string | null), row as unknown as PartyRow);
      push(this.partyGstin, (row.gstin as string | null)?.toUpperCase(), row as unknown as PartyRow);
    }
    if (kind === 'karigar') push(this.karigarPhone, phoneKey(row.phone as string | null), row as unknown as KarigarRow);
    if (kind === 'account') push(this.accountTally, normKey(row.tally_name as string | null), row as unknown as AccountRow);
    if (kind === 'item') this.codes.item.add(row.code.toUpperCase());
    if (kind === 'category') this.codes.category.add(row.code.toUpperCase());
    if (kind === 'plan') this.codes.plan.add(row.code.toUpperCase());
  }

  /** Masters an import made or changed, so later rows in the same job find them as they now are. */
  rememberRow(kind: 'category' | 'item' | 'party' | 'karigar' | 'plan', row: { id: string; code: string; name: string } & Record<string, unknown>): void {
    const list = { category: this.categories, item: this.items, party: this.parties, karigar: this.karigars, plan: this.plans }[kind] as unknown[];
    list.push(row);
    this.remember(kind, row);
  }

  private code<T>(kind: string, text: string): T[] | undefined { return this.byCode.get(kind)?.get(squash(text)) as T[] | undefined; }
  private name<T>(kind: string, text: string): T[] | undefined { return this.byName.get(kind)?.get(normKey(text)) as T[] | undefined; }

  /** Code first, then name: the common case for masters with both. */
  private codeOrName<T extends { id: string; name: string }>(kind: string, rows: T[], v: LookupValue): Found<T> {
    if (v.id) { const row = rows.find((r) => r.id === v.id); return row ? { kind: 'found', row } : { kind: 'missing' }; }
    const byCode = this.code<T>(kind, v.text);
    if (byCode?.length === 1) return { kind: 'found', row: byCode[0]! };
    return one(this.name<T>(kind, v.text), (r) => r.name);
  }

  metal(v: LookupValue): Found<MetalRow> {
    const hit = this.codeOrName('metal', this.metals, v);
    if (hit.kind !== 'missing') return hit;
    const k = normKey(v.text);
    const code = Object.entries(METAL_WORDS).find(([, words]) => words.includes(k))?.[0];
    const row = code ? this.metals.find((m) => m.code === code) : undefined;
    return row ? { kind: 'found', row } : { kind: 'missing' };
  }

  /** The metal a purity cell implies on its own: 925 and "Sterling" are silver, 22K is gold. */
  metalFromPurityText(text: string): MetalRow | undefined {
    const t = normKey(text);
    const code = /silver|sterling|chandi/.test(t) ? 'SILVER' : /platinum/.test(t) ? 'PLATINUM' : /gold|\bk\b|kt|karat|carat/.test(t) ? 'GOLD' : null;
    return code ? this.metals.find((m) => m.code === code) : undefined;
  }

  /**
   * A purity from its code, name, karat or fineness. With the metal known it is
   * looked for within that metal; without it, 999 could be gold or silver and
   * is called ambiguous rather than guessed.
   */
  purity(v: LookupValue, metalId?: string | null): Found<PurityRow> {
    const pool = this.purities.filter((p) => !metalId || p.metal_id === metalId);
    if (v.id) { const row = this.purities.find((r) => r.id === v.id); return row ? { kind: 'found', row } : { kind: 'missing' }; }
    const pick = (rows: PurityRow[]) => {
      const live = rows.filter((r) => r.is_active);
      return one(live.length ? live : rows, (r) => r.code);
    };
    const exact = pool.filter((p) => squash(p.code) === squash(v.text) || normKey(p.name) === normKey(v.text));
    if (exact.length) return pick(exact);
    const hint = purityHint(v.text);
    if (!hint) return { kind: 'missing' };
    const implied = metalId ? pool : (() => { const m = this.metalFromPurityText(v.text); return m ? pool.filter((p) => p.metal_id === m.id) : pool; })();
    if (hint.karat !== undefined) {
      const byKarat = implied.filter((p) => p.karat !== null && Number(p.karat) === hint.karat);
      if (byKarat.length) return pick(byKarat);
    }
    if (hint.fineness) {
      // 91.6 and 91.667 are both "22K": a purity within half a percent is the one meant.
      const near = implied.filter((p) => Math.abs(Number(sub(p.fineness, hint.fineness!))) <= 0.5)
        .sort((a, b) => Math.abs(Number(sub(a.fineness, hint.fineness!))) - Math.abs(Number(sub(b.fineness, hint.fineness!))));
      if (near.length) {
        const best = Number(sub(near[0]!.fineness, hint.fineness));
        return pick(near.filter((p) => Number(sub(p.fineness, hint.fineness!)) === best));
      }
    }
    return { kind: 'missing' };
  }

  category(v: LookupValue): Found<CategoryRow> { return this.codeOrName('category', this.categories, v); }
  item(v: LookupValue): Found<ItemRow> { return this.codeOrName('item', this.items, v); }
  plan(v: LookupValue): Found<PlanRow> { return this.codeOrName('plan', this.plans, v); }

  branch(v: LookupValue): Found<BranchRow> { return this.codeOrName('branch', this.branches, v); }
  /** The head office, or the first branch: where rows without a branch go. */
  mainBranch(): BranchRow | undefined { return this.branches.find((b) => b.is_head_office) ?? this.branches[0]; }

  location(v: LookupValue, branchId: string): Found<LocationRow> {
    const pool = this.locations.filter((l) => l.branch_id === branchId);
    if (v.id) { const row = this.locations.find((l) => l.id === v.id); return row ? { kind: 'found', row } : { kind: 'missing' }; }
    const k = normKey(v.text);
    const named = pool.filter((l) => normKey(l.code) === k || normKey(l.name) === k);
    // "Vault" or "Counter" with no location of that name: the branch's location of that kind.
    return one(named.length ? named : pool.filter((l) => l.kind === k), (l) => l.name);
  }

  /** The counter for showcase pieces, the vault for bulk metal, else the branch's default spot. */
  defaultLocation(branchId: string, prefer: 'counter' | 'vault'): LocationRow | undefined {
    const pool = this.locations.filter((l) => l.branch_id === branchId);
    return pool.find((l) => l.kind === prefer) ?? pool.find((l) => l.is_default) ?? pool[0];
  }

  /**
   * A customer or supplier. Code first; then the phone — but where a phone is
   * shared, only together with the name; then the name alone, if only one
   * party of that kind carries it.
   */
  party(v: LookupValue, opts: { role?: 'customer' | 'supplier' | null; phone?: string | null; gstin?: string | null } = {}): Found<PartyRow> {
    if (v.id) { const row = this.parties.find((p) => p.id === v.id); return row ? { kind: 'found', row } : { kind: 'missing' }; }
    const name = normKey(v.text);
    const byCode = this.code<PartyRow>('party', v.text);
    if (byCode?.length === 1) return { kind: 'found', row: byCode[0]! };
    if (opts.gstin) {
      const byGstin = this.partyGstin.get(opts.gstin.toUpperCase());
      if (byGstin?.length === 1) return { kind: 'found', row: byGstin[0]! };
    }
    const phone = phoneKey(opts.phone) ?? phoneKey(/^\+?[\d\s-]{10,15}$/.test(v.text) ? v.text : null);
    if (phone) {
      const byPhone = this.partyPhone.get(phone) ?? [];
      const sameName = byPhone.filter((p) => normKey(p.name) === name);
      if (sameName.length === 1) return { kind: 'found', row: sameName[0]! };
      if (byPhone.length === 1 && (!name || /^\+?[\d\s-]{10,15}$/.test(v.text))) return { kind: 'found', row: byPhone[0]! };
    }
    if (!name) return { kind: 'missing' };
    const byName = this.name<PartyRow>('party', v.text) ?? [];
    const ofRole = opts.role ? byName.filter((p) => (opts.role === 'customer' ? p.is_customer : p.is_supplier)) : byName;
    if (ofRole.length === 1) return { kind: 'found', row: ofRole[0]! };
    if (ofRole.length > 1) return { kind: 'ambiguous', count: ofRole.length, names: ofRole.slice(0, 4).map((p) => `${p.name} (${p.code})`) };
    return one(byName, (p) => `${p.name} (${p.code})`);
  }

  /** Who else already uses this phone, for a "shares a number with…" note. */
  partiesWithPhone(phone: string | null | undefined): PartyRow[] { return this.partyPhone.get(phoneKey(phone) ?? '') ?? []; }
  partyByGstin(gstin: string): PartyRow[] { return this.partyGstin.get(gstin.toUpperCase()) ?? []; }

  karigar(v: LookupValue, phone?: string | null): Found<KarigarRow> {
    if (v.id) { const row = this.karigars.find((k) => k.id === v.id); return row ? { kind: 'found', row } : { kind: 'missing' }; }
    const byCode = this.code<KarigarRow>('karigar', v.text);
    if (byCode?.length === 1) return { kind: 'found', row: byCode[0]! };
    const p = phoneKey(phone);
    if (p) {
      const hit = (this.karigarPhone.get(p) ?? []).filter((k) => normKey(k.name) === normKey(v.text));
      if (hit.length === 1) return { kind: 'found', row: hit[0]! };
    }
    return one(this.name<KarigarRow>('karigar', v.text), (k) => `${k.name} (${k.code})`);
  }

  /** A ledger by code, name or the name Tally gave it. */
  account(v: LookupValue): Found<AccountRow> {
    if (v.id) { const row = this.accounts.find((a) => a.id === v.id); return row ? { kind: 'found', row } : { kind: 'missing' }; }
    const byCode = this.code<AccountRow>('account', v.text);
    if (byCode?.length === 1) return { kind: 'found', row: byCode[0]! };
    // A ledger and its group often share a name ("Capital Account", "Stock in Hand"): a balance belongs to the ledger.
    const byName = this.name<AccountRow>('account', v.text);
    const ledgersByName = byName?.filter((a) => !a.is_group);
    if (ledgersByName?.length) return one(ledgersByName, (a) => `${a.name} (${a.code})`);
    if (byName?.length) return one(byName, (a) => `${a.name} (${a.code})`);
    const byTally = one(this.accountTally.get(normKey(v.text)), (a) => `${a.name} (${a.code})`);
    if (byTally.kind !== 'missing') return byTally;
    // Tally calls it "Cash"; a shop with a single cash ledger means that one.
    if (['cash', 'cash a c', 'cash ac', 'cash account', 'cash in hand', 'petty cash'].includes(normKey(v.text))) {
      return one(this.accounts.filter((a) => a.ledger_kind === 'cash' && !a.is_group && a.is_active), (a) => `${a.name} (${a.code})`);
    }
    return { kind: 'missing' };
  }

  /** An account group by its Tally name ("Sundry Debtors", "Cash-in-Hand"). */
  group(text: string): AccountRow | undefined {
    const k = normKey(text);
    const groups = this.accounts.filter((a) => a.is_group);
    return groups.find((g) => normKey(g.name) === k || squash(g.code) === squash(text))
      ?? groups.find((g) => squash(g.name) === squash(text))
      // "Bank OD A/c" and "Bank OCC A/c" are bank accounts that run in the red; "Loans (Liability)" is enough for them.
      ?? (/\bbank od\b|\bocc\b|\bod a c\b/.test(k) ? groups.find((g) => g.code === 'G-LOAN') : undefined)
      ?? (/expense/.test(k) ? groups.find((g) => g.code === (/direct/.test(k) && !/indirect/.test(k) ? 'G-DE' : 'G-IE')) : undefined)
      ?? (/income/.test(k) ? groups.find((g) => g.code === (/direct/.test(k) && !/indirect/.test(k) ? 'G-DI' : 'G-II')) : undefined);
  }

  /* --------------------------------------------------------- making records */

  /** A category the file names that the shop does not have yet. */
  async ensureCategory(tx: Tx, ctx: JobContext, name: string): Promise<string> {
    const found = this.category({ text: name });
    if (found.kind === 'found') return found.row.id;
    ctx.willCreate('category', normKey(name));
    const code = deriveCode(name, this.codes.category);
    const id = ctx.mode === 'commit'
      ? (await repo<{ id: string }>(tx, 'item_category').insert({ code, name: name.trim() })).id
      : `new:category:${normKey(name)}`;
    this.rememberRow('category', { id, code, name: name.trim() });
    return id;
  }

  /** An item the stock file names that the masters do not have yet. */
  async ensureItem(tx: Tx, ctx: JobContext, input: {
    name: string; code?: string | null; tracking: 'lot' | 'piece'; metalId: string | null; purityId: string | null; categoryId: string | null;
  }): Promise<ItemRow> {
    const key = normKey(input.code || input.name);
    ctx.willCreate('item', key);
    const code = input.code && !this.codes.item.has(input.code.toUpperCase())
      ? (this.codes.item.add(input.code.toUpperCase()), input.code.toUpperCase())
      : deriveCode(input.name, this.codes.item, 40);
    const values = {
      code, name: input.name.trim(), tracking: input.tracking, nature: input.tracking === 'lot' ? 'raw_metal' : 'finished',
      uom: 'gram', metal_id: input.metalId, default_purity_id: input.purityId,
      category_id: isPlanned(input.categoryId) ? null : input.categoryId, hsn_code: '7113', is_active: true,
    };
    const id = ctx.mode === 'commit' ? (await repo<{ id: string }>(tx, 'item').insert(values)).id : `new:item:${key}`;
    const row: ItemRow = { id, code, name: values.name, tracking: input.tracking, metal_id: input.metalId,
      default_purity_id: input.purityId, category_id: values.category_id, is_active: true };
    this.rememberRow('item', row as unknown as ItemRow & Record<string, unknown>);
    return row;
  }

  /** A customer or supplier named in a balance, scheme or loan file who is not in the masters yet. */
  async createParty(tx: Tx, ctx: JobContext, input: { name: string; phone?: string | null; role: 'customer' | 'supplier' }): Promise<PartyRow> {
    ctx.willCreate(input.role, `${normKey(input.name)}|${phoneKey(input.phone) ?? ''}`);
    let row: PartyRow;
    if (ctx.mode === 'commit') {
      const { numbers: [code] } = await reserveDocumentNumbers(tx, 'party', 1);
      const saved = await repo<PartyRow>(tx, 'party').insert({
        code, name: input.name.trim(), phone: input.phone ?? null, is_customer: input.role === 'customer',
        is_supplier: input.role === 'supplier', party_type: input.role === 'supplier' ? 'business' : 'individual', is_active: true,
        notes: `Created by the data import "${ctx.title}".`,
      });
      row = { id: saved.id, code: saved.code, name: saved.name, phone: saved.phone, gstin: null, is_customer: saved.is_customer, is_supplier: saved.is_supplier };
    } else {
      row = { id: `new:party:${normKey(input.name)}|${phoneKey(input.phone) ?? ''}`, code: '(new)', name: input.name.trim(), phone: input.phone ?? null,
        gstin: null, is_customer: input.role === 'customer', is_supplier: input.role === 'supplier' };
    }
    this.rememberRow('party', row as unknown as PartyRow & Record<string, unknown>);
    return row;
  }

  /** Marks an existing party as a customer or supplier too, when a balance or account needs it to be. */
  async addRole(tx: Tx, ctx: JobContext, party: PartyRow, role: 'customer' | 'supplier'): Promise<void> {
    if (role === 'customer' ? party.is_customer : party.is_supplier) return;
    if (ctx.mode === 'commit') {
      await tx.query(`update party set ${role === 'customer' ? 'is_customer' : 'is_supplier'} = true, updated_at = now() where id = $1`, [party.id]);
    }
    if (role === 'customer') party.is_customer = true; else party.is_supplier = true;
  }

  async createKarigar(tx: Tx, ctx: JobContext, input: { name: string; phone?: string | null }): Promise<KarigarRow> {
    ctx.willCreate('karigar', normKey(input.name));
    let row: KarigarRow;
    if (ctx.mode === 'commit') {
      const { numbers: [code] } = await reserveDocumentNumbers(tx, 'karigar', 1);
      const saved = await repo<KarigarRow>(tx, 'karigar').insert({ code, name: input.name.trim(), phone: input.phone ?? null, is_active: true });
      row = { id: saved.id, code: saved.code, name: saved.name, phone: saved.phone };
    } else {
      row = { id: `new:karigar:${normKey(input.name)}`, code: '(new)', name: input.name.trim(), phone: input.phone ?? null };
    }
    this.rememberRow('karigar', row as unknown as KarigarRow & Record<string, unknown>);
    return row;
  }

  /** A ledger from a trial balance that the chart does not have, made under the group the file names. */
  async createLedger(tx: Tx, ctx: JobContext, name: string, group: AccountRow): Promise<AccountRow> {
    ctx.willCreate('ledger', normKey(name));
    let row: AccountRow;
    if (ctx.mode === 'commit') {
      const saved = await createAccount(tx, { name: name.trim(), parentId: group.id, tallyName: name.trim() });
      row = { id: saved.id, code: saved.code, name: saved.name, tally_name: name.trim(), is_group: false, is_control: false,
        account_type: group.account_type, parent_id: group.id, is_active: true, ledger_kind: String(saved.ledger_kind) };
    } else {
      row = { id: `new:ledger:${normKey(name)}`, code: '(new)', name: name.trim(), tally_name: name.trim(), is_group: false,
        is_control: false, account_type: group.account_type, parent_id: group.id, is_active: true, ledger_kind: 'general' };
    }
    this.accounts.push(row);
    this.remember('account', row as unknown as AccountRow & Record<string, unknown>);
    return row;
  }
}

/** The last ten digits: +91 98765 43210, 098765 43210 and 9876543210 are one number. */
export function phoneKey(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}
