/**
 * Posting to the books.
 *
 * One call writes the voucher, the money entries and the metal entries
 * together, and refuses the whole thing if the money side does not balance.
 * There is no way to post a half-entry, because there is no API for it.
 *
 * It is also the one door every module comes through, so it is where the past
 * is protected: a closed month, a closed year or a closed cash day refuses new
 * entries here, whichever screen they were typed on.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError } from '../../core/errors/app-error.js';
import { compare, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { newId } from '../../core/util/id.js';
import { businessDate } from '../../core/util/business-date.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { nextDocumentNumber } from '../numbering/numbering.service.js';
import { CHART, CHART_RENAMES, type VoucherType } from './accounts.schema.js';

export interface MoneyEntry {
  accountCode?: string;
  accountId?: string;
  partyId?: string | null;
  debit?: Decimal;
  credit?: Decimal;
  narration?: string;
  againstType?: string;
  againstId?: string;
}

export interface MetalEntry {
  accountCode?: string;
  accountId?: string;
  partyId?: string | null;
  metalId: string;
  purityId?: string | null;
  grossWeight?: Decimal;
  weightIn?: Decimal;
  weightOut?: Decimal;
  ratePerGram?: Decimal;
  narration?: string;
}

export interface PostingInput {
  voucherType: VoucherType;
  voucherDate: string;
  branchId: string;
  sourceType: string;
  sourceId: string;
  narration?: string;
  money: MoneyEntry[];
  metal?: MetalEntry[];
}

/* ------------------------------------------------------------- the chart */

/** Tenants whose chart is known to be complete in this process. */
const chartReady = new Set<string>();

/**
 * Brings a business's chart up to the standard one: adds any group or ledger
 * it is missing, hangs the standard ledgers under their groups, and renames
 * a standard ledger whose name nobody has changed. Never touches a ledger the
 * shop made itself, and never removes anything.
 */
export async function ensureChart(tx: Tx, force = false): Promise<void> {
  if (!force && chartReady.has(tx.context.tenantId)) return;
  const rows = JSON.stringify(CHART.map((a) => ({
    code: a.code, name: a.name, account_type: a.account_type, parent: a.parent,
    is_group: a.is_group ?? false, is_direct: a.is_direct ?? false, ledger_kind: a.ledger_kind ?? 'general',
    is_control: a.is_control ?? false, control_for: a.control_for ?? null, tracks_metal: a.tracks_metal ?? false,
    description: a.description ?? null,
  })));
  const recordset = `jsonb_to_recordset($1::jsonb) as x(code text, name text, account_type text, parent text, is_group boolean,
    is_direct boolean, ledger_kind text, is_control boolean, control_for text, tracks_metal boolean, description text)`;
  await tx.query(
    `insert into account (id, tenant_id, code, name, account_type, is_group, is_direct, ledger_kind, is_control, control_for,
                          tracks_metal, description, is_system)
     select gen_random_uuid(), $2, x.code, x.name, x.account_type, x.is_group, x.is_direct, x.ledger_kind, x.is_control,
            x.control_for, x.tracks_metal, x.description, true
       from ${recordset}
      where not exists (select 1 from account a where a.code = x.code)
     on conflict do nothing`,
    [rows, tx.context.tenantId]);
  // Standard ledgers seeded before the chart had groups: hang them in place and give them their kind.
  await tx.query(
    `update account a set parent_id = coalesce(a.parent_id, p.id),
            is_group = x.is_group, is_direct = x.is_direct,
            ledger_kind = case when a.ledger_kind = 'general' then x.ledger_kind else a.ledger_kind end,
            description = coalesce(a.description, x.description)
       from ${recordset}
       left join account p on p.code = x.parent
      where a.code = x.code and a.is_system
        and (a.parent_id is null and x.parent is not null or a.is_group <> x.is_group
             or (a.ledger_kind = 'general' and x.ledger_kind <> 'general'))`,
    [rows]);
  const renames = CHART.filter((a) => Object.values(CHART_RENAMES).includes(a.name));
  if (renames.length) {
    await tx.query(
      `update account a set name = x.name, updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(code text, old text, name text)
        where a.code = x.code and a.is_system and a.name = x.old`,
      [JSON.stringify(renames.map((a) => ({
        code: a.code, name: a.name, old: Object.entries(CHART_RENAMES).find(([, to]) => to === a.name)![0],
      })))]);
  }
  chartReady.add(tx.context.tenantId);
}

/** For tests that rebuild a tenant's chart. */
export const forgetChart = (tenantId?: string) => (tenantId ? chartReady.delete(tenantId) : chartReady.clear());

/**
 * Account codes and ids to the ledgers they name, in one query. A standard
 * account that did not exist when the shop was set up is created the first
 * time it is needed. A group can never be posted to.
 */
async function resolveAccounts(tx: Tx, entries: { accountId?: string; accountCode?: string }[]): Promise<Map<string, string>> {
  if (entries.some((e) => !e.accountId && !e.accountCode)) throw new Error('A ledger entry needs either accountId or accountCode');
  const codes = [...new Set(entries.flatMap((e) => (!e.accountId && e.accountCode ? [e.accountCode] : [])))];
  const ids = [...new Set(entries.flatMap((e) => (e.accountId ? [e.accountId] : [])))];
  const load = () => tx.query<{ id: string; code: string; name: string; is_group: boolean; is_active: boolean }>(
    `select id, code, name, is_group, is_active from account
      where (code = any($1::text[]) or id = any($2::uuid[])) and deleted_at is null`, [codes, ids]);
  let rows = await load();
  if (codes.some((c) => !rows.some((r) => r.code === c))) {
    await ensureChart(tx, true);
    rows = await load();
  }
  const missing = codes.find((c) => !rows.some((r) => r.code === c)) ?? ids.find((i) => !rows.some((r) => r.id === i));
  if (missing) throw new BusinessRuleError(`Account "${missing}" does not exist in the chart of accounts.`, 'account_missing');
  const group = rows.find((r) => r.is_group);
  if (group) throw new BusinessRuleError(`${group.name} is a group. Post to a ledger under it.`, 'account_is_group');
  return new Map(rows.map((r) => [r.code, r.id]));
}

/* --------------------------------------------------------- the locked past */

const LOCK_SETTINGS = {
  booksStart: CONFIG.accBooksStart, autoLock: CONFIG.accMonthAutoLock,
  lockDays: CONFIG.accMonthLockDays, dayLock: CONFIG.accDayLock,
};

const addDays = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const monthEnd = (iso: string) => {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

/**
 * Why nothing may be dated `date` at `branchId`, or null when it may. Closed
 * months and years lock every branch; a closed cash day locks its own branch.
 */
/** Closing entries never touch cash, so a closed cash day does not stop them; the year close writes into its own closed months. */
const NO_DAY_LOCK = new Set<VoucherType>(['gst_settlement', 'year_close', 'revaluation']);

export async function lockReason(tx: Tx, branchId: string, date: string, voucherType?: VoucherType): Promise<{ code: string; message: string } | null> {
  const s = await getConfigMany(tx, LOCK_SETTINGS);
  if (s.booksStart && date < s.booksStart) {
    return { code: 'before_books_start', message: `The books begin on ${s.booksStart}. Nothing can be dated ${date}.` };
  }
  const row = await tx.one<{ period: string | null; month_status: string | null; month_reopened: boolean; day_closed: boolean }>(
    `select (select period_type || ' ' || to_char(start_date, 'Mon YYYY') from accounting_period
              where status = 'closed' and $1::date between start_date and end_date and ($3::boolean or period_type = 'year')
              order by period_type desc limit 1) as period,
            (select status from accounting_period where period_type = 'month' and start_date = date_trunc('month', $1::date)::date) as month_status,
            coalesce((select reopened_at is not null from accounting_period
                       where period_type = 'month' and start_date = date_trunc('month', $1::date)::date), false) as month_reopened,
            exists (select 1 from cash_day where status = 'closed' and branch_id = $2 and business_date = $1::date) as day_closed`,
    [date, branchId, voucherType !== 'year_close']);
  if (row.period) {
    const [kind, ...label] = row.period.split(' ');
    return { code: 'period_closed', message: `The ${kind === 'year' ? 'financial year' : 'month'} of ${label.join(' ')} is closed. Reopen it in Accounts to post on ${date}.` };
  }
  if (s.dayLock && row.day_closed && !(voucherType && NO_DAY_LOCK.has(voucherType))) {
    return { code: 'day_closed', message: `The cash day of ${date} is closed at this branch. Reopen the day in Accounts to post to it.` };
  }
  if (s.autoLock && !row.month_reopened && voucherType !== 'year_close') {
    const today = await businessDate(tx);
    if (addDays(monthEnd(date), s.lockDays) < today) {
      return { code: 'period_closed', message: `${date.slice(0, 7)} locked itself ${s.lockDays} days after the month ended. Reopen it in Accounts to post to it.` };
    }
  }
  return null;
}

export async function assertPeriodOpen(tx: Tx, branchId: string, date: string, voucherType?: VoucherType): Promise<void> {
  const reason = await lockReason(tx, branchId, date, voucherType);
  if (reason) throw new BusinessRuleError(reason.message, reason.code, { date });
}

/* --------------------------------------------------------------- posting */

export async function postVoucher(tx: Tx, input: PostingInput): Promise<{ voucherId: string; voucherNumber: string }> {
  const money = input.money.filter((e) => compare(e.debit ?? '0', '0') !== 0 || compare(e.credit ?? '0', '0') !== 0);
  const metal = (input.metal ?? []).filter((e) => compare(e.weightIn ?? '0', '0') !== 0 || compare(e.weightOut ?? '0', '0') !== 0);

  if (money.length === 0 && metal.length === 0) throw new BusinessRuleError('A voucher must have at least one entry.', 'empty_voucher');
  if (money.some((e) => compare(e.debit ?? '0', '0') < 0 || compare(e.credit ?? '0', '0') < 0)) {
    throw new BusinessRuleError('A ledger entry cannot be negative.', 'negative_entry');
  }

  const totalDebit = sum(money.map((e) => e.debit ?? '0'));
  const totalCredit = sum(money.map((e) => e.credit ?? '0'));
  if (compare(totalDebit, totalCredit) !== 0) {
    throw new BusinessRuleError(
      `The entry does not balance: debits ${totalDebit} vs credits ${totalCredit} (out by ${sub(totalDebit, totalCredit)}).`,
      'unbalanced_voucher',
      { totalDebit, totalCredit },
    );
  }

  // One series for every voucher type. The type is already a column, so a
  // separate series per type would only add setup work for no extra meaning.
  const [{ number }, ids] = await Promise.all([
    nextDocumentNumber(tx, 'voucher', { branchId: input.branchId }),
    resolveAccounts(tx, [...money, ...metal]),
    assertPeriodOpen(tx, input.branchId, input.voucherDate, input.voucherType),
  ]);
  const account = (e: { accountId?: string; accountCode?: string }) => e.accountId ?? ids.get(e.accountCode!)!;

  const voucherId = newId();
  await tx.query(
    `insert into voucher
       (id, tenant_id, voucher_number, voucher_type, voucher_date, branch_id, narration,
        source_type, source_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [voucherId, tx.context.tenantId, number, input.voucherType, input.voucherDate, input.branchId,
     input.narration ?? null, input.sourceType, input.sourceId, tx.context.userId],
  );

  // All entries of each kind in one statement.
  const base = [tx.context.tenantId, voucherId, input.branchId, input.voucherDate, tx.context.userId];
  if (money.length) {
    await tx.query(
      `insert into ledger_entry
         (id, tenant_id, voucher_id, branch_id, entry_date, created_by, updated_by,
          account_id, party_id, debit, credit, narration, against_type, against_id)
       select gen_random_uuid(), $1, $2, $3, $4, $5, $5,
              x.account_id, x.party_id, x.debit, x.credit, x.narration, x.against_type, x.against_id
         from jsonb_to_recordset($6::jsonb) as x(account_id uuid, party_id uuid, debit numeric, credit numeric,
                                                narration text, against_type text, against_id uuid)`,
      [...base, JSON.stringify(money.map((e) => ({
        account_id: account(e), party_id: e.partyId ?? null, debit: e.debit ?? '0', credit: e.credit ?? '0',
        narration: e.narration ?? null, against_type: e.againstType ?? null, against_id: e.againstId ?? null,
      })))],
    );
  }
  if (metal.length) {
    await tx.query(
      `insert into metal_ledger_entry
         (id, tenant_id, voucher_id, branch_id, entry_date, created_by, updated_by,
          account_id, party_id, metal_id, purity_id, gross_weight, weight_in, weight_out, rate_per_gram, narration)
       select gen_random_uuid(), $1, $2, $3, $4, $5, $5,
              x.account_id, x.party_id, x.metal_id, x.purity_id, x.gross_weight, x.weight_in, x.weight_out, x.rate_per_gram, x.narration
         from jsonb_to_recordset($6::jsonb) as x(account_id uuid, party_id uuid, metal_id uuid, purity_id uuid, gross_weight numeric,
                                                weight_in numeric, weight_out numeric, rate_per_gram numeric, narration text)`,
      [...base, JSON.stringify(metal.map((e) => ({
        account_id: account(e), party_id: e.partyId ?? null, metal_id: e.metalId, purity_id: e.purityId ?? null,
        gross_weight: e.grossWeight ?? '0', weight_in: e.weightIn ?? '0', weight_out: e.weightOut ?? '0',
        rate_per_gram: e.ratePerGram ?? null, narration: e.narration ?? null,
      })))],
    );
  }

  return { voucherId, voucherNumber: number };
}

/**
 * Cancels a posted voucher by writing its mirror image. The original stays
 * exactly as it was — an auditor can see both the mistake and the correction.
 * The mirror is dated today unless a date is given (a revaluation is undone
 * on the first of the next month).
 */
export async function reverseVoucher(tx: Tx, voucherId: string, reason: string, onDate?: string): Promise<string> {
  const original = await tx.maybeOne<{
    id: string; voucher_type: VoucherType; branch_id: string;
    source_type: string; source_id: string; is_reversed: boolean;
  }>(`select * from voucher where id = $1`, [voucherId]);

  if (!original) throw new BusinessRuleError('That voucher does not exist.', 'voucher_missing');
  if (original.is_reversed) throw new BusinessRuleError('That voucher was already reversed.', 'already_reversed');

  const moneyRows = await tx.query<{ account_id: string; party_id: string | null; debit: Decimal; credit: Decimal;
    against_type: string | null; against_id: string | null }>(
    `select account_id, party_id, debit, credit, against_type, against_id from ledger_entry where voucher_id = $1`,
    [voucherId],
  );
  const metalRows = await tx.query<{
    account_id: string; party_id: string | null; metal_id: string; purity_id: string | null;
    gross_weight: Decimal; weight_in: Decimal; weight_out: Decimal;
  }>(`select * from metal_ledger_entry where voucher_id = $1`, [voucherId]);

  const date = onDate ?? (await businessDate(tx));
  const { voucherId: reversalId } = await postVoucher(tx, {
    voucherType: original.voucher_type,
    voucherDate: date,
    branchId: original.branch_id,
    sourceType: original.source_type,
    sourceId: original.source_id,
    narration: `Reversal: ${reason}`,
    money: moneyRows.map((r) => ({
      accountId: r.account_id,
      partyId: r.party_id,
      debit: r.credit,
      credit: r.debit,
      narration: reason,
      againstType: r.against_type ?? undefined,
      againstId: r.against_id ?? undefined,
    })),
    metal: metalRows.map((r) => ({
      accountId: r.account_id,
      partyId: r.party_id,
      metalId: r.metal_id,
      purityId: r.purity_id,
      grossWeight: r.gross_weight,
      weightIn: r.weight_out,
      weightOut: r.weight_in,
      narration: reason,
    })),
  });

  await tx.query(
    `update voucher set is_reversed = true, updated_at = now() where id = $1`,
    [voucherId],
  );
  await tx.query(
    `update voucher set reverses_voucher_id = $2 where id = $1`,
    [reversalId, voucherId],
  );

  return reversalId;
}
