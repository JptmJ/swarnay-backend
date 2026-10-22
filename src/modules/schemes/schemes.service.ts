/**
 * Swarna Nidhi — monthly gold savings schemes.
 *
 * The shop collects a fixed amount every month, adds a bonus at the end, and
 * the whole lot buys jewellery at that day's rate. Three things decide how this
 * has to be modelled, and all three are easy to get wrong:
 *
 * 1. **The money is owed, not earned.** Every rupee collected is a liability
 *    (2300) until the customer takes jewellery for it. Booking it as income is
 *    how jewellers end up spending money they still owe, so nothing here ever
 *    touches a revenue account until redemption, and even then the revenue is
 *    the bill's, not ours.
 *
 * 2. **A weight plan owes grams, not rupees.** Paying ₹5,000 when gold is
 *    ₹6,500/g buys 0.769 g, and 0.769 g is what the customer is owed however
 *    gold moves afterwards. That obligation is carried on 2310, which tracks
 *    metal, so the shop can see its gold liability beside its gold stock.
 *
 * 3. **The terms are a promise.** A shop that improves its bonus next year must
 *    not quietly change what it already promised, and one that reduces it must
 *    not take anything away from people already saving. So every account keeps
 *    its own copy of the plan's terms from the day it was opened, and nothing
 *    here reads the live plan once an account exists.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { postVoucher, reverseVoucher, type MetalEntry, type MoneyEntry } from '../accounts/ledger.service.js';
import { paymentAccount } from '../purchase/purchase.service.js';
import { modeCharges, postingSettings } from '../accounts/posting.js';
import { activeCustomer, checkCashLimit } from '../sales/sales.service.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';

const rs = (v: Decimal) => round(v, 2);
const g3 = (v: Decimal) => round(v, 3);
const inr = (v: Decimal | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SETTINGS = {
  bonusAccrual: CONFIG.schemeBonusAccrual, bonusTreatment: CONFIG.schemeBonusTreatment,
  bonusForfeit: CONFIG.schemeBonusForfeit, rateSource: CONFIG.schemeRateSource,
  lateRateBasis: CONFIG.schemeLateRateBasis, allowAdvance: CONFIG.schemeAllowAdvance,
  autoMature: CONFIG.schemeAutoMature, redeemOnOrder: CONFIG.schemeRedeemOnOrder,
  redeemPartial: CONFIG.schemeRedeemPartial, redeemWindowDays: CONFIG.schemeRedeemWindow,
  closureAllowed: CONFIG.schemeClosureAllowed, closureSettlement: CONFIG.schemeClosureSettlement,
  closureDeduction: CONFIG.schemeClosureDeduction, closureMinMonths: CONFIG.schemeClosureMinMonths,
  missedAfterDays: CONFIG.schemeMissedAfterDays, printOnCollect: CONFIG.schemeReceiptPrint,
};
/** Every Schemes setting. Anyone with schemes.accounts.view may read them. */
export const schemeSettings = (tx: Tx) => getConfigMany(tx, SETTINGS);
export type SchemeSettings = Awaited<ReturnType<typeof schemeSettings>>;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

/* ------------------------------------------------------------------- rates */

interface RateRow { purity_id: string | null; rate_per_gram: Decimal | null; buying_rate_per_gram: Decimal | null }

/**
 * What a gram costs on a given day, for the purity the plan saves in. `onDate`
 * lets a late installment be priced at the month it was due rather than today,
 * which is the kinder of the two and the shop's choice.
 */
export async function schemeRate(
  tx: Tx, metalId: string, purityId: string | null, source: 'selling' | 'buying', onDate: string,
): Promise<{ ratePerGram: Decimal; purityId: string | null; note: string }> {
  const branchId = branchOf(tx);
  const rates = await tx.query<RateRow>(
    `select distinct on (purity_id) purity_id, rate_per_gram, buying_rate_per_gram
       from metal_rate
      where metal_id = $1 and effective_from::date <= $3 and (branch_id = $2 or branch_id is null)
      order by purity_id, effective_from desc, branch_id nulls last`,
    [metalId, branchId, onDate]);
  const of = (r: RateRow) => (source === 'buying' ? r.buying_rate_per_gram : r.rate_per_gram);

  if (purityId) {
    const row = rates.find((r) => r.purity_id === purityId);
    const rate = row && of(row);
    if (!rate || !(compare(rate, '0') > 0)) {
      throw new BusinessRuleError(
        `No ${source} rate is set for the purity this scheme saves in. Enter it in Masters → Rates.`, 'rate_required');
    }
    return { ratePerGram: rate, purityId, note: `${source} rate on ${onDate}` };
  }

  // No purity on the plan: use the purest one that has a rate, so grams mean something definite.
  const purities = await tx.query<{ id: string; code: string; fineness: Decimal }>(
    `select id, code, fineness_percent as fineness from purity where metal_id = $1 and is_active
      order by fineness_percent desc`, [metalId]);
  for (const p of purities) {
    const row = rates.find((r) => r.purity_id === p.id);
    const rate = row && of(row);
    if (rate && compare(rate, '0') > 0) return { ratePerGram: rate, purityId: p.id, note: `${p.code} ${source} rate on ${onDate}` };
  }
  throw new BusinessRuleError(`No ${source} rate is set for this metal. Enter it in Masters → Rates.`, 'rate_required');
}

/* -------------------------------------------------------------- enrollment */

export interface EnrollInput {
  schemePlanId: string;
  customerId: string;
  enrolledOn?: string;
  installmentAmount?: Decimal;
  dueDay?: number;
  nomineeName?: string;
  nomineeRelationship?: string;
  nomineePhone?: string;
  notes?: string;
}

interface PlanRow {
  id: string; code: string; name: string; metal_id: string; purity_id: string | null;
  accrual_basis: 'rupee' | 'weight'; tenure_months: number;
  installment_amount: Decimal | null; minimum_installment: Decimal | null; is_flexible_amount: boolean;
  bonus_installments: Decimal; bonus_percent: Decimal; max_missed_installments: number;
  making_charge_discount_percent: Decimal; allow_partial_redemption: boolean; allow_cash_redemption: boolean;
  grace_period_days: number; is_active: boolean;
}

async function activePlan(tx: Tx, id: string): Promise<PlanRow> {
  const plan = await tx.maybeOne<PlanRow>(
    `select * from scheme_plan where id = $1 and deleted_at is null`, [id]);
  if (!plan) throw new NotFoundError('That scheme plan does not exist.');
  if (!plan.is_active) throw new BusinessRuleError(`${plan.name} is closed to new members.`, 'plan_inactive');
  return plan;
}

/** The same month-end rule people expect: the 31st of a 30-day month is its last day. */
function addMonths(iso: string, months: number, day: number): string {
  const start = new Date(`${iso}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/**
 * Opens an account and writes the whole schedule at once, so "what is due this
 * month" stays a query rather than a calculation, and so the customer can be
 * handed a printed card of dates on the day they join.
 */
export async function enroll(tx: Tx, input: EnrollInput) {
  const branchId = branchOf(tx);
  const today = await businessDate(tx);
  const plan = await activePlan(tx, input.schemePlanId);
  const customer = await activeCustomer(tx, input.customerId);

  const enrolledOn = input.enrolledOn ?? today;
  if (enrolledOn > today) throw new ValidationError('An account cannot be opened with a date in the future.');

  const amount = rs(input.installmentAmount ?? plan.installment_amount ?? '0');
  if (!(compare(amount, '0') > 0)) {
    throw new ValidationError(`${plan.name} has no installment amount. Enter what this member will pay each month.`);
  }
  if (!plan.is_flexible_amount && plan.installment_amount && compare(amount, plan.installment_amount) !== 0) {
    throw new BusinessRuleError(
      `${plan.name} is a fixed ${inr(plan.installment_amount)} a month. Use a flexible plan to take a different amount.`,
      'installment_fixed');
  }
  if (plan.minimum_installment && compare(amount, plan.minimum_installment) < 0) {
    throw new BusinessRuleError(
      `${plan.name} takes at least ${inr(plan.minimum_installment)} a month.`, 'installment_below_minimum');
  }

  const dueDay = input.dueDay ?? Number(enrolledOn.slice(8, 10));
  // Numbered on the day the account is opened on the system, not on a back-dated
  // enrolment date: a number belongs to the period it was actually issued in.
  const { numbers: [accountNumber] } = await reserveDocumentNumbers(tx, 'scheme_account', 1, { branchId, date: new Date(today) });
  const maturityDate = addMonths(enrolledOn, plan.tenure_months, Math.min(dueDay, 28));

  const account = await repo(tx, 'scheme_account').insert({
    account_number: accountNumber, scheme_plan_id: plan.id, customer_id: customer.id, branch_id: branchId,
    enrolled_on: enrolledOn, maturity_date: maturityDate, due_day: Math.min(dueDay, 28),
    installment_amount: amount, installments_due: plan.tenure_months,
    // The promise, frozen on the day it was made.
    accrual_basis: plan.accrual_basis, purity_id: plan.purity_id,
    bonus_installments: plan.bonus_installments, bonus_percent: plan.bonus_percent,
    making_charge_discount_percent: plan.making_charge_discount_percent,
    max_missed_installments: plan.max_missed_installments, grace_period_days: plan.grace_period_days,
    is_flexible_amount: plan.is_flexible_amount, minimum_installment: plan.minimum_installment,
    nominee_name: input.nomineeName ?? null, nominee_relationship: input.nomineeRelationship ?? null,
    nominee_phone: input.nomineePhone ?? null,
  });

  const schedule = Array.from({ length: plan.tenure_months }, (_, i) => ({
    scheme_account_id: account.id, installment_number: i + 1,
    due_date: addMonths(enrolledOn, i, Math.min(dueDay, 28)),
    amount_due: amount, status: 'due' as const,
  }));
  await repo(tx, 'scheme_installment').insertMany(schedule);

  return { ...account, customer_name: customer.name, plan_name: plan.name, installments: schedule.length };
}

/* -------------------------------------------------------------- collection */

interface AccountRow {
  id: string; account_number: string; scheme_plan_id: string; customer_id: string; branch_id: string;
  status: string; enrolled_on: string; maturity_date: string; installment_amount: Decimal;
  accrual_basis: 'rupee' | 'weight'; purity_id: string | null;
  installments_paid: number; installments_due: number; installments_missed: number;
  total_paid: Decimal; total_weight_accrued: Decimal;
  bonus_amount: Decimal; bonus_weight: Decimal; redeemable_amount: Decimal; redeemable_weight: Decimal;
  bonus_installments: Decimal; bonus_percent: Decimal; making_charge_discount_percent: Decimal;
  max_missed_installments: number; grace_period_days: number; is_bonus_forfeited: boolean;
  is_flexible_amount: boolean; minimum_installment: Decimal | null;
  metal_id: string; plan_name: string; allow_partial_redemption: boolean; allow_cash_redemption: boolean;
  customer_name: string;
}

const ACCOUNT_SELECT = `
  select a.*, s.metal_id, s.name as plan_name, s.allow_partial_redemption, s.allow_cash_redemption,
         p.name as customer_name
    from scheme_account a
    join scheme_plan s on s.id = a.scheme_plan_id
    join party p on p.id = a.customer_id`;

async function accountFor(tx: Tx, id: string, lock = false): Promise<AccountRow> {
  const row = await tx.maybeOne<AccountRow>(`${ACCOUNT_SELECT} where a.id = $1 ${lock ? 'for no key update of a' : ''}`, [id]);
  if (!row) throw new NotFoundError('That scheme account does not exist.');
  return row;
}

export interface CollectInput {
  /** One or more installment rows to settle, oldest first. Left out, the next one due is taken. */
  installmentIds?: string[];
  /** For a flexible plan, or for paying several months at once. */
  amount?: Decimal;
  paymentMethodId: string;
  reference?: string;
  docDate?: string;
  notes?: string;
}

/**
 * Takes a month's money (or several), works out the grams it bought, posts it
 * to the scheme liability and gives the customer a receipt.
 *
 * Nothing here is revenue. The shop is holding this money until the customer
 * takes jewellery for it, so it sits on 2300 — and, for a weight plan, the
 * grams sit on 2310 as well, which is the obligation that actually matters.
 */
export async function collect(tx: Tx, accountId: string, input: CollectInput) {
  const branchId = branchOf(tx);
  const s = await schemeSettings(tx);
  const today = await businessDate(tx);
  const docDate = input.docDate ?? today;
  const account = await accountFor(tx, accountId, true);
  const customer = await activeCustomer(tx, account.customer_id);

  if (account.status !== 'active') {
    throw new BusinessRuleError(
      `${account.account_number} is ${account.status}, so no more money can be taken on it.`, 'account_not_active');
  }

  // Which months this payment settles.
  const open = await tx.query<{ id: string; installment_number: number; due_date: string; amount_due: Decimal; status: string }>(
    `select id, installment_number, due_date, amount_due, status from scheme_installment
      where scheme_account_id = $1 and status in ('due', 'missed') order by installment_number`, [accountId]);
  if (!open.length) {
    throw new BusinessRuleError(`Every month on ${account.account_number} is already paid.`, 'nothing_due');
  }

  let rows = input.installmentIds?.length
    ? input.installmentIds.map((id) => {
        const found = open.find((o) => o.id === id);
        if (!found) throw new BusinessRuleError('That month is not open on this account.', 'installment_not_open');
        return found;
      })
    : [open[0]!];

  // Paying a lump sum clears as many months as it covers.
  if (input.amount !== undefined && !input.installmentIds?.length) {
    let left = rs(input.amount);
    const taken: typeof open = [];
    for (const row of open) {
      if (compare(left, row.amount_due) < 0) break;
      taken.push(row);
      left = sub(left, row.amount_due);
    }
    if (!taken.length) {
      if (!account.is_flexible_amount) {
        throw new BusinessRuleError(
          `A month on ${account.account_number} is ${inr(open[0]!.amount_due)}; ${inr(input.amount)} does not cover one.`,
          'amount_below_installment');
      }
      taken.push(open[0]!);
    }
    if (!isZero(left) && compare(left, '0') > 0 && !account.is_flexible_amount) {
      throw new BusinessRuleError(
        `${inr(input.amount)} is ${inr(left)} more than the months it covers. Take whole months, or use a flexible plan.`,
        'amount_not_whole_months');
    }
    rows = taken;
  }
  if (rows.length > 1 && !s.allowAdvance) {
    throw new BusinessRuleError('This shop takes one month at a time. Collect them one by one.', 'advance_not_allowed');
  }

  const method = await paymentAccount(tx, input.paymentMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) {
    throw new BusinessRuleError(`${method.name} cannot be used to pay a scheme installment.`, 'payment_method_invalid');
  }
  if (method.requires_reference && !input.reference?.trim()) {
    throw new BusinessRuleError(`${method.name} needs a reference (card slip, UTR, cheque number).`, 'reference_required');
  }

  // What is actually being paid: the months chosen, or the flexible amount against one month.
  const scheduled = sum(rows.map((r) => r.amount_due));
  const paid = rs(input.amount !== undefined && account.is_flexible_amount && rows.length === 1 ? input.amount : scheduled);
  if (!(compare(paid, '0') > 0)) throw new ValidationError('Enter what the member is paying.');
  if (account.is_flexible_amount && account.minimum_installment && compare(paid, account.minimum_installment) < 0) {
    throw new BusinessRuleError(
      `This plan takes at least ${inr(account.minimum_installment)} a month.`, 'installment_below_minimum');
  }
  if (method.max_amount && compare(paid, method.max_amount) > 0) {
    throw new BusinessRuleError(`${method.name} allows at most ${inr(method.max_amount)} at a time.`, 'payment_limit');
  }
  if (method.kind === 'cash') await checkCashLimit(tx, customer, paid, docDate);

  // Grams, for a weight plan. A late month can be priced at the rate it was due at.
  const weightPlan = account.accrual_basis === 'weight';
  let ratePerGram: Decimal | null = null;
  let purityId: string | null = account.purity_id;
  let weight: Decimal = '0';
  if (weightPlan) {
    const first = rows[0]!;
    const rateDate = s.lateRateBasis === 'due_date' && first.due_date < docDate ? first.due_date : docDate;
    const rate = await schemeRate(tx, account.metal_id, account.purity_id, s.rateSource, rateDate);
    ratePerGram = rate.ratePerGram;
    purityId = rate.purityId;
    weight = g3(div(paid, rate.ratePerGram));
  }

  const { numbers: [receiptNumber] } = await reserveDocumentNumbers(tx, 'scheme_receipt', 1, { branchId, date: new Date(docDate) });
  const share = rows.length;
  const perRow = rs(div(paid, String(share)));
  const perWeight = weightPlan ? g3(div(weight, String(share))) : '0';

  for (const [at, row] of rows.entries()) {
    // The last row carries the rounding, so the parts add back to the whole.
    const rowPaid = at === share - 1 ? sub(paid, mul(perRow, String(share - 1))) : perRow;
    const rowWeight = weightPlan ? (at === share - 1 ? sub(weight, mul(perWeight, String(share - 1))) : perWeight) : '0';
    await tx.query(
      `update scheme_installment
          set status = 'paid', amount_paid = $2, paid_on = $3, payment_method_id = $4, payment_reference = $5,
              rate_per_gram = $6, weight_accrued = $7, purity_id = $8, receipt_number = $9,
              collected_by = $10, notes = coalesce($11, notes), cancelled_at = null, cancel_reason = null,
              updated_at = now()
        where id = $1`,
      [row.id, rowPaid, docDate, method.id, input.reference?.trim() ?? null, ratePerGram, rowWeight,
       purityId, receiptNumber, tx.context.userId, input.notes ?? null]);
  }

  // The books: money in, and the same amount owed back to the member.
  const narration = `${receiptNumber}, ${account.account_number}, ${customer.name}`;
  const money: MoneyEntry[] = [
    { ...method.account, debit: paid, narration },
    { accountCode: '2300', credit: paid, partyId: customer.id, narration },
    ...modeCharges(await postingSettings(tx), method, paid, receiptNumber!),
  ];
  const metal: MetalEntry[] = weightPlan && compare(weight, '0') > 0
    ? [{ accountCode: '2310', metalId: account.metal_id, purityId, weightIn: weight, partyId: customer.id, narration }]
    : [];
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'scheme', voucherDate: docDate, branchId, sourceType: 'scheme_installment', sourceId: rows[0]!.id,
    narration, money, metal,
  });
  await tx.query(`update scheme_installment set voucher_id = $2 where id = any($1::uuid[])`, [rows.map((r) => r.id), voucherId]);

  const updated = await refreshAccount(tx, accountId);
  return {
    account: updated, receiptNumber, voucherId,
    installments: rows.map((r) => r.installment_number),
    amountPaid: paid, weightAccrued: weight, ratePerGram,
    printReceipt: s.printOnCollect,
  };
}

/**
 * Undoes a collection entered by mistake: the month goes back to due and the
 * money is reversed with mirror entries, never by deleting what was posted.
 */
export async function cancelCollection(tx: Tx, installmentId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('Say why the collection is being taken back.');
  const row = await tx.maybeOne<{
    id: string; scheme_account_id: string; status: string; voucher_id: string | null;
    receipt_number: string | null; installment_number: number; account_status: string;
  }>(
    `select i.id, i.scheme_account_id, i.status, i.voucher_id, i.receipt_number, i.installment_number,
            a.status as account_status
       from scheme_installment i join scheme_account a on a.id = i.scheme_account_id
      where i.id = $1 for no key update of i`, [installmentId]);
  if (!row) throw new NotFoundError('That installment does not exist.');
  if (row.status !== 'paid') throw new BusinessRuleError('That month is not paid, so there is nothing to take back.', 'not_paid');
  if (['redeemed', 'closed'].includes(row.account_status)) {
    throw new BusinessRuleError(
      'This account has already been settled. A collection on it can no longer be taken back.', 'account_settled');
  }

  if (row.voucher_id) {
    // Others may have been collected on the same receipt; each is reversed once.
    const shared = await tx.query<{ id: string }>(
      `select id from scheme_installment where voucher_id = $1 and status = 'paid'`, [row.voucher_id]);
    if (shared.length === 1) await reverseVoucher(tx, row.voucher_id, `Collection taken back: ${reason.trim()}`);
    else {
      throw new BusinessRuleError(
        `${row.receipt_number} covers ${shared.length} months at once; take the whole receipt back instead.`,
        'receipt_covers_many');
    }
  }
  await tx.query(
    `update scheme_installment
        set status = 'due', amount_paid = 0, paid_on = null, payment_method_id = null, payment_reference = null,
            rate_per_gram = null, weight_accrued = 0, receipt_number = null, voucher_id = null,
            cancelled_at = now(), cancel_reason = $2, updated_at = now()
      where id = $1`, [installmentId, reason.trim()]);
  return refreshAccount(tx, row.scheme_account_id);
}

/** Lets a month go without payment — a goodwill call, recorded with its reason. */
export async function waiveInstallment(tx: Tx, installmentId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('Say why this month is being waived.');
  const row = await tx.maybeOne<{ scheme_account_id: string; status: string }>(
    `select scheme_account_id, status from scheme_installment where id = $1`, [installmentId]);
  if (!row) throw new NotFoundError('That installment does not exist.');
  if (row.status === 'paid') throw new BusinessRuleError('That month is already paid.', 'already_paid');
  await tx.query(
    `update scheme_installment set status = 'waived', waived_reason = $2, updated_at = now() where id = $1`,
    [installmentId, reason.trim()]);
  return refreshAccount(tx, row.scheme_account_id);
}

/* ----------------------------------------------------------- the running total */

/**
 * Rebuilds an account's totals from its own installment rows, which are the
 * record. Running totals that are only ever added to drift the first time
 * anything is cancelled; derived ones cannot.
 */
export async function refreshAccount(tx: Tx, accountId: string) {
  const s = await schemeSettings(tx);
  const today = await businessDate(tx);
  const account = await accountFor(tx, accountId);

  const totals = await tx.one<{
    paid_count: number; paid_amount: Decimal; paid_weight: Decimal; waived_count: number; missed_count: number;
  }>(
    `select count(*) filter (where status = 'paid')::int as paid_count,
            coalesce(sum(amount_paid) filter (where status = 'paid'), 0)::text as paid_amount,
            coalesce(sum(weight_accrued) filter (where status = 'paid'), 0)::text as paid_weight,
            count(*) filter (where status = 'waived')::int as waived_count,
            count(*) filter (where status in ('due','missed') and due_date + ($2 || ' days')::interval < $3::date)::int as missed_count
       from scheme_installment where scheme_account_id = $1`,
    [accountId, String(account.grace_period_days + s.missedAfterDays), today]);

  // Months that have gone past without being paid, kept on the row as well as counted.
  await tx.query(
    `update scheme_installment set status = 'missed', updated_at = now()
      where scheme_account_id = $1 and status = 'due' and due_date + ($2 || ' days')::interval < $3::date`,
    [accountId, String(account.grace_period_days + s.missedAfterDays), today]);

  const settled = totals.paid_count + totals.waived_count;
  const forfeited = s.bonusForfeit && totals.missed_count > account.max_missed_installments;

  // The bonus: so many months' worth, plus a percentage of what was saved.
  const fullBonus = forfeited ? '0' : rs(add(
    mul(account.installment_amount, account.bonus_installments),
    div(mul(totals.paid_amount, account.bonus_percent), '100'),
  ));
  const earnedBonus = s.bonusAccrual === 'monthly' && account.installments_due > 0
    ? rs(div(mul(fullBonus, String(Math.min(settled, account.installments_due))), String(account.installments_due)))
    : (settled >= account.installments_due ? fullBonus : '0');

  // On a weight plan the bonus is grams too, bought at the average rate the member paid.
  const avgRate = compare(totals.paid_weight, '0') > 0 ? div(totals.paid_amount, totals.paid_weight) : '0';
  const bonusWeight = account.accrual_basis === 'weight' && compare(avgRate, '0') > 0
    ? g3(div(earnedBonus, avgRate)) : '0';

  const spent = await tx.one<{ amount: Decimal; weight: Decimal }>(
    `select coalesce(sum(amount_redeemed), 0)::text as amount, coalesce(sum(weight_redeemed), 0)::text as weight
       from scheme_redemption where scheme_account_id = $1 and status = 'posted'`, [accountId]);

  const redeemableAmount = rs(sub(add(totals.paid_amount, earnedBonus), spent.amount));
  const redeemableWeight = g3(sub(add(totals.paid_weight, bonusWeight), spent.weight));

  // Fully paid and matured by date: ready to spend, if the shop matures them automatically.
  let status = account.status;
  if (status === 'active' && s.autoMature && settled >= account.installments_due && today >= account.maturity_date) {
    status = 'matured';
  }

  const updated = await tx.one(
    `update scheme_account
        set installments_paid = $2, installments_missed = $3, total_paid = $4, total_weight_accrued = $5,
            bonus_amount = $6, bonus_weight = $7, redeemable_amount = $8, redeemable_weight = $9,
            is_bonus_forfeited = $10, status = $11,
            matured_at = case when $11 = 'matured' and matured_at is null then now() else matured_at end,
            updated_at = now()
      where id = $1 returning *`,
    [accountId, totals.paid_count, totals.missed_count, totals.paid_amount, totals.paid_weight,
     earnedBonus, bonusWeight, redeemableAmount, redeemableWeight, forfeited, status]);
  return { ...updated, customer_name: account.customer_name, plan_name: account.plan_name };
}

/** Marks an account matured by hand, for shops that would rather check first. */
export async function matureAccount(tx: Tx, accountId: string) {
  const account = await accountFor(tx, accountId, true);
  if (account.status === 'matured') return refreshAccount(tx, accountId);
  if (account.status !== 'active') {
    throw new BusinessRuleError(`${account.account_number} is ${account.status}.`, 'account_not_active');
  }
  await tx.query(`update scheme_account set status = 'matured', matured_at = now(), updated_at = now() where id = $1`, [accountId]);
  return refreshAccount(tx, accountId);
}

/* ------------------------------------------------------------- redemption */

/** A redemption row as it comes back, so callers can link it to their own document. */
export interface RedemptionRow {
  id: string; redemption_number: string; scheme_account_id: string; redeemed_on: string;
  amount_redeemed: Decimal; weight_redeemed: Decimal; bonus_applied: Decimal; is_partial: boolean;
  kind: 'redemption' | 'early_closure'; status: 'posted' | 'cancelled';
}

export interface RedeemInput {
  /** Rupees off the account. Left out, the whole redeemable balance is used. */
  amount?: Decimal;
  salesInvoiceId?: string;
  retailOrderId?: string;
  /**
   * Release it as the member's credit, to be spent straight away. This is what
   * the counter does: the bill it is paying does not exist until the bill saves,
   * so the savings become credit and the bill's own tender spends them.
   */
  toCredit?: boolean;
  /** Only where both the plan and the shop allow it. */
  cashPaymentMethodId?: string;
  docDate?: string;
  notes?: string;
}

/**
 * Spends a matured account. The scheme does not sell anything itself — the bill
 * does — so this only releases the liability and tells the bill how much of it
 * was paid for out of savings.
 */
export async function redeem(tx: Tx, accountId: string, input: RedeemInput) {
  const branchId = branchOf(tx);
  const s = await schemeSettings(tx);
  const today = await businessDate(tx);
  const docDate = input.docDate ?? today;
  const account = await accountFor(tx, accountId, true);
  const customer = await activeCustomer(tx, account.customer_id);

  if (!['matured', 'active'].includes(account.status)) {
    throw new BusinessRuleError(`${account.account_number} is ${account.status} and cannot be redeemed.`, 'account_not_redeemable');
  }
  if (account.status === 'active') {
    throw new BusinessRuleError(
      `${account.account_number} matures on ${account.maturity_date}. Close it early instead if the member wants their money now.`,
      'not_matured');
  }
  if (compare(account.redeemable_amount, '0') <= 0) {
    throw new BusinessRuleError(`There is nothing left on ${account.account_number}.`, 'nothing_to_redeem');
  }

  const amount = rs(input.amount ?? account.redeemable_amount);
  if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter how much of the scheme is being used.');
  if (compare(amount, account.redeemable_amount) > 0) {
    throw new BusinessRuleError(
      `${account.account_number} has ${inr(account.redeemable_amount)}; ${inr(amount)} was entered.`, 'exceeds_balance');
  }
  const isPartial = compare(amount, account.redeemable_amount) < 0;
  if (isPartial && !(s.redeemPartial && account.allow_partial_redemption)) {
    throw new BusinessRuleError(
      `${account.plan_name} has to be spent in one go — ${inr(account.redeemable_amount)}.`, 'partial_not_allowed');
  }
  if (input.retailOrderId && !s.redeemOnOrder) {
    throw new BusinessRuleError('This shop does not let a scheme pay for an order.', 'order_not_allowed');
  }
  if (input.cashPaymentMethodId && !account.allow_cash_redemption) {
    throw new BusinessRuleError(
      `${account.plan_name} is redeemed against jewellery, not paid out in cash.`, 'cash_not_allowed');
  }
  if (!input.salesInvoiceId && !input.retailOrderId && !input.cashPaymentMethodId && !input.toCredit) {
    throw new ValidationError('Say what the scheme is paying for: a bill, an order, a cash payout where that is allowed, or the member’s credit.');
  }

  // The share of grams that goes with the money, so a weight account stays consistent.
  const weight = account.accrual_basis === 'weight' && compare(account.redeemable_amount, '0') > 0
    ? g3(div(mul(account.redeemable_weight, amount), account.redeemable_amount)) : '0';
  const bonusShare = compare(account.redeemable_amount, '0') > 0
    ? rs(div(mul(account.bonus_amount, amount), account.redeemable_amount)) : '0';

  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'scheme_redemption', 1, { branchId, date: new Date(docDate) });
  const rate = account.accrual_basis === 'weight' && compare(weight, '0') > 0 ? rs(div(amount, weight)) : '0';
  const narration = `${docNumber}, ${account.account_number}, ${customer.name}`;

  const redemption = await repo<RedemptionRow>(tx, 'scheme_redemption').insert({
    scheme_account_id: accountId, redemption_number: docNumber, redeemed_on: docDate, branch_id: branchId,
    is_partial: isPartial, amount_redeemed: amount, weight_redeemed: weight, bonus_applied: bonusShare,
    bonus_weight_applied: account.accrual_basis === 'weight' ? g3(div(mul(account.bonus_weight, amount), account.redeemable_amount)) : '0',
    making_discount_percent: account.making_charge_discount_percent,
    rate_per_gram: rate, sales_invoice_id: input.salesInvoiceId ?? null, retail_order_id: input.retailOrderId ?? null,
    cash_paid_out: input.cashPaymentMethodId ? amount : '0', kind: 'redemption', notes: input.notes ?? null,
  });

  /*
   * The liability goes; what replaces it depends on where the money went.
   * Against a bill or an order the member now holds credit they can spend, so
   * it moves to 2400 and the counter settles it exactly like any other advance
   * — one path for customer credit, not two. Cash simply leaves.
   */
  const money: MoneyEntry[] = [{ accountCode: '2300', debit: amount, partyId: customer.id, narration }];
  if (input.cashPaymentMethodId) {
    const method = await paymentAccount(tx, input.cashPaymentMethodId, branchId);
    if (method.kind === 'cash') await checkCashLimit(tx, customer, amount, docDate);
    money.push({ ...method.account, credit: amount, narration });
  } else {
    money.push({ accountCode: '2400', credit: amount, partyId: customer.id, narration: `${narration} — credit to spend` });
  }

  // The bonus is the shop's cost the moment it is handed over, unless the shop
  // would rather show it as a discount on the bill, which the bill itself does.
  if (compare(bonusShare, '0') > 0 && s.bonusTreatment === 'expense') {
    money.push({ accountCode: '5300', debit: bonusShare, narration: `Scheme bonus, ${account.account_number}` });
    money.push({ accountCode: '2300', credit: bonusShare, partyId: customer.id, narration });
  }

  const metal: MetalEntry[] = account.accrual_basis === 'weight' && compare(weight, '0') > 0
    ? [{ accountCode: '2310', metalId: account.metal_id, purityId: account.purity_id, weightOut: weight, partyId: customer.id, narration }]
    : [];

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'scheme', voucherDate: docDate, branchId, sourceType: 'scheme_redemption', sourceId: redemption.id,
    narration, money, metal,
  });
  await tx.query(`update scheme_redemption set voucher_id = $2 where id = $1`, [redemption.id, voucherId]);

  // An order records what has been put towards it, the same way it records an
  // advance or old gold, so the counter knows what is left to collect on delivery.
  if (input.retailOrderId) {
    await tx.query(
      `update retail_order set scheme_credit = scheme_credit + $2,
              balance_amount = total_amount - advance_amount - old_gold_credit - (scheme_credit + $2), updated_at = now()
        where id = $1`, [input.retailOrderId, amount]);
  }
  if (!isPartial) {
    await tx.query(
      `update scheme_account set status = 'redeemed', closed_at = now(), updated_at = now() where id = $1`, [accountId]);
  }
  const updated = await refreshAccount(tx, accountId);
  return { redemption: { ...redemption, voucher_id: voucherId }, account: updated };
}

/* ---------------------------------------------------------- early closure */

export interface CloseInput {
  reason: string;
  /** refund = money back through a mode; credit = leave it as the customer's credit. */
  settlement?: 'refund' | 'credit';
  refundPaymentMethodId?: string;
  docDate?: string;
}

/**
 * A member who wants out before maturity. They get back what they paid, less
 * whatever the shop keeps for the trouble, and never the bonus — the bonus is
 * what was promised for seeing it through.
 */
export async function closeAccount(tx: Tx, accountId: string, input: CloseInput) {
  const branchId = branchOf(tx);
  const s = await schemeSettings(tx);
  const today = await businessDate(tx);
  const docDate = input.docDate ?? today;
  if (!input.reason?.trim()) throw new ValidationError('Say why the account is being closed.');

  const account = await accountFor(tx, accountId, true);
  const customer = await activeCustomer(tx, account.customer_id);
  if (!['active', 'matured'].includes(account.status)) {
    throw new BusinessRuleError(`${account.account_number} is already ${account.status}.`, 'account_not_active');
  }
  if (!s.closureAllowed) {
    throw new BusinessRuleError('This shop does not close scheme accounts early.', 'closure_not_allowed');
  }
  if (account.installments_paid < s.closureMinMonths) {
    throw new BusinessRuleError(
      `${s.closureMinMonths} months have to be paid before an account can be closed early; ${account.account_number} has ${account.installments_paid}.`,
      'closure_too_early');
  }

  const settlement = input.settlement ?? (s.closureSettlement === 'ask' ? undefined : s.closureSettlement);
  if (!settlement) throw new ValidationError('Say whether the money is refunded or left as the customer’s credit.');
  if (settlement === 'refund' && !input.refundPaymentMethodId) {
    throw new ValidationError('Choose how the money is being handed back.');
  }

  // Only what was actually paid comes back; the bonus is not earned.
  const deduction = rs(div(mul(account.total_paid, String(s.closureDeduction)), '100'));
  const payable = rs(sub(account.total_paid, deduction));
  if (compare(payable, '0') < 0) throw new BusinessRuleError('The deduction is more than the account holds.', 'deduction_exceeds');

  const { numbers: [docNumber] } = await reserveDocumentNumbers(tx, 'scheme_redemption', 1, { branchId, date: new Date(docDate) });
  const narration = `${docNumber}, ${account.account_number}, ${customer.name}`;

  const closure = await repo<RedemptionRow>(tx, 'scheme_redemption').insert({
    scheme_account_id: accountId, redemption_number: docNumber, redeemed_on: docDate, branch_id: branchId,
    is_partial: false, kind: 'early_closure',
    amount_redeemed: account.total_paid, weight_redeemed: account.total_weight_accrued,
    bonus_applied: '0', bonus_weight_applied: '0', making_discount_percent: '0',
    deduction_amount: deduction, rate_per_gram: '0',
    cash_paid_out: settlement === 'refund' ? payable : '0', notes: input.reason.trim(),
  });

  const money: MoneyEntry[] = [{ accountCode: '2300', debit: account.total_paid, partyId: customer.id, narration }];
  if (settlement === 'refund') {
    const method = await paymentAccount(tx, input.refundPaymentMethodId!, branchId);
    money.push({ ...method.account, credit: payable, narration });
  } else {
    money.push({ accountCode: '2400', credit: payable, partyId: customer.id, narration: `${narration} — left as credit` });
  }
  // What the shop keeps is income the day the member walks away, not before.
  if (compare(deduction, '0') > 0) {
    money.push({ accountCode: '4200', credit: deduction, narration: `Kept on early closure, ${account.account_number}` });
  }

  const metal: MetalEntry[] = account.accrual_basis === 'weight' && compare(account.total_weight_accrued, '0') > 0
    ? [{ accountCode: '2310', metalId: account.metal_id, purityId: account.purity_id,
         weightOut: account.total_weight_accrued, partyId: customer.id, narration }]
    : [];

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'scheme', voucherDate: docDate, branchId, sourceType: 'scheme_redemption', sourceId: closure.id,
    narration, money, metal,
  });
  await tx.query(`update scheme_redemption set voucher_id = $2 where id = $1`, [closure.id, voucherId]);
  await tx.query(
    `update scheme_account set status = 'closed', closed_at = now(), close_reason = $2, updated_at = now() where id = $1`,
    [accountId, input.reason.trim()]);

  const updated = await accountFor(tx, accountId);
  return { closure: { ...closure, voucher_id: voucherId }, account: updated, refunded: payable, kept: deduction };
}

/* ------------------------------------------------------------------ reads */

/** One account with its passbook, its receipts and what it has been spent on. */
export async function accountDetail(tx: Tx, accountId: string) {
  const account = await accountFor(tx, accountId);
  const [installments, redemptions] = await Promise.all([
    tx.query(
      `select i.*, m.name as payment_method_name, u.full_name as collected_by_name
         from scheme_installment i
         left join payment_method m on m.id = i.payment_method_id
         left join app_user u on u.id = i.collected_by
        where i.scheme_account_id = $1 order by i.installment_number`, [accountId]),
    tx.query(
      `select r.*, s.doc_number as invoice_number, o.order_number
         from scheme_redemption r
         left join sales_invoice s on s.id = r.sales_invoice_id
         left join retail_order o on o.id = r.retail_order_id
        where r.scheme_account_id = $1 order by r.redeemed_on desc`, [accountId]),
  ]);
  return { ...account, installments, redemptions };
}

/**
 * The card a member is given when they join: every date they have to pay, the
 * terms they were promised, and room to tick the months off. Printed later it
 * is their passbook, because the same rows then carry what was actually paid.
 */
export async function schemeCard(tx: Tx, accountId: string) {
  const account = await tx.maybeOne<Record<string, unknown>>(
    `select a.*, s.name as plan_name, s.code as plan_code, s.terms_and_conditions, s.tenure_months,
            m.name as metal_name, pu.code as purity_code,
            p.name as customer_name, p.code as customer_code, p.phone as customer_phone,
            p.address_line1 as customer_address, p.city as customer_city,
            b.name as branch_name, b.gstin as branch_gstin, b.address_line1 as branch_address,
            b.city as branch_city, b.phone as branch_phone
       from scheme_account a
       join scheme_plan s on s.id = a.scheme_plan_id
       join party p on p.id = a.customer_id
       join branch b on b.id = a.branch_id
       left join metal m on m.id = s.metal_id
       left join purity pu on pu.id = a.purity_id
      where a.id = $1`, [accountId]);
  if (!account) throw new NotFoundError('That scheme account does not exist.');

  const months = await tx.query(
    `select i.installment_number, i.due_date, i.amount_due, i.status, i.paid_on, i.amount_paid,
            i.weight_accrued, i.receipt_number
       from scheme_installment i where i.scheme_account_id = $1 order by i.installment_number`,
    [accountId]);

  return { ...account, months };
}

/**
 * A collection as it prints: the slip the member is handed. One receipt can * cover several months, so it carries the months it settled and where the
 * account stands afterwards — which is the part a member actually checks.
 */
export async function schemeReceipt(tx: Tx, receiptNumber: string) {
  const months = await tx.query<{
    id: string; installment_number: number; due_date: string; paid_on: string; amount_paid: Decimal;
    weight_accrued: Decimal; rate_per_gram: Decimal | null; payment_reference: string | null;
    scheme_account_id: string; method_name: string | null; method_kind: string | null; collected_by_name: string | null;
    purity_code: string | null;
  }>(
    `select i.id, i.installment_number, i.due_date, i.paid_on, i.amount_paid, i.weight_accrued, i.rate_per_gram,
            i.payment_reference, i.scheme_account_id,
            m.name as method_name, m.kind as method_kind, u.full_name as collected_by_name, pu.code as purity_code
       from scheme_installment i
       left join payment_method m on m.id = i.payment_method_id
       left join app_user u on u.id = i.collected_by
       left join purity pu on pu.id = i.purity_id
      where i.receipt_number = $1 and i.status = 'paid'
      order by i.installment_number`, [receiptNumber]);
  if (!months.length) throw new NotFoundError('That receipt does not exist.');

  const account = await tx.one<Record<string, unknown>>(
    `select a.id, a.account_number, a.accrual_basis, a.installment_amount, a.installments_paid, a.installments_due,
            a.total_paid, a.total_weight_accrued, a.bonus_amount, a.redeemable_amount, a.redeemable_weight,
            a.maturity_date, a.status,
            s.name as plan_name, s.code as plan_code,
            p.name as customer_name, p.code as customer_code, p.phone as customer_phone,
            p.address_line1 as customer_address, p.city as customer_city,
            b.name as branch_name, b.gstin as branch_gstin, b.address_line1 as branch_address,
            b.city as branch_city, b.phone as branch_phone
       from scheme_account a
       join scheme_plan s on s.id = a.scheme_plan_id
       join party p on p.id = a.customer_id
       join branch b on b.id = a.branch_id
      where a.id = $1`, [months[0]!.scheme_account_id]);

  // The next month still waiting, so the member leaves knowing when to come back.
  const nextDue = await tx.maybeOne<{ due_date: string; amount_due: Decimal }>(
    `select due_date, amount_due from scheme_installment
      where scheme_account_id = $1 and status in ('due', 'missed')
      order by installment_number limit 1`, [months[0]!.scheme_account_id]);

  return {
    ...account,
    receipt_number: receiptNumber,
    doc_date: months[0]!.paid_on,
    method_name: months[0]!.method_name,
    method_kind: months[0]!.method_kind,
    reference: months[0]!.payment_reference,
    collected_by_name: months[0]!.collected_by_name,
    months: months.map((m) => ({
      installmentNumber: m.installment_number, dueDate: m.due_date, amount: m.amount_paid,
      weight: m.weight_accrued, ratePerGram: m.rate_per_gram, purityCode: m.purity_code,
    })),
    amount_paid: sum(months.map((m) => m.amount_paid)),
    weight_accrued: sum(months.map((m) => m.weight_accrued)),
    next_due: nextDue,
  };
}

/** What a member can spend right now — read by the counter and by Orders. */
export async function customerSchemeCredit(tx: Tx, customerId: string) {
  const rows = await tx.query<{
    id: string; account_number: string; plan_name: string; status: string; redeemable_amount: Decimal;
    redeemable_weight: Decimal; accrual_basis: string; maturity_date: string; allow_partial_redemption: boolean;
  }>(
    `select a.id, a.account_number, s.name as plan_name, a.status, a.redeemable_amount, a.redeemable_weight,
            a.accrual_basis, a.maturity_date, s.allow_partial_redemption
       from scheme_account a join scheme_plan s on s.id = a.scheme_plan_id
      where a.customer_id = $1 and a.status = 'matured' and a.redeemable_amount > 0
      order by a.maturity_date`, [customerId]);
  return { accounts: rows, total: sum(rows.map((r) => r.redeemable_amount)) };
}

/** The collection worklist: what is due or already missed, oldest first. */
export async function dueList(
  tx: Tx, q: { onDate?: string; includeMissed?: boolean; branchId?: string; customerId?: string; limit?: number },
) {
  const today = await businessDate(tx);
  const onDate = q.onDate ?? today;
  const params: unknown[] = [onDate];
  const where: string[] = [
    `i.status in (${q.includeMissed === false ? "'due'" : "'due','missed'"})`,
    'i.due_date <= $1', `a.status = 'active'`,
  ];
  if (q.branchId) { params.push(q.branchId); where.push(`a.branch_id = $${params.length}`); }
  if (q.customerId) { params.push(q.customerId); where.push(`a.customer_id = $${params.length}`); }
  const rows = await tx.query<{ amount_due: Decimal }>(
    `select i.id, i.installment_number, i.due_date, i.amount_due, i.status,
            a.id as scheme_account_id, a.account_number, a.accrual_basis, a.installment_amount,
            p.id as customer_id, p.name as customer_name, p.phone as customer_phone,
            s.name as plan_name, ($1::date - i.due_date) as days_late
       from scheme_installment i
       join scheme_account a on a.id = i.scheme_account_id
       join party p on p.id = a.customer_id
       join scheme_plan s on s.id = a.scheme_plan_id
      where ${where.join(' and ')}
      order by i.due_date, a.account_number
      limit ${Math.min(Number(q.limit ?? 200), 500)}`, params);
  return { rows, totalDue: sum(rows.map((r) => r.amount_due)), onDate };
}

/** What the shop owes its scheme members, which is the number that matters. */
export async function liabilitySummary(tx: Tx, branchId?: string) {
  const params: unknown[] = [];
  let scope = '';
  if (branchId) { params.push(branchId); scope = ` and a.branch_id = $${params.length}`; }
  const row = await tx.one<Record<string, string>>(
    `select count(*) filter (where a.status = 'active')::int as active_accounts,
            count(*) filter (where a.status = 'matured')::int as matured_accounts,
            coalesce(sum(a.total_paid) filter (where a.status in ('active','matured')), 0)::text as collected,
            coalesce(sum(a.bonus_amount) filter (where a.status in ('active','matured')), 0)::text as bonus_accrued,
            coalesce(sum(a.redeemable_amount) filter (where a.status in ('active','matured')), 0)::text as owed,
            coalesce(sum(a.total_weight_accrued) filter (where a.status in ('active','matured')), 0)::text as owed_weight,
            coalesce(sum(a.installment_amount) filter (where a.status = 'active'), 0)::text as monthly_run_rate
       from scheme_account a where true${scope}`, params);
  return row;
}
