/**
 * Closing the books: the cash drawer every day, the month, and the year.
 *
 * A day close counts the drawer against what the books say should be in it
 * and writes any difference to Cash Short / Excess, so the books always match
 * the cash. A month close sets off GST and locks the month. A year close moves
 * the year's profit to capital and locks the year. Every close can be reopened
 * by someone allowed to, and the reason is kept.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { ensureChart, reverseVoucher } from './ledger.service.js';
import { accountsSettings, addDays, fyBounds, monthEnd, monthStart } from './chart.service.js';
import { postSystemJournal } from './journal.service.js';

const rs = (v: Decimal) => round(v, 2);
const abs = (v: Decimal) => (compare(v, '0') < 0 ? sub('0', v) : v);
const inr = (v: Decimal | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function branchOf(tx: Tx, requested?: string): string {
  const b = requested ?? tx.context.branchId;
  if (!b) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return b;
}

/** What each kind of voucher is called on the day sheet. */
export const SOURCE_LABELS: Record<string, string> = {
  sale: 'Sales', sales_return: 'Customer returns', receipt: 'Receipts', payment: 'Payments', expense: 'Expenses',
  contra: 'Cash / bank transfers', journal: 'Journals', old_gold: 'Old gold', scheme: 'Gold savings', mortgage: 'Girvi',
  purchase: 'Purchases', purchase_return: 'Returns to suppliers', production: 'Karigar', opening: 'Opening balance',
  cash_difference: 'Cash short / excess', stock_journal: 'Stock adjustments', branch_transfer: 'Branch transfers',
  gst_settlement: 'GST set-off', year_close: 'Year close', revaluation: 'Revaluation',
};

/* ------------------------------------------------------------------ day */

async function cashLedgers(tx: Tx, accountId?: string) {
  await ensureChart(tx);
  const rows = await tx.query<{ id: string; code: string; name: string }>(
    `select id, code, name from account where deleted_at is null and is_active and not is_group and ledger_kind = 'cash'
       ${accountId ? 'and id = $1' : ''} order by code`, accountId ? [accountId] : []);
  if (accountId && !rows.length) throw new NotFoundError('That cash ledger does not exist.');
  return rows;
}

/** The drawer at a branch on a date: what it opened with, what moved, what should be in it now. */
async function drawer(tx: Tx, accountId: string, branchId: string, date: string) {
  const [opening, moves] = await Promise.all([
    tx.one<{ v: Decimal }>(`select coalesce(sum(debit - credit), 0)::text as v from ledger_entry
                             where account_id = $1 and branch_id = $2 and entry_date < $3`, [accountId, branchId, date]),
    tx.query<{ voucher_type: string; cash_in: Decimal; cash_out: Decimal; count: number }>(
      `select v.voucher_type, sum(e.debit)::text as cash_in, sum(e.credit)::text as cash_out, count(distinct v.id)::int as count
         from ledger_entry e join voucher v on v.id = e.voucher_id
        where e.account_id = $1 and e.branch_id = $2 and e.entry_date = $3
        group by v.voucher_type order by v.voucher_type`, [accountId, branchId, date]),
  ]);
  const cashIn = sum(moves.map((m) => m.cash_in));
  const cashOut = sum(moves.map((m) => m.cash_out));
  return {
    opening: opening.v, cashIn, cashOut, expected: sub(add(opening.v, cashIn), cashOut),
    bySource: moves.map((m) => ({ ...m, label: SOURCE_LABELS[m.voucher_type] ?? m.voucher_type, net: sub(m.cash_in, m.cash_out) })),
  };
}

const denominationsOf = (s: string) => s.split(',').map((x) => Number(x.trim())).filter((n) => n > 0);

function countTotal(denominations: Record<string, number> | undefined, counted: Decimal | undefined): Decimal {
  if (denominations && Object.keys(denominations).length) {
    let total = '0';
    for (const [note, n] of Object.entries(denominations)) {
      if (!(Number.isInteger(n) && n >= 0)) throw new ValidationError(`The count of ₹${note} must be a whole number.`);
      total = add(total, mul(String(note), String(n)));
    }
    if (counted !== undefined && compare(rs(counted), rs(total)) !== 0) {
      throw new ValidationError(`The notes add up to ${inr(total)}, not ${inr(counted)}.`);
    }
    return rs(total);
  }
  if (counted === undefined) throw new ValidationError('Enter the cash counted.');
  if (compare(counted, '0') < 0) throw new ValidationError('Cash counted cannot be negative.');
  return rs(counted);
}

/** Today's (or any day's) cash position for each cash ledger, with its open/close record. */
export async function dayStatus(tx: Tx, q: { date?: string; branchId?: string } = {}) {
  const branchId = branchOf(tx, q.branchId);
  const today = await businessDate(tx);
  const date = q.date ?? today;
  const s = await accountsSettings(tx);
  const ledgers = await cashLedgers(tx);
  const [records, pending, lastClosed] = await Promise.all([
    tx.query<Record<string, unknown> & { account_id: string }>(
      `select d.*, d.business_date::text as business_date, ou.full_name as opened_by_name, cu.full_name as closed_by_name,
              ru.full_name as reopened_by_name, v.voucher_number as difference_voucher_number
         from cash_day d left join app_user ou on ou.id = d.opened_by left join app_user cu on cu.id = d.closed_by
         left join app_user ru on ru.id = d.reopened_by left join voucher v on v.id = d.difference_voucher_id
        where d.branch_id = $1 and d.business_date = $2`, [branchId, date]),
    tx.query<{ business_date: string; name: string }>(
      `select d.business_date::text, a.name from cash_day d join account a on a.id = d.account_id
        where d.branch_id = $1 and d.status = 'open' and d.business_date < $2 order by d.business_date`, [branchId, date]),
    tx.maybeOne<{ business_date: string }>(
      `select business_date::text from cash_day where branch_id = $1 and status = 'closed' order by business_date desc limit 1`, [branchId]),
  ]);
  const drawers = await Promise.all(ledgers.map(async (l) => ({
    account: l,
    ...(await drawer(tx, l.id, branchId, date)),
    record: records.find((r) => r.account_id === l.id) ?? null,
  })));
  return {
    date, today, branchId, drawers,
    unclosedEarlier: pending,
    lastClosed: lastClosed?.business_date ?? null,
    settings: {
      countOnOpen: s.dayCountOnOpen, lockOnClose: s.dayLock, tolerance: s.cashTolerance,
      differencePosting: s.differencePosting, denominations: denominationsOf(s.denominations),
    },
  };
}

async function postDifference(tx: Tx, d: { accountId: string; branchId: string; date: string; difference: Decimal; dayId: string; when: string }) {
  if (isZero(d.difference)) return null;
  const excess = compare(d.difference, '0') > 0;
  const amount = abs(d.difference);
  const label = `Cash ${excess ? 'excess' : 'short'} at ${d.when}, ${d.date}`;
  const entry = await postSystemJournal(tx, {
    docType: 'cash_difference', docDate: d.date, branchId: d.branchId, narration: label, sourceType: 'cash_day', sourceId: d.dayId,
    lines: excess
      ? [{ accountId: d.accountId, debit: amount, narration: label }, { accountCode: '5920', credit: amount, narration: label }]
      : [{ accountCode: '5920', debit: amount, narration: label }, { accountId: d.accountId, credit: amount, narration: label }],
  });
  return entry?.voucher_id ?? null;
}

export async function openDay(tx: Tx, input: { accountId?: string; counted?: Decimal; denominations?: Record<string, number>; note?: string; branchId?: string }) {
  const branchId = branchOf(tx, input.branchId);
  const today = await businessDate(tx);
  const s = await accountsSettings(tx);
  const [cash] = await cashLedgers(tx, input.accountId);
  if (!cash) throw new BusinessRuleError('There is no cash ledger to open.', 'no_cash_ledger');
  const existing = await tx.maybeOne<{ status: string }>(
    `select status from cash_day where branch_id = $1 and business_date = $2 and account_id = $3`, [branchId, today, cash.id]);
  if (existing) throw new BusinessRuleError(`${cash.name} is already ${existing.status === 'open' ? 'open' : 'closed'} for today.`, 'day_exists');
  const d = await drawer(tx, cash.id, branchId, today);
  const counted = s.dayCountOnOpen ? countTotal(input.denominations, input.counted) : d.opening;
  const difference = sub(counted, d.opening);
  if (compare(abs(difference), String(s.cashTolerance)) > 0 && !input.note?.trim()) {
    throw new BusinessRuleError(`The drawer is ${inr(abs(difference))} ${compare(difference, '0') > 0 ? 'over' : 'short'} on what the books carried forward. Add a note to explain it.`, 'note_required');
  }
  const row = await tx.one<{ id: string }>(
    `insert into cash_day (id, tenant_id, branch_id, business_date, account_id, status, opening_expected, opening_counted,
                           opening_denominations, opened_by, opened_at, note, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, 'open', $5, $6, $7, $8, now(), $9, $8, $8) returning id`,
    [tx.context.tenantId, branchId, today, cash.id, d.opening, counted, input.denominations ? JSON.stringify(input.denominations) : null,
     tx.context.userId, input.note ?? null]);
  if (s.differencePosting === 'post') {
    const voucherId = await postDifference(tx, { accountId: cash.id, branchId, date: today, difference, dayId: row.id, when: 'opening' });
    if (voucherId) await tx.query(`update cash_day set difference_voucher_id = $2 where id = $1`, [row.id, voucherId]);
  }
  return dayStatus(tx, { branchId });
}

export async function closeDay(tx: Tx, input: { accountId?: string; date?: string; counted?: Decimal; denominations?: Record<string, number>; note?: string; branchId?: string }) {
  const branchId = branchOf(tx, input.branchId);
  const today = await businessDate(tx);
  const date = input.date ?? today;
  if (date > today) throw new ValidationError('A day that has not happened yet cannot be closed.');
  const s = await accountsSettings(tx);
  const [cash] = await cashLedgers(tx, input.accountId);
  if (!cash) throw new BusinessRuleError('There is no cash ledger to close.', 'no_cash_ledger');
  let row = await tx.maybeOne<{ id: string; status: string; note: string | null }>(
    `select id, status, note from cash_day where branch_id = $1 and business_date = $2 and account_id = $3 for update`, [branchId, date, cash.id]);
  if (row?.status === 'closed') throw new BusinessRuleError(`${cash.name} is already closed for ${date}.`, 'day_closed');
  const before = await drawer(tx, cash.id, branchId, date);
  if (!row) {
    // A day nobody opened is opened with what the books carried forward, and closed at once.
    row = await tx.one<{ id: string; status: string; note: string | null }>(
      `insert into cash_day (id, tenant_id, branch_id, business_date, account_id, status, opening_expected, opening_counted,
                             opened_by, opened_at, created_by, updated_by)
       values (gen_random_uuid(), $1, $2, $3, $4, 'open', $5, $5, $6, now(), $6, $6) returning id, status, note`,
      [tx.context.tenantId, branchId, date, cash.id, before.opening, tx.context.userId]);
  }
  const counted = countTotal(input.denominations, input.counted);
  const difference = sub(counted, before.expected);
  if (compare(abs(difference), String(s.cashTolerance)) > 0 && !input.note?.trim()) {
    throw new BusinessRuleError(`The drawer is ${inr(abs(difference))} ${compare(difference, '0') > 0 ? 'over' : 'short'}. Add a note to explain it before closing.`, 'note_required');
  }
  const voucherId = s.differencePosting === 'post'
    ? await postDifference(tx, { accountId: cash.id, branchId, date, difference, dayId: row.id, when: 'closing' })
    : null;
  const after = await drawer(tx, cash.id, branchId, date);
  await tx.query(
    `update cash_day set status = 'closed', closing_expected = $2, closing_counted = $3, closing_denominations = $4, difference = $5,
            difference_voucher_id = coalesce($6, difference_voucher_id), summary = $7,
            note = coalesce(nullif($8, ''), note), closed_by = $9, closed_at = now(), updated_at = now(), updated_by = $9
      where id = $1`,
    [row.id, before.expected, counted, input.denominations ? JSON.stringify(input.denominations) : null, difference, voucherId,
     JSON.stringify({ opening: after.opening, cashIn: after.cashIn, cashOut: after.cashOut, bySource: after.bySource }),
     input.note ?? '', tx.context.userId]);
  return dayStatus(tx, { branchId, date });
}

export async function reopenDay(tx: Tx, dayId: string, reason: string) {
  const s = await accountsSettings(tx);
  if (!s.allowReopen) throw new BusinessRuleError('Reopening is switched off in Accounts → Settings.', 'reopen_disabled');
  const row = await tx.maybeOne<{ status: string; business_date: string; branch_id: string }>(
    `select status, business_date::text, branch_id from cash_day where id = $1 for update`, [dayId]);
  if (!row) throw new NotFoundError('That day does not exist.');
  if (row.status !== 'closed') throw new BusinessRuleError('That day is not closed.', 'day_not_closed');
  const locked = await tx.maybeOne(`select 1 from accounting_period where status = 'closed' and $1::date between start_date and end_date`, [row.business_date]);
  if (locked) throw new BusinessRuleError(`${row.business_date} is inside a closed month or year. Reopen that first.`, 'period_closed');
  await tx.query(
    `update cash_day set status = 'open', reopened_by = $2, reopened_at = now(), reopen_reason = $3, updated_at = now() where id = $1`,
    [dayId, tx.context.userId, reason]);
  return dayStatus(tx, { branchId: row.branch_id, date: row.business_date });
}

export async function dayHistory(tx: Tx, q: { branchId?: string; from?: string; to?: string; limit?: number }) {
  const params: unknown[] = [q.branchId ?? null, q.from ?? null, q.to ?? null];
  return tx.query(
    `select d.id, d.business_date::text, d.status, d.opening_expected, d.opening_counted, d.closing_expected, d.closing_counted,
            d.difference, d.note, d.closed_at, d.reopen_reason, a.name as account_name, b.name as branch_name,
            cu.full_name as closed_by_name, v.voucher_number as difference_voucher_number
       from cash_day d join account a on a.id = d.account_id join branch b on b.id = d.branch_id
       left join app_user cu on cu.id = d.closed_by left join voucher v on v.id = d.difference_voucher_id
      where ($1::uuid is null or d.branch_id = $1) and ($2::date is null or d.business_date >= $2) and ($3::date is null or d.business_date <= $3)
      order by d.business_date desc, a.code limit ${Number(q.limit ?? 60)}`, params);
}

/* --------------------------------------------------------------- months */

const OUTPUT_GST = ['2200', '2201', '2202', '2203'];
const INPUT_GST = ['1300', '1301', '1302', '1303', '1309'];

/** Net ledger balances by branch for some codes, up to a date. */
async function branchBalances(tx: Tx, codes: string[], to: string, from?: string) {
  return tx.query<{ branch_id: string; code: string; account_id: string; net: Decimal }>(
    `select e.branch_id, a.code, a.id as account_id, sum(e.debit - e.credit)::text as net
       from ledger_entry e join account a on a.id = e.account_id
      where a.code = any($1::text[]) and e.entry_date <= $2 and ($3::date is null or e.entry_date >= $3)
      group by e.branch_id, a.code, a.id having sum(e.debit - e.credit) <> 0`, [codes, to, from ?? null]);
}

/** GST set-off for a month: output less input moved to GST Payable (Net), or carried forward as credit. */
async function settleGst(tx: Tx, periodId: string, end: string) {
  const rows = await branchBalances(tx, [...OUTPUT_GST, ...INPUT_GST], end);
  const byBranch = new Map<string, typeof rows>();
  for (const r of rows) byBranch.set(r.branch_id, [...(byBranch.get(r.branch_id) ?? []), r]);
  const out: { branchId: string; output: Decimal; input: Decimal; net: Decimal; docNumber: string | null }[] = [];
  for (const [branchId, list] of byBranch) {
    const lines: { accountId?: string; accountCode?: string; debit?: Decimal; credit?: Decimal; narration?: string }[] = [];
    let output = '0'; let input = '0';
    for (const r of list) {
      // Clear each GST ledger to nothing.
      if (compare(r.net, '0') < 0) lines.push({ accountId: r.account_id, debit: abs(r.net), narration: 'GST set-off' });
      else lines.push({ accountId: r.account_id, credit: r.net, narration: 'GST set-off' });
      if (OUTPUT_GST.includes(r.code)) output = add(output, sub('0', r.net)); else input = add(input, r.net);
    }
    const net = sub(output, input);
    if (compare(net, '0') > 0) lines.push({ accountCode: '2299', credit: net, narration: 'GST payable for the month' });
    else if (compare(net, '0') < 0) lines.push({ accountCode: '1309', debit: abs(net), narration: 'GST credit carried forward' });
    const entry = await postSystemJournal(tx, {
      docType: 'gst_settlement', docDate: end, branchId, narration: `GST set-off to ${end}`, sourceType: 'accounting_period', sourceId: periodId, lines,
    });
    out.push({ branchId, output, input, net, docNumber: entry?.doc_number ?? null });
  }
  return out;
}

/** Latest pure rate per metal on a date, buying or selling. */
async function pureRates(tx: Tx, on: string, basis: 'buying' | 'selling') {
  const rows = await tx.query<{ metal_id: string; rate: Decimal | null; fineness: Decimal }>(
    `select distinct on (r.metal_id) r.metal_id,
            (case when $2 = 'buying' then coalesce(r.buying_rate_per_gram, r.rate_per_gram) else r.rate_per_gram end)::text as rate,
            coalesce(pu.fineness_percent, 100)::text as fineness
       from metal_rate r left join purity pu on pu.id = r.purity_id
      where r.effective_from < ($1::date + 1)
      order by r.metal_id, coalesce(pu.fineness_percent, 100) desc, r.effective_from desc`, [on, basis]);
  return new Map(rows.filter((r) => r.rate).map((r) => [r.metal_id, rs(String(Number(r.rate) * 100 / Number(r.fineness)))]));
}

/**
 * Metal stock marked to today's rate for the month-end figures only: the gain
 * or loss against cost is written on the last day and reversed on the next,
 * so reports for that date show it and the running books never keep it.
 */
async function revalue(tx: Tx, periodId: string, end: string, basis: 'buying' | 'selling') {
  const [fine, books, rates] = await Promise.all([
    tx.query<{ branch_id: string; metal_id: string; fine: Decimal }>(
      `select e.branch_id, e.metal_id, sum(e.weight_in - e.weight_out)::text as fine
         from metal_ledger_entry e join account a on a.id = e.account_id
        where a.code = '1210' and e.entry_date <= $1 group by e.branch_id, e.metal_id having sum(e.weight_in - e.weight_out) <> 0`, [end]),
    branchBalances(tx, ['1200', '1295'], end),
    pureRates(tx, end, basis),
  ]);
  const out: { branchId: string; market: Decimal; book: Decimal; difference: Decimal }[] = [];
  for (const branchId of new Set(fine.map((f) => f.branch_id))) {
    const market = rs(sum(fine.filter((f) => f.branch_id === branchId).map((f) => mul(f.fine, rates.get(f.metal_id) ?? '0'))));
    const book = sum(books.filter((b) => b.branch_id === branchId).map((b) => b.net));
    const difference = sub(market, book);
    if (isZero(difference)) continue;
    const gain = compare(difference, '0') > 0;
    const amount = abs(difference);
    const entry = await postSystemJournal(tx, {
      docType: 'revaluation', docDate: end, branchId, narration: `Metal stock at ${basis} rate on ${end}`, sourceType: 'accounting_period', sourceId: periodId,
      autoReverseOn: addDays(end, 1),
      lines: gain
        ? [{ accountCode: '1295', debit: amount }, { accountCode: '4600', credit: amount }]
        : [{ accountCode: '4600', debit: amount }, { accountCode: '1295', credit: amount }],
    });
    if (entry) await reverseVoucher(tx, entry.voucher_id, `Revaluation of ${end} undone`, addDays(end, 1));
    out.push({ branchId, market, book, difference });
  }
  return out;
}

async function periodRow(tx: Tx, type: 'month' | 'year', start: string, end: string) {
  const existing = await tx.maybeOne<{ id: string; status: string }>(
    `select id, status from accounting_period where period_type = $1 and start_date = $2 for update`, [type, start]);
  if (existing) return existing;
  return tx.one<{ id: string; status: string }>(
    `insert into accounting_period (id, tenant_id, period_type, start_date, end_date, status, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, 'open', $5, $5) returning id, status`,
    [tx.context.tenantId, type, start, end, tx.context.userId]);
}

/** Profit for a span, per the P&L ledgers, leaving out year-close entries. */
async function profitFor(tx: Tx, from: string, to: string) {
  const r = await tx.one<{ income: Decimal; expense: Decimal }>(
    `select coalesce(sum(case when a.account_type = 'income' then e.credit - e.debit end), 0)::text as income,
            coalesce(sum(case when a.account_type = 'expense' then e.debit - e.credit end), 0)::text as expense
       from ledger_entry e join account a on a.id = e.account_id join voucher v on v.id = e.voucher_id
      where e.entry_date between $1 and $2 and v.voucher_type <> 'year_close' and a.account_type in ('income', 'expense')`, [from, to]);
  return { income: r.income, expense: r.expense, profit: sub(r.income, r.expense) };
}

/** What stands between a month and its close, and what it earned. */
async function monthChecklist(tx: Tx, start: string, end: string) {
  const r = await tx.one<{ pending: number; open_days: number; unmatched: number; unclosed_days: number }>(
    `select (select count(*)::int from journal_entry where status = 'pending_approval' and doc_date between $1 and $2) as pending,
            (select count(*)::int from cash_day where status = 'open' and business_date between $1 and $2) as open_days,
            (select count(*)::int from bank_statement_line where status = 'unmatched' and txn_date between $1 and $2) as unmatched,
            (select count(distinct (e.branch_id, e.entry_date))::int
               from ledger_entry e join account a on a.id = e.account_id and a.ledger_kind = 'cash'
              where e.entry_date between $1 and $2
                and not exists (select 1 from cash_day d where d.branch_id = e.branch_id and d.business_date = e.entry_date and d.status = 'closed')) as unclosed_days`,
    [start, end]);
  return {
    pendingApprovals: r.pending, openCashDays: r.open_days, unmatchedBankLines: r.unmatched, daysWithoutClose: r.unclosed_days,
    blockers: [
      ...(r.pending ? [`${r.pending} expense(s) are waiting for approval.`] : []),
      ...(r.open_days ? [`${r.open_days} cash day(s) were opened and never closed.`] : []),
    ],
    warnings: [
      ...(r.unmatched ? [`${r.unmatched} bank statement line(s) are not matched.`] : []),
      ...(r.unclosed_days ? [`${r.unclosed_days} day(s) had cash movement without a day close.`] : []),
    ],
  };
}

/** The months of a financial year with where each stands. */
export async function periodsOverview(tx: Tx, q: { date?: string } = {}) {
  const s = await accountsSettings(tx);
  const today = await businessDate(tx);
  const fy = fyBounds(q.date ?? today, s.fyStartMonth);
  const rows = await tx.query<{ id: string; period_type: string; start_date: string; end_date: string; status: string; closed_at: string | null;
    closed_by_name: string | null; reopened_at: string | null; reopen_reason: string | null; summary: unknown; voucher_number: string | null }>(
    `select p.id, p.period_type, p.start_date::text, p.end_date::text, p.status, p.closed_at, u.full_name as closed_by_name,
            p.reopened_at, p.reopen_reason, p.summary, v.voucher_number
       from accounting_period p left join app_user u on u.id = p.closed_by left join voucher v on v.id = p.voucher_id
      where p.start_date between $1 and $2`, [fy.start, fy.end]);
  const months = [];
  for (let m = fy.start; m <= fy.end; m = addDays(monthEnd(m), 1)) {
    const end = monthEnd(m);
    const row = rows.find((r) => r.period_type === 'month' && r.start_date === m) ?? null;
    const autoLocked = s.monthAutoLock && !row?.reopened_at && addDays(end, s.monthLockDays) < today;
    const [pnl, check] = m <= today ? await Promise.all([profitFor(tx, m, end), monthChecklist(tx, m, end)]) : [null, null];
    months.push({
      start: m, end, label: new Date(`${m}T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }),
      status: row?.status === 'closed' ? 'closed' : autoLocked ? 'locked' : end < today ? 'due' : m <= today ? 'current' : 'future',
      record: row, pnl, checklist: check,
    });
  }
  const year = rows.find((r) => r.period_type === 'year') ?? null;
  return {
    fy, today, months, year,
    yearPnl: await profitFor(tx, fy.start, fy.end < today ? fy.end : today),
    settings: { autoLock: s.monthAutoLock, lockDays: s.monthLockDays, gstSettlement: s.monthGst, revaluation: s.revaluation,
      allowReopen: s.allowReopen, profitTo: s.yearProfitTo, registration: s.registration },
  };
}

export async function closeMonth(tx: Tx, input: { month: string; note?: string }) {
  const start = monthStart(`${input.month}-01`);
  const end = monthEnd(start);
  const today = await businessDate(tx);
  if (end >= today) throw new BusinessRuleError(`${input.month} has not ended yet. Close it from ${addDays(end, 1)}.`, 'month_not_over');
  const s = await accountsSettings(tx);
  const row = await periodRow(tx, 'month', start, end);
  if (row.status === 'closed') throw new BusinessRuleError(`${input.month} is already closed.`, 'period_closed');
  const check = await monthChecklist(tx, start, end);
  if (check.blockers.length) throw new BusinessRuleError(`${input.month} cannot close yet: ${check.blockers.join(' ')}`, 'close_blocked', check);
  if (s.monthAutoLock) {
    // A month that locked itself is opened for the length of the close, so its own entries can be written.
    await tx.query(`update accounting_period set reopened_at = coalesce(reopened_at, now()) where id = $1`, [row.id]);
  }
  await ensureChart(tx);
  const gst = s.monthGst && s.registration === 'regular' ? await settleGst(tx, row.id, end) : [];
  const revaluation = s.revaluation ? await revalue(tx, row.id, end, s.metalRate) : [];
  const pnl = await profitFor(tx, start, end);
  const gstVoucher = gst.length ? await tx.maybeOne<{ voucher_id: string }>(
    `select voucher_id from journal_entry where source_type = 'accounting_period' and source_id = $1 and doc_type = 'gst_settlement'
      order by created_at desc limit 1`, [row.id]) : null;
  await tx.query(
    `update accounting_period set status = 'closed', closed_by = $2, closed_at = now(), summary = $3, voucher_id = coalesce($4, voucher_id),
            updated_at = now(), updated_by = $2 where id = $1`,
    [row.id, tx.context.userId, JSON.stringify({ gst, revaluation, pnl, checklist: check, note: input.note ?? null }), gstVoucher?.voucher_id ?? null]);
  return { month: input.month, gst, revaluation, pnl, warnings: check.warnings };
}

export async function reopenPeriod(tx: Tx, periodId: string, reason: string) {
  const s = await accountsSettings(tx);
  if (!s.allowReopen) throw new BusinessRuleError('Reopening is switched off in Accounts → Settings.', 'reopen_disabled');
  const p = await tx.maybeOne<{ period_type: string; start_date: string; end_date: string; status: string }>(
    `select period_type, start_date::text, end_date::text, status from accounting_period where id = $1 for update`, [periodId]);
  if (!p) throw new NotFoundError('That period does not exist.');
  if (p.status !== 'closed') throw new BusinessRuleError('That period is not closed.', 'period_not_closed');
  if (p.period_type === 'month') {
    const year = await tx.maybeOne(`select 1 from accounting_period where period_type = 'year' and status = 'closed' and $1::date between start_date and end_date`, [p.start_date]);
    if (year) throw new BusinessRuleError('The financial year this month is in is closed. Reopen the year first.', 'year_closed');
  }
  await tx.query(
    `update accounting_period set status = 'open', reopened_by = $2, reopened_at = now(), reopen_reason = $3, updated_at = now(), updated_by = $2
      where id = $1`, [periodId, tx.context.userId, reason]);
  return { reopened: true, period: p.period_type, start: p.start_date };
}

/* ---------------------------------------------------------------- years */

export async function closeYear(tx: Tx, input: { date?: string; closeOpenMonths?: boolean }) {
  const s = await accountsSettings(tx);
  const today = await businessDate(tx);
  const fy = fyBounds(input.date ?? addDays(fyBounds(today, s.fyStartMonth).start, -1), s.fyStartMonth);
  if (fy.end >= today) throw new BusinessRuleError(`The year ${fy.label} has not ended yet.`, 'year_not_over');
  const year = await periodRow(tx, 'year', fy.start, fy.end);
  if (year.status === 'closed') throw new BusinessRuleError(`The year ${fy.label} is already closed.`, 'period_closed');

  const closed = await tx.query<{ start_date: string }>(
    `select start_date::text from accounting_period where period_type = 'month' and status = 'closed' and start_date between $1 and $2`, [fy.start, fy.end]);
  const open: string[] = [];
  for (let m = fy.start; m <= fy.end; m = addDays(monthEnd(m), 1)) if (!closed.some((c) => c.start_date === m)) open.push(m.slice(0, 7));
  if (open.length && !input.closeOpenMonths) {
    throw new BusinessRuleError(`Close the months first (${open.join(', ')}), or close them all with the year.`, 'months_open', { open });
  }
  for (const month of open) await closeMonth(tx, { month, note: `Closed with the year ${fy.label}` });

  // Each branch's income and expenses cleared, the difference to capital.
  const rows = await tx.query<{ branch_id: string; account_id: string; account_type: string; net: Decimal }>(
    `select e.branch_id, e.account_id, a.account_type, sum(e.debit - e.credit)::text as net
       from ledger_entry e join account a on a.id = e.account_id
      where a.account_type in ('income', 'expense') and e.entry_date <= $1
      group by e.branch_id, e.account_id, a.account_type having sum(e.debit - e.credit) <> 0`, [fy.end]);
  const target = s.yearProfitTo === 'retained' ? '3100' : '3000';
  const results: { branchId: string; profit: Decimal; docNumber: string | null }[] = [];
  for (const branchId of new Set(rows.map((r) => r.branch_id))) {
    const list = rows.filter((r) => r.branch_id === branchId);
    const lines: { accountId?: string; accountCode?: string; debit?: Decimal; credit?: Decimal; narration?: string }[] =
      list.map((r) => (compare(r.net, '0') > 0 ? { accountId: r.account_id, credit: r.net } : { accountId: r.account_id, debit: abs(r.net) }));
    const profit = sub('0', sum(list.map((r) => r.net)));
    lines.push(compare(profit, '0') >= 0
      ? { accountCode: target, credit: profit, narration: `Profit for ${fy.label}` }
      : { accountCode: target, debit: abs(profit), narration: `Loss for ${fy.label}` });
    const entry = await postSystemJournal(tx, {
      docType: 'year_close', docDate: fy.end, branchId, narration: `Year ${fy.label} closed: ${compare(profit, '0') >= 0 ? 'profit' : 'loss'} to ${target === '3000' ? 'capital' : 'retained earnings'}`,
      sourceType: 'accounting_period', sourceId: year.id, lines,
    });
    results.push({ branchId, profit, docNumber: entry?.doc_number ?? null });
  }
  const pnl = await profitFor(tx, fy.start, fy.end);
  await tx.query(
    `update accounting_period set status = 'closed', closed_by = $2, closed_at = now(), summary = $3, updated_at = now(), updated_by = $2 where id = $1`,
    [year.id, tx.context.userId, JSON.stringify({ pnl, branches: results, profitTo: target })]);
  return { year: fy.label, pnl, branches: results, monthsClosed: open };
}
