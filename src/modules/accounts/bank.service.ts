/**
 * The bank, ticked off against the books, and the books handed to Tally.
 *
 * Reconciliation: the shop pastes or uploads its statement, the lines are
 * matched to the entries in the bank ledger (most by themselves, on amount and
 * date), and what is left shows exactly why the bank and the books differ —
 * a cheque not yet cleared, a charge not yet entered.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { compare, isZero, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { accountsSettings, addDays, loadChart, type ChartAccount } from './chart.service.js';

const rs = (v: Decimal) => round(v, 2);

async function bankLedger(tx: Tx, accountId: string) {
  const a = await tx.maybeOne<{ id: string; name: string; ledger_kind: string }>(
    `select id, name, ledger_kind from account where id = $1 and deleted_at is null`, [accountId]);
  if (!a) throw new NotFoundError('That bank ledger does not exist.');
  if (a.ledger_kind !== 'bank') throw new BusinessRuleError(`${a.name} is not a bank ledger.`, 'not_bank');
  return a;
}

export interface StatementRow { date: string; description?: string; reference?: string; withdrawal?: Decimal; deposit?: Decimal; balance?: Decimal }

/** Adds statement lines, skipping any already imported (same date, amount and description). */
export async function importStatement(tx: Tx, input: { accountId: string; rows: StatementRow[] }) {
  const bank = await bankLedger(tx, input.accountId);
  if (!input.rows.length) throw new ValidationError('The statement has no lines.');
  const batch = `${new Date().toISOString().slice(0, 16)}`;
  const rows = input.rows.map((r, i) => {
    const w = rs(r.withdrawal ?? '0'); const d = rs(r.deposit ?? '0');
    if (compare(w, '0') < 0 || compare(d, '0') < 0) throw new ValidationError(`Line ${i + 1}: amounts cannot be negative.`);
    if (!isZero(w) && !isZero(d)) throw new ValidationError(`Line ${i + 1} has both a withdrawal and a deposit.`);
    if (isZero(w) && isZero(d)) throw new ValidationError(`Line ${i + 1} has no amount.`);
    return { txn_date: r.date, description: r.description?.trim() || null, reference: r.reference?.trim() || null,
      withdrawal: w, deposit: d, balance: r.balance ? rs(r.balance) : null };
  });
  const inserted = await tx.query<{ id: string }>(
    `insert into bank_statement_line (id, tenant_id, account_id, txn_date, description, reference, withdrawal, deposit, balance, import_batch,
                                      created_by, updated_by)
     select gen_random_uuid(), $1, $2, x.txn_date, x.description, x.reference, x.withdrawal, x.deposit, x.balance, $3, $4, $4
       from jsonb_to_recordset($5::jsonb) as x(txn_date date, description text, reference text, withdrawal numeric, deposit numeric, balance numeric)
      where not exists (select 1 from bank_statement_line b where b.account_id = $2 and b.txn_date = x.txn_date
                          and b.withdrawal = x.withdrawal and b.deposit = x.deposit and coalesce(b.description, '') = coalesce(x.description, ''))
     returning id`,
    [tx.context.tenantId, bank.id, batch, tx.context.userId, JSON.stringify(rows)]);
  const matched = await autoMatch(tx, bank.id);
  return { received: rows.length, added: inserted.length, skipped: rows.length - inserted.length, autoMatched: matched.matched };
}

/**
 * Pairs statement lines with book entries of the same amount and direction,
 * closest date first within a week, preferring a matching reference. Each
 * entry is used once.
 */
export async function autoMatch(tx: Tx, accountId: string) {
  await bankLedger(tx, accountId);
  const [lines, entries] = await Promise.all([
    tx.query<{ id: string; txn_date: string; withdrawal: Decimal; deposit: Decimal; reference: string | null; description: string | null }>(
      `select id, txn_date::text, withdrawal::text, deposit::text, reference, description from bank_statement_line
        where account_id = $1 and status = 'unmatched' order by txn_date`, [accountId]),
    tx.query<{ id: string; entry_date: string; debit: Decimal; credit: Decimal; narration: string | null }>(
      `select e.id, e.entry_date::text, e.debit::text, e.credit::text, coalesce(e.narration, v.narration) as narration
         from ledger_entry e join voucher v on v.id = e.voucher_id
        where e.account_id = $1 and e.bank_cleared_on is null
          and not exists (select 1 from bank_statement_line b where b.matched_entry_id = e.id)`, [accountId]),
  ]);
  const used = new Set<string>();
  const pairs: { line: string; entry: string; date: string }[] = [];
  const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86400000;
  for (const l of lines) {
    const deposit = !isZero(l.deposit);
    const amount = deposit ? l.deposit : l.withdrawal;
    const candidates = entries.filter((e) => !used.has(e.id) && compare(deposit ? e.debit : e.credit, amount) === 0 && days(e.entry_date, l.txn_date) <= 7);
    if (!candidates.length) continue;
    const ref = (l.reference ?? '').toLowerCase();
    candidates.sort((a, b) => {
      const ra = ref && (a.narration ?? '').toLowerCase().includes(ref) ? 0 : 1;
      const rb = ref && (b.narration ?? '').toLowerCase().includes(ref) ? 0 : 1;
      return ra - rb || days(a.entry_date, l.txn_date) - days(b.entry_date, l.txn_date);
    });
    used.add(candidates[0]!.id);
    pairs.push({ line: l.id, entry: candidates[0]!.id, date: l.txn_date });
  }
  if (pairs.length) {
    await tx.query(
      `update bank_statement_line b set status = 'matched', matched_entry_id = x.entry, matched_by = $2, matched_at = now(), updated_at = now()
         from jsonb_to_recordset($1::jsonb) as x(line uuid, entry uuid, date date) where b.id = x.line`, [JSON.stringify(pairs), tx.context.userId]);
    await tx.query(
      `update ledger_entry e set bank_cleared_on = x.date from jsonb_to_recordset($1::jsonb) as x(line uuid, entry uuid, date date) where e.id = x.entry`,
      [JSON.stringify(pairs)]);
  }
  return { matched: pairs.length };
}

export async function matchLine(tx: Tx, lineId: string, entryId: string) {
  const line = await tx.maybeOne<{ id: string; account_id: string; status: string; txn_date: string; withdrawal: Decimal; deposit: Decimal }>(
    `select id, account_id, status, txn_date::text, withdrawal::text, deposit::text from bank_statement_line where id = $1 for update`, [lineId]);
  if (!line) throw new NotFoundError('That statement line does not exist.');
  if (line.status === 'matched') throw new BusinessRuleError('That line is already matched.', 'already_matched');
  const entry = await tx.maybeOne<{ id: string; account_id: string; debit: Decimal; credit: Decimal; bank_cleared_on: string | null }>(
    `select id, account_id, debit::text, credit::text, bank_cleared_on::text from ledger_entry where id = $1`, [entryId]);
  if (!entry || entry.account_id !== line.account_id) throw new BusinessRuleError('That entry is not in this bank ledger.', 'entry_mismatch');
  const taken = await tx.maybeOne(`select 1 from bank_statement_line where matched_entry_id = $1`, [entryId]);
  if (taken) throw new BusinessRuleError('That entry is already matched to another line.', 'already_matched');
  const deposit = !isZero(line.deposit);
  if ((deposit && isZero(entry.debit)) || (!deposit && isZero(entry.credit))) {
    throw new BusinessRuleError(deposit ? 'A deposit matches money into the bank, not out.' : 'A withdrawal matches money out of the bank, not in.', 'direction_mismatch');
  }
  await tx.query(`update bank_statement_line set status = 'matched', matched_entry_id = $2, matched_by = $3, matched_at = now(), updated_at = now() where id = $1`,
    [lineId, entryId, tx.context.userId]);
  await tx.query(`update ledger_entry set bank_cleared_on = $2 where id = $1`, [entryId, line.txn_date]);
  return { matched: true, amountsDiffer: compare(deposit ? entry.debit : entry.credit, deposit ? line.deposit : line.withdrawal) !== 0 };
}

export async function unmatchLine(tx: Tx, lineId: string) {
  const line = await tx.maybeOne<{ matched_entry_id: string | null }>(`select matched_entry_id from bank_statement_line where id = $1 for update`, [lineId]);
  if (!line) throw new NotFoundError('That statement line does not exist.');
  if (line.matched_entry_id) await tx.query(`update ledger_entry set bank_cleared_on = null where id = $1`, [line.matched_entry_id]);
  await tx.query(`update bank_statement_line set status = 'unmatched', matched_entry_id = null, matched_by = null, matched_at = null, note = null, updated_at = now() where id = $1`, [lineId]);
  return { unmatched: true };
}

export async function ignoreLine(tx: Tx, lineId: string, note: string) {
  const r = await tx.maybeOne(`update bank_statement_line set status = 'ignored', note = $2, matched_by = $3, matched_at = now(), updated_at = now()
                                where id = $1 and status = 'unmatched' returning id`, [lineId, note, tx.context.userId]);
  if (!r) throw new BusinessRuleError('Only an unmatched line can be set aside.', 'not_unmatched');
  return { ignored: true };
}

/** Ticks a book entry as cleared without a statement line (or unticks it). */
export async function clearEntry(tx: Tx, entryId: string, clearedOn: string | null) {
  const e = await tx.maybeOne<{ account_id: string }>(`select account_id from ledger_entry where id = $1`, [entryId]);
  if (!e) throw new NotFoundError('That entry does not exist.');
  await bankLedger(tx, e.account_id);
  await tx.query(`update ledger_entry set bank_cleared_on = $2 where id = $1`, [entryId, clearedOn]);
  return { cleared: clearedOn };
}

/** Where the bank and the books stand, and every line that explains the gap. */
export async function reconciliation(tx: Tx, q: { accountId: string; from?: string; to?: string }) {
  const bank = await bankLedger(tx, q.accountId);
  const to = q.to ?? (await businessDate(tx));
  const from = q.from ?? addDays(to, -30);
  const [book, lines, entries, uncleared] = await Promise.all([
    tx.one<{ v: Decimal }>(`select coalesce(sum(debit - credit), 0)::text as v from ledger_entry where account_id = $1 and entry_date <= $2`, [bank.id, to]),
    tx.query<{ id: string; txn_date: string; description: string | null; reference: string | null; withdrawal: Decimal; deposit: Decimal;
      balance: Decimal | null; status: string; note: string | null; matched_entry_id: string | null; voucher_number: string | null }>(
      `select b.id, b.txn_date::text, b.description, b.reference, b.withdrawal::text, b.deposit::text, b.balance::text, b.status, b.note,
              b.matched_entry_id, v.voucher_number
         from bank_statement_line b left join ledger_entry e on e.id = b.matched_entry_id left join voucher v on v.id = e.voucher_id
        where b.account_id = $1 and b.txn_date between $2 and $3 order by b.txn_date, b.created_at`, [bank.id, from, to]),
    tx.query<{ id: string; entry_date: string; debit: Decimal; credit: Decimal; narration: string | null; voucher_number: string;
      voucher_type: string; bank_cleared_on: string | null; matched: boolean }>(
      `select e.id, e.entry_date::text, e.debit::text, e.credit::text, coalesce(e.narration, v.narration) as narration, v.voucher_number,
              v.voucher_type, e.bank_cleared_on::text,
              exists (select 1 from bank_statement_line b where b.matched_entry_id = e.id) as matched
         from ledger_entry e join voucher v on v.id = e.voucher_id
        where e.account_id = $1 and e.entry_date between $2 and $3 order by e.entry_date, v.created_at`, [bank.id, from, to]),
    tx.one<{ deposits: Decimal; payments: Decimal }>(
      `select coalesce(sum(debit) filter (where bank_cleared_on is null or bank_cleared_on > $2), 0)::text as deposits,
              coalesce(sum(credit) filter (where bank_cleared_on is null or bank_cleared_on > $2), 0)::text as payments
         from ledger_entry where account_id = $1 and entry_date <= $2`, [bank.id, to]),
  ]);
  const lastBalance = [...lines].reverse().find((l) => l.balance !== null)?.balance ?? null;
  // What the bank should show: the books, less money entered but not yet through the bank.
  const expectedBank = sub(sub(book.v, uncleared.deposits), sub('0', uncleared.payments));
  return {
    account: bank, from, to,
    bookBalance: book.v, statementBalance: lastBalance, expectedBankBalance: expectedBank,
    unclearedDeposits: uncleared.deposits, unclearedPayments: uncleared.payments,
    difference: lastBalance !== null ? sub(lastBalance, expectedBank) : null,
    lines, entries,
    counts: { unmatched: lines.filter((l) => l.status === 'unmatched').length, matched: lines.filter((l) => l.status === 'matched').length,
      ignored: lines.filter((l) => l.status === 'ignored').length, entriesUncleared: entries.filter((e) => !e.bank_cleared_on).length },
  };
}

/* ------------------------------------------------------------------ Tally */

/** Our groups that have no exact twin in Tally, and the Tally group they belong in. */
const TALLY_GROUP: Record<string, string> = { 'G-CADV': 'Current Liabilities', 'G-TAXA': 'Duties & Taxes' };
const TALLY_PRIMARY = new Set([
  'Capital Account', 'Reserves & Surplus', 'Loans (Liability)', 'Current Liabilities', 'Duties & Taxes', 'Sundry Creditors', 'Provisions',
  'Fixed Assets', 'Current Assets', 'Cash-in-Hand', 'Bank Accounts', 'Sundry Debtors', 'Stock-in-Hand', 'Loans & Advances (Asset)',
  'Suspense A/c', 'Sales Accounts', 'Direct Incomes', 'Indirect Incomes', 'Purchase Accounts', 'Direct Expenses', 'Indirect Expenses',
]);
const VCH_TYPE: Record<string, string> = {
  sale: 'Sales', sales_return: 'Credit Note', purchase: 'Purchase', purchase_return: 'Debit Note', receipt: 'Receipt',
  payment: 'Payment', expense: 'Payment', contra: 'Contra',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tallyDate = (iso: string) => iso.replace(/-/g, '');

/**
 * Tally XML: the ledgers (customers and suppliers as their own ledgers under
 * Sundry Debtors / Creditors, as Tally keeps them) and the vouchers. With
 * `onlyNew`, only what has not gone before, and those are marked as sent.
 */
export async function tallyExport(tx: Tx, q: { from?: string; to?: string; onlyNew?: boolean; markExported?: boolean }) {
  const s = await accountsSettings(tx);
  if (!s.tallyEnabled) throw new BusinessRuleError('The Tally export is switched off. Turn it on in Accounts → Settings.', 'tally_disabled');
  const to = q.to ?? (await businessDate(tx));
  const from = q.from ?? addDays(to, -30);
  const company = s.tallyCompany || (await tx.one<{ name: string }>(`select coalesce(display_name, legal_name) as name from tenant where id = $1`, [tx.context.tenantId])).name;
  const chart = await loadChart(tx);
  const byId = new Map(chart.map((a) => [a.id, a]));
  const tallyName = (a: ChartAccount) => a.tally_name || a.name;
  const parentName = (a: ChartAccount): string => {
    const p = a.parent_id ? byId.get(a.parent_id) : undefined;
    if (!p) return a.account_type === 'asset' ? 'Current Assets' : a.account_type === 'liability' ? 'Current Liabilities'
      : a.account_type === 'equity' ? 'Capital Account' : a.account_type === 'income' ? 'Indirect Incomes' : 'Indirect Expenses';
    return TALLY_GROUP[p.code] ?? tallyName(p);
  };
  const vouchers = await tx.query<{ id: string; voucher_number: string; voucher_type: string; voucher_date: string; narration: string | null }>(
    `select id, voucher_number, voucher_type, voucher_date::text, narration from voucher
      where voucher_date between $1 and $2 and voucher_type not in ('year_close') ${q.onlyNew ? 'and exported_at is null' : ''}
      order by voucher_date, created_at`, [from, to]);
  const ids = vouchers.map((v) => v.id);
  const entries = ids.length ? await tx.query<{ voucher_id: string; account_id: string; party_name: string | null; debit: Decimal; credit: Decimal }>(
    `select e.voucher_id, e.account_id, p.name as party_name, e.debit::text, e.credit::text
       from ledger_entry e left join party p on p.id = e.party_id where e.voucher_id = any($1::uuid[])`, [ids]) : [];
  const ledgerOf = (e: { account_id: string; party_name: string | null }) => {
    const a = byId.get(e.account_id)!;
    return a.is_control && e.party_name ? e.party_name : tallyName(a);
  };

  const groups = chart.filter((a) => a.is_group && !TALLY_PRIMARY.has(tallyName(a)) && !TALLY_GROUP[a.code]);
  const usedLedgers = new Set(entries.map((e) => e.account_id));
  const ledgers = chart.filter((a) => !a.is_group && (usedLedgers.has(a.id) || a.ledger_kind !== 'general') && !(a.is_control));
  const parties = new Map<string, string>();
  for (const e of entries) {
    const a = byId.get(e.account_id)!;
    if (a.is_control && e.party_name) parties.set(e.party_name, a.control_for === 'supplier' ? 'Sundry Creditors' : 'Sundry Debtors');
  }

  const masters = [
    ...groups.map((g) => `<TALLYMESSAGE><GROUP NAME="${esc(tallyName(g))}" ACTION="Create"><NAME>${esc(tallyName(g))}</NAME><PARENT>${esc(parentName(g))}</PARENT></GROUP></TALLYMESSAGE>`),
    ...ledgers.map((l) => `<TALLYMESSAGE><LEDGER NAME="${esc(tallyName(l))}" ACTION="Create"><NAME>${esc(tallyName(l))}</NAME><PARENT>${esc(parentName(l))}</PARENT></LEDGER></TALLYMESSAGE>`),
    ...[...parties].map(([name, parent]) => `<TALLYMESSAGE><LEDGER NAME="${esc(name)}" ACTION="Create"><NAME>${esc(name)}</NAME><PARENT>${parent}</PARENT></LEDGER></TALLYMESSAGE>`),
  ];
  const vchXml = vouchers.map((v) => {
    const lines = entries.filter((e) => e.voucher_id === v.id);
    const type = VCH_TYPE[v.voucher_type] ?? 'Journal';
    const body = lines.map((e) => {
      const debit = !isZero(e.debit);
      // Tally writes debits as negative amounts.
      const amount = debit ? `-${e.debit}` : e.credit;
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${esc(ledgerOf(e))}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${amount}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    }).join('');
    return `<TALLYMESSAGE><VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${tallyDate(v.voucher_date)}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>`
      + `<VOUCHERNUMBER>${esc(v.voucher_number)}</VOUCHERNUMBER><NARRATION>${esc(v.narration ?? '')}</NARRATION>${body}</VOUCHER></TALLYMESSAGE>`;
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA>`
    + `<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`
    + `<REQUESTDATA>${masters.join('')}</REQUESTDATA></IMPORTDATA><IMPORTDATA>`
    + `<REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`
    + `<REQUESTDATA>${vchXml.join('')}</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  if (q.markExported && ids.length) await tx.query(`update voucher set exported_at = now() where id = any($1::uuid[])`, [ids]);
  return {
    company, from, to, vouchers: vouchers.length, ledgers: ledgers.length + parties.size + groups.length,
    total: sum(entries.map((e) => e.debit)), fileName: `tally-${from}-to-${to}.xml`, xml,
  };
}

export const tallyPending = async (tx: Tx) =>
  (await tx.one<{ n: number }>(`select count(*)::int as n from voucher where exported_at is null and voucher_type <> 'year_close'`)).n;


