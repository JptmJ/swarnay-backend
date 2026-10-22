/**
 * Pieces every kind of import leans on: where a row's stock or money belongs,
 * the opening voucher that puts a balance on the books, taking those vouchers
 * back out, and keeping number series clear of numbers brought over.
 */
import { z } from 'zod';
import type { Tx } from '../../../core/db/client.js';
import { add, compare, isZero, sub, sum, type Decimal } from '../../../core/util/decimal.js';
import { postVoucher, reverseVoucher, type MetalEntry, type MoneyEntry } from '../../accounts/ledger.service.js';
import { financialYear } from '../../numbering/numbering.service.js';
import type { BranchRow, LocationRow } from '../lookups.js';
import { DATE_FORMATS } from '../normalize.js';
import type { FieldDef, Issue, JobContext, LookupValue } from '../types.js';

/** Options every posting import shares. */
export const postingOptions = {
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
    .describe('The cut-over day: balances and opening stock are dated this day. Defaults to today.'),
  defaultBranchId: z.string().uuid().optional().describe('Rows that do not name a branch go here. Defaults to the head office.'),
};
export const postingHelp = [
  { key: 'asOf', label: 'Cut-over date', description: 'The day the old software’s figures are true on. Balances, stock and accounts are dated this day; it cannot be in the future or before the books start.' },
  { key: 'defaultBranchId', label: 'Branch', description: 'Where rows go that do not name a branch. Leave it to use the head office.' },
];
export const dateFormatOption = z.enum(DATE_FORMATS).default('DMY');

export const branchField: FieldDef = { key: 'branch', label: 'Branch', type: 'lookup', lookup: 'branch', synonyms: ['branch', 'branch code', 'branch name', 'showroom', 'store', 'shop', 'outlet'] };
export const locationField: FieldDef = { key: 'location', label: 'Location', type: 'lookup', lookup: 'location', synonyms: ['location', 'counter', 'rack', 'tray', 'section', 'godown', 'place', 'stock location'], description: 'A stock location of the branch by code or name, or a kind: counter, vault, window.' };

/** The branch a row belongs to: the one it names, else the one chosen for the file, else the head office. */
export function branchFor(v: Record<string, unknown>, ctx: JobContext, issues: Issue[], rowNumber: number): BranchRow | null {
  const l = ctx.lookups;
  const named = v.branch as LookupValue | undefined;
  if (named) {
    const hit = l.branch(named);
    if (hit.kind === 'found') return hit.row;
    ctx.unknown('branch', named.text, rowNumber);
    issues.push({ level: 'error', field: 'branch', message: hit.kind === 'ambiguous' ? `Branch "${named.text}" matches more than one.` : `Branch "${named.text}" does not exist. Add it in the console first, or match it in the value panel.` });
    return null;
  }
  const chosen = ctx.options.defaultBranchId ? l.branches.find((b) => b.id === ctx.options.defaultBranchId) : undefined;
  const branch = chosen ?? l.mainBranch();
  if (!branch) issues.push({ level: 'error', message: 'This business has no active branch.' });
  return branch ?? null;
}

/** Where in the branch stock goes: the location named, the one chosen for the file, or the counter / vault. */
export function locationFor(
  v: Record<string, unknown>, ctx: JobContext, branch: BranchRow, prefer: 'counter' | 'vault', issues: Issue[], rowNumber: number,
): LocationRow | null {
  const l = ctx.lookups;
  const named = v.location as LookupValue | undefined;
  if (named) {
    const hit = l.location(named, branch.id);
    if (hit.kind === 'found') return hit.row;
    ctx.unknown('location', named.text, rowNumber);
    issues.push({ level: 'error', field: 'location', message: `${branch.name} has no stock location "${named.text}".` });
    return null;
  }
  const chosen = ctx.options.locationId ? l.locations.find((x) => x.id === ctx.options.locationId && x.branch_id === branch.id) : undefined;
  const location = chosen ?? l.defaultLocation(branch.id, prefer);
  if (!location) issues.push({ level: 'error', message: `${branch.name} has no stock location.` });
  return location ?? null;
}

/** Midday on the cut-over day, so stock reports put opening stock on that day rather than the day it was typed in. */
export const movedAtFor = (ctx: JobContext): Date | undefined =>
  ctx.asOf < ctx.today ? new Date(`${ctx.asOf}T06:30:00Z`) : undefined;

/**
 * One opening voucher. Money lines are balanced against Opening Balance
 * Difference (3900), which is where every opening entry waits until the whole
 * trial balance is in and the difference comes to nothing.
 */
export async function postOpening(tx: Tx, ctx: JobContext, input: {
  branchId: string; narration: string; money?: MoneyEntry[]; metal?: MetalEntry[];
}): Promise<string | null> {
  const money = (input.money ?? []).filter((e) => !isZero(e.debit ?? '0') || !isZero(e.credit ?? '0'));
  const metal = (input.metal ?? []).filter((e) => !isZero(e.weightIn ?? '0') || !isZero(e.weightOut ?? '0'));
  if (!money.length && !metal.length) return null;
  const gap = sub(sum(money.map((e) => e.debit ?? '0')), sum(money.map((e) => e.credit ?? '0')));
  if (!isZero(gap)) {
    money.push(compare(gap, '0') > 0
      ? { accountCode: '3900', credit: gap, narration: 'Opening balance difference' }
      : { accountCode: '3900', debit: sub('0', gap), narration: 'Opening balance difference' });
  }
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'opening', voucherDate: ctx.asOf, branchId: input.branchId,
    sourceType: 'data_import', sourceId: ctx.batchId, narration: input.narration, money, metal,
  });
  return voucherId;
}

/** A debit for a positive amount, a credit for a negative one. */
export const signed = (accountCode: string, amount: Decimal, narration: string, partyId?: string | null): MoneyEntry =>
  compare(amount, '0') >= 0
    ? { accountCode, debit: amount, narration, partyId: partyId ?? null }
    : { accountCode, credit: sub('0', amount), narration, partyId: partyId ?? null };

/** Takes back every voucher an import posted, each on its own date, so the opening position nets to nothing. */
export async function reverseImportVouchers(tx: Tx, batchId: string, reason: string): Promise<number> {
  const vouchers = await tx.query<{ id: string; voucher_date: string }>(
    `select id, voucher_date::text from voucher
      where source_type = 'data_import' and source_id = $1 and not is_reversed and reverses_voucher_id is null
      order by voucher_date, created_at`, [batchId]);
  for (const v of vouchers) await reverseVoucher(tx, v.id, reason, v.voucher_date);
  return vouchers.length;
}

/** Gives a record's number a mark so the number is free again, while the record keeps its history. */
export const undoneSuffix = (batchId: string) => `~U${batchId.replace(/-/g, '').slice(-5).toUpperCase()}`;

/**
 * Moves a number series past numbers brought over from the old software. A
 * shop whose old codes were C000123 would otherwise be handed C000123 again by
 * the next customer added by hand, and the save would fail.
 */
export async function bumpSeriesPast(tx: Tx, docType: string, numbers: Array<string | null | undefined>): Promise<string | null> {
  const used = numbers.filter((n): n is string => Boolean(n));
  if (!used.length) return null;
  const series = await tx.query<{ id: string; prefix: string; suffix: string; padding: number; next_number: string; reset_period: string;
    current_period: string | null; branch_code: string | null }>(
    `select s.id, s.prefix, s.suffix, s.padding, s.next_number::text, s.reset_period, s.current_period, b.code as branch_code
       from numbering_series s left join branch b on b.id = s.branch_id
      where s.doc_type = $1 and s.is_active`, [docType]);
  const now = new Date();
  const fy = financialYear(now);
  const expand = (t: string, branch: string | null) => t
    .replaceAll('{FYS}', fy.slice(2)).replaceAll('{FYY}', fy.slice(0, 4)).replaceAll('{FY}', fy)
    .replaceAll('{YYYY}', String(now.getFullYear())).replaceAll('{YY}', String(now.getFullYear() % 100).padStart(2, '0'))
    .replaceAll('{MM}', String(now.getMonth() + 1).padStart(2, '0')).replaceAll('{BRANCH}', branch ?? '');
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const notes: string[] = [];
  for (const s of series) {
    const pattern = new RegExp(`^${escape(expand(s.prefix, s.branch_code))}(\\d+)${escape(expand(s.suffix, s.branch_code))}$`, 'i');
    let max = 0n;
    for (const n of used) {
      const m = n.match(pattern);
      if (m && BigInt(m[1]!) > max) max = BigInt(m[1]!);
    }
    if (max === 0n || max < BigInt(s.next_number)) continue;
    await tx.query(`update numbering_series set next_number = $2, updated_at = now() where id = $1`, [s.id, (max + 1n).toString()]);
    notes.push(`The ${docType.replace(/_/g, ' ')} series now continues from ${(max + 1n).toString()}, after the highest number brought over.`);
  }
  return notes.join(' ') || null;
}

/** Adds up decimals that may be missing. */
export const plus = (a: Decimal | undefined, b: Decimal | undefined): Decimal => add(a ?? '0', b ?? '0');
