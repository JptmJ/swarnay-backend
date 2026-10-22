/**
 * Vouchers typed in Accounts — the money that moves without a bill: rent, the
 * electrician, salary, cash taken to the bank, a correction an accountant
 * asks for, and the opening balances the books start from.
 *
 * Each is a numbered document with its own lines, posted the moment it is
 * saved (or once approved, where the shop asks for approval). Like every other
 * document in Swarnay it is never edited: a mistake is cancelled, which writes
 * the mirror entry, and entered again.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { hasPermission } from '../identity/permissions.js';
import { paymentAccount } from '../purchase/purchase.service.js';
import { assertPeriodOpen, ensureChart, postVoucher, reverseVoucher, type MetalEntry, type MoneyEntry } from './ledger.service.js';
import { accountsSettings } from './chart.service.js';
import type { JournalType, VoucherType } from './accounts.schema.js';

const rs = (v: Decimal) => round(v, 2);
const inr = (v: Decimal | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

interface Ledger {
  id: string; code: string; name: string; account_type: string; is_group: boolean; is_active: boolean;
  is_control: boolean; control_for: string | null; ledger_kind: string; tracks_metal: boolean;
}

async function ledger(tx: Tx, id: string, what = 'That ledger'): Promise<Ledger> {
  const a = await tx.maybeOne<Ledger>(
    `select id, code, name, account_type, is_group, is_active, is_control, control_for, ledger_kind, tracks_metal
       from account where id = $1 and deleted_at is null`, [id]);
  if (!a) throw new NotFoundError(`${what} does not exist.`);
  if (a.is_group) throw new BusinessRuleError(`${a.name} is a group. Choose a ledger under it.`, 'account_is_group');
  if (!a.is_active) throw new BusinessRuleError(`${a.name} is switched off.`, 'account_inactive');
  return a;
}

/** A party on a control account must be the right kind: a customer on Debtors, a supplier on Creditors. */
async function partyFor(tx: Tx, a: Ledger, partyId: string | null | undefined) {
  if (!a.is_control) return partyId ?? null;
  if (!partyId) throw new BusinessRuleError(`${a.name} is kept party by party. Choose whose balance this is.`, 'party_required');
  const p = await tx.maybeOne<{ id: string; name: string; is_customer: boolean; is_supplier: boolean }>(
    `select id, name, is_customer, is_supplier from party where id = $1 and deleted_at is null`, [partyId]);
  if (!p) throw new NotFoundError('That customer or supplier does not exist.');
  if (a.control_for === 'customer' && !p.is_customer) throw new BusinessRuleError(`${p.name} is not a customer.`, 'party_mismatch');
  if (a.control_for === 'supplier' && !p.is_supplier) throw new BusinessRuleError(`${p.name} is not a supplier.`, 'party_mismatch');
  return p.id;
}

/** Bills, receipts and supplier payments keep their own balances; those ledgers are changed from their own screens. */
function noControl(a: Ledger) {
  if (a.is_control) {
    const where = a.control_for === 'supplier' ? 'Purchase → Pay supplier' : a.code === '1400' ? 'Girvi' : 'Billing → Receive payment';
    throw new BusinessRuleError(`${a.name} is kept bill by bill. Use ${where}, or a journal if your accountant asks for an adjustment.`, 'account_is_control');
  }
}

export interface JournalLineInput {
  accountId: string; partyId?: string | null; debit?: Decimal; credit?: Decimal; narration?: string;
  metalId?: string | null; purityId?: string | null; weightIn?: Decimal; weightOut?: Decimal;
}

interface Common { docDate?: string; narration?: string; reference?: string; attachmentKey?: string }
export type JournalInput =
  | (Common & { docType: 'expense'; accountId: string; amount: Decimal; gstAmount?: Decimal; gstRate?: Decimal; interState?: boolean;
      paymentMethodId?: string; payableTo?: 'expenses_payable' | 'supplier'; partyId?: string; payee?: string;
      tdsPercent?: Decimal; billNumber?: string; billDate?: string })
  | (Common & { docType: 'payment' | 'receipt'; accountId: string; amount: Decimal; paymentMethodId: string;
      partyId?: string; payee?: string; tdsPercent?: Decimal })
  | (Common & { docType: 'contra'; fromAccountId: string; toAccountId: string; amount: Decimal })
  | (Common & { docType: 'journal'; lines: JournalLineInput[] });

interface BuiltLine {
  accountId: string; partyId: string | null; debit: Decimal; credit: Decimal; narration: string | null;
  metalId: string | null; purityId: string | null; weightIn: Decimal; weightOut: Decimal;
}
const L = (accountId: string, side: 'debit' | 'credit', amount: Decimal, narration: string | null, partyId: string | null = null): BuiltLine => ({
  accountId, partyId, debit: side === 'debit' ? amount : '0', credit: side === 'credit' ? amount : '0', narration,
  metalId: null, purityId: null, weightIn: '0', weightOut: '0',
});

async function codeId(tx: Tx, code: string): Promise<string> {
  await ensureChart(tx);
  return (await tx.one<{ id: string }>(`select id from account where code = $1 and deleted_at is null`, [code])).id;
}

/** The ledger a payment mode posts to. */
async function modeLedger(tx: Tx, methodId: string, branchId: string, purpose: string) {
  const m = await paymentAccount(tx, methodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(m.kind)) {
    throw new BusinessRuleError(`${m.name} cannot ${purpose}. Choose cash, card, UPI or bank.`, 'payment_method_invalid');
  }
  const id = 'accountId' in m.account && m.account.accountId ? m.account.accountId : await codeId(tx, m.account.accountCode!);
  return { method: m, accountId: id };
}

/** Turns what was typed into balanced lines. All the accounting rules live here. */
async function build(tx: Tx, input: JournalInput, branchId: string) {
  const s = await accountsSettings(tx);
  const lines: BuiltLine[] = [];
  let partyId: string | null = null;
  let payee: string | null = null;
  let methodName: string | null = null;
  const tdsOf = (base: Decimal, pct: Decimal | undefined) => {
    if (!pct || isZero(pct)) return '0';
    if (!s.tdsEnabled) throw new BusinessRuleError('TDS is switched off. Turn it on in Accounts → Settings to hold back TDS.', 'tds_disabled');
    return rs(div(mul(base, pct), '100'));
  };

  switch (input.docType) {
    case 'expense': {
      const exp = await ledger(tx, input.accountId, 'That expense head');
      if (!['expense', 'asset'].includes(exp.account_type) || exp.ledger_kind !== 'general' || exp.is_control) {
        throw new BusinessRuleError(`${exp.name} is not an expense head. Choose an expense (or an asset you bought, like a safe).`, 'account_not_expense');
      }
      const amount = rs(input.amount);
      if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount before GST.');
      const gst = rs(input.gstAmount ?? (input.gstRate ? div(mul(amount, input.gstRate), '100') : '0'));
      if (compare(gst, '0') < 0) throw new ValidationError('GST cannot be negative.');
      const composition = s.registration === 'composition';
      // Under composition GST paid is not claimed back: it is part of what the expense cost.
      lines.push(L(exp.id, 'debit', composition ? add(amount, gst) : amount, input.narration ?? exp.name));
      if (!composition && compare(gst, '0') > 0) {
        if (input.interState) lines.push(L(await codeId(tx, '1303'), 'debit', gst, 'IGST input'));
        else {
          const half = rs(div(gst, '2'));
          lines.push(L(await codeId(tx, '1301'), 'debit', half, 'CGST input'), L(await codeId(tx, '1302'), 'debit', sub(gst, half), 'SGST input'));
        }
      }
      const total = add(amount, gst);
      const tds = tdsOf(amount, input.tdsPercent);
      const net = sub(total, tds);
      if (input.paymentMethodId) {
        const m = await modeLedger(tx, input.paymentMethodId, branchId, 'pay an expense');
        methodName = m.method.name;
        lines.push(L(m.accountId, 'credit', net, `Paid by ${m.method.name}${input.reference ? ` ${input.reference}` : ''}`));
      } else if (input.payableTo === 'supplier') {
        const creditors = await ledger(tx, await codeId(tx, '2000'));
        partyId = await partyFor(tx, creditors, input.partyId);
        lines.push(L(creditors.id, 'credit', net, `Bill ${input.billNumber ?? ''}`.trim(), partyId));
      } else {
        lines.push(L(await codeId(tx, '2040'), 'credit', net, 'Owed, to be paid later'));
      }
      if (compare(tds, '0') > 0) lines.push(L(await codeId(tx, '2250'), 'credit', tds, `TDS ${input.tdsPercent}%`));
      payee = input.payee?.trim() || null;
      if (input.partyId && !partyId) partyId = input.partyId;
      break;
    }
    case 'payment':
    case 'receipt': {
      const acc = await ledger(tx, input.accountId);
      noControl(acc);
      if (acc.ledger_kind !== 'general') throw new BusinessRuleError(`Money between ${acc.name} and another cash or bank ledger is a contra entry.`, 'use_contra');
      const amount = rs(input.amount);
      if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount.');
      const m = await modeLedger(tx, input.paymentMethodId, branchId, input.docType === 'payment' ? 'pay money out' : 'receive money');
      methodName = m.method.name;
      const ref = input.reference ? ` ${input.reference}` : '';
      if (input.docType === 'payment') {
        const tds = tdsOf(amount, input.tdsPercent);
        lines.push(L(acc.id, 'debit', amount, input.narration ?? acc.name), L(m.accountId, 'credit', sub(amount, tds), `${m.method.name}${ref}`));
        if (compare(tds, '0') > 0) lines.push(L(await codeId(tx, '2250'), 'credit', tds, `TDS ${input.tdsPercent}%`));
      } else {
        if (input.tdsPercent && !isZero(input.tdsPercent)) throw new ValidationError('TDS is held back on payments, not receipts.');
        lines.push(L(m.accountId, 'debit', amount, `${m.method.name}${ref}`), L(acc.id, 'credit', amount, input.narration ?? acc.name));
      }
      partyId = input.partyId ?? null;
      payee = input.payee?.trim() || null;
      break;
    }
    case 'contra': {
      if (input.fromAccountId === input.toAccountId) throw new ValidationError('Money moves between two different ledgers.');
      const [from, to] = await Promise.all([ledger(tx, input.fromAccountId), ledger(tx, input.toAccountId)]);
      for (const a of [from, to]) {
        if (a.ledger_kind === 'general') throw new BusinessRuleError(`${a.name} is not a cash or bank ledger. Use a payment, receipt or journal.`, 'contra_not_money');
      }
      const amount = rs(input.amount);
      if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount.');
      lines.push(L(to.id, 'debit', amount, `From ${from.name}`), L(from.id, 'credit', amount, `To ${to.name}`));
      break;
    }
    case 'journal': {
      if (input.lines.length < 2) throw new ValidationError('A journal needs at least two lines.');
      for (const l of input.lines) {
        const a = await ledger(tx, l.accountId);
        const debit = rs(l.debit ?? '0'); const credit = rs(l.credit ?? '0');
        if (compare(debit, '0') < 0 || compare(credit, '0') < 0) throw new ValidationError('Amounts cannot be negative.');
        if (!isZero(debit) && !isZero(credit)) throw new ValidationError(`${a.name}: a line is either a debit or a credit.`);
        const weighs = !isZero(l.weightIn ?? '0') || !isZero(l.weightOut ?? '0');
        if (weighs && (!a.tracks_metal || !l.metalId)) throw new ValidationError(`${a.name} is not kept in grams, or the metal is missing.`);
        if (isZero(debit) && isZero(credit) && !weighs) throw new ValidationError(`${a.name}: enter an amount.`);
        lines.push({
          accountId: a.id, partyId: await partyFor(tx, a, l.partyId), debit, credit, narration: l.narration ?? null,
          metalId: l.metalId ?? null, purityId: l.purityId ?? null, weightIn: l.weightIn ?? '0', weightOut: l.weightOut ?? '0',
        });
      }
      break;
    }
  }
  const dr = sum(lines.map((l) => l.debit)); const cr = sum(lines.map((l) => l.credit));
  if (compare(dr, cr) !== 0) throw new BusinessRuleError(`Debits ${inr(dr)} and credits ${inr(cr)} must be equal (out by ${inr(sub(dr, cr))}).`, 'unbalanced_voucher');
  return { lines, amount: dr, partyId, payee, methodName, settings: s };
}

const VOUCHER_FOR: Record<JournalType, VoucherType> = {
  payment: 'payment', receipt: 'receipt', contra: 'contra', journal: 'journal', expense: 'expense', opening: 'opening',
  gst_settlement: 'gst_settlement', year_close: 'year_close', cash_difference: 'cash_difference', revaluation: 'revaluation',
};
const SERIES_FOR = (t: JournalType) => (['payment', 'receipt', 'contra', 'journal', 'expense', 'opening'].includes(t) ? `acc_${t}` : 'acc_system');

async function docDateOf(tx: Tx, requested: string | undefined, allowBackdating: boolean, opening = false): Promise<string> {
  const today = await businessDate(tx);
  const date = requested ?? today;
  if (date > today) throw new ValidationError('A voucher cannot be dated in the future.');
  if (date < today && !allowBackdating && !opening) {
    throw new BusinessRuleError('Back-dated entries are switched off. Use today’s date (the bill’s own date goes in Bill date), or turn on back-dating in Settings.', 'backdate_not_allowed');
  }
  return date;
}

/** Writes the document and its lines and, unless it waits for approval, posts it. */
async function save(tx: Tx, doc: {
  docType: JournalType; docDate: string; branchId: string; status: 'posted' | 'pending_approval';
  lines: BuiltLine[]; amount: Decimal; partyId?: string | null; payee?: string | null; narration?: string | null;
  reference?: string | null; billNumber?: string | null; billDate?: string | null; attachmentKey?: string | null;
  sourceType?: string; sourceId?: string; autoReverseOn?: string | null;
}) {
  const today = await businessDate(tx);
  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, SERIES_FOR(doc.docType), 1, { branchId: doc.branchId, date: new Date(today) });
  const entry = await tx.one<{ id: string; doc_number: string }>(
    `insert into journal_entry (id, tenant_id, doc_number, doc_type, doc_date, branch_id, status, party_id, payee, amount, narration,
                                reference, bill_number, bill_date, attachment_key, source_type, source_id, auto_reverse_on, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18)
     returning id, doc_number`,
    [tx.context.tenantId, docNumber, doc.docType, doc.docDate, doc.branchId, doc.status, doc.partyId ?? null, doc.payee ?? null,
     doc.amount, doc.narration ?? null, doc.reference ?? null, doc.billNumber ?? null, doc.billDate ?? null, doc.attachmentKey ?? null,
     doc.sourceType ?? null, doc.sourceId ?? null, doc.autoReverseOn ?? null, tx.context.userId]);
  await tx.query(
    `insert into journal_entry_line (id, tenant_id, journal_entry_id, line_number, account_id, party_id, debit, credit,
                                     metal_id, purity_id, weight_in, weight_out, narration, created_by, updated_by)
     select gen_random_uuid(), $1, $2, x.n, x.account_id, x.party_id, x.debit, x.credit, x.metal_id, x.purity_id,
            x.weight_in, x.weight_out, x.narration, $3, $3
       from jsonb_to_recordset($4::jsonb) as x(n int, account_id uuid, party_id uuid, debit numeric, credit numeric,
                                              metal_id uuid, purity_id uuid, weight_in numeric, weight_out numeric, narration text)`,
    [tx.context.tenantId, entry.id, tx.context.userId, JSON.stringify(doc.lines.map((l, i) => ({
      n: i + 1, account_id: l.accountId, party_id: l.partyId, debit: l.debit, credit: l.credit, metal_id: l.metalId,
      purity_id: l.purityId, weight_in: l.weightIn, weight_out: l.weightOut, narration: l.narration,
    })))]);
  if (doc.status === 'posted') await post(tx, entry.id);
  return entry;
}

/** Posts a saved document to the books. */
async function post(tx: Tx, id: string) {
  const e = await tx.one<{ id: string; doc_number: string; doc_type: JournalType; doc_date: string; branch_id: string; narration: string | null;
    payee: string | null; party_name: string | null }>(
    `select j.id, j.doc_number, j.doc_type, j.doc_date::text, j.branch_id, j.narration, j.payee, p.name as party_name
       from journal_entry j left join party p on p.id = j.party_id where j.id = $1`, [id]);
  const lines = await tx.query<{ account_id: string; party_id: string | null; debit: Decimal; credit: Decimal; narration: string | null;
    metal_id: string | null; purity_id: string | null; weight_in: Decimal; weight_out: Decimal }>(
    `select * from journal_entry_line where journal_entry_id = $1 order by line_number`, [id]);
  const who = e.party_name ?? e.payee;
  const money: MoneyEntry[] = lines.filter((l) => !isZero(l.debit) || !isZero(l.credit)).map((l) => ({
    accountId: l.account_id, partyId: l.party_id, debit: l.debit, credit: l.credit, narration: l.narration ?? e.narration ?? undefined,
    againstType: 'journal_entry', againstId: e.id,
  }));
  const metal: MetalEntry[] = lines.filter((l) => l.metal_id && (!isZero(l.weight_in) || !isZero(l.weight_out))).map((l) => ({
    accountId: l.account_id, partyId: l.party_id, metalId: l.metal_id!, purityId: l.purity_id, weightIn: l.weight_in, weightOut: l.weight_out,
    narration: l.narration ?? undefined,
  }));
  const { voucherId } = await postVoucher(tx, {
    voucherType: VOUCHER_FOR[e.doc_type], voucherDate: e.doc_date, branchId: e.branch_id, sourceType: 'journal_entry', sourceId: e.id,
    narration: [e.doc_number, e.narration, who ? `(${who})` : null].filter(Boolean).join(' '), money, metal,
  });
  await tx.query(`update journal_entry set voucher_id = $2, status = 'posted', updated_at = now() where id = $1`, [id, voucherId]);
  return voucherId;
}

export async function createJournal(tx: Tx, input: JournalInput) {
  const branchId = branchOf(tx);
  const built = await build(tx, input, branchId);
  const docDate = await docDateOf(tx, input.docDate, built.settings.allowBackdating);
  await assertPeriodOpen(tx, branchId, docDate);
  const needsApproval = input.docType === 'expense' && built.settings.expenseApproval
    && (built.settings.expenseLimit === 0 || compare(built.amount, String(built.settings.expenseLimit)) > 0)
    && !hasPermission(tx.context.permissions, 'accounts.journal.approve');
  const entry = await save(tx, {
    docType: input.docType, docDate, branchId, status: needsApproval ? 'pending_approval' : 'posted',
    lines: built.lines, amount: built.amount, partyId: built.partyId, payee: built.payee, narration: input.narration ?? null,
    reference: input.reference ?? null, attachmentKey: input.attachmentKey ?? null,
    billNumber: input.docType === 'expense' ? input.billNumber ?? null : null,
    billDate: input.docType === 'expense' ? input.billDate ?? null : null,
  });
  return { ...(await journalDetail(tx, entry.id)), needsApproval };
}

/** Used by the day, month and year close, which write their own entries. */
export async function postSystemJournal(tx: Tx, doc: {
  docType: Extract<JournalType, 'gst_settlement' | 'year_close' | 'cash_difference' | 'revaluation' | 'opening'>;
  docDate: string; branchId: string; narration: string; sourceType: string; sourceId: string;
  lines: { accountId?: string; accountCode?: string; partyId?: string | null; debit?: Decimal; credit?: Decimal; narration?: string }[];
  autoReverseOn?: string | null;
}) {
  const lines: BuiltLine[] = [];
  for (const l of doc.lines) {
    const debit = rs(l.debit ?? '0'); const credit = rs(l.credit ?? '0');
    if (isZero(debit) && isZero(credit)) continue;
    lines.push({ ...L(l.accountId ?? (await codeId(tx, l.accountCode!)), isZero(debit) ? 'credit' : 'debit', isZero(debit) ? credit : debit, l.narration ?? null, l.partyId ?? null) });
  }
  if (!lines.length) return null;
  const amount = sum(lines.map((l) => l.debit));
  const entry = await save(tx, { ...doc, status: 'posted', lines, amount });
  return tx.one<{ id: string; doc_number: string; voucher_id: string }>(`select id, doc_number, voucher_id from journal_entry where id = $1`, [entry.id]);
}

export async function approveJournal(tx: Tx, id: string) {
  const e = await tx.maybeOne<{ status: string; doc_number: string; branch_id: string; doc_date: string; created_by: string | null }>(
    `select status, doc_number, branch_id, doc_date::text, created_by from journal_entry where id = $1 for update`, [id]);
  if (!e) throw new NotFoundError('That voucher does not exist.');
  if (e.status !== 'pending_approval') throw new BusinessRuleError(`${e.doc_number} is ${e.status.replace('_', ' ')}, not waiting for approval.`, 'not_pending');
  await assertPeriodOpen(tx, e.branch_id, e.doc_date);
  await tx.query(`update journal_entry set approved_by = $2, approved_at = now() where id = $1`, [id, tx.context.userId]);
  await post(tx, id);
  return journalDetail(tx, id);
}

export async function rejectJournal(tx: Tx, id: string, reason: string) {
  const e = await tx.maybeOne<{ status: string; doc_number: string }>(`select status, doc_number from journal_entry where id = $1 for update`, [id]);
  if (!e) throw new NotFoundError('That voucher does not exist.');
  if (e.status !== 'pending_approval') throw new BusinessRuleError(`${e.doc_number} is not waiting for approval.`, 'not_pending');
  await tx.query(`update journal_entry set status = 'rejected', reject_reason = $2, approved_by = $3, approved_at = now(), updated_at = now() where id = $1`,
    [id, reason, tx.context.userId]);
  return journalDetail(tx, id);
}

export async function cancelJournal(tx: Tx, id: string, reason: string) {
  const e = await tx.maybeOne<{ status: string; doc_number: string; voucher_id: string | null; source_type: string | null; doc_type: JournalType }>(
    `select status, doc_number, voucher_id, source_type, doc_type from journal_entry where id = $1 for update`, [id]);
  if (!e) throw new NotFoundError('That voucher does not exist.');
  if (e.status === 'cancelled' || e.status === 'rejected') throw new BusinessRuleError(`${e.doc_number} is already ${e.status}.`, 'already_cancelled');
  if (e.source_type) {
    const how = e.source_type === 'cash_day' ? 'Reopen the day' : 'Reopen the period';
    throw new BusinessRuleError(`${e.doc_number} was written by a close. ${how} instead.`, 'system_voucher');
  }
  if (e.status === 'posted' && e.voucher_id) await reverseVoucher(tx, e.voucher_id, `${e.doc_number} cancelled: ${reason}`);
  await tx.query(`update journal_entry set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, updated_at = now() where id = $1`,
    [id, tx.context.userId, reason]);
  return journalDetail(tx, id);
}

export async function journalDetail(tx: Tx, id: string) {
  const e = await tx.maybeOne<Record<string, unknown>>(
    `select j.*, j.doc_date::text as doc_date, b.name as branch_name, p.name as party_name, v.voucher_number,
            cu.full_name as created_by_name, au.full_name as approved_by_name, xu.full_name as cancelled_by_name
       from journal_entry j join branch b on b.id = j.branch_id
       left join party p on p.id = j.party_id left join voucher v on v.id = j.voucher_id
       left join app_user cu on cu.id = j.created_by left join app_user au on au.id = j.approved_by
       left join app_user xu on xu.id = j.cancelled_by
      where j.id = $1`, [id]);
  if (!e) throw new NotFoundError('That voucher does not exist.');
  const lines = await tx.query(
    `select l.*, a.code as account_code, a.name as account_name, p.name as party_name, m.name as metal_name, pu.code as purity_code
       from journal_entry_line l join account a on a.id = l.account_id
       left join party p on p.id = l.party_id left join metal m on m.id = l.metal_id left join purity pu on pu.id = l.purity_id
      where l.journal_entry_id = $1 order by l.line_number`, [id]);
  return { ...e, lines };
}

export async function journalList(tx: Tx, q: { docType?: JournalType; status?: string; from?: string; to?: string; search?: string;
  accountId?: string; branchId?: string; limit?: number; offset?: number }) {
  const where: string[] = []; const params: unknown[] = [];
  const add_ = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  if (q.docType) add_('j.doc_type = ?', q.docType);
  if (q.status) add_('j.status = ?', q.status);
  if (q.from) add_('j.doc_date >= ?', q.from);
  if (q.to) add_('j.doc_date <= ?', q.to);
  if (q.branchId) add_('j.branch_id = ?', q.branchId);
  if (q.accountId) add_('exists (select 1 from journal_entry_line l where l.journal_entry_id = j.id and l.account_id = ?)', q.accountId);
  if (q.search) add_(`(j.doc_number ilike ? or j.narration ilike $${params.length + 1} or j.payee ilike $${params.length + 1}
                       or j.reference ilike $${params.length + 1} or j.bill_number ilike $${params.length + 1} or p.name ilike $${params.length + 1})`, `%${q.search}%`);
  const sql = where.length ? `where ${where.join(' and ')}` : '';
  const [rows, total] = await Promise.all([
    tx.query(
      `select j.id, j.doc_number, j.doc_type, j.doc_date::text, j.status, j.amount, j.narration, j.payee, j.reference, j.bill_number,
              j.source_type, j.party_id, p.name as party_name, b.name as branch_name, v.voucher_number, cu.full_name as created_by_name,
              (select string_agg(a.name, ', ' order by l.line_number) from journal_entry_line l join account a on a.id = l.account_id
                where l.journal_entry_id = j.id and l.debit > 0) as debit_accounts,
              (select string_agg(a.name, ', ' order by l.line_number) from journal_entry_line l join account a on a.id = l.account_id
                where l.journal_entry_id = j.id and l.credit > 0) as credit_accounts
         from journal_entry j join branch b on b.id = j.branch_id left join party p on p.id = j.party_id
         left join voucher v on v.id = j.voucher_id left join app_user cu on cu.id = j.created_by
        ${sql} order by j.doc_date desc, j.created_at desc limit ${Number(q.limit ?? 50)} offset ${Number(q.offset ?? 0)}`, params),
    tx.one<{ n: number; amount: Decimal }>(
      `select count(*)::int as n, coalesce(sum(j.amount) filter (where j.status = 'posted'), 0)::text as amount
         from journal_entry j left join party p on p.id = j.party_id ${sql}`, params),
  ]);
  return { rows, total: total.n, postedAmount: total.amount };
}

/* ------------------------------------------------------- opening balances */

export interface OpeningInput {
  date?: string;
  ledgers?: { accountId: string; debit?: Decimal; credit?: Decimal }[];
  parties?: { partyId: string; accountCode: '1100' | '2400' | '2000'; debit?: Decimal; credit?: Decimal }[];
  metals?: { accountCode: '2010' | '2100' | '1220'; partyId?: string | null; metalId: string; purityId?: string | null; weightIn?: Decimal; weightOut?: Decimal }[];
}

/** The date opening balances are written on: the day the books begin, or today when no start is set. */
async function openingDate(tx: Tx, requested?: string) {
  const s = await accountsSettings(tx);
  const today = await businessDate(tx);
  const date = requested ?? (s.booksStart || today);
  if (date > today) throw new ValidationError('Opening balances cannot be dated in the future.');
  return date;
}

/**
 * What the books started with: every ledger's opening, each customer's and
 * supplier's, and the grams owed either way. Opening stock entered through
 * Stock shows here too. Whatever does not add up waits in Opening Balance
 * Difference until it is sorted out.
 */
export async function openingState(tx: Tx) {
  await ensureChart(tx);
  const s = await accountsSettings(tx);
  const [ledgers, parties, metals] = await Promise.all([
    tx.query<{ id: string; code: string; name: string; account_type: string; ledger_kind: string; group_name: string | null;
      debit: Decimal; credit: Decimal }>(
      `select a.id, a.code, a.name, a.account_type, a.ledger_kind, g.name as group_name,
              coalesce(sum(e.debit), 0)::text as debit, coalesce(sum(e.credit), 0)::text as credit
         from account a left join account g on g.id = a.parent_id
         left join ledger_entry e on e.account_id = a.id and e.voucher_id in (select id from voucher where voucher_type = 'opening')
        where a.deleted_at is null and not a.is_group and not a.is_control and a.is_active and a.code not in ('3100')
        group by a.id, g.name order by a.code`),
    tx.query<{ party_id: string; party_name: string; party_code: string; account_code: string; debit: Decimal; credit: Decimal }>(
      `select e.party_id, p.name as party_name, p.code as party_code, a.code as account_code,
              sum(e.debit)::text as debit, sum(e.credit)::text as credit
         from ledger_entry e join account a on a.id = e.account_id join party p on p.id = e.party_id
         join voucher v on v.id = e.voucher_id and v.voucher_type = 'opening'
        where a.code in ('1100', '2400', '2000')
        group by e.party_id, p.name, p.code, a.code order by p.name`),
    tx.query<{ account_code: string; party_id: string | null; party_name: string | null; metal_id: string; metal_name: string;
      purity_id: string | null; purity_code: string | null; weight_in: Decimal; weight_out: Decimal }>(
      `select a.code as account_code, e.party_id, p.name as party_name, e.metal_id, m.name as metal_name, e.purity_id, pu.code as purity_code,
              sum(e.weight_in)::text as weight_in, sum(e.weight_out)::text as weight_out
         from metal_ledger_entry e join account a on a.id = e.account_id join metal m on m.id = e.metal_id
         join voucher v on v.id = e.voucher_id and v.voucher_type = 'opening'
         left join party p on p.id = e.party_id left join purity pu on pu.id = e.purity_id
        group by a.code, e.party_id, p.name, e.metal_id, m.name, e.purity_id, pu.code order by a.code, p.name`),
  ]);
  const diff = ledgers.find((l) => l.code === '3900');
  const totalDr = sum([...ledgers.map((l) => l.debit), ...parties.map((p) => p.debit)]);
  const totalCr = sum([...ledgers.map((l) => l.credit), ...parties.map((p) => p.credit)]);
  return {
    date: s.booksStart || null,
    ledgers, parties, metals,
    /** Debit-positive: what Opening Balance Difference holds until the openings add up. */
    difference: diff ? sub(diff.debit, diff.credit) : '0',
    totalDebit: totalDr, totalCredit: totalCr,
  };
}

/**
 * Sets opening balances. Only the change from what is already there is
 * posted, as one opening voucher, so the screen behaves like a form while the
 * books keep every step. Anything that does not balance goes to Opening
 * Balance Difference.
 */
export async function saveOpening(tx: Tx, input: OpeningInput) {
  const branchId = branchOf(tx);
  const date = await openingDate(tx, input.date);
  const current = await openingState(tx);
  const lines: BuiltLine[] = [];
  const diffId = await codeId(tx, '3900');

  for (const row of input.ledgers ?? []) {
    const a = await ledger(tx, row.accountId);
    if (a.is_control) throw new BusinessRuleError(`${a.name} is opened party by party.`, 'account_is_control');
    if (a.id === diffId) throw new BusinessRuleError('Opening Balance Difference fills itself; it is not typed.', 'account_system');
    const want = sub(rs(row.debit ?? '0'), rs(row.credit ?? '0'));
    const have = current.ledgers.find((l) => l.id === a.id);
    const delta = sub(want, have ? sub(have.debit, have.credit) : '0');
    if (!isZero(delta)) lines.push(L(a.id, compare(delta, '0') > 0 ? 'debit' : 'credit', compare(delta, '0') > 0 ? delta : sub('0', delta), 'Opening balance'));
  }
  for (const row of input.parties ?? []) {
    const acc = await ledger(tx, await codeId(tx, row.accountCode));
    const partyId = await partyFor(tx, { ...acc, is_control: true, control_for: row.accountCode === '2000' ? 'supplier' : 'customer' }, row.partyId);
    const want = sub(rs(row.debit ?? '0'), rs(row.credit ?? '0'));
    const have = current.parties.find((p) => p.party_id === partyId && p.account_code === row.accountCode);
    const delta = sub(want, have ? sub(have.debit, have.credit) : '0');
    if (!isZero(delta)) lines.push(L(acc.id, compare(delta, '0') > 0 ? 'debit' : 'credit', compare(delta, '0') > 0 ? delta : sub('0', delta), 'Opening balance', partyId));
  }
  for (const row of input.metals ?? []) {
    const acc = await ledger(tx, await codeId(tx, row.accountCode));
    const partyId = row.accountCode === '1220' ? null
      : await partyFor(tx, { ...acc, is_control: true, control_for: row.accountCode === '2010' ? 'supplier' : 'customer' }, row.partyId);
    const want = sub(row.weightIn ?? '0', row.weightOut ?? '0');
    const have = current.metals.find((m) => m.account_code === row.accountCode && (m.party_id ?? null) === partyId
      && m.metal_id === row.metalId && (m.purity_id ?? null) === (row.purityId ?? null));
    const delta = sub(want, have ? sub(have.weight_in, have.weight_out) : '0');
    if (isZero(delta)) continue;
    lines.push({ ...L(acc.id, 'debit', '0', 'Opening balance (grams)', partyId), metalId: row.metalId, purityId: row.purityId ?? null,
      weightIn: compare(delta, '0') > 0 ? delta : '0', weightOut: compare(delta, '0') < 0 ? sub('0', delta) : '0' });
  }
  if (!lines.length) return { changed: false, state: current };

  const gap = sub(sum(lines.map((l) => l.debit)), sum(lines.map((l) => l.credit)));
  if (!isZero(gap)) lines.push(L(diffId, compare(gap, '0') > 0 ? 'credit' : 'debit', compare(gap, '0') > 0 ? gap : sub('0', gap), 'Difference in opening balances'));
  const amount = sum(lines.map((l) => l.debit));
  const entry = await save(tx, {
    docType: 'opening', docDate: date, branchId, status: 'posted', lines, amount, narration: 'Opening balances',
  });
  return { changed: true, docNumber: entry.doc_number, state: await openingState(tx) };
}
