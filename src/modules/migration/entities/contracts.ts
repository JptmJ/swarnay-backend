/**
 * Running accounts: scheme members part-way through their plan, and girvi
 * loans still out. These are what keep a shop tied to its old software — a
 * member who has paid seven months must walk in and find seven months paid —
 * so they are brought over as accounts that simply carry on.
 *
 * A scheme member becomes a real scheme account with its whole schedule: the
 * months already paid are marked paid (dated their due day), the rest fall due
 * as normal, and the bonus, maturity and missed-month rules work from there.
 * The money already collected is owed to the member, so it opens on Scheme
 * Liability (and grams on Scheme Metal Payable for weight plans).
 *
 * A girvi loan becomes a real loan: its articles in the vault register, its
 * outstanding principal on Girvi Loans Receivable, and its interest carrying on
 * from the day it was last paid up to — or, given the interest due on the
 * cut-over day, from that day with the arrears already charged.
 *
 * Neither goes through the screens' own "enrol" or "sanction" checks (fixed
 * amounts, loan-to-value caps, identity proof): those guard new business, and
 * these are facts that already happened. Where the old figures break a rule,
 * the row carries a warning instead.
 */
import { z } from 'zod';
import type { Tx } from '../../../core/db/client.js';
import { repo } from '../../../core/db/repository.js';
import { compare, div, isZero, mul, round, sub, sum, type Decimal } from '../../../core/util/decimal.js';
import { reserveDocumentNumbers } from '../../numbering/numbering.service.js';
import type { MetalEntry, MoneyEntry } from '../../accounts/ledger.service.js';
import { refreshAccount, schemeRate, schemeSettings } from '../../schemes/schemes.service.js';
import { appraise, girviSettings, monthlyRate, refreshLoan, type GirviSettings } from '../../girvi/girvi.service.js';
import type { PartyRow, PlanRow } from '../lookups.js';
import { PHONE_WORDS } from '../normalize.js';
import type { CommitResult, EntityDef, FieldDef, Issue, JobContext, LookupValue, PreparedRow } from '../types.js';
import { branchField, branchFor, bumpSeriesPast, postingHelp, postingOptions, postOpening, reverseImportVouchers, signed, undoneSuffix } from './shared.js';

const MIGRATED_NOTE = 'Brought over from the previous software.';

/** The same month-end rule the schemes use: the 31st of a 30-day month is its last day. */
function addMonths(iso: string, months: number, day: number): string {
  const start = new Date(`${iso}T00:00:00Z`);
  const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
/** Whole months from one date to another, counting a month only once its day has come round. */
function monthsBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
}

/** The customer a scheme or loan row names: code, then mobile with the name, then the name — made if allowed. */
async function customerFor(
  tx: Tx, v: Record<string, unknown>, ctx: JobContext, issues: Issue[], rowNumber: number, nameField: string, required: boolean,
): Promise<PartyRow | null> {
  const l = ctx.lookups;
  const named = v[nameField] as LookupValue | undefined;
  const code = v.customer_code as string | undefined;
  const phone = v.phone as string | undefined;
  if (code) {
    const hit = l.party({ text: code });
    if (hit.kind === 'found' && hit.row.code.toUpperCase() === code.toUpperCase()) return hit.row;
  }
  if (named) {
    const hit = l.party(named, { role: 'customer', phone });
    if (hit.kind === 'found') {
      if (!hit.row.is_customer) await l.addRole(tx, ctx, hit.row, 'customer');
      return hit.row;
    }
    if (hit.kind === 'ambiguous') {
      ctx.unknown(nameField, named.text, rowNumber);
      issues.push({ level: 'error', field: nameField, message: `"${named.text}" matches ${hit.count} customers: ${hit.names.join(', ')}. Add the customer code or mobile, or choose in the value panel.` });
      return null;
    }
    if (ctx.options.createMissingCustomers) {
      issues.push({ level: 'warning', message: `${named.text} is not in the customer book yet; a customer will be made.` });
      return l.createParty(tx, ctx, { name: named.text, phone, role: 'customer' });
    }
  }
  if (required || named || code) {
    ctx.unknown(nameField, named?.text ?? code ?? '', rowNumber);
    issues.push({ level: 'error', field: nameField, message: `Customer "${named?.text ?? code}" is not in the customer book. Import customers first, or allow missing customers to be made.` });
  }
  return null;
}

/* ======================================================= scheme accounts */

interface SchemePlanned {
  plan: PlanRow; customerId: string; branchId: string; number?: string; enrolledOn: string; dueDay: number; maturity: string;
  amount: Decimal; paidCount: number; totalPaid: Decimal; weight?: Decimal;
  nominee: { name?: string; relationship?: string; phone?: string };
}

export const schemeAccounts: EntityDef = {
  key: 'scheme_accounts', label: 'Scheme members', group: 'running', order: 130, posts: true, chunk: 100,
  description: 'Members part-way through a savings plan: who, which plan, when they joined, and what they have paid so far. Their passbook carries on — paid months show paid, the rest fall due — and the money already collected opens as owed to them.',
  needs: ['party', 'plan', 'branch'],
  requireOneOf: [
    { fields: ['customer', 'customer_code'], message: 'Give the member’s name or customer code.' },
  ],
  options: z.object({ ...postingOptions, createMissingCustomers: z.boolean().default(true) }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp,
    { key: 'createMissingCustomers', label: 'Make missing customers', description: 'A member who is not in the customer book is added to it (name and mobile). Off: such rows are refused.' }],
  fields: [
    { key: 'account_number', label: 'Account number', type: 'code', synonyms: ['account no', 'member no', 'scheme no', 'card no', 'passbook no', 'ac no', 'a c no', 'membership no', 'folio'],
      description: 'Kept, so members’ cards and passbooks still match. Blank takes the next number.' },
    { key: 'customer', label: 'Member name', type: 'lookup', lookup: 'party', synonyms: ['customer', 'member', 'member name', 'name', 'customer name', 'party name'], example: 'Sunita Shah' },
    { key: 'customer_code', label: 'Customer code', type: 'code', synonyms: ['customer code', 'party code', 'cust code', 'customer id'] },
    { key: 'phone', label: 'Mobile', type: 'phone', soft: true, synonyms: PHONE_WORDS },
    { key: 'plan', label: 'Plan', type: 'lookup', lookup: 'plan', required: true, synonyms: ['plan', 'scheme', 'scheme name', 'plan name', 'scheme code', 'plan code'], example: 'Swarna Nidhi 11+1' },
    { key: 'enrolled_on', label: 'Joined on', type: 'date', required: true, synonyms: ['joining date', 'start date', 'enrolment date', 'enrollment date', 'opening date', 'enrolled on', 'date of joining', 'doj', 'date'], example: '05/06/2026' },
    { key: 'installment_amount', label: 'Monthly amount', type: 'money', synonyms: ['installment', 'emi', 'monthly amount', 'installment amount', 'monthly'] },
    { key: 'installments_paid', label: 'Months paid', type: 'int', synonyms: ['paid installments', 'installments paid', 'months paid', 'no of installments paid', 'paid months', 'emi paid'] },
    { key: 'total_paid', label: 'Amount paid', type: 'money', synonyms: ['total paid', 'amount paid', 'deposit', 'collected', 'total deposit', 'paid amount', 'balance', 'total amount'] },
    { key: 'weight_accrued', label: 'Grams saved', type: 'weight', synonyms: ['grams', 'gold weight', 'weight', 'accumulated weight', 'gold accumulated', 'total weight'], description: 'For weight plans. Blank: worked out from the rate on each month’s due day.' },
    { key: 'due_day', label: 'Due day', type: 'int', min: 1, max: 31, synonyms: ['due day', 'due date day', 'installment day'] },
    { key: 'nominee_name', label: 'Nominee', type: 'text', synonyms: ['nominee', 'nominee name'] },
    { key: 'nominee_relationship', label: 'Nominee relation', type: 'text', synonyms: ['relation', 'relationship', 'nominee relation'] },
    { key: 'nominee_phone', label: 'Nominee mobile', type: 'phone', soft: true, synonyms: ['nominee mobile', 'nominee phone'] },
    branchField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<SchemePlanned>[] = [];
    const l = ctx.lookups;
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      const v = row.values;
      const label = `${v.account_number ? `${v.account_number} · ` : ''}${(v.customer as LookupValue | undefined)?.text ?? v.customer_code ?? ''}`;
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      const planHit = l.plan(v.plan as LookupValue);
      if (planHit.kind !== 'found') {
        ctx.unknown('plan', (v.plan as LookupValue).text, row.rowNumber);
        issues.push({ level: 'error', field: 'plan', message: `Plan "${(v.plan as LookupValue).text}" is not set up. Import savings plans first, or match it in the value panel.` });
        out.push({ row, action: 'insert', issues, label });
        continue;
      }
      const plan = planHit.row;
      if (!plan.is_active) issues.push({ level: 'warning', message: `${plan.name} is closed to new members; this existing member is brought over all the same.` });
      const enrolledOn = v.enrolled_on as string;
      if (enrolledOn > ctx.asOf) issues.push({ level: 'error', field: 'enrolled_on', message: `Joined on ${enrolledOn}, after the cut-over date ${ctx.asOf}.` });
      const amount = (v.installment_amount as Decimal | undefined) ?? plan.installment_amount ?? undefined;
      if (!amount || !(compare(amount, '0') > 0)) issues.push({ level: 'error', field: 'installment_amount', message: `${plan.name} has no fixed amount; give each member’s monthly amount.` });
      else if (!plan.is_flexible_amount && plan.installment_amount && compare(amount, plan.installment_amount) !== 0) {
        issues.push({ level: 'warning', field: 'installment_amount', message: `${plan.name} is ₹${plan.installment_amount} a month; this member pays ₹${amount}, which is kept.` });
      }

      // Months paid and money paid: either one gives the other.
      let paidCount = v.installments_paid as number | undefined;
      let totalPaid = v.total_paid as Decimal | undefined;
      if (amount && compare(amount, '0') > 0) {
        if (paidCount === undefined && totalPaid !== undefined) {
          paidCount = Number(div(totalPaid, amount).split('.')[0]);
          if (paidCount === 0 && compare(totalPaid, '0') > 0) paidCount = 1;
          const whole = mul(amount, String(paidCount));
          if (!plan.is_flexible_amount && compare(whole, totalPaid) !== 0) {
            issues.push({ level: 'warning', field: 'total_paid', message: `₹${totalPaid} is not a whole number of ₹${amount} months; taken as ${paidCount} month(s) totalling ₹${totalPaid}.` });
          }
        }
        paidCount ??= 0;
        totalPaid ??= mul(amount, String(paidCount));
      }
      paidCount ??= 0;
      totalPaid ??= '0';
      if (paidCount > plan.tenure_months) issues.push({ level: 'error', field: 'installments_paid', message: `${paidCount} months paid, but ${plan.name} runs ${plan.tenure_months} months.` });
      if (paidCount === 0) issues.push({ level: 'warning', message: 'Nothing paid yet; the account opens with every month due.' });
      const dueDay = Math.min((v.due_day as number | undefined) ?? Number(enrolledOn.slice(8, 10)), 28);
      const elapsed = monthsBetween(enrolledOn, ctx.asOf) + 1;
      if (paidCount > elapsed) issues.push({ level: 'warning', message: `${paidCount} months paid, ${elapsed} fallen due so far: paid ahead.` });
      let weight = v.weight_accrued as Decimal | undefined;
      if (plan.accrual_basis === 'weight' && weight === undefined && paidCount > 0) {
        issues.push({ level: 'warning', field: 'weight_accrued', message: 'No grams given for this weight plan; they will be worked out from the rate on each month’s due day.' });
      }
      if (plan.accrual_basis === 'rupee' && weight !== undefined) weight = undefined;

      const number = v.account_number as string | undefined;
      if (number) {
        const first = ctx.seen.get(`scheme:${number}`);
        if (first !== undefined && first !== row.rowNumber) issues.push({ level: 'error', field: 'account_number', message: `Account ${number} is also on row ${first}.` });
        else ctx.seen.set(`scheme:${number}`, row.rowNumber);
      }
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      const customer = await customerFor(tx, v, ctx, issues, row.rowNumber, 'customer', true);
      if (!branch || !customer || issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }
      ctx.total('members', '1'); ctx.total('amount_paid', totalPaid);
      if (weight) ctx.total('grams_saved', weight);
      out.push({
        row, action: 'insert', issues, label: `${number ? `${number} · ` : ''}${customer.name} · ${plan.name}`,
        plan: {
          plan, customerId: customer.id, branchId: branch.id, number, enrolledOn, dueDay,
          maturity: addMonths(enrolledOn, plan.tenure_months, dueDay), amount: amount!, paidCount, totalPaid, weight,
          nominee: { name: v.nominee_name as string | undefined, relationship: v.nominee_relationship as string | undefined, phone: v.nominee_phone as string | undefined },
        },
      });
    }
    // Account numbers the shop already uses.
    const numbers = out.flatMap((p) => (p.plan?.number ? [p.plan.number] : []));
    if (numbers.length) {
      const taken = new Set((await tx.query<{ account_number: string }>(
        `select account_number from scheme_account where upper(account_number) = any($1::text[])`, [numbers.map((n) => n.toUpperCase())])).map((r) => r.account_number.toUpperCase()));
      for (const p of out) if (p.plan?.number && taken.has(p.plan.number.toUpperCase())) p.issues.push({ level: 'error', field: 'account_number', message: `Account ${p.plan.number} already exists in this shop.` });
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const s = await schemeSettings(tx);
    const results: CommitResult[] = [];
    const byBranch = new Map<string, Array<{ row: PreparedRow; p: SchemePlanned }>>();
    for (const r of rows) {
      const p = r.plan as SchemePlanned;
      byBranch.set(p.branchId, [...(byBranch.get(p.branchId) ?? []), { row: r, p }]);
    }
    for (const [branchId, list] of byBranch) {
      tx.context.branchId = branchId;
      const fresh = list.filter((x) => !x.p.number);
      const { numbers } = fresh.length
        ? await reserveDocumentNumbers(tx, 'scheme_account', fresh.length, { branchId, date: new Date(`${ctx.today}T00:00:00`) })
        : { numbers: [] as string[] };
      fresh.forEach((x, i) => { x.p.number = numbers[i]; });

      const money: MoneyEntry[] = [];
      const metal: MetalEntry[] = [];
      const made: Array<{ rowId: string; accountId: string; paidIds: string[] }> = [];
      const narration = `Scheme deposits brought over — ${ctx.title}`;
      for (const { row, p } of list) {
        // Grams per paid month: the file's total shared out, or each month at its own due day's rate.
        const schedule = Array.from({ length: p.plan.tenure_months }, (_, i) => addMonths(p.enrolledOn, i, p.dueDay));
        const perMonth = round(div(p.totalPaid, String(Math.max(p.paidCount, 1))), 2);
        const amounts = Array.from({ length: p.paidCount }, (_, i) => (i === p.paidCount - 1 ? sub(p.totalPaid, mul(perMonth, String(p.paidCount - 1))) : perMonth));
        let grams: Decimal[] = [];
        let rates: Array<Decimal | null> = amounts.map(() => null);
        let purityId = p.plan.purity_id;
        if (p.plan.accrual_basis === 'weight' && p.paidCount > 0) {
          if (p.weight !== undefined) {
            const each = round(div(p.weight, String(p.paidCount)), 3);
            grams = amounts.map((_, i) => (i === p.paidCount - 1 ? sub(p.weight!, mul(each, String(p.paidCount - 1))) : each));
          } else {
            try {
              const priced = await Promise.all(amounts.map((_, i) => schemeRate(tx, p.plan.metal_id, p.plan.purity_id, s.rateSource, schedule[i]! < ctx.asOf ? schedule[i]! : ctx.asOf)));
              rates = priced.map((x) => x.ratePerGram);
              purityId = priced[0]?.purityId ?? purityId;
              grams = amounts.map((a, i) => round(div(a, priced[i]!.ratePerGram), 3));
            } catch (error) {
              results.push({ rowId: row.row.id, ok: false, issues: [{ level: 'error', message: `${(error as Error).message} The grams this member has saved cannot be worked out — give them in the file.` }] });
              continue;
            }
          }
        }
        const account = await repo<{ id: string }>(tx, 'scheme_account').insert({
          account_number: p.number, scheme_plan_id: p.plan.id, customer_id: p.customerId, branch_id: branchId,
          enrolled_on: p.enrolledOn, maturity_date: p.maturity, due_day: p.dueDay, installment_amount: p.amount,
          installments_due: p.plan.tenure_months,
          // The plan's terms, frozen as they stand: the member signed up to these.
          accrual_basis: p.plan.accrual_basis, purity_id: p.plan.purity_id,
          bonus_installments: p.plan.bonus_installments, bonus_percent: p.plan.bonus_percent,
          making_charge_discount_percent: p.plan.making_charge_discount_percent,
          max_missed_installments: p.plan.max_missed_installments, grace_period_days: p.plan.grace_period_days,
          is_flexible_amount: p.plan.is_flexible_amount, minimum_installment: p.plan.minimum_installment,
          nominee_name: p.nominee.name ?? null, nominee_relationship: p.nominee.relationship ?? null, nominee_phone: p.nominee.phone ?? null,
        });
        const installments = await repo<{ id: string; status: string }>(tx, 'scheme_installment').insertMany(schedule.map((due, i) => {
          const paid = i < p.paidCount;
          return {
            scheme_account_id: account.id, installment_number: i + 1, due_date: due, amount_due: p.amount,
            status: paid ? 'paid' : 'due',
            amount_paid: paid ? amounts[i] : '0', paid_on: paid ? (due < ctx.asOf ? due : ctx.asOf) : null,
            weight_accrued: paid ? grams[i] ?? '0' : '0', rate_per_gram: paid ? rates[i] ?? null : null,
            purity_id: paid && grams.length ? purityId : null, notes: paid ? MIGRATED_NOTE : null,
          };
        }));
        if (compare(p.totalPaid, '0') > 0) money.push(signed('2300', sub('0', p.totalPaid), narration, p.customerId));
        const totalGrams = grams.length ? sum(grams) : '0';
        if (compare(totalGrams, '0') > 0) metal.push({ accountCode: '2310', partyId: p.customerId, metalId: p.plan.metal_id, purityId, weightIn: totalGrams, narration });
        made.push({ rowId: row.row.id, accountId: account.id, paidIds: installments.filter((x) => x.status === 'paid').map((x) => x.id) });
      }
      const voucherId = await postOpening(tx, ctx, { branchId, narration, money, metal });
      if (voucherId) {
        await tx.query(`update scheme_installment set voucher_id = $2 where id = any($1::uuid[])`, [made.flatMap((m) => m.paidIds), voucherId]);
      }
      for (const m of made) {
        await refreshAccount(tx, m.accountId);
        results.push({ rowId: m.rowId, ok: true, action: 'insert', targetTable: 'scheme_account', targetId: m.accountId });
      }
    }
    tx.context.branchId = null;
    return results;
  },

  async finish(tx, ctx) {
    const numbers = await tx.query<{ account_number: string }>(
      `select a.account_number from import_row r join scheme_account a on a.id = r.target_id where r.batch_id = $1 and r.status = 'imported'`, [ctx.batchId]);
    const note = await bumpSeriesPast(tx, 'scheme_account', numbers.map((n) => n.account_number));
    return note ? [note] : [];
  },

  async canUndo(tx, rows, { batchId }) {
    const ids = rows.flatMap((r) => (r.target_id ? [r.target_id] : []));
    const used = await tx.query<{ account_number: string }>(
      `select a.account_number from scheme_account a
        where a.id = any($1::uuid[])
          and (a.status in ('redeemed', 'closed')
               or exists (select 1 from scheme_redemption x where x.scheme_account_id = a.id)
               or exists (select 1 from scheme_installment i where i.scheme_account_id = a.id and i.status = 'paid'
                           and (i.voucher_id is null or i.voucher_id not in (select id from voucher where source_type = 'data_import' and source_id = $2))))
        limit 6`, [ids, batchId]);
    if (!used.length) return null;
    return `Members have paid, redeemed or closed since the import (${used.slice(0, 5).map((u) => u.account_number).join(', ')}${used.length > 5 ? '…' : ''}). Cancel those collections first.`;
  },

  async undo(tx, rows, { batchId, reason }) {
    const ids = rows.flatMap((r) => (r.target_id ? [r.target_id] : []));
    await tx.query(
      `update scheme_account set status = 'cancelled', closed_at = now(), close_reason = $2, account_number = account_number || $3, updated_at = now()
        where id = any($1::uuid[])`, [ids, `Import undone: ${reason}`, undoneSuffix(batchId)]);
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};

/* ============================================================ girvi loans */

interface LoanHead {
  kind: 'loan';
  number?: string; customerId: string | null; borrowerName: string; phone: string; address?: string;
  idType?: string; idNumber?: string; sanctionedOn: string; dueDate?: string; principal: Decimal; original?: Decimal;
  quotedRate?: Decimal; rateBasis?: 'per_month' | 'per_year' | 'per_hundred'; paidUntil?: string; interestDue: Decimal;
  packet?: string; branchId: string; notes?: string; article: Article;
}
interface Article {
  description: string; metalId: string; purityId: string | null; fineness: Decimal | null; quantity: number;
  gross: Decimal; stone: Decimal; value?: Decimal;
}
interface ArticleOnly { kind: 'article'; loanKey: string; article: Article }
type LoanPlanned = LoanHead | ArticleOnly;

export const girviLoans: EntityDef = {
  key: 'girvi_loans', label: 'Girvi loans', group: 'running', order: 140, posts: true, chunk: 100,
  description: 'Loans still out on the cut-over day: borrower, articles held, principal outstanding, rate, and how far interest is paid. A loan with several articles can take one row per article under the same loan number.',
  // Borrower, date and principal are asked of a loan's first row only: further rows of the same loan carry just an article.
  needs: ['party', 'metal', 'purity', 'branch'],
  options: z.object({
    ...postingOptions, createMissingCustomers: z.boolean().default(true),
    rateBasis: z.enum(['per_month', 'per_year', 'per_hundred']).optional(),
  }) as unknown as z.ZodType<Record<string, unknown>>,
  optionHelp: [...postingHelp,
    { key: 'createMissingCustomers', label: 'Make missing customers', description: 'A borrower not in the customer book is added (name and mobile). Off: the loan is kept against the borrower’s name only.' },
    { key: 'rateBasis', label: 'Rates in the file are', description: 'per_month (2 = 2% a month), per_year (24 = 24% a year) or per_hundred (₹2 per ₹100 a month). Blank: as the shop quotes them in Girvi settings.' }],
  fields: [
    { key: 'loan_number', label: 'Loan number', type: 'code', synonyms: ['loan no', 'girvi no', 'ticket no', 'pawn no', 'bill no', 'receipt no', 'loan number', 'gl no', 'account no'],
      description: 'Kept, so the borrower’s pawn ticket still matches. Rows with the same number are one loan with several articles.' },
    { key: 'borrower', label: 'Borrower', type: 'lookup', lookup: 'party', synonyms: ['borrower', 'name', 'customer', 'customer name', 'party', 'party name', 'borrower name'], example: 'Rajesh Kumar' },
    { key: 'customer_code', label: 'Customer code', type: 'code', synonyms: ['customer code', 'party code', 'cust code'] },
    { key: 'phone', label: 'Mobile', type: 'phone', soft: true, synonyms: PHONE_WORDS },
    { key: 'address', label: 'Address', type: 'text', synonyms: ['address', 'addr'] },
    { key: 'id_type', label: 'ID proof', type: 'enum', soft: true, synonyms: ['id type', 'id proof', 'kyc type', 'proof'],
      options: [
        { value: 'aadhaar', label: 'Aadhaar', synonyms: ['aadhar', 'uid', 'adhar'] },
        { value: 'pan', label: 'PAN', synonyms: ['pan card'] },
        { value: 'voter', label: 'Voter ID', synonyms: ['voter', 'epic', 'election card'] },
        { value: 'driving_licence', label: 'Driving licence', synonyms: ['dl', 'driving license', 'licence', 'license'] },
        { value: 'passport', label: 'Passport', synonyms: [] },
      ] },
    { key: 'id_number', label: 'ID number', type: 'text', synonyms: ['id no', 'id number', 'proof no', 'kyc no', 'aadhaar no'] },
    { key: 'sanctioned_on', label: 'Loan date', type: 'date', synonyms: ['loan date', 'date', 'girvi date', 'start date', 'sanction date', 'pawn date', 'issue date'], example: '15/02/2026' },
    { key: 'due_date', label: 'Due date', type: 'date', synonyms: ['due date', 'maturity', 'maturity date', 'expiry', 'expiry date'] },
    { key: 'principal', label: 'Principal outstanding', type: 'money', synonyms: ['principal', 'loan amount', 'amount', 'outstanding principal', 'balance principal', 'principal balance', 'outstanding', 'balance'], example: '75000' },
    { key: 'original_principal', label: 'Amount first lent', type: 'money', synonyms: ['original amount', 'sanctioned amount', 'loan given', 'disbursed'] },
    { key: 'interest_rate', label: 'Interest rate', type: 'decimal', synonyms: ['rate', 'interest', 'interest rate', 'roi', 'int rate', 'rate of interest'], example: '1.5' },
    { key: 'rate_basis', label: 'Rate is', type: 'enum', synonyms: ['rate basis', 'rate type', 'interest type'],
      options: [
        { value: 'per_month', label: '% a month', synonyms: ['monthly', 'pm', 'p m', 'per month', 'month'] },
        { value: 'per_year', label: '% a year', synonyms: ['yearly', 'annual', 'pa', 'p a', 'per annum', 'per year', 'year'] },
        { value: 'per_hundred', label: '₹ per ₹100 a month', synonyms: ['per hundred', 'per 100', 'rupee per hundred'] },
      ] },
    { key: 'interest_paid_until', label: 'Interest paid up to', type: 'date', synonyms: ['interest paid upto', 'interest paid till', 'last interest date', 'int paid till', 'paid upto', 'interest upto'] },
    { key: 'interest_due', label: 'Interest due', type: 'money', synonyms: ['interest due', 'pending interest', 'outstanding interest', 'interest outstanding', 'unpaid interest', 'accrued interest'] },
    { key: 'packet_number', label: 'Packet number', type: 'text', synonyms: ['packet', 'packet no', 'bag no', 'pouch no', 'locker no', 'vault no'] },
    { key: 'item_description', label: 'Article', type: 'text', required: true, synonyms: ['item', 'article', 'ornament', 'description', 'item description', 'items', 'particulars', 'jewellery'], example: 'Gold bangles (pair)' },
    { key: 'metal', label: 'Metal', type: 'lookup', lookup: 'metal', synonyms: ['metal'] },
    { key: 'purity', label: 'Purity', type: 'lookup', lookup: 'purity', synonyms: ['purity', 'karat', 'touch', 'tunch'] },
    { key: 'quantity', label: 'Pieces', type: 'int', min: 1, synonyms: ['qty', 'quantity', 'pcs', 'nos', 'pieces'] },
    { key: 'gross_weight', label: 'Gross weight', type: 'weight', required: true, synonyms: ['gross', 'gross wt', 'weight', 'wt', 'gr wt'], example: '24.500' },
    { key: 'stone_weight', label: 'Stone weight', type: 'weight', synonyms: ['stone', 'stone wt', 'less', 'less wt'] },
    { key: 'appraised_value', label: 'Value', type: 'money', synonyms: ['value', 'appraised value', 'valuation', 'market value', 'item value'] },
    { key: 'notes', label: 'Notes', type: 'text', synonyms: ['remarks', 'remark', 'narration'] },
    branchField,
  ],

  async prepare(tx, rows, ctx) {
    const out: PreparedRow<LoanPlanned>[] = [];
    const l = ctx.lookups;
    const s = (ctx.memo.get('girviSettings') as GirviSettings | undefined) ?? await girviSettings(tx);
    ctx.memo.set('girviSettings', s);
    for (const row of rows) {
      const issues: Issue[] = [...row.issues];
      const v = row.values;
      const number = v.loan_number as string | undefined;
      const label = `${number ? `${number} · ` : ''}${(v.borrower as LookupValue | undefined)?.text ?? v.customer_code ?? ''}`;
      if (issues.some((i) => i.level === 'error')) { out.push({ row, action: 'insert', issues, label }); continue; }

      // The article this row carries.
      let metalId = l.metals.find((m) => m.code === 'GOLD')?.id ?? l.metals[0]?.id;
      if (v.metal) {
        const m = l.metal(v.metal as LookupValue);
        if (m.kind === 'found') metalId = m.row.id;
        else { ctx.unknown('metal', (v.metal as LookupValue).text, row.rowNumber); issues.push({ level: 'error', field: 'metal', message: `Metal "${(v.metal as LookupValue).text}" is not one this shop deals in.` }); }
      }
      let purityId: string | null = null;
      let fineness: Decimal | null = null;
      if (v.purity) {
        const p = l.purity(v.purity as LookupValue, metalId);
        if (p.kind === 'found') { purityId = p.row.id; fineness = p.row.fineness; metalId = p.row.metal_id; }
        else { ctx.unknown('purity', (v.purity as LookupValue).text, row.rowNumber); issues.push({ level: 'error', field: 'purity', message: `Purity "${(v.purity as LookupValue).text}" is not set up.` }); }
      }
      const gross = v.gross_weight as Decimal;
      const stone = (v.stone_weight as Decimal | undefined) ?? '0';
      if (!(compare(gross, '0') > 0)) issues.push({ level: 'error', field: 'gross_weight', message: 'Gross weight must be more than 0 g.' });
      if (compare(stone, gross) > 0) issues.push({ level: 'error', field: 'stone_weight', message: 'The stones weigh more than the article.' });
      if (!purityId) issues.push({ level: 'warning', field: 'purity', message: 'No purity given; the article is valued as the shop’s default purity for its metal, or not at all.' });
      const article: Article = {
        description: String(v.item_description), metalId: metalId!, purityId, fineness, quantity: (v.quantity as number | undefined) ?? 1,
        gross, stone, value: v.appraised_value as Decimal | undefined,
      };

      // A second row of a loan already seen is one more article for it.
      const key = number ? `loan:${number.toUpperCase()}` : null;
      const head = key ? ctx.seen.get(key) : undefined;
      if (key && head !== undefined && head !== row.rowNumber) {
        if (ctx.memo.get(`${key}:bad`)) issues.push({ level: 'error', message: `The first row of loan ${number} (row ${head}) has errors, so this article cannot be added.` });
        out.push({ row, action: 'insert', issues, label: `${number} · article: ${article.description}`, plan: { kind: 'article', loanKey: key, article } });
        if (!issues.some((i) => i.level === 'error')) ctx.total('gross_weight', gross);
        continue;
      }
      if (key) ctx.seen.set(key, row.rowNumber);

      if (!v.borrower && !v.customer_code) issues.push({ level: 'error', field: 'borrower', message: 'Give the borrower’s name or customer code.' });
      const principal = v.principal as Decimal | undefined;
      if (!principal || !(compare(principal, '0') > 0)) issues.push({ level: 'error', field: 'principal', message: 'Give the principal still outstanding (more than ₹0). A loan fully repaid does not need bringing over.' });
      const sanctionedOn = (v.sanctioned_on as string | undefined) ?? '';
      if (!sanctionedOn) issues.push({ level: 'error', field: 'sanctioned_on', message: 'Loan date is missing.' });
      else if (sanctionedOn > ctx.asOf) issues.push({ level: 'error', field: 'sanctioned_on', message: `Lent on ${sanctionedOn}, after the cut-over date ${ctx.asOf}.` });
      const paidUntil = v.interest_paid_until as string | undefined;
      if (paidUntil && (paidUntil < sanctionedOn || paidUntil > ctx.asOf)) {
        issues.push({ level: 'error', field: 'interest_paid_until', message: `Interest paid up to ${paidUntil} is outside the loan’s life (${sanctionedOn} to ${ctx.asOf}).` });
      }
      const interestDue = (v.interest_due as Decimal | undefined) ?? '0';
      if (!paidUntil && isZero(interestDue)) {
        issues.push({ level: 'warning', message: `Neither the interest due nor the date it is paid up to is given: interest is taken as settled up to ${ctx.asOf}.` });
      }
      const branch = branchFor(v, ctx, issues, row.rowNumber);
      const customer = await customerFor(tx, v, ctx, issues, row.rowNumber, 'borrower', false);
      const borrowerName = customer?.name ?? (v.borrower as LookupValue | undefined)?.text ?? '';
      const phone = (v.phone as string | undefined) ?? customer?.phone ?? undefined;
      if (!phone) issues.push({ level: 'error', field: 'phone', message: 'A mobile number is needed for every borrower.' });
      if (!borrowerName) issues.push({ level: 'error', field: 'borrower', message: 'Say who the borrower is.' });
      const quoted = v.interest_rate as Decimal | undefined;
      if (!quoted) issues.push({ level: 'warning', field: 'interest_rate', message: `No rate given; the shop’s rate of ${s.defaultRate} is used.` });

      const bad = !branch || issues.some((i) => i.level === 'error');
      if (key) ctx.memo.set(`${key}:bad`, bad);
      if (bad) { out.push({ row, action: 'insert', issues, label }); continue; }
      ctx.total('loans', '1'); ctx.total('principal', principal!); ctx.total('gross_weight', gross);
      if (!isZero(interestDue)) ctx.total('interest_due', interestDue);
      out.push({
        row, action: 'insert', issues, label: `${number ? `${number} · ` : ''}${borrowerName} · ₹${principal}`,
        plan: {
          kind: 'loan', number, customerId: customer?.id ?? null, borrowerName, phone: phone!, address: v.address as string | undefined,
          idType: v.id_type as string | undefined, idNumber: v.id_number as string | undefined, sanctionedOn,
          dueDate: v.due_date as string | undefined, principal: principal!, original: v.original_principal as Decimal | undefined,
          quotedRate: quoted, rateBasis: v.rate_basis as LoanHead['rateBasis'], paidUntil, interestDue,
          packet: v.packet_number as string | undefined, branchId: branch!.id, notes: v.notes as string | undefined, article,
        },
      });
    }
    const numbers = out.flatMap((p) => (p.plan && p.plan.kind === 'loan' && p.plan.number ? [p.plan.number] : []));
    if (numbers.length) {
      const taken = new Set((await tx.query<{ loan_number: string }>(
        `select loan_number from girvi_loan where upper(loan_number) = any($1::text[])`, [numbers.map((n) => n.toUpperCase())])).map((r) => r.loan_number.toUpperCase()));
      for (const p of out) {
        if (p.plan?.kind === 'loan' && p.plan.number && taken.has(p.plan.number.toUpperCase())) {
          p.issues.push({ level: 'error', field: 'loan_number', message: `Loan ${p.plan.number} already exists in this shop.` });
        }
      }
    }
    return out;
  },

  async commit(tx, rows, ctx) {
    const s = (ctx.memo.get('girviSettings') as GirviSettings | undefined) ?? await girviSettings(tx);
    const results: CommitResult[] = [];
    const byBranch = new Map<string, MoneyEntry[]>();
    const narration = `Girvi loans brought over — ${ctx.title}`;
    const loans: string[] = [];

    /** Values an article at the rate of its loan's day; without a rate it is recorded unvalued. */
    const valueOf = async (a: Article, onDate: string, branchId: string): Promise<{ net: Decimal; fine: Decimal; value: Decimal; note?: string }> => {
      const net = round(sub(a.gross, a.stone), 3);
      const fine = a.fineness ? round(div(mul(net, a.fineness), '100'), 3) : net;
      if (a.value) return { net, fine, value: a.value };
      tx.context.branchId = branchId;
      await tx.query('savepoint girvi_value');
      try {
        const v = await appraise(tx, s, [{ metalId: a.metalId, purityId: a.purityId, grossWeight: a.gross, stoneWeight: a.stone }], onDate);
        await tx.query('release savepoint girvi_value');
        return { net, fine: v.lines[0]!.fine, value: v.appraised };
      } catch (error) {
        await tx.query('rollback to savepoint girvi_value');
        return { net, fine, value: '0', note: `Not valued: ${(error as Error).message}` };
      }
    };

    for (const r of rows) {
      const p = r.plan as LoanPlanned;
      if (p.kind === 'article') {
        const loanId = ctx.memo.get(p.loanKey) as string | undefined;
        if (!loanId) { results.push({ rowId: r.row.id, ok: false, issues: [{ level: 'error', message: 'Its loan was not brought over, so the article cannot be added.' }] }); continue; }
        const loan = await tx.one<{ sanctioned_on: string; branch_id: string; lines: number }>(
          `select l.sanctioned_on::text, l.branch_id, (select count(*)::int from girvi_collateral c where c.girvi_loan_id = l.id) as lines
             from girvi_loan l where l.id = $1`, [loanId]);
        const v = await valueOf(p.article, loan.sanctioned_on, loan.branch_id);
        await repo(tx, 'girvi_collateral').insert({
          girvi_loan_id: loanId, line_number: loan.lines + 1, description: p.article.description, metal_id: p.article.metalId,
          purity_id: p.article.purityId, quantity: p.article.quantity, gross_weight: p.article.gross, stone_weight: p.article.stone,
          net_weight: v.net, fine_weight: v.fine, tested_purity_percent: p.article.fineness, test_method: 'declared', appraised_value: v.value,
        });
        await tx.query(
          `update girvi_loan set total_gross_weight = total_gross_weight + $2, total_net_weight = total_net_weight + $3,
                  total_fine_weight = total_fine_weight + $4, appraised_value = appraised_value + $5, updated_at = now() where id = $1`,
          [loanId, p.article.gross, v.net, v.fine, v.value]);
        results.push({ rowId: r.row.id, ok: true, action: 'insert', targetTable: 'girvi_collateral', targetId: loanId,
          issues: v.note ? [{ level: 'warning', message: v.note }] : undefined });
        continue;
      }

      tx.context.branchId = p.branchId;
      const basis = p.rateBasis ?? (ctx.options.rateBasis as LoanHead['rateBasis']) ?? s.rateBasis;
      const quoted = p.quotedRate ?? String(s.defaultRate);
      const number = p.number ?? (await reserveDocumentNumbers(tx, 'girvi_loan', 1, { branchId: p.branchId, date: new Date(`${ctx.today}T00:00:00`) })).numbers[0]!;
      const v = await valueOf(p.article, p.sanctionedOn, p.branchId);
      const issues: Issue[] = v.note ? [{ level: 'warning', message: v.note }] : [];
      if (compare(v.value, '0') > 0 && compare(p.principal, div(mul(v.value, String(s.ltvCap)), '100')) > 0) {
        issues.push({ level: 'warning', message: `₹${p.principal} is more than the ${s.ltvCap}% the shop now lends on ₹${v.value} of gold. Brought over as it stands.` });
      }
      // Interest carries on from the day it is paid up to — or, with arrears given, from the cut-over day.
      const lastAccrued = !isZero(p.interestDue) ? ctx.asOf : (p.paidUntil ?? ctx.asOf);
      const loan = await repo<{ id: string }>(tx, 'girvi_loan').insert({
        loan_number: number, status: 'active', branch_id: p.branchId, customer_id: p.customerId,
        borrower_name: p.borrowerName, borrower_phone: p.phone, borrower_address: p.address ?? null,
        borrower_id_type: p.idType ?? null, borrower_id_number: p.idNumber ?? null,
        sanctioned_on: p.sanctionedOn, due_date: p.dueDate ?? null,
        total_gross_weight: p.article.gross, total_net_weight: v.net, total_fine_weight: v.fine,
        appraised_value: v.value, ltv_percent: String(s.ltvPercent),
        max_eligible_amount: round(div(mul(v.value, String(s.ltvPercent)), '100'), 2),
        principal_amount: p.principal, outstanding_amount: p.principal,
        interest_rate_monthly: monthlyRate(quoted, basis), quoted_rate: quoted, quoted_rate_basis: basis,
        interest_method: s.method, compound_months: s.compoundMonths, period_basis: s.periodBasis,
        minimum_months: String(s.minimumMonths), part_month: s.partMonth, grace_days: s.graceDays,
        penal_rate_monthly: monthlyRate(String(s.penalRate), s.rateBasis), allocation_order: s.allocation,
        overdue_grace_days: s.overdueGrace, storage_per_month: String(s.storageFee),
        disbursed_amount: p.original ?? p.principal, disbursed_at: new Date(`${p.sanctionedOn}T06:30:00Z`),
        vault_packet_number: p.packet ?? null, packet_sealed_at: p.packet ? new Date(`${p.sanctionedOn}T06:30:00Z`) : null,
        last_accrued_on: lastAccrued,
        notes: [MIGRATED_NOTE, p.original && compare(p.original, p.principal) !== 0 ? `First lent ₹${p.original}; ₹${p.principal} outstanding when brought over.` : null, p.notes]
          .filter(Boolean).join(' '),
      });
      await repo(tx, 'girvi_collateral').insert({
        girvi_loan_id: loan.id, line_number: 1, description: p.article.description, metal_id: p.article.metalId,
        purity_id: p.article.purityId, quantity: p.article.quantity, gross_weight: p.article.gross, stone_weight: p.article.stone,
        net_weight: v.net, fine_weight: v.fine, tested_purity_percent: p.article.fineness, test_method: 'declared', appraised_value: v.value,
      });
      const lines = byBranch.get(p.branchId) ?? [];
      lines.push(signed('1400', p.principal, `${number}, ${p.borrowerName}`, p.customerId));
      if (!isZero(p.interestDue)) {
        await repo(tx, 'girvi_accrual').insert({
          girvi_loan_id: loan.id, period_start: p.paidUntil ?? p.sanctionedOn, period_end: ctx.asOf, principal_base: p.principal,
          rate_monthly: monthlyRate(quoted, basis), days: daysBetween(p.paidUntil ?? p.sanctionedOn, ctx.asOf),
          interest_amount: p.interestDue, kind: 'interest',
        });
        // Where the shop books interest as it accrues, the arrears are already income owed to it.
        if (s.bookWhen === 'accrued') lines.push(signed('1410', p.interestDue, `Interest due on ${number}`, p.customerId));
      }
      byBranch.set(p.branchId, lines);
      if (p.number) ctx.memo.set(`loan:${p.number.toUpperCase()}`, loan.id);
      loans.push(loan.id);
      results.push({ rowId: r.row.id, ok: true, action: 'insert', targetTable: 'girvi_loan', targetId: loan.id, issues: issues.length ? issues : undefined });
    }

    for (const [branchId, money] of byBranch) {
      const voucherId = await postOpening(tx, ctx, { branchId, narration, money });
      if (voucherId) {
        await tx.query(`update girvi_loan set voucher_id = $2 where id = any($1::uuid[]) and branch_id = $3`, [loans, voucherId, branchId]);
        if (s.bookWhen === 'accrued') {
          await tx.query(
            `update girvi_accrual set voucher_id = $2
              where voucher_id is null and girvi_loan_id in (select id from girvi_loan where id = any($1::uuid[]) and branch_id = $3)`,
            [loans, voucherId, branchId]);
        }
      }
    }
    for (const id of loans) await refreshLoan(tx, id);
    tx.context.branchId = null;
    return results;
  },

  async finish(tx, ctx) {
    const rows = await tx.query<{ loan_number: string; vault_packet_number: string | null }>(
      `select distinct l.loan_number, l.vault_packet_number from import_row r join girvi_loan l on l.id = r.target_id
        where r.batch_id = $1 and r.status = 'imported' and r.target_table = 'girvi_loan'`, [ctx.batchId]);
    const notes = [
      await bumpSeriesPast(tx, 'girvi_loan', rows.map((r) => r.loan_number)),
      await bumpSeriesPast(tx, 'girvi_packet', rows.map((r) => r.vault_packet_number)),
    ];
    return notes.filter((n): n is string => Boolean(n));
  },

  async canUndo(tx, rows, { batchId }) {
    const ids = [...new Set(rows.flatMap((r) => (r.target_id ? [r.target_id] : [])))];
    const used = await tx.query<{ loan_number: string }>(
      `select l.loan_number from girvi_loan l
        where l.id = any($1::uuid[])
          and (l.status not in ('active', 'overdue')
               or exists (select 1 from girvi_repayment x where x.girvi_loan_id = l.id)
               or exists (select 1 from girvi_accrual a where a.girvi_loan_id = l.id and a.voucher_id is not null
                           and a.voucher_id not in (select id from voucher where source_type = 'data_import' and source_id = $2)))
        limit 6`, [ids, batchId]);
    if (!used.length) return null;
    return `Some loans have had payments, interest posted, a release or an auction since the import (${used.slice(0, 5).map((u) => u.loan_number).join(', ')}${used.length > 5 ? '…' : ''}). Undo those first.`;
  },

  async undo(tx, rows, { batchId, reason }) {
    const ids = [...new Set(rows.flatMap((r) => (r.target_id && r.target_table === 'girvi_loan' ? [r.target_id] : [])))];
    await tx.query(
      `update girvi_loan set status = 'cancelled', loan_number = loan_number || $2, vault_packet_number = null,
              notes = coalesce(notes || ' ', '') || $3, updated_at = now()
        where id = any($1::uuid[])`, [ids, undoneSuffix(batchId), `Import undone: ${reason}`]);
    await reverseImportVouchers(tx, batchId, reason);
    return { undone: rows.map((r) => r.id), kept: [] };
  },
};
