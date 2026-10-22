/**
 * The chart of accounts as the owner sees it: groups with ledgers under them,
 * each carrying its balance, and the handful of rules that decide how the
 * books behave. Everything else in Accounts reads balances through here.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, isZero, sub, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { ensureChart } from './ledger.service.js';
import type { AccountType } from './accounts.schema.js';

/* -------------------------------------------------------------- settings */

const SETTINGS = {
  registration: CONFIG.accGstRegistration, compositionRate: CONFIG.accCompositionRate,
  revenueSplit: CONFIG.accRevenueSplit, cardCharges: CONFIG.accCardCharges,
  fyStartMonth: CONFIG.accFyStartMonth, booksStart: CONFIG.accBooksStart,
  dayCountOnOpen: CONFIG.accDayOpening, dayLock: CONFIG.accDayLock, denominations: CONFIG.accDayDenominations,
  cashTolerance: CONFIG.accDayTolerance, differencePosting: CONFIG.accDayDifference,
  monthAutoLock: CONFIG.accMonthAutoLock, monthLockDays: CONFIG.accMonthLockDays, monthGst: CONFIG.accMonthGst,
  allowReopen: CONFIG.accPeriodReopen, yearProfitTo: CONFIG.accYearCloseTo,
  expenseApproval: CONFIG.accExpenseApproval, expenseLimit: CONFIG.accExpenseLimit,
  tallyEnabled: CONFIG.accTallyEnabled, tallyCompany: CONFIG.accTallyCompany,
  revaluation: CONFIG.accRevaluation, metalRate: CONFIG.accMetalRate,
  tdsEnabled: CONFIG.accTdsEnabled, tdsPercent: CONFIG.accTdsPercent,
  watchBackdateDays: CONFIG.accWatchBackdate, watchDiscountPercent: CONFIG.accWatchDiscount,
  watchCashLimit: CONFIG.accWatchCash, forecastDays: CONFIG.accForecastDays,
  allowBackdating: CONFIG.allowBackdating,
};
/** Every Accounts rule in force. Anyone with accounts.view may read them. */
export const accountsSettings = (tx: Tx) => getConfigMany(tx, SETTINGS);
export type AccountsSettings = Awaited<ReturnType<typeof accountsSettings>>;

/* ----------------------------------------------------------------- dates */

export const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
export const monthEnd = (iso: string) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
/** The financial year a date falls in, as its first and last day. */
export function fyBounds(iso: string, startMonth: number): { start: string; end: string; label: string } {
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
  const startYear = m >= startMonth ? y : y - 1;
  const start = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const next = new Date(`${start}T00:00:00Z`);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  next.setUTCDate(0);
  const end = next.toISOString().slice(0, 10);
  const label = startMonth === 1 ? String(startYear) : `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  return { start, end, label };
}

/* -------------------------------------------------------------- balances */

export interface ChartAccount {
  id: string; code: string; name: string; account_type: AccountType; parent_id: string | null;
  is_group: boolean; is_direct: boolean; ledger_kind: 'cash' | 'bank' | 'general';
  is_control: boolean; control_for: string | null; tracks_metal: boolean; is_system: boolean; is_active: boolean;
  description: string | null; bank_name: string | null; bank_account_number: string | null; bank_ifsc: string | null;
  tally_name: string | null;
}

export async function loadChart(tx: Tx): Promise<ChartAccount[]> {
  await ensureChart(tx);
  return tx.query<ChartAccount>(
    `select id, code, name, account_type, parent_id, is_group, is_direct, ledger_kind, is_control, control_for, tracks_metal,
            is_system, is_active, description, bank_name, bank_account_number, bank_ifsc, tally_name
       from account where deleted_at is null order by code`);
}

export interface BalanceFilter {
  from?: string; to?: string; branchId?: string | null;
  /** Profit reports leave out the entry that moves a closed year's profit to capital. */
  excludeYearClose?: boolean;
}

/** Debit and credit totals per ledger, in one grouped query. */
export async function balances(tx: Tx, f: BalanceFilter = {}): Promise<Map<string, { debit: Decimal; credit: Decimal }>> {
  const where: string[] = []; const params: unknown[] = [];
  if (f.from) { params.push(f.from); where.push(`e.entry_date >= $${params.length}`); }
  if (f.to) { params.push(f.to); where.push(`e.entry_date <= $${params.length}`); }
  if (f.branchId) { params.push(f.branchId); where.push(`e.branch_id = $${params.length}`); }
  if (f.excludeYearClose) where.push(`v.voucher_type <> 'year_close'`);
  const rows = await tx.query<{ account_id: string; debit: Decimal; credit: Decimal }>(
    `select e.account_id, sum(e.debit)::text as debit, sum(e.credit)::text as credit
       from ledger_entry e ${f.excludeYearClose ? 'join voucher v on v.id = e.voucher_id' : ''}
      ${where.length ? `where ${where.join(' and ')}` : ''}
      group by e.account_id`, params);
  return new Map(rows.map((r) => [r.account_id, { debit: r.debit, credit: r.credit }]));
}

/** Debit-positive net, and the same figure on the side an accountant reads it. */
export const naturalSide = (type: AccountType): 'Dr' | 'Cr' => (type === 'asset' || type === 'expense' ? 'Dr' : 'Cr');
export function natural(type: AccountType, net: Decimal): Decimal {
  return naturalSide(type) === 'Dr' ? net : sub('0', net);
}

export interface TreeRow extends ChartAccount {
  depth: number;
  path: string[];
  debit: Decimal; credit: Decimal;
  /** Debit minus credit. */
  net: Decimal;
  /** Positive when on the account type's usual side. */
  balance: Decimal;
  ledger_count: number;
}

/**
 * The chart in display order — each group followed by what sits under it —
 * with every group carrying the total of everything beneath. Ledgers the shop
 * made before the chart had groups are shown under their type's root group.
 */
export function buildTree(chart: ChartAccount[], sums: Map<string, { debit: Decimal; credit: Decimal }>): TreeRow[] {
  const byId = new Map(chart.map((a) => [a.id, a]));
  const roots = new Map<AccountType, string>();
  for (const a of chart) if (a.is_group && !a.parent_id && !roots.has(a.account_type)) roots.set(a.account_type, a.id);
  const parentOf = (a: ChartAccount) => a.parent_id && byId.has(a.parent_id) ? a.parent_id : (a.is_group ? null : roots.get(a.account_type) ?? null);
  const children = new Map<string | null, ChartAccount[]>();
  for (const a of chart) {
    const p = parentOf(a);
    children.set(p, [...(children.get(p) ?? []), a]);
  }
  const order: AccountType[] = ['asset', 'liability', 'equity', 'income', 'expense'];
  const sortKids = (list: ChartAccount[]) => [...list].sort((x, y) =>
    Number(y.is_group) - Number(x.is_group) || x.code.localeCompare(y.code, undefined, { numeric: true }));
  const out: TreeRow[] = [];
  const walk = (a: ChartAccount, depth: number, path: string[]): TreeRow => {
    const own = sums.get(a.id) ?? { debit: '0', credit: '0' };
    const row: TreeRow = { ...a, depth, path, debit: own.debit, credit: own.credit, net: sub(own.debit, own.credit), balance: '0', ledger_count: a.is_group ? 0 : 1 };
    out.push(row);
    for (const c of sortKids(children.get(a.id) ?? [])) {
      const child = walk(c, depth + 1, [...path, a.name]);
      row.debit = add(row.debit, child.debit); row.credit = add(row.credit, child.credit);
      row.ledger_count += child.ledger_count;
    }
    row.net = sub(row.debit, row.credit);
    row.balance = natural(a.account_type, row.net);
    return row;
  };
  const top = (children.get(null) ?? []).sort((x, y) => order.indexOf(x.account_type) - order.indexOf(y.account_type)
    || x.code.localeCompare(y.code, undefined, { numeric: true }));
  for (const a of top) walk(a, 0, []);
  return out;
}

/** The chart with balances as at a date (or over a period), for one branch or all. */
export async function chartTree(tx: Tx, q: { from?: string; to?: string; branchId?: string; includeInactive?: boolean } = {}) {
  const [chart, sums] = await Promise.all([loadChart(tx), balances(tx, { from: q.from, to: q.to, branchId: q.branchId })]);
  const rows = buildTree(q.includeInactive ? chart : chart.filter((a) => a.is_active || a.is_group), sums);
  return { rows, asOn: q.to ?? (await businessDate(tx)) };
}

/* ------------------------------------------------------- managing ledgers */

export interface AccountInput {
  name: string; parentId: string; code?: string; isGroup?: boolean;
  ledgerKind?: 'cash' | 'bank' | 'general'; description?: string | null;
  bankName?: string | null; bankAccountNumber?: string | null; bankIfsc?: string | null; tallyName?: string | null;
  isActive?: boolean;
}

/** The next free code under a group: one past the highest numeric code among its ledgers. */
async function nextCode(tx: Tx, parent: ChartAccount, isGroup: boolean, name: string): Promise<string> {
  if (isGroup) {
    const base = `G-${name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'GRP'}`;
    const taken = await tx.query<{ code: string }>(`select code from account where code like $1`, [`${base}%`]);
    if (!taken.length) return base;
    for (let i = 2; ; i++) if (!taken.some((t) => t.code === `${base}${i}`)) return `${base}${i}`;
  }
  const siblings = await tx.query<{ code: string }>(
    `with recursive tree as (select id from account where id = $1
                             union all select a.id from account a join tree t on a.parent_id = t.id)
     select a.code from account a join tree t on t.id = a.id where a.code ~ '^[0-9]+$'`, [parent.id]);
  const base = { asset: 1000, liability: 2000, equity: 3000, income: 4000, expense: 5000 }[parent.account_type];
  let next = siblings.length ? Math.max(...siblings.map((s) => Number(s.code))) + 1 : base + 700;
  const all = new Set((await tx.query<{ code: string }>(`select code from account`)).map((r) => r.code));
  while (all.has(String(next))) next++;
  return String(next);
}

async function groupFor(tx: Tx, parentId: string): Promise<ChartAccount> {
  const parent = await tx.maybeOne<ChartAccount>(`select * from account where id = $1 and deleted_at is null`, [parentId]);
  if (!parent) throw new NotFoundError('That group does not exist.');
  if (!parent.is_group) throw new BusinessRuleError(`${parent.name} is a ledger, not a group. Choose the group it belongs in.`, 'parent_not_group');
  return parent;
}

export async function createAccount(tx: Tx, input: AccountInput) {
  await ensureChart(tx);
  const parent = await groupFor(tx, input.parentId);
  const name = input.name.trim();
  if (!name) throw new ValidationError('Give the ledger a name.');
  const dup = await tx.maybeOne<{ code: string }>(`select code from account where lower(name) = lower($1) and deleted_at is null`, [name]);
  if (dup) throw new BusinessRuleError(`There is already a ledger called ${name} (${dup.code}).`, 'account_duplicate');
  const code = input.code?.trim() || (await nextCode(tx, parent, !!input.isGroup, name));
  if (await tx.maybeOne(`select 1 from account where code = $1`, [code])) throw new BusinessRuleError(`Code ${code} is already used.`, 'code_taken');
  const kind = input.ledgerKind ?? (parent.code === 'G-BANK' ? 'bank' : parent.code === 'G-CASH' ? 'cash' : 'general');
  if (kind !== 'general' && parent.account_type !== 'asset') throw new BusinessRuleError('A cash or bank ledger sits under the assets.', 'ledger_kind_invalid');
  return tx.one<ChartAccount>(
    `insert into account (id, tenant_id, code, name, account_type, parent_id, is_group, is_direct, ledger_kind, description,
                          bank_name, bank_account_number, bank_ifsc, tally_name, is_system, is_active, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, $14, $15, $15) returning *`,
    [tx.context.tenantId, code, name, parent.account_type, parent.id, !!input.isGroup, input.isGroup ? parent.is_direct : false,
     input.isGroup ? 'general' : kind, input.description ?? null, input.bankName ?? null, input.bankAccountNumber ?? null,
     input.bankIfsc?.toUpperCase() ?? null, input.tallyName ?? null, input.isActive ?? true, tx.context.userId]);
}

export async function updateAccount(tx: Tx, id: string, input: Partial<AccountInput>) {
  const acc = await tx.maybeOne<ChartAccount>(`select * from account where id = $1 and deleted_at is null for update`, [id]);
  if (!acc) throw new NotFoundError('That ledger does not exist.');
  const sets: string[] = []; const params: unknown[] = [id];
  const set = (col: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Give the ledger a name.');
    const dup = await tx.maybeOne<{ code: string }>(`select code from account where lower(name) = lower($1) and id <> $2 and deleted_at is null`, [name, id]);
    if (dup) throw new BusinessRuleError(`There is already a ledger called ${name} (${dup.code}).`, 'account_duplicate');
    set('name', name);
  }
  if (input.parentId !== undefined && input.parentId !== acc.parent_id) {
    if (acc.is_system) throw new BusinessRuleError(`${acc.name} is a standard ledger and stays in its group.`, 'account_system');
    const parent = await groupFor(tx, input.parentId);
    if (parent.account_type !== acc.account_type) {
      throw new BusinessRuleError(`${acc.name} is ${acc.account_type === 'asset' || acc.account_type === 'expense' ? 'an' : 'a'} ${acc.account_type}; it can only move to another ${acc.account_type} group.`, 'parent_type_mismatch');
    }
    if (acc.is_group) {
      const loop = await tx.maybeOne(
        `with recursive tree as (select id from account where id = $1 union all select a.id from account a join tree t on a.parent_id = t.id)
         select 1 from tree where id = $2`, [id, parent.id]);
      if (loop) throw new BusinessRuleError('A group cannot sit inside itself.', 'parent_loop');
    }
    set('parent_id', parent.id);
  }
  if (input.description !== undefined) set('description', input.description);
  if (input.bankName !== undefined) set('bank_name', input.bankName);
  if (input.bankAccountNumber !== undefined) set('bank_account_number', input.bankAccountNumber);
  if (input.bankIfsc !== undefined) set('bank_ifsc', input.bankIfsc?.toUpperCase() ?? null);
  if (input.tallyName !== undefined) set('tally_name', input.tallyName);
  if (input.ledgerKind !== undefined && input.ledgerKind !== acc.ledger_kind) {
    if (acc.is_system || acc.is_group) throw new BusinessRuleError(`${acc.name}'s kind is fixed.`, 'account_system');
    if (input.ledgerKind !== 'general' && acc.account_type !== 'asset') throw new BusinessRuleError('A cash or bank ledger sits under the assets.', 'ledger_kind_invalid');
    set('ledger_kind', input.ledgerKind);
  }
  if (input.isActive !== undefined && input.isActive !== acc.is_active) {
    if (acc.is_system && !input.isActive) throw new BusinessRuleError(`${acc.name} is a standard ledger the system posts to; it cannot be switched off.`, 'account_system');
    if (!input.isActive) {
      const bal = await tx.one<{ net: Decimal }>(`select coalesce(sum(debit - credit), 0)::text as net from ledger_entry where account_id = $1`, [id]);
      if (!isZero(bal.net)) throw new BusinessRuleError(`${acc.name} still has a balance. Clear it before switching the ledger off.`, 'account_has_balance');
    }
    set('is_active', input.isActive);
  }
  if (!sets.length) return acc;
  params.push(tx.context.userId);
  return tx.one<ChartAccount>(`update account set ${sets.join(', ')}, updated_at = now(), updated_by = $${params.length} where id = $1 returning *`, params);
}

export async function deleteAccount(tx: Tx, id: string) {
  const acc = await tx.maybeOne<ChartAccount>(`select * from account where id = $1 and deleted_at is null for update`, [id]);
  if (!acc) throw new NotFoundError('That ledger does not exist.');
  if (acc.is_system) throw new BusinessRuleError(`${acc.name} is a standard ledger and cannot be removed.`, 'account_system');
  const used = await tx.one<{ entries: number; children: number; modes: number }>(
    `select (select count(*)::int from ledger_entry where account_id = $1) as entries,
            (select count(*)::int from account where parent_id = $1 and deleted_at is null) as children,
            (select count(*)::int from payment_method where account_id = $1 and deleted_at is null) as modes`, [id]);
  if (used.entries) throw new BusinessRuleError(`${acc.name} has entries in the books. Switch it off instead.`, 'account_in_use');
  if (used.children) throw new BusinessRuleError(`${acc.name} still has ledgers under it. Move or remove them first.`, 'account_has_children');
  if (used.modes) throw new BusinessRuleError(`A payment mode in Masters posts to ${acc.name}. Point it elsewhere first.`, 'account_in_use');
  await tx.query(`update account set deleted_at = now(), updated_at = now(), updated_by = $2 where id = $1`, [id, tx.context.userId]);
  return { deleted: true };
}

/** Cash and bank ledgers, each with what the books say is in it. */
export async function moneyAccounts(tx: Tx, q: { asOn?: string; branchId?: string } = {}) {
  await ensureChart(tx);
  const params: unknown[] = [q.asOn ?? null, q.branchId ?? null];
  return tx.query<{ id: string; code: string; name: string; ledger_kind: 'cash' | 'bank'; bank_name: string | null;
    bank_account_number: string | null; balance: Decimal; modes: string | null }>(
    `select a.id, a.code, a.name, a.ledger_kind, a.bank_name, a.bank_account_number,
            coalesce((select sum(e.debit - e.credit) from ledger_entry e
                       where e.account_id = a.id and ($1::date is null or e.entry_date <= $1::date)
                         and ($2::uuid is null or e.branch_id = $2::uuid)), 0)::text as balance,
            (select string_agg(m.name, ', ' order by m.name) from payment_method m
              where m.deleted_at is null and m.is_active
                and (m.account_id = a.id or (m.account_id is null and ((a.code = '1000' and m.kind = 'cash')
                     or (a.code = '1010' and m.kind not in ('cash', 'credit', 'advance', 'old_gold', 'scheme')))))) as modes
       from account a
      where a.deleted_at is null and a.is_active and not a.is_group and a.ledger_kind in ('cash', 'bank')
      order by a.ledger_kind, a.code`, params);
}

/** For a screen that needs one ledger's figures without the whole tree. */
export async function accountBalance(tx: Tx, accountId: string, q: BalanceFilter = {}): Promise<Decimal> {
  const s = await balances(tx, q);
  const b = s.get(accountId);
  return b ? sub(b.debit, b.credit) : '0';
}

export const isPositive = (v: Decimal) => compare(v, '0') > 0;
