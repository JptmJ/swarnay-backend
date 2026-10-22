/**
 * Girvi — lending against a customer's jewellery.
 *
 * Four things decide how this has to be modelled, and each is easy to get wrong:
 *
 * 1. **The gold is not the shop's.** It is security, held in a sealed packet
 *    until the loan is cleared. It never enters stock and is never valued as
 *    the shop's own metal — it only has to be findable, which is what the vault
 *    register is for. The shop's asset is the money lent (1400), not the gold.
 *
 * 2. **Interest is append-only.** Each period is a row, written once. Working
 *    it out again from the sanction date every time the screen opens sounds
 *    simpler, but the rate can change, payments land irregularly, and a
 *    borrower disputing a figure has to be shown how it was arrived at, month
 *    by month. Nothing here ever rewrites a period that has already been taken.
 *
 * 3. **Shops quote interest differently.** A % a month, a % a year, or the old
 *    rupees-per-hundred. All three are stored as a % a month so the arithmetic
 *    is done one way, and the number the borrower was quoted is kept beside it
 *    so the ticket prints what they were actually told.
 *
 * 4. **The terms are a contract.** Every loan keeps its own copy of the rules
 *    it was given on, so changing the shop's settings next month never rewrites
 *    what somebody already signed.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { postVoucher, reverseVoucher, type MoneyEntry } from '../accounts/ledger.service.js';
import { paymentAccount } from '../purchase/purchase.service.js';
import { modeCharges, postingSettings } from '../accounts/posting.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';

const rs = (v: Decimal) => round(v, 2);
const g3 = (v: Decimal) => round(v, 3);
const inr = (v: Decimal | number) =>
  `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SETTINGS = {
  rateBasis: CONFIG.girviRateBasis, defaultRate: CONFIG.girviDefaultRate, rateEditable: CONFIG.girviRateEditable,
  method: CONFIG.girviInterestMethod, compoundMonths: CONFIG.girviCompoundEvery, periodBasis: CONFIG.girviPeriodBasis,
  minimumMonths: CONFIG.girviMinimumMonths, partMonth: CONFIG.girviPartMonth, graceDays: CONFIG.girviGraceDays,
  penalRate: CONFIG.girviPenalRate, bookWhen: CONFIG.girviAccrualBooking,
  rateSource: CONFIG.girviRateSource, rateMargin: CONFIG.girviRateMargin, valuationBasis: CONFIG.girviValuationBasis,
  ltvPercent: CONFIG.girviLtvPercent, ltvCap: CONFIG.girviLtvMax, ltvSilver: CONFIG.girviLtvSilver,
  minLoan: CONFIG.girviMinLoan, maxLoan: CONFIG.girviMaxLoan, rounding: CONFIG.girviRounding,
  allowTopUp: CONFIG.girviAllowTopUp,
  tenureMonths: CONFIG.girviTenureMonths, overdueGrace: CONFIG.girviOverdueGrace,
  feeBasis: CONFIG.girviFeeBasis, feeValue: CONFIG.girviFeeValue, feeTaken: CONFIG.girviFeeTaken,
  appraisalFee: CONFIG.girviAppraisalFee, penaltyBasis: CONFIG.girviPenaltyBasis, penaltyValue: CONFIG.girviPenaltyValue,
  storageFee: CONFIG.girviStorageFee,
  allocation: CONFIG.girviAllocation, allowInterestOnly: CONFIG.girviAllowInterestOnly,
  allowPartPrincipal: CONFIG.girviAllowPartPrincipal, minRepayment: CONFIG.girviMinRepayment,
  allowForeclosure: CONFIG.girviForeclosure, foreclosurePercent: CONFIG.girviForeclosureFee,
  packetRequired: CONFIG.girviPacketRequired, witnessRequired: CONFIG.girviWitness,
  kycRequired: CONFIG.girviKycRequired, kycMinValue: CONFIG.girviKycMinValue,
  borrowerPhoto: CONFIG.girviBorrowerPhoto, articlePhoto: CONFIG.girviArticlePhoto,
  noticeAfterDays: CONFIG.girviNoticeAfterDays, noticeCount: CONFIG.girviNoticeCount,
  noticeGapDays: CONFIG.girviNoticeGapDays, auctionAfterDays: CONFIG.girviAuctionAfterDays,
  surplus: CONFIG.girviSurplus,
  cashDisbursalLimit: CONFIG.girviCashDisbursalLimit, cashRepaymentLimit: CONFIG.girviCashRepaymentLimit,
  printTicket: CONFIG.girviPrintOnSanction,
};
/** Every Girvi setting. Anyone with girvi.view may read them. */
export const girviSettings = (tx: Tx) => getConfigMany(tx, SETTINGS);
export type GirviSettings = Awaited<ReturnType<typeof girviSettings>>;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

/* ------------------------------------------------------------------ rates */

/** However a shop quotes its rate, the arithmetic is done on a % a month. */
export function monthlyRate(quoted: Decimal, basis: 'per_month' | 'per_year' | 'per_hundred'): Decimal {
  if (basis === 'per_year') return round(div(quoted, '12'), 6);
  // "₹2 per ₹100 a month" is simply 2% a month said the old way.
  if (basis === 'per_hundred') return round(quoted, 6);
  return round(quoted, 6);
}

interface RateRow { purity_id: string | null; rate_per_gram: Decimal | null; buying_rate_per_gram: Decimal | null }

/**
 * What the collateral is worth today. The rate is the shop's own, read from
 * Masters, never sent in by whoever is typing the loan.
 */
export async function appraise<
  T extends { metalId: string; purityId?: string | null; grossWeight: Decimal; stoneWeight?: Decimal; testedPurityPercent?: Decimal },
>(tx: Tx, s: GirviSettings, lines: T[], onDate: string) {
  const branchId = branchOf(tx);
  const metalIds = [...new Set(lines.map((l) => l.metalId))];
  const [metals, purities, rates] = await Promise.all([
    tx.query<{ id: string; code: string; name: string }>(`select id, code, name from metal where id = any($1::uuid[])`, [metalIds]),
    tx.query<{ id: string; code: string; metal_id: string; fineness: Decimal }>(
      `select id, code, metal_id, fineness_percent as fineness from purity where metal_id = any($1::uuid[]) and is_active`, [metalIds]),
    /*
     * The rate as it stood on the day being valued, so a loan entered after the
     * fact is appraised at what gold was actually worth then. A shop whose rate
     * history does not reach that far back falls to its earliest known rate
     * rather than refusing to record the loan at all.
     */
    tx.query<RateRow & { metal_id: string }>(
      `select distinct on (metal_id, purity_id) metal_id, purity_id, rate_per_gram, buying_rate_per_gram
         from metal_rate where metal_id = any($1::uuid[]) and (branch_id = $2 or branch_id is null)
        order by metal_id, purity_id,
                 (effective_from::date <= $3) desc,
                 case when effective_from::date <= $3 then effective_from end desc,
                 effective_from asc,
                 branch_id nulls last`, [metalIds, branchId, onDate]),
  ]);
  const rateOf = (r: RateRow) => (s.rateSource === 'buying' ? r.buying_rate_per_gram : r.rate_per_gram);
  const metalName = (id: string) => metals.find((m) => m.id === id)?.name ?? 'this metal';

  /** Per gram of pure metal: a base (no-purity) rate, else the purest purity brought up to 100%. */
  const pureRate = (metalId: string): Decimal => {
    const base = rates.find((r) => r.metal_id === metalId && r.purity_id === null && rateOf(r));
    if (base) return rateOf(base)!;
    const priced = purities
      .filter((p) => p.metal_id === metalId)
      .flatMap((p) => { const r = rates.find((x) => x.metal_id === metalId && x.purity_id === p.id); const v = r && rateOf(r); return v && compare(v, '0') > 0 ? [{ p, rate: v }] : []; })
      .sort((a, b) => compare(b.p.fineness, a.p.fineness));
    const top = priced[0];
    if (!top) throw new BusinessRuleError(`No ${s.rateSource} rate is set for ${metalName(metalId)}. Enter it in Masters → Rates.`, 'rate_required');
    return rs(div(mul(top.rate, '100'), top.p.fineness));
  };

  const margin = (v: Decimal) => (s.rateMargin > 0 ? rs(sub(v, div(mul(v, String(s.rateMargin)), '100'))) : v);

  const priced = lines.map((l) => {
    const gross = g3(l.grossWeight);
    const stone = g3(l.stoneWeight ?? '0');
    if (compare(stone, gross) > 0) throw new ValidationError('The stones cannot weigh more than the article.');
    const net = g3(sub(gross, stone));
    const purity = purities.find((p) => p.id === l.purityId);
    const percent = l.testedPurityPercent ?? purity?.fineness;
    if (percent === undefined) throw new ValidationError(`Say how pure "${metalName(l.metalId)}" is, or choose its purity.`);
    const fine = g3(div(mul(net, percent), '100'));

    let rate: Decimal;
    let basis: string;
    if (s.valuationBasis === 'fine') {
      rate = margin(pureRate(l.metalId));
      basis = 'fine weight at the pure rate';
    } else {
      // The rate of the purity at or below what was tested, so nothing is over-valued.
      const below = purities
        .filter((p) => p.metal_id === l.metalId && compare(p.fineness, percent) <= 0)
        .sort((a, b) => compare(b.fineness, a.fineness));
      const found = below.map((p) => { const r = rates.find((x) => x.purity_id === p.id); const v = r && rateOf(r); return v && compare(v, '0') > 0 ? { p, rate: v } : null; }).find(Boolean);
      if (!found) throw new BusinessRuleError(`No ${s.rateSource} rate is set for ${metalName(l.metalId)} at that purity. Enter it in Masters → Rates.`, 'rate_required');
      rate = margin(found.rate);
      basis = `${found.p.code} rate`;
    }
    const weighed = s.valuationBasis === 'fine' ? fine : net;
    return { ...l, grossWeight: gross, stoneWeight: stone, net, fine, purityPercent: round(percent, 3), ratePerGram: rate, basis, value: rs(mul(weighed, rate)) };
  });

  const appraised = rs(sum(priced.map((p) => p.value)));
  // Silver usually carries a lower limit than gold; the lowest that applies wins.
  const isSilver = metals.some((m) => m.code === 'SILVER' && metalIds.includes(m.id));
  const ltv = isSilver && s.ltvSilver > 0 ? Math.min(s.ltvSilver, s.ltvPercent) : s.ltvPercent;
  const maxEligible = rs(div(mul(appraised, String(ltv)), '100'));
  return { lines: priced, appraised, ltvPercent: ltv, maxEligible };
}

/* --------------------------------------------------------------- sanction */

export interface CollateralInput {
  description: string;
  metalId: string;
  purityId?: string | null;
  itemCategoryId?: string | null;
  quantity?: number;
  grossWeight: Decimal;
  stoneWeight?: Decimal;
  testedPurityPercent?: Decimal;
  testMethod?: 'xrf' | 'touchstone' | 'declared';
  conditionNotes?: string;
  photoStorageKey?: string;
}

export interface SanctionInput {
  customerId?: string;
  borrowerName?: string;
  borrowerPhone?: string;
  borrowerAddress?: string;
  borrowerIdType?: 'aadhaar' | 'pan' | 'voter' | 'driving_licence' | 'passport';
  borrowerIdNumber?: string;
  borrowerPhotoKey?: string;
  sanctionedOn?: string;
  dueDate?: string;
  tenureMonths?: number;
  principalAmount: Decimal;
  /** Left out, the shop's own rate is used. */
  quotedRate?: Decimal;
  ltvPercent?: Decimal;
  disbursalMethodId: string;
  disbursalReference?: string;
  vaultPacketNumber?: string;
  vaultLocationId?: string;
  packetWitnessName?: string;
  collateral: CollateralInput[];
  notes?: string;
}

/** The same month-end rule people expect: the 31st of a 30-day month is its last day. */
function addMonths(iso: string, months: number): string {
  const start = new Date(`${iso}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(start.getUTCDate(), lastDay));
  return target.toISOString().slice(0, 10);
}
const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (from: string, to: string): number =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

/** Cash handed out or taken back today for one borrower, against whatever ceiling the shop set. */
async function checkCashLimit(
  tx: Tx, s: GirviSettings, kind: 'disbursal' | 'repayment', loanKey: { customerId: string | null; phone: string },
  amount: Decimal, date: string,
) {
  const limit = kind === 'disbursal' ? s.cashDisbursalLimit : s.cashRepaymentLimit;
  if (!limit || !(compare(amount, '0') > 0)) return;
  const row = kind === 'disbursal'
    ? await tx.one<{ total: Decimal }>(
        `select coalesce(sum(l.disbursed_amount), 0)::text as total
           from girvi_loan l join payment_method m on m.id = l.disbursal_method_id
          where m.kind = 'cash' and l.disbursed_at::date = $1
            and (($2::uuid is not null and l.customer_id = $2) or l.borrower_phone = $3)`,
        [date, loanKey.customerId, loanKey.phone])
    : await tx.one<{ total: Decimal }>(
        `select coalesce(sum(r.amount), 0)::text as total
           from girvi_repayment r join girvi_loan l on l.id = r.girvi_loan_id
           join payment_method m on m.id = r.payment_method_id
          where m.kind = 'cash' and r.paid_on = $1 and r.status = 'posted'
            and (($2::uuid is not null and l.customer_id = $2) or l.borrower_phone = $3)`,
        [date, loanKey.customerId, loanKey.phone]);
  if (compare(add(row.total, amount), String(limit)) > 0) {
    throw new BusinessRuleError(
      `${inr(row.total)} in cash has already passed ${kind === 'disbursal' ? 'to' : 'from'} this borrower today; with ${inr(amount)} more it goes over the ${inr(limit)} this shop allows. Use another payment mode.`,
      'cash_limit');
  }
}

/**
 * Gives the loan: values the gold, caps it at the shop's loan-to-value, seals
 * the packet and hands the money over. The money leaving is the shop's asset
 * moving from cash into a receivable — the gold is not bought and never enters
 * stock, because it still belongs to the borrower.
 */
export async function sanction(tx: Tx, input: SanctionInput) {
  const branchId = branchOf(tx);
  const s = await girviSettings(tx);
  const today = await businessDate(tx);
  const sanctionedOn = input.sanctionedOn ?? today;
  if (sanctionedOn > today) throw new ValidationError('A loan cannot be dated in the future.');
  if (!input.collateral?.length) throw new ValidationError('Add at least one article to lend against.');

  // Who is borrowing: a customer on file, or someone walking in.
  let customer: { id: string; name: string; phone: string | null } | null = null;
  if (input.customerId) {
    customer = await tx.maybeOne<{ id: string; name: string; phone: string | null }>(
      `select id, name, phone from party where id = $1 and is_customer and deleted_at is null`, [input.customerId]);
    if (!customer) throw new NotFoundError('That customer does not exist.');
  }
  const borrowerName = (input.borrowerName ?? customer?.name ?? '').trim();
  const borrowerPhone = (input.borrowerPhone ?? customer?.phone ?? '').trim();
  if (!borrowerName) throw new ValidationError('Say who is borrowing.');
  if (!borrowerPhone) throw new ValidationError('A mobile number is needed for the borrower.');

  const valued = await appraise(tx, s, input.collateral, sanctionedOn);

  // How much may be lent, and how much is being lent.
  const ltv = input.ltvPercent ?? String(valued.ltvPercent);
  if (compare(ltv, String(s.ltvCap)) > 0) {
    throw new BusinessRuleError(`This shop lends at most ${s.ltvCap}% of the value.`, 'ltv_above_cap');
  }
  const maxEligible = rs(div(mul(valued.appraised, ltv), '100'));
  const principal = rs(input.principalAmount);
  if (!(compare(principal, '0') > 0)) throw new ValidationError('Enter how much is being lent.');
  if (compare(principal, maxEligible) > 0) {
    throw new BusinessRuleError(
      `${inr(principal)} is more than the ${ltv}% that may be lent on ${inr(valued.appraised)} of gold, which is ${inr(maxEligible)}.`,
      'ltv_exceeded', { appraised: valued.appraised, maxEligible });
  }
  if (s.minLoan > 0 && compare(principal, String(s.minLoan)) < 0) {
    throw new BusinessRuleError(`This shop's smallest loan is ${inr(s.minLoan)}.`, 'below_minimum');
  }
  if (s.maxLoan > 0 && compare(principal, String(s.maxLoan)) > 0) {
    throw new BusinessRuleError(`This shop's largest loan is ${inr(s.maxLoan)}.`, 'above_maximum');
  }

  // Identity, where the shop insists on it.
  if (s.kycRequired && compare(principal, String(s.kycMinValue)) >= 0
    && !(input.borrowerIdType && input.borrowerIdNumber?.trim())) {
    throw new BusinessRuleError(
      s.kycMinValue > 0
        ? `Proof of identity is needed on a loan of ${inr(s.kycMinValue)} or more.`
        : 'Proof of identity is needed on every loan.',
      'identity_required');
  }
  if (s.borrowerPhoto && !input.borrowerPhotoKey) {
    throw new BusinessRuleError('This shop takes the borrower’s photograph on every loan.', 'photo_required');
  }
  if (s.articlePhoto && input.collateral.some((c) => !c.photoStorageKey)) {
    throw new BusinessRuleError('This shop photographs every article taken in.', 'article_photo_required');
  }
  if (s.witnessRequired && !input.packetWitnessName?.trim()) {
    throw new BusinessRuleError('Someone has to witness the packet being sealed.', 'witness_required');
  }

  // The rate the borrower was quoted, in the shop's own words, and as a % a month.
  const quoted = input.quotedRate ?? String(s.defaultRate);
  if (input.quotedRate !== undefined && !s.rateEditable && compare(input.quotedRate, String(s.defaultRate)) !== 0) {
    throw new BusinessRuleError(`This shop lends at ${s.defaultRate} only.`, 'rate_not_editable');
  }
  const rateMonthly = monthlyRate(quoted, s.rateBasis);

  // What the shop charges to set it up.
  const processing = s.feeBasis === 'percent' ? rs(div(mul(principal, String(s.feeValue)), '100')) : rs(String(s.feeValue));
  const appraisal = rs(String(s.appraisalFee));
  const charges = add(processing, appraisal);
  const disbursed = s.feeTaken === 'deducted' ? rs(sub(principal, charges)) : principal;
  if (compare(disbursed, '0') < 0) throw new BusinessRuleError('The charges come to more than the loan.', 'charges_exceed_loan');
  // Added to the loan means the borrower owes them back as well.
  const owed = s.feeTaken === 'added' ? add(principal, charges) : principal;

  const tenure = input.tenureMonths ?? s.tenureMonths;
  const dueDate = input.dueDate ?? (tenure > 0 ? addMonths(sanctionedOn, tenure) : null);

  const method = await paymentAccount(tx, input.disbursalMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) {
    throw new BusinessRuleError(`${method.name} cannot be used to hand out a loan.`, 'payment_method_invalid');
  }
  if (method.requires_reference && !input.disbursalReference?.trim()) {
    throw new BusinessRuleError(`${method.name} needs a reference (UTR, cheque number).`, 'reference_required');
  }
  if (method.kind === 'cash') {
    await checkCashLimit(tx, s, 'disbursal', { customerId: customer?.id ?? null, phone: borrowerPhone }, disbursed, sanctionedOn);
  }

  /*
   * Numbered on the day the loan is entered, not on a back-dated sanction date:
   * the counters reset each financial year, so a back-dated number would collide
   * with one already issued. A number belongs to the period it was issued in.
   */
  const [{ numbers: [loanNumber] }, packet] = await Promise.all([
    reserveDocumentNumbers(tx, 'girvi_loan', 1, { branchId, date: new Date(today) }),
    input.vaultPacketNumber?.trim()
      ? Promise.resolve({ numbers: [input.vaultPacketNumber.trim()] })
      : (s.packetRequired
          ? reserveDocumentNumbers(tx, 'girvi_packet', 1, { branchId, date: new Date(today) })
          : Promise.resolve({ numbers: [null] })),
  ]);

  const loan = await repo(tx, 'girvi_loan').insert({
    loan_number: loanNumber, status: 'active', branch_id: branchId, customer_id: customer?.id ?? null,
    borrower_name: borrowerName, borrower_phone: borrowerPhone, borrower_address: input.borrowerAddress ?? null,
    borrower_id_type: input.borrowerIdType ?? null, borrower_id_number: input.borrowerIdNumber?.trim() ?? null,
    borrower_photo_key: input.borrowerPhotoKey ?? null,
    sanctioned_on: sanctionedOn, due_date: dueDate,
    total_gross_weight: g3(sum(valued.lines.map((l) => l.grossWeight))),
    total_net_weight: g3(sum(valued.lines.map((l) => l.net))),
    total_fine_weight: g3(sum(valued.lines.map((l) => l.fine))),
    appraised_value: valued.appraised, ltv_percent: ltv, max_eligible_amount: maxEligible,
    principal_amount: owed, outstanding_amount: owed,
    // The terms, frozen as signed.
    interest_rate_monthly: rateMonthly, quoted_rate: quoted, quoted_rate_basis: s.rateBasis,
    interest_method: s.method, compound_months: s.compoundMonths, period_basis: s.periodBasis,
    minimum_months: String(s.minimumMonths), part_month: s.partMonth, grace_days: s.graceDays,
    penal_rate_monthly: monthlyRate(String(s.penalRate), s.rateBasis),
    allocation_order: s.allocation, overdue_grace_days: s.overdueGrace,
    processing_fee: processing, appraisal_fee: appraisal, fee_treatment: s.feeTaken,
    storage_per_month: String(s.storageFee),
    disbursed_amount: disbursed, disbursal_method_id: method.id,
    disbursal_reference: input.disbursalReference?.trim() ?? null, disbursed_at: new Date(),
    vault_packet_number: packet.numbers[0], vault_location_id: input.vaultLocationId ?? null,
    packet_sealed_at: packet.numbers[0] ? new Date() : null,
    packet_witness_name: input.packetWitnessName?.trim() ?? null,
    last_accrued_on: sanctionedOn, notes: input.notes ?? null,
  });

  await repo(tx, 'girvi_collateral').insertMany(valued.lines.map((l, i) => ({
    girvi_loan_id: loan.id, line_number: i + 1, description: l.description,
    item_category_id: l.itemCategoryId ?? null, metal_id: l.metalId, purity_id: l.purityId ?? null,
    quantity: l.quantity ?? 1, gross_weight: l.grossWeight, stone_weight: l.stoneWeight,
    net_weight: l.net, fine_weight: l.fine, tested_purity_percent: l.purityPercent,
    test_method: l.testMethod ?? 'xrf', appraised_value: l.value,
    condition_notes: l.conditionNotes ?? null, photo_storage_key: l.photoStorageKey ?? null,
  })));

  /*
   * The books. Money leaves the till and becomes a receivable; the shop is no
   * poorer for it. The gold is not bought, so no stock and no metal moves —
   * it is the borrower's, held as security.
   */
  const narration = `${loanNumber}, ${borrowerName}`;
  const money: MoneyEntry[] = [
    { accountCode: '1400', debit: owed, partyId: customer?.id ?? null, narration },
    { ...method.account, credit: disbursed, narration },
  ];
  if (compare(charges, '0') > 0 && s.feeTaken !== 'added') {
    // Deducted or collected separately, the charge is income the day the loan is made.
    money.push({ accountCode: '4310', credit: charges, narration: `Charges on ${loanNumber}` });
    if (s.feeTaken === 'separate') money.push({ ...method.account, debit: charges, narration });
  }
  if (s.feeTaken === 'added' && compare(charges, '0') > 0) {
    money.push({ accountCode: '4310', credit: charges, narration: `Charges on ${loanNumber}` });
  }

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'mortgage', voucherDate: sanctionedOn, branchId, sourceType: 'girvi_loan', sourceId: loan.id,
    narration, money,
  });
  await tx.query(`update girvi_loan set voucher_id = $2 where id = $1`, [loan.id, voucherId]);

  return { ...(await loanDetail(tx, loan.id)), printTicket: s.printTicket };
}

/* -------------------------------------------------------------- interest */

interface LoanRow {
  id: string; loan_number: string; status: string; branch_id: string; customer_id: string | null;
  borrower_name: string; borrower_phone: string; sanctioned_on: string; due_date: string | null;
  principal_amount: Decimal; outstanding_amount: Decimal;
  interest_rate_monthly: Decimal; penal_rate_monthly: Decimal; interest_method: 'simple' | 'compound';
  compound_months: number; period_basis: 'calendar' | 'thirty_days' | 'actual_days';
  minimum_months: Decimal; part_month: 'full' | 'pro_rata'; grace_days: number;
  allocation_order: 'penalty_interest_principal' | 'interest_penalty_principal' | 'principal_first';
  overdue_grace_days: number; storage_per_month: Decimal;
  interest_accrued: Decimal; interest_paid: Decimal; penalty_accrued: Decimal; penalty_paid: Decimal;
  principal_repaid: Decimal; last_accrued_on: string | null;
  vault_packet_number: string | null; appraised_value: Decimal; ltv_percent: Decimal;
  notice_count: number; last_notice_at: string | null;
}

async function loanFor(tx: Tx, id: string, lock = false): Promise<LoanRow> {
  const row = await tx.maybeOne<LoanRow>(
    `select * from girvi_loan where id = $1 ${lock ? 'for no key update' : ''}`, [id]);
  if (!row) throw new NotFoundError('That loan does not exist.');
  return row;
}

/** Where the next unwritten period starts and ends, by the loan's own rule. */
function nextPeriod(loan: LoanRow, from: string): { start: string; end: string } {
  const start = from;
  if (loan.period_basis === 'thirty_days') return { start, end: addDays(start, 30) };
  if (loan.period_basis === 'actual_days') return { start, end: addMonths(start, 1) };
  return { start, end: addMonths(start, 1) };
}

/**
 * Writes every interest period that has fallen due up to `upTo`, one row each,
 * and never touches a period already written. Running it twice changes nothing.
 *
 * Whether it also reaches the ledger is the shop's choice: a shop that books
 * interest as it is earned gets a voucher per period; one that books it when
 * the money arrives gets none until the borrower pays.
 */
export async function accrueInterest(tx: Tx, loanId: string, upTo?: string) {
  const s = await girviSettings(tx);
  const today = await businessDate(tx);
  const asAt = upTo ?? today;
  const loan = await loanFor(tx, loanId, true);
  if (!['active', 'overdue'].includes(loan.status)) return { written: 0, loan: await loanDetail(tx, loanId) };

  const begins = addDays(loan.sanctioned_on, loan.grace_days);
  let cursor = loan.last_accrued_on && loan.last_accrued_on > begins ? loan.last_accrued_on : begins;
  const written: { period_start: string; period_end: string; interest_amount: Decimal; kind: string }[] = [];

  // The balance interest is charged on. Compound means unpaid interest joins it.
  let base = sub(loan.principal_amount, loan.principal_repaid);
  if (loan.interest_method === 'compound') {
    const unpaid = sub(loan.interest_accrued, loan.interest_paid);
    if (compare(unpaid, '0') > 0) base = add(base, unpaid);
  }
  if (!(compare(base, '0') > 0)) return { written: 0, loan: await loanDetail(tx, loanId) };

  const existing = new Set((await tx.query<{ period_start: string; kind: string }>(
    `select period_start, kind from girvi_accrual where girvi_loan_id = $1`, [loanId]))
    .map((r) => `${r.period_start}|${r.kind}`));

  let guard = 0;
  while (cursor < asAt && guard++ < 480) {
    const period = nextPeriod(loan, cursor);
    if (period.end > asAt) break;                       // a part-period is not charged until it closes
    const days = daysBetween(period.start, period.end);
    const months = loan.period_basis === 'actual_days' ? div(String(days), '30') : '1';

    const charge = (kind: 'interest' | 'penal' | 'storage', rate: Decimal, amount?: Decimal) => {
      if (existing.has(`${period.start}|${kind}`)) return;
      const value = amount ?? rs(mul(base, div(mul(rate, months), '100')));
      if (!(compare(value, '0') > 0)) return;
      written.push({ period_start: period.start, period_end: period.end, interest_amount: value, kind });
    };

    charge('interest', loan.interest_rate_monthly);
    // The extra rate only applies to periods that start after the loan went overdue.
    if (loan.due_date && compare(loan.penal_rate_monthly, '0') > 0
      && period.start >= addDays(loan.due_date, loan.overdue_grace_days)) {
      charge('penal', loan.penal_rate_monthly);
    }
    if (compare(loan.storage_per_month, '0') > 0) charge('storage', '0', rs(mul(loan.storage_per_month, months)));

    cursor = period.end;
  }

  if (written.length) {
    await repo(tx, 'girvi_accrual').insertMany(written.map((w) => ({
      girvi_loan_id: loanId, period_start: w.period_start, period_end: w.period_end,
      principal_base: base, rate_monthly: w.kind === 'penal' ? loan.penal_rate_monthly : loan.interest_rate_monthly,
      days: daysBetween(w.period_start, w.period_end), interest_amount: w.interest_amount, kind: w.kind,
    })));

    // Interest earned but not yet received, where the shop books it that way.
    if (s.bookWhen === 'accrued') {
      const interest = sum(written.filter((w) => w.kind !== 'storage').map((w) => w.interest_amount));
      const storage = sum(written.filter((w) => w.kind === 'storage').map((w) => w.interest_amount));
      const narration = `Interest to ${cursor}, ${loan.loan_number}`;
      const money: MoneyEntry[] = [{ accountCode: '1410', debit: add(interest, storage), partyId: loan.customer_id, narration }];
      if (compare(interest, '0') > 0) money.push({ accountCode: '4300', credit: interest, narration });
      if (compare(storage, '0') > 0) money.push({ accountCode: '4310', credit: storage, narration });
      const { voucherId } = await postVoucher(tx, {
        voucherType: 'mortgage', voucherDate: cursor, branchId: loan.branch_id,
        sourceType: 'girvi_accrual', sourceId: loanId, narration, money,
      });
      await tx.query(
        `update girvi_accrual set voucher_id = $2 where girvi_loan_id = $1 and voucher_id is null`, [loanId, voucherId]);
    }
  }

  await refreshLoan(tx, loanId, cursor);
  return { written: written.length, loan: await loanDetail(tx, loanId) };
}

/** Runs the accrual over every loan that is still running. */
export async function accrueAll(tx: Tx, upTo?: string) {
  const loans = await tx.query<{ id: string }>(
    `select id from girvi_loan where status in ('active', 'overdue') order by sanctioned_on`);
  let written = 0;
  for (const l of loans) written += (await accrueInterest(tx, l.id, upTo)).written;
  return { loans: loans.length, written };
}

/**
 * Totals rebuilt from the rows that are the record — the accruals and the
 * repayments — rather than only added to as things happen, which drifts the
 * first time anything is cancelled or waived.
 */
export async function refreshLoan(tx: Tx, loanId: string, lastAccruedOn?: string) {
  const today = await businessDate(tx);
  const loan = await loanFor(tx, loanId);

  const charged = await tx.one<{ interest: Decimal; penal: Decimal; storage: Decimal }>(
    `select coalesce(sum(interest_amount) filter (where kind = 'interest' and not is_waived), 0)::text as interest,
            coalesce(sum(interest_amount) filter (where kind = 'penal' and not is_waived), 0)::text as penal,
            coalesce(sum(interest_amount) filter (where kind = 'storage' and not is_waived), 0)::text as storage
       from girvi_accrual where girvi_loan_id = $1`, [loanId]);
  const taken = await tx.one<{ interest: Decimal; principal: Decimal; penalty: Decimal; fee: Decimal }>(
    `select coalesce(sum(interest_component), 0)::text as interest,
            coalesce(sum(principal_component), 0)::text as principal,
            coalesce(sum(penalty_component), 0)::text as penalty,
            coalesce(sum(fee_component), 0)::text as fee
       from girvi_repayment where girvi_loan_id = $1 and status = 'posted'`, [loanId]);

  const interestAccrued = rs(add(charged.interest, charged.storage));
  const penaltyAccrued = rs(charged.penal);
  const principalLeft = rs(sub(loan.principal_amount, taken.principal));
  const outstanding = rs(add(principalLeft, add(sub(interestAccrued, taken.interest), sub(penaltyAccrued, taken.penalty))));

  // Overdue is a fact about the date, not something anyone sets by hand.
  let status = loan.status;
  if (['active', 'overdue'].includes(status)) {
    if (compare(outstanding, '0.01') <= 0) status = 'redeemed';
    else if (loan.due_date && today > addDays(loan.due_date, loan.overdue_grace_days)) status = 'overdue';
    else status = 'active';
  }

  await tx.query(
    `update girvi_loan
        set interest_accrued = $2, interest_paid = $3, penalty_accrued = $4, penalty_paid = $5,
            principal_repaid = $6, outstanding_amount = $7, status = $8,
            last_accrued_on = coalesce($9, last_accrued_on), updated_at = now()
      where id = $1`,
    [loanId, interestAccrued, taken.interest, penaltyAccrued, taken.penalty,
     taken.principal, outstanding, status, lastAccruedOn ?? null]);
}

/** Lets interest go — a goodwill call, kept with its reason. */
export async function waiveAccrual(tx: Tx, accrualId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('Say why this interest is being let go.');
  const row = await tx.maybeOne<{ girvi_loan_id: string; is_waived: boolean }>(
    `select girvi_loan_id, is_waived from girvi_accrual where id = $1`, [accrualId]);
  if (!row) throw new NotFoundError('That interest period does not exist.');
  if (row.is_waived) throw new BusinessRuleError('That period is already waived.', 'already_waived');
  await tx.query(
    `update girvi_accrual set is_waived = true, waive_reason = $2, updated_at = now() where id = $1`,
    [accrualId, reason.trim()]);
  await refreshLoan(tx, row.girvi_loan_id);
  return loanDetail(tx, row.girvi_loan_id);
}

/* ------------------------------------------------------------- repayment */

export interface RepayInput {
  amount: Decimal;
  paymentMethodId: string;
  reference?: string;
  paidOn?: string;
  /** Settles the whole loan today, charging whatever the shop asks for closing early. */
  foreclose?: boolean;
  notes?: string;
}

/** What a loan needs to clear it today, by the shop's own order of allocation. */
export async function settlementQuote(tx: Tx, loanId: string) {
  const s = await girviSettings(tx);
  const today = await businessDate(tx);
  await accrueInterest(tx, loanId, today);
  const loan = await loanFor(tx, loanId);

  const interestDue = rs(sub(loan.interest_accrued, loan.interest_paid));
  const penaltyDue = rs(sub(loan.penalty_accrued, loan.penalty_paid));
  const principalDue = rs(sub(loan.principal_amount, loan.principal_repaid));

  // A shop that charges a full month's interest however early it is redeemed.
  const monthsRun = Math.max(0, daysBetween(loan.sanctioned_on, today)) / 30;
  const shortfallMonths = Math.max(0, Number(loan.minimum_months) - monthsRun);
  const minimumTopUp = shortfallMonths > 0
    ? rs(mul(principalDue, div(mul(loan.interest_rate_monthly, String(round(String(shortfallMonths), 4))), '100')))
    : '0';

  const foreclosureFee = s.foreclosurePercent > 0 && loan.due_date && today < loan.due_date
    ? rs(div(mul(principalDue, String(s.foreclosurePercent)), '100')) : '0';

  const total = rs(add(add(principalDue, interestDue), add(penaltyDue, add(minimumTopUp, foreclosureFee))));
  return {
    loanId, asAt: today, principalDue, interestDue, penaltyDue,
    minimumInterestTopUp: minimumTopUp, foreclosureFee, totalToClear: total,
    allocationOrder: loan.allocation_order,
    canForeclose: s.allowForeclosure,
  };
}

/**
 * Money coming back. How it is applied is the shop's own rule, because shops
 * genuinely differ: most clear the penalty, then the interest, then the
 * principal, but some take the interest first and a few put everything against
 * the principal.
 */
export async function repay(tx: Tx, loanId: string, input: RepayInput) {
  const branchId = branchOf(tx);
  const s = await girviSettings(tx);
  const today = await businessDate(tx);
  const paidOn = input.paidOn ?? today;

  await accrueInterest(tx, loanId, paidOn);
  const loan = await loanFor(tx, loanId, true);
  if (!['active', 'overdue'].includes(loan.status)) {
    throw new BusinessRuleError(`${loan.loan_number} is ${loan.status}; nothing more can be taken on it.`, 'loan_not_active');
  }

  const amount = rs(input.amount);
  if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter how much is being paid.');
  if (s.minRepayment > 0 && compare(amount, String(s.minRepayment)) < 0 && !input.foreclose) {
    throw new BusinessRuleError(`The smallest payment this shop takes is ${inr(s.minRepayment)}.`, 'below_minimum');
  }

  const quote = await settlementQuote(tx, loanId);
  if (input.foreclose && !s.allowForeclosure) {
    throw new BusinessRuleError('This shop does not let a loan be closed early.', 'foreclosure_not_allowed');
  }
  const fees = input.foreclose ? rs(add(quote.minimumInterestTopUp, quote.foreclosureFee)) : '0';
  if (input.foreclose && compare(amount, quote.totalToClear) < 0) {
    throw new BusinessRuleError(
      `${loan.loan_number} needs ${inr(quote.totalToClear)} to close today; ${inr(amount)} was entered.`, 'short_of_settlement');
  }

  const interestDue = rs(sub(loan.interest_accrued, loan.interest_paid));
  const penaltyDue = rs(sub(loan.penalty_accrued, loan.penalty_paid));
  const principalDue = rs(sub(loan.principal_amount, loan.principal_repaid));

  // Split it the shop's way.
  let left = sub(amount, fees);
  const take = (due: Decimal): Decimal => {
    const part = compare(left, due) > 0 ? due : left;
    left = sub(left, part);
    return rs(part);
  };
  let toPenalty = '0';
  let toInterest = '0';
  let toPrincipal = '0';
  if (loan.allocation_order === 'principal_first') {
    toPrincipal = take(principalDue); toPenalty = take(penaltyDue); toInterest = take(interestDue);
  } else if (loan.allocation_order === 'interest_penalty_principal') {
    toInterest = take(interestDue); toPenalty = take(penaltyDue); toPrincipal = take(principalDue);
  } else {
    toPenalty = take(penaltyDue); toInterest = take(interestDue); toPrincipal = take(principalDue);
  }
  if (compare(left, '0.01') > 0) {
    throw new BusinessRuleError(
      `${inr(amount)} is more than the ${inr(quote.totalToClear)} owed on ${loan.loan_number}.`, 'overpayment');
  }
  if (!s.allowPartPrincipal && compare(toPrincipal, '0') > 0 && compare(toPrincipal, principalDue) < 0) {
    throw new BusinessRuleError(
      'This shop takes the principal in one go. Pay the interest now and the principal in full when the loan closes.',
      'part_principal_not_allowed');
  }
  if (!s.allowInterestOnly && isZero(toPrincipal) && compare(toInterest, '0') > 0 && compare(principalDue, '0') > 0) {
    throw new BusinessRuleError('This shop does not take interest-only payments.', 'interest_only_not_allowed');
  }

  const method = await paymentAccount(tx, input.paymentMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) {
    throw new BusinessRuleError(`${method.name} cannot be used to repay a loan.`, 'payment_method_invalid');
  }
  if (method.requires_reference && !input.reference?.trim()) {
    throw new BusinessRuleError(`${method.name} needs a reference (card slip, UTR, cheque number).`, 'reference_required');
  }
  if (method.max_amount && compare(amount, method.max_amount) > 0) {
    throw new BusinessRuleError(`${method.name} allows at most ${inr(method.max_amount)} at a time.`, 'payment_limit');
  }
  if (method.kind === 'cash') {
    await checkCashLimit(tx, s, 'repayment', { customerId: loan.customer_id, phone: loan.borrower_phone }, amount, paidOn);
  }

  const outstandingAfter = rs(sub(quote.totalToClear, amount));
  const { numbers: [receiptNumber] } = await reserveDocumentNumbers(tx, 'girvi_receipt', 1, { branchId, date: new Date(today) });

  const receipt = await repo(tx, 'girvi_repayment').insert({
    girvi_loan_id: loanId, receipt_number: receiptNumber, paid_on: paidOn, amount,
    interest_component: toInterest, principal_component: toPrincipal, penalty_component: toPenalty,
    fee_component: fees, payment_method_id: method.id, reference: input.reference?.trim() ?? null,
    collected_by: tx.context.userId, outstanding_after: outstandingAfter, notes: input.notes ?? null,
  });

  /*
   * The books. The money comes in; the principal part reduces what the borrower
   * owes, and the interest part either clears the receivable already booked or
   * becomes income now, depending on how the shop books interest.
   */
  const narration = `${receiptNumber}, ${loan.loan_number}, ${loan.borrower_name}`;
  const money: MoneyEntry[] = [{ ...method.account, debit: amount, narration }];
  if (compare(toPrincipal, '0') > 0) money.push({ accountCode: '1400', credit: toPrincipal, partyId: loan.customer_id, narration });
  const earned = add(toInterest, toPenalty);
  if (compare(earned, '0') > 0) {
    if (s.bookWhen === 'accrued') money.push({ accountCode: '1410', credit: earned, partyId: loan.customer_id, narration });
    else {
      if (compare(toInterest, '0') > 0) money.push({ accountCode: '4300', credit: toInterest, narration });
      if (compare(toPenalty, '0') > 0) money.push({ accountCode: '4310', credit: toPenalty, narration });
    }
  }
  if (compare(fees, '0') > 0) money.push({ accountCode: '4310', credit: fees, narration: `Closing charges on ${loan.loan_number}` });
  money.push(...modeCharges(await postingSettings(tx), method, amount, receiptNumber!));

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'mortgage', voucherDate: paidOn, branchId, sourceType: 'girvi_repayment', sourceId: receipt.id,
    narration, money,
  });
  await tx.query(`update girvi_repayment set voucher_id = $2 where id = $1`, [receipt.id, voucherId]);

  await refreshLoan(tx, loanId);
  const after = await loanFor(tx, loanId);
  return {
    receipt: { ...receipt, voucher_id: voucherId }, loan: await loanDetail(tx, loanId),
    cleared: after.status === 'redeemed', receiptNumber,
  };
}

/** Undoes a payment entered by mistake, with mirror entries. */
export async function cancelRepayment(tx: Tx, repaymentId: string, reason: string) {
  if (!reason?.trim()) throw new ValidationError('Say why the payment is being taken back.');
  const row = await tx.maybeOne<{ id: string; girvi_loan_id: string; status: string; voucher_id: string | null; loan_status: string }>(
    `select r.id, r.girvi_loan_id, r.status, r.voucher_id, l.status as loan_status
       from girvi_repayment r join girvi_loan l on l.id = r.girvi_loan_id
      where r.id = $1 for no key update of r`, [repaymentId]);
  if (!row) throw new NotFoundError('That payment does not exist.');
  if (row.status !== 'posted') throw new BusinessRuleError('That payment was already taken back.', 'already_cancelled');
  if (['auctioned'].includes(row.loan_status)) {
    throw new BusinessRuleError('This loan has been auctioned; its payments can no longer be changed.', 'loan_settled');
  }
  if (row.voucher_id) await reverseVoucher(tx, row.voucher_id, `Payment taken back: ${reason.trim()}`);
  await tx.query(
    `update girvi_repayment set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() where id = $1`,
    [repaymentId, reason.trim()]);
  // A loan that was closed by this payment is open again.
  await tx.query(
    `update girvi_loan set status = 'active', redeemed_at = null, updated_at = now()
      where id = $1 and status = 'redeemed'`, [row.girvi_loan_id]);
  await refreshLoan(tx, row.girvi_loan_id);
  return loanDetail(tx, row.girvi_loan_id);
}

/* ------------------------------------------------- release, default, auction */

/**
 * Giving the packet back. Only once nothing is owed — the gold is the security,
 * and handing it over with a balance outstanding leaves the shop with nothing.
 */
export async function releaseLoan(tx: Tx, loanId: string, input: { releasedToName?: string; notes?: string }) {
  const branchId = branchOf(tx);
  const today = await businessDate(tx);
  await accrueInterest(tx, loanId, today);
  const loan = await loanFor(tx, loanId, true);

  if (loan.status === 'auctioned') throw new BusinessRuleError('That collateral was auctioned.', 'already_auctioned');
  if (compare(loan.outstanding_amount, '0.01') > 0) {
    throw new BusinessRuleError(
      `${inr(loan.outstanding_amount)} is still owed on ${loan.loan_number}. Take it before the packet goes back.`,
      'balance_outstanding', { outstanding: loan.outstanding_amount });
  }
  const released = await tx.one<{ pending: number }>(
    `select count(*)::int as pending from girvi_collateral where girvi_loan_id = $1 and not is_released`, [loanId]);
  if (released.pending === 0) throw new BusinessRuleError('Everything on this loan has already gone back.', 'already_released');

  const { numbers: [releaseNumber] } = await reserveDocumentNumbers(tx, 'girvi_release', 1, { branchId, date: new Date(today) });
  await tx.query(
    `update girvi_collateral set is_released = true, released_at = now(), updated_at = now()
      where girvi_loan_id = $1 and not is_released`, [loanId]);
  await tx.query(
    `update girvi_loan
        set status = 'redeemed', redeemed_at = now(), release_receipt_number = $2, released_to_name = $3,
            packet_opened_at = now(), notes = coalesce($4, notes), updated_at = now()
      where id = $1`, [loanId, releaseNumber, input.releasedToName?.trim() ?? loan.borrower_name, input.notes ?? null]);

  // Nothing to post: the gold was never the shop's, and the money was settled by the repayments.
  return { ...(await loanDetail(tx, loanId)), releaseNumber };
}

/** Records that a notice has gone out, which is what makes an auction lawful later. */
export async function sendNotice(tx: Tx, loanId: string, input: { note?: string }) {
  const today = await businessDate(tx);
  const s = await girviSettings(tx);
  const loan = await loanFor(tx, loanId, true);
  if (!['active', 'overdue'].includes(loan.status)) {
    throw new BusinessRuleError(`${loan.loan_number} is ${loan.status}.`, 'loan_not_active');
  }
  if (!loan.due_date) throw new BusinessRuleError('This loan has no due date, so it cannot fall into default.', 'no_due_date');
  const overdueFrom = addDays(loan.due_date, loan.overdue_grace_days);
  if (today < addDays(overdueFrom, s.noticeAfterDays)) {
    throw new BusinessRuleError(
      `A notice is not due until ${addDays(overdueFrom, s.noticeAfterDays)}.`, 'notice_too_early');
  }
  const row = await tx.one<{ notice_count: number; last_notice_at: string | null }>(
    `select notice_count, last_notice_at from girvi_loan where id = $1`, [loanId]);
  if (row.last_notice_at && daysBetween(String(row.last_notice_at).slice(0, 10), today) < s.noticeGapDays) {
    throw new BusinessRuleError(`This shop leaves ${s.noticeGapDays} days between notices.`, 'notice_too_soon');
  }
  if (row.notice_count >= s.noticeCount) {
    throw new BusinessRuleError(`All ${s.noticeCount} notices have already gone out.`, 'notices_exhausted');
  }
  await tx.query(
    `update girvi_loan
        set notice_count = notice_count + 1, last_notice_at = now(),
            default_notice_sent_at = coalesce(default_notice_sent_at, now()),
            status = 'overdue', notes = coalesce($2, notes), updated_at = now()
      where id = $1`, [loanId, input.note ?? null]);
  return loanDetail(tx, loanId);
}

/**
 * Selling the collateral once every notice has gone out and the time allowed
 * has passed. What the sale fetches clears the debt; anything left over is the
 * borrower's money, not the shop's, unless the shop has set otherwise.
 */
export async function auctionLoan(
  tx: Tx, loanId: string,
  input: { proceeds: Decimal; auctionDate?: string; paymentMethodId?: string; notes?: string },
) {
  const branchId = branchOf(tx);
  const s = await girviSettings(tx);
  const today = await businessDate(tx);
  const auctionDate = input.auctionDate ?? today;
  await accrueInterest(tx, loanId, auctionDate);
  const loan = await loanFor(tx, loanId, true);

  if (loan.status === 'auctioned') throw new BusinessRuleError('That loan was already auctioned.', 'already_auctioned');
  if (compare(loan.outstanding_amount, '0.01') <= 0) {
    throw new BusinessRuleError('Nothing is owed on this loan, so the collateral goes back instead.', 'nothing_owed');
  }
  if (loan.notice_count < s.noticeCount) {
    throw new BusinessRuleError(
      `${s.noticeCount} notice(s) have to go out before an auction; ${loan.notice_count} have.`, 'notices_pending');
  }
  if (loan.last_notice_at && daysBetween(String(loan.last_notice_at).slice(0, 10), auctionDate) < s.auctionAfterDays) {
    throw new BusinessRuleError(
      `This shop waits ${s.auctionAfterDays} days after the last notice before an auction.`, 'auction_too_early');
  }

  const proceeds = rs(input.proceeds);
  if (!(compare(proceeds, '0') > 0)) throw new ValidationError('Enter what the collateral fetched.');

  const owed = rs(loan.outstanding_amount);
  const recovered = compare(proceeds, owed) > 0 ? owed : proceeds;
  const surplus = compare(proceeds, owed) > 0 ? rs(sub(proceeds, owed)) : '0';
  const shortfall = compare(owed, proceeds) > 0 ? rs(sub(owed, proceeds)) : '0';
  const returnSurplus = s.surplus === 'return' && compare(surplus, '0') > 0;

  const method = input.paymentMethodId ? await paymentAccount(tx, input.paymentMethodId, branchId) : null;
  const narration = `Auction of ${loan.loan_number}, ${loan.borrower_name}`;

  const principalLeft = rs(sub(loan.principal_amount, loan.principal_repaid));
  const interestLeft = rs(sub(loan.interest_accrued, loan.interest_paid));
  const penaltyLeft = rs(sub(loan.penalty_accrued, loan.penalty_paid));

  const money: MoneyEntry[] = [
    { ...(method?.account ?? { accountCode: '1000' }), debit: proceeds, narration },
  ];
  // What the sale recovers, cleared in the order the shop allocates payments.
  let left = recovered;
  const clear = (due: Decimal) => { const part = compare(left, due) > 0 ? due : left; left = sub(left, part); return rs(part); };
  const onPenalty = clear(penaltyLeft);
  const onInterest = clear(interestLeft);
  const onPrincipal = clear(principalLeft);
  if (compare(onPrincipal, '0') > 0) money.push({ accountCode: '1400', credit: onPrincipal, partyId: loan.customer_id, narration });
  if (compare(add(onInterest, onPenalty), '0') > 0) {
    if (s.bookWhen === 'accrued') money.push({ accountCode: '1410', credit: add(onInterest, onPenalty), partyId: loan.customer_id, narration });
    else {
      if (compare(onInterest, '0') > 0) money.push({ accountCode: '4300', credit: onInterest, narration });
      if (compare(onPenalty, '0') > 0) money.push({ accountCode: '4310', credit: onPenalty, narration });
    }
  }
  // Anything the sale did not cover is a loss the shop takes.
  if (compare(shortfall, '0') > 0) {
    money.push({ accountCode: '5900', debit: shortfall, narration: `Shortfall on ${loan.loan_number}` });
    const stillPrincipal = rs(sub(principalLeft, onPrincipal));
    if (compare(stillPrincipal, '0') > 0) money.push({ accountCode: '1400', credit: stillPrincipal, partyId: loan.customer_id, narration });
    const stillEarned = rs(sub(add(interestLeft, penaltyLeft), add(onInterest, onPenalty)));
    if (compare(stillEarned, '0') > 0 && s.bookWhen === 'accrued') {
      money.push({ accountCode: '1410', credit: stillEarned, partyId: loan.customer_id, narration });
    }
  }
  if (returnSurplus) {
    // Owed back to the borrower until it is handed over.
    money.push({ accountCode: '2400', credit: surplus, partyId: loan.customer_id, narration: `${narration} — surplus owed back` });
  } else if (compare(surplus, '0') > 0) {
    money.push({ accountCode: '4310', credit: surplus, narration: `${narration} — surplus kept` });
  }

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'mortgage', voucherDate: auctionDate, branchId, sourceType: 'girvi_loan', sourceId: loanId,
    narration, money,
  });

  await tx.query(`update girvi_collateral set is_released = true, released_at = now() where girvi_loan_id = $1`, [loanId]);
  await tx.query(
    `update girvi_loan
        set status = 'auctioned', auction_date = $2, auction_proceeds = $3, surplus_returned = $4,
            outstanding_amount = 0, packet_opened_at = now(), notes = coalesce($5, notes), updated_at = now()
      where id = $1`, [loanId, auctionDate, proceeds, returnSurplus ? surplus : '0', input.notes ?? null]);

  return {
    loan: await loanDetail(tx, loanId), proceeds, recovered, surplus, shortfall,
    surplusReturned: returnSurplus, voucherId,
  };
}

/* ------------------------------------------------------------------ reads */

/** One loan with its collateral, every interest period and every payment. */
export async function loanDetail(tx: Tx, loanId: string) {
  const loan = await tx.maybeOne<Record<string, unknown>>(
    `select l.*, b.name as branch_name, b.gstin as branch_gstin, b.address_line1 as branch_address,
            b.city as branch_city, b.phone as branch_phone,
            p.name as customer_name, p.code as customer_code,
            m.name as disbursal_method_name,
            loc.name as vault_location_name
       from girvi_loan l
       join branch b on b.id = l.branch_id
       left join party p on p.id = l.customer_id
       left join payment_method m on m.id = l.disbursal_method_id
       left join stock_location loc on loc.id = l.vault_location_id
      where l.id = $1`, [loanId]);
  if (!loan) throw new NotFoundError('That loan does not exist.');
  const [collateral, accruals, repayments] = await Promise.all([
    tx.query(
      `select c.*, me.name as metal_name, pu.code as purity_code
         from girvi_collateral c
         left join metal me on me.id = c.metal_id
         left join purity pu on pu.id = c.purity_id
        where c.girvi_loan_id = $1 order by c.line_number`, [loanId]),
    tx.query(
      `select * from girvi_accrual where girvi_loan_id = $1 order by period_start, kind`, [loanId]),
    tx.query(
      `select r.*, m.name as payment_method_name, u.full_name as collected_by_name
         from girvi_repayment r
         left join payment_method m on m.id = r.payment_method_id
         left join app_user u on u.id = r.collected_by
        where r.girvi_loan_id = $1 order by r.paid_on, r.created_at`, [loanId]),
  ]);
  return { ...loan, collateral, accruals, repayments };
}

/** Loans, filtered the way the screens need them. */
export async function loanList(
  tx: Tx,
  q: { status?: string; branchId?: string; customerId?: string; search?: string; overdueOnly?: boolean;
    dueBefore?: string; limit?: number; offset?: number },
) {
  const today = await businessDate(tx);
  const params: unknown[] = [];
  const where: string[] = [];
  if (q.status) { params.push(q.status); where.push(`l.status = $${params.length}`); }
  if (q.branchId) { params.push(q.branchId); where.push(`l.branch_id = $${params.length}`); }
  if (q.customerId) { params.push(q.customerId); where.push(`l.customer_id = $${params.length}`); }
  if (q.dueBefore) { params.push(q.dueBefore); where.push(`l.due_date <= $${params.length}`); }
  if (q.overdueOnly) { params.push(today); where.push(`l.due_date is not null and l.due_date < $${params.length} and l.status in ('active','overdue')`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(l.loan_number ilike $${params.length} or l.borrower_name ilike $${params.length}
      or l.borrower_phone ilike $${params.length} or l.vault_packet_number ilike $${params.length})`);
  }
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const [rows, counted] = await Promise.all([
    tx.query(
      `select l.*, b.name as branch_name, p.name as customer_name,
              case when l.due_date is null then null else l.due_date - $${params.length + 1}::date end as days_to_due
         from girvi_loan l join branch b on b.id = l.branch_id
         left join party p on p.id = l.customer_id
         ${clause} order by l.sanctioned_on desc nulls last, l.loan_number desc
         limit ${Math.min(Number(q.limit ?? 50), 200)} offset ${Number(q.offset ?? 0)}`, [...params, today]),
    tx.one<{ total: number }>(`select count(*)::int as total from girvi_loan l ${clause}`, params),
  ]);
  return { rows, total: counted.total };
}

/** Every packet the shop is holding, so anything can be found in the vault. */
export async function vaultRegister(tx: Tx, q: { branchId?: string; search?: string }) {
  const params: unknown[] = [];
  const where: string[] = [`l.status in ('active', 'overdue')`];
  if (q.branchId) { params.push(q.branchId); where.push(`l.branch_id = $${params.length}`); }
  if (q.search) {
    params.push(`%${q.search}%`);
    where.push(`(l.vault_packet_number ilike $${params.length} or l.borrower_name ilike $${params.length} or l.loan_number ilike $${params.length})`);
  }
  const rows = await tx.query(
    `select l.id, l.loan_number, l.vault_packet_number, l.borrower_name, l.borrower_phone,
            l.sanctioned_on, l.due_date, l.status, l.outstanding_amount,
            l.total_gross_weight, l.total_net_weight, l.total_fine_weight, l.appraised_value,
            l.packet_sealed_at, l.packet_witness_name, loc.name as vault_location_name,
            (select count(*) from girvi_collateral c where c.girvi_loan_id = l.id) as articles
       from girvi_loan l
       left join stock_location loc on loc.id = l.vault_location_id
      where ${where.join(' and ')}
      order by l.vault_packet_number nulls last`, params);
  return {
    rows,
    totals: {
      packets: rows.length,
      grossWeight: g3(sum(rows.map((r) => String((r as Record<string, unknown>).total_gross_weight)))),
      fineWeight: g3(sum(rows.map((r) => String((r as Record<string, unknown>).total_fine_weight)))),
      lentAgainst: rs(sum(rows.map((r) => String((r as Record<string, unknown>).outstanding_amount)))),
    },
  };
}

/** The lending book: what is out, what it is earning, and what is at risk. */
export async function portfolio(tx: Tx, branchId?: string) {
  const today = await businessDate(tx);
  const params: unknown[] = [today];
  let scope = '';
  if (branchId) { params.push(branchId); scope = ` and l.branch_id = $${params.length}`; }
  return tx.one<Record<string, string>>(
    `select count(*) filter (where l.status = 'active')::int as active_loans,
            count(*) filter (where l.status = 'overdue')::int as overdue_loans,
            count(*) filter (where l.status = 'redeemed')::int as redeemed_loans,
            count(*) filter (where l.status = 'auctioned')::int as auctioned_loans,
            coalesce(sum(l.principal_amount - l.principal_repaid) filter (where l.status in ('active','overdue')), 0)::text as principal_out,
            coalesce(sum(l.interest_accrued - l.interest_paid) filter (where l.status in ('active','overdue')), 0)::text as interest_due,
            coalesce(sum(l.outstanding_amount) filter (where l.status in ('active','overdue')), 0)::text as total_outstanding,
            coalesce(sum(l.appraised_value) filter (where l.status in ('active','overdue')), 0)::text as collateral_value,
            coalesce(sum(l.total_fine_weight) filter (where l.status in ('active','overdue')), 0)::text as fine_weight_held,
            coalesce(sum(l.outstanding_amount) filter (where l.status in ('active','overdue') and l.due_date < $1), 0)::text as overdue_amount
       from girvi_loan l where true${scope}`, params);
}
