/**
 * Karigar job work.
 *
 * Two quite different things come through here and the difference matters in
 * the books. Shop metal issued to a goldsmith is still the shop's: it leaves
 * stock, sits against the karigar (1220) and comes back as a piece. The
 * customer's own chain sent out for a repair was never the shop's, so it moves
 * no money at all — it only has to be findable, which is what the custody
 * register is for.
 *
 * What comes back is always lighter. The part of that loss the shop agreed to
 * allow (the ghat) is a cost of making; anything beyond it is either recovered
 * from the karigar's wages or written off, as the shop's settings say.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, isZero, mul, round, sub, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { recordMovements, reverseMovementsFor, type MovementInput } from '../inventory/stock.service.js';
import { postVoucher, type MetalEntry, type MoneyEntry } from '../accounts/ledger.service.js';
import { tagAll } from '../tagging/tagging.service.js';
import { orderSettings } from './orders.service.js';

const rs = (v: Decimal) => round(v, 2);
const g3 = (v: Decimal) => round(v, 3);
const inr = (v: Decimal) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

export interface IssueJobInput {
  karigarId: string;
  retailOrderId?: string;
  kind?: 'making' | 'repair';
  /** shop = metal out of our stock; customer = their own item, which we never owned. */
  metalSource?: 'shop' | 'customer';
  metalId: string;
  purityId?: string;
  dueDate?: string;
  ghatPercent?: Decimal;
  labourBasis?: 'per_gram' | 'flat' | 'percent';
  labourRate?: Decimal;
  notes?: string;

  /** Shop metal: which lot it leaves, from where, and how much. */
  itemId?: string;
  locationId?: string;
  grossWeight?: Decimal;
  stoneWeight?: Decimal;

  /** The customer's own items going out, by their custody row. */
  custodyItemIds?: string[];
}

export interface ReceiveJobInput {
  receivedGrossWeight: Decimal;
  receivedStoneWeight?: Decimal;
  /** Tested on what came back; the job's purity is used when it is left out. */
  assayPercent?: Decimal;
  labourAmount?: Decimal;
  /** Shop metal: where it goes, and the piece it is tagged as. */
  intoLocationId?: string;
  tag?: { itemId: string; purityId: string; huid?: string; makingCost?: Decimal };
  notes?: string;
}

const purityOf = async (tx: Tx, purityId: string | null | undefined): Promise<Decimal> => {
  if (!purityId) return '100';
  const row = await tx.maybeOne<{ fineness_percent: Decimal }>(`select fineness_percent from purity where id = $1`, [purityId]);
  if (!row) throw new NotFoundError('Purity', purityId);
  return row.fineness_percent;
};

async function activeKarigar(tx: Tx, id: string) {
  const k = await tx.maybeOne<{ id: string; name: string; is_active: boolean; standard_ghat_percent: Decimal; labour_rate_per_gram: Decimal }>(
    `select id, name, is_active, standard_ghat_percent, labour_rate_per_gram from karigar where id = $1 and deleted_at is null`, [id]);
  if (!k) throw new NotFoundError('Karigar', id);
  if (!k.is_active) throw new BusinessRuleError(`${k.name} is no longer active.`, 'karigar_inactive');
  return k;
}

async function ledger(
  tx: Tx, job: { id: string; karigar_id: string; branch_id: string; retail_order_id: string | null },
  entry: { type: string; date: string; metalId?: string | null; purityId?: string | null; gross?: Decimal; in?: Decimal; out?: Decimal; debit?: Decimal; credit?: Decimal; voucherId?: string | null; narration: string },
): Promise<void> {
  await repo(tx, 'karigar_ledger').insert({
    karigar_id: job.karigar_id, entry_type: entry.type, entry_date: entry.date, branch_id: job.branch_id,
    metal_id: entry.metalId ?? null, purity_id: entry.purityId ?? null,
    gross_weight: entry.gross ?? '0', weight_in: entry.in ?? '0', weight_out: entry.out ?? '0',
    amount_debit: entry.debit ?? '0', amount_credit: entry.credit ?? '0',
    retail_order_id: job.retail_order_id, job_card_id: job.id, voucher_id: entry.voucherId ?? null,
    narration: entry.narration,
  });
}

/** Keeps the karigar master's running balances in step with their ledger. */
async function refreshKarigar(tx: Tx, karigarId: string): Promise<void> {
  await tx.query(
    `update karigar k
        set metal_balance_fine = b.metal, wage_balance = b.wage, updated_at = now()
       from (select coalesce(sum(weight_out - weight_in), 0) as metal,
                    coalesce(sum(amount_credit - amount_debit), 0) as wage
               from karigar_ledger where karigar_id = $1) b
      where k.id = $1`, [karigarId]);
}

/* ------------------------------------------------------------------- issue */

export async function issueJob(tx: Tx, input: IssueJobInput) {
  const branchId = branchOf(tx);
  const today = await businessDate(tx);
  const karigar = await activeKarigar(tx, input.karigarId);
  const source = input.metalSource ?? 'shop';
  const kind = input.kind ?? (source === 'customer' ? 'repair' : 'making');
  if (input.dueDate && input.dueDate < today) throw new ValidationError('The due date cannot be in the past.');

  const fineness = await purityOf(tx, input.purityId);
  const ghat = input.ghatPercent ?? karigar.standard_ghat_percent;
  if (compare(ghat, '0') < 0 || compare(ghat, '100') > 0) throw new ValidationError('The ghat allowance must be between 0% and 100%.');
  const labourBasis = input.labourBasis ?? 'per_gram';
  const labourRate = input.labourRate ?? (labourBasis === 'per_gram' ? karigar.labour_rate_per_gram : '0');

  let gross: Decimal = g3(input.grossWeight ?? '0');
  let stone: Decimal = g3(input.stoneWeight ?? '0');
  let custody: { id: string; token_number: string; gross_weight: Decimal; stone_weight: Decimal; net_weight: Decimal }[] = [];

  if (source === 'customer') {
    const ids = [...new Set(input.custodyItemIds ?? [])];
    if (!ids.length) throw new ValidationError('Choose which of the customer’s items is going to the karigar.');
    custody = await tx.query(
      `select id, token_number, gross_weight, stone_weight, net_weight, status from order_custody_item
        where id = any($1::uuid[]) for update`, [ids]);
    if (custody.length !== ids.length) throw new NotFoundError('Custody item', ids.join(', '));
    for (const c of custody as unknown as { token_number: string; status: string }[]) {
      if (c.status !== 'received') throw new BusinessRuleError(`${c.token_number} is ${c.status.replace('_', ' ')}, not at the counter.`, 'custody_unavailable');
    }
    gross = g3(custody.reduce((t, c) => add(t, c.gross_weight), '0' as Decimal));
    stone = g3(custody.reduce((t, c) => add(t, c.stone_weight), '0' as Decimal));
  } else {
    if (!input.itemId || !input.locationId) throw new ValidationError('Choose the metal and where it leaves from.');
    if (!(compare(gross, '0') > 0)) throw new ValidationError('Enter the weight going out.');
  }

  const net = g3(sub(gross, stone));
  const fine = g3(div(mul(net, fineness), '100'));

  const { numbers: [jobNumber] } = await reserveDocumentNumbers(tx, 'karigar_job', 1, { branchId, date: new Date(today) });
  const job = await repo<{ id: string }>(tx, 'karigar_job').insert({
    job_number: jobNumber, karigar_id: karigar.id, branch_id: branchId, retail_order_id: input.retailOrderId ?? null,
    kind, status: 'issued', metal_source: source, issued_on: today, due_date: input.dueDate ?? null,
    metal_id: input.metalId, purity_id: input.purityId ?? null, item_id: input.itemId ?? null,
    issued_from_location_id: source === 'shop' ? input.locationId : null,
    issued_gross_weight: gross, issued_net_weight: net, issued_fine_weight: fine, issued_stone_weight: stone,
    issued_value: '0', ghat_percent: ghat, labour_basis: labourBasis, labour_rate: labourRate,
    notes: input.notes ?? null,
  });
  const jobRef = { id: job.id, karigar_id: karigar.id, branch_id: branchId, retail_order_id: input.retailOrderId ?? null };

  let issuedValue: Decimal = '0';
  if (source === 'shop') {
    /* What the metal cost us, so the value follows it out to the karigar and back. */
    const held = await tx.maybeOne<{ average_rate: Decimal }>(
      `select average_rate from stock_balance where item_id = $1 and purity_id is not distinct from $2 and location_id = $3`,
      [input.itemId!, input.purityId ?? null, input.locationId!]);
    issuedValue = rs(mul(net, held?.average_rate ?? '0'));
    await recordMovements(tx, [{
      direction: 'out', reason: 'production_issue', tracking: 'lot', itemId: input.itemId!, purityId: input.purityId ?? null,
      locationId: input.locationId!, quantity: '0', grossWeight: gross, netWeight: net, fineWeight: fine,
      value: issuedValue, sourceType: 'karigar_job', sourceId: job.id, note: `${jobNumber} to ${karigar.name}`,
    } as MovementInput]);

    const money: MoneyEntry[] = [
      { accountCode: '1220', debit: issuedValue, narration: `With ${karigar.name}, ${jobNumber}` },
      { accountCode: '1200', credit: issuedValue, narration: `Metal issued on ${jobNumber}` },
    ];
    const metal: MetalEntry[] = [
      { accountCode: '1210', metalId: input.metalId, purityId: input.purityId ?? undefined, grossWeight: gross, weightOut: fine, narration: `Issued on ${jobNumber}` },
      { accountCode: '1220', metalId: input.metalId, purityId: input.purityId ?? undefined, grossWeight: gross, weightIn: fine, narration: `With ${karigar.name}` },
    ];
    const { voucherId } = await postVoucher(tx, {
      voucherType: 'production', voucherDate: today, branchId, sourceType: 'karigar_job', sourceId: job.id,
      narration: `${jobNumber}: metal issued to ${karigar.name}`, money, metal,
    });
    await tx.query(`update karigar_job set issued_value = $2, issue_voucher_id = $3 where id = $1`, [job.id, issuedValue, voucherId]);
    await ledger(tx, jobRef, { type: 'issue', date: today, metalId: input.metalId, purityId: input.purityId, gross, out: fine, voucherId, narration: `${jobNumber}: metal issued` });
  } else {
    await tx.query(
      `update order_custody_item set status = 'with_karigar', karigar_job_id = $2, updated_at = now() where id = any($1::uuid[])`,
      [custody.map((c) => c.id), job.id]);
    await ledger(tx, jobRef, { type: 'issue', date: today, metalId: input.metalId, purityId: input.purityId, gross, out: fine, narration: `${jobNumber}: customer’s item issued (not shop stock)` });
  }

  await refreshKarigar(tx, karigar.id);
  return jobDetail(tx, job.id);
}

/* ----------------------------------------------------------------- receive */

export async function receiveJob(tx: Tx, jobId: string, input: ReceiveJobInput) {
  const branchId = branchOf(tx);
  const today = await businessDate(tx);
  const s = await orderSettings(tx);
  const job = await tx.one<{
    id: string; job_number: string; status: string; karigar_id: string; branch_id: string; retail_order_id: string | null;
    metal_source: 'shop' | 'customer'; metal_id: string; purity_id: string | null; item_id: string | null;
    issued_gross_weight: Decimal; issued_net_weight: Decimal; issued_fine_weight: Decimal; issued_value: Decimal;
    ghat_percent: Decimal; labour_basis: 'per_gram' | 'flat' | 'percent'; labour_rate: Decimal;
  }>(`select * from karigar_job where id = $1 for update`, [jobId]);
  if (job.status !== 'issued') throw new BusinessRuleError(`${job.job_number} is ${job.status}.`, 'not_issued');
  const karigar = await activeKarigar(tx, job.karigar_id);

  const gross = g3(input.receivedGrossWeight);
  const stone = g3(input.receivedStoneWeight ?? '0');
  if (!(compare(gross, '0') > 0)) throw new ValidationError('Enter the weight that came back.');
  if (compare(stone, gross) > 0) throw new ValidationError('The stones cannot weigh more than the whole piece.');
  const net = g3(sub(gross, stone));
  const assay = input.assayPercent ?? await purityOf(tx, job.purity_id);
  if (!(compare(assay, '0') > 0) || compare(assay, '100') > 0) throw new ValidationError('The purity must be above 0% and at most 100%.');
  const fine = g3(div(mul(net, assay), '100'));
  if (compare(fine, job.issued_fine_weight) > 0) {
    throw new BusinessRuleError(
      `${job.job_number} went out with ${job.issued_fine_weight} g fine; ${fine} g cannot come back. Check the weight and purity.`,
      'received_exceeds_issued');
  }

  const allowed = g3(div(mul(job.issued_fine_weight, job.ghat_percent), '100'));
  const actual = g3(sub(job.issued_fine_weight, fine));
  const excess = compare(actual, allowed) > 0 ? g3(sub(actual, allowed)) : '0';
  const handling = s.excessGhat as 'recover' | 'absorb';

  /* Labour, on whatever basis was agreed. */
  const labour = input.labourAmount !== undefined ? rs(input.labourAmount)
    : job.labour_basis === 'per_gram' ? rs(mul(net, job.labour_rate))
      : job.labour_basis === 'flat' ? rs(job.labour_rate)
        : rs(div(mul(job.issued_value, job.labour_rate), '100'));
  if (compare(labour, '0') < 0) throw new ValidationError('Wages cannot be less than zero.');

  let pieceId: string | null = null;
  let excessValue: Decimal = '0';

  if (job.metal_source === 'shop') {
    const into = input.intoLocationId;
    if (!into) throw new ValidationError('Choose where the finished piece goes.');
    /* Value coming back: what went out, less the metal that did not. */
    const keptShare = compare(job.issued_fine_weight, '0') > 0 ? div(fine, job.issued_fine_weight) : '0';
    const backValue = rs(mul(job.issued_value, keptShare));
    const lossValue = rs(sub(job.issued_value, backValue));
    excessValue = compare(actual, '0') > 0 ? rs(mul(lossValue, div(excess, actual))) : '0';
    const allowedValue = rs(sub(lossValue, excessValue));

    if (input.tag) {
      const tagged = await tagAll(tx, [{
        itemId: input.tag.itemId, purityId: input.tag.purityId, locationId: into,
        grossWeight: gross, stoneWeight: stone, huid: input.tag.huid,
        costValue: add(backValue, labour), makingCost: input.tag.makingCost ?? labour,
      }], 'production_receipt', { type: 'karigar_job', id: job.id });
      pieceId = tagged[0]?.id ?? null;
    } else {
      if (!job.item_id) throw new ValidationError('Say which item the metal comes back into.');
      await recordMovements(tx, [{
        direction: 'in', reason: 'production_receipt', tracking: 'lot', itemId: job.item_id, purityId: job.purity_id,
        locationId: into, quantity: '0', grossWeight: gross, netWeight: net, fineWeight: fine,
        value: add(backValue, labour), sourceType: 'karigar_job', sourceId: job.id, note: `${job.job_number} back from ${karigar.name}`,
      } as MovementInput]);
    }

    const money: MoneyEntry[] = [
      { accountCode: '1200', debit: add(backValue, labour), narration: `${job.job_number} back from ${karigar.name}` },
      { accountCode: '1220', credit: job.issued_value, narration: `Back from ${karigar.name}` },
    ];
    if (compare(allowedValue, '0') > 0) money.push({ accountCode: '4200', debit: allowedValue, narration: `Ghat allowed on ${job.job_number}` });
    if (compare(excessValue, '0') > 0) {
      money.push(handling === 'recover'
        ? { accountCode: '2020', debit: excessValue, narration: `Metal short on ${job.job_number}, recovered from ${karigar.name}` }
        : { accountCode: '4200', debit: excessValue, narration: `Metal short on ${job.job_number}, written off` });
    }
    if (compare(labour, '0') > 0) money.push({ accountCode: '2020', credit: labour, narration: `Wages owed to ${karigar.name}` });
    const metal: MetalEntry[] = [
      { accountCode: '1220', metalId: job.metal_id, purityId: job.purity_id ?? undefined, grossWeight: job.issued_gross_weight, weightOut: job.issued_fine_weight, narration: `Back from ${karigar.name}` },
      { accountCode: '1210', metalId: job.metal_id, purityId: input.tag?.purityId ?? job.purity_id ?? undefined, grossWeight: gross, weightIn: fine, narration: `${job.job_number} received` },
    ];
    const { voucherId } = await postVoucher(tx, {
      voucherType: 'production', voucherDate: today, branchId, sourceType: 'karigar_job_receive', sourceId: job.id,
      narration: `${job.job_number}: received from ${karigar.name}`, money, metal,
    });
    await tx.query(`update karigar_job set receive_voucher_id = $2 where id = $1`, [job.id, voucherId]);
    await ledger(tx, job, { type: 'return', date: today, metalId: job.metal_id, purityId: job.purity_id, gross, in: fine, voucherId, narration: `${job.job_number}: metal returned` });
  } else {
    /* The customer's own item: nothing moves through stock or the books. */
    await tx.query(
      `update order_custody_item set status = 'ready', updated_at = now() where karigar_job_id = $1 and status = 'with_karigar'`, [job.id]);
    await ledger(tx, job, { type: 'return', date: today, metalId: job.metal_id, purityId: job.purity_id, gross, in: fine, narration: `${job.job_number}: customer’s item returned` });
    if (compare(labour, '0') > 0) {
      const { voucherId } = await postVoucher(tx, {
        voucherType: 'production', voucherDate: today, branchId, sourceType: 'karigar_job_receive', sourceId: job.id,
        narration: `${job.job_number}: wages to ${karigar.name}`,
        money: [
          { accountCode: '5200', debit: labour, narration: `Wages on ${job.job_number}` },
          { accountCode: '2020', credit: labour, narration: `Owed to ${karigar.name}` },
        ],
      });
      await tx.query(`update karigar_job set receive_voucher_id = $2 where id = $1`, [job.id, voucherId]);
    }
  }

  if (compare(allowed, '0') > 0 || compare(excess, '0') > 0) {
    await ledger(tx, job, { type: 'ghat_allowed', date: today, metalId: job.metal_id, in: allowed, narration: `${job.job_number}: ghat allowed ${allowed} g` });
    if (compare(excess, '0') > 0) {
      await ledger(tx, job, {
        type: 'ghat_excess', date: today, metalId: job.metal_id, in: excess,
        debit: handling === 'recover' ? excessValue : '0',
        narration: `${job.job_number}: ${excess} g short of the ${job.ghat_percent}% allowed${handling === 'recover' ? ', recovered' : ', written off'}`,
      });
    }
  }
  if (compare(labour, '0') > 0) {
    await ledger(tx, job, { type: 'wage_earned', date: today, credit: labour, narration: `${job.job_number}: wages ${inr(labour)}` });
  }

  await tx.query(
    `update karigar_job
        set status = 'received', received_on = $2, received_gross_weight = $3, received_net_weight = $4,
            received_fine_weight = $5, received_stone_weight = $6, ghat_allowed_fine = $7, ghat_actual_fine = $8,
            ghat_excess_fine = $9, excess_ghat_handling = $10, excess_ghat_value = $11, labour_amount = $12,
            received_into_location_id = $13, piece_id = $14, notes = coalesce($15, notes), updated_at = now(), updated_by = $16
      where id = $1`,
    [job.id, today, gross, net, fine, stone, allowed, actual, excess, handling, excessValue, labour,
      input.intoLocationId ?? null, pieceId, input.notes ?? null, tx.context.userId]);
  await refreshKarigar(tx, job.karigar_id);
  return jobDetail(tx, job.id);
}

/* ------------------------------------------------------------------ cancel */

/** Calls back a job sent out by mistake: the metal returns exactly as it left. */
export async function cancelJob(tx: Tx, jobId: string, reason: string) {
  const job = await tx.one<{ id: string; job_number: string; status: string; karigar_id: string; metal_source: string; issue_voucher_id: string | null }>(
    `select id, job_number, status, karigar_id, metal_source, issue_voucher_id from karigar_job where id = $1 for update`, [jobId]);
  if (job.status === 'cancelled') throw new BusinessRuleError(`${job.job_number} is already cancelled.`, 'already_cancelled');
  if (job.status === 'received') {
    throw new BusinessRuleError(`${job.job_number} has already come back; it can no longer be cancelled.`, 'already_received');
  }
  if (job.metal_source === 'shop') {
    await reverseMovementsFor(tx, 'karigar_job', job.id, `${job.job_number} cancelled`, true);
    if (job.issue_voucher_id) {
      const { reverseVoucher } = await import('../accounts/ledger.service.js');
      await reverseVoucher(tx, job.issue_voucher_id, `Cancelled: ${reason}`);
    }
  } else {
    await tx.query(
      `update order_custody_item set status = 'received', karigar_job_id = null, updated_at = now()
        where karigar_job_id = $1 and status = 'with_karigar'`, [job.id]);
  }
  await tx.query(
    `delete from karigar_ledger where job_card_id = $1`, [job.id]);
  await tx.query(
    `update karigar_job set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now(), updated_by = $3
      where id = $1`, [job.id, reason, tx.context.userId]);
  await refreshKarigar(tx, job.karigar_id);
  return jobDetail(tx, job.id);
}

/* ------------------------------------------------------------------- wages */

/** Pays a karigar what is owed for finished work. */
export async function payKarigar(
  tx: Tx, input: { karigarId: string; amount: Decimal; paymentMethodId: string; reference?: string; notes?: string },
) {
  const branchId = branchOf(tx);
  const today = await businessDate(tx);
  const karigar = await activeKarigar(tx, input.karigarId);
  const amount = rs(input.amount);
  if (!(compare(amount, '0') > 0)) throw new ValidationError('Enter the amount paid.');
  const { wage_balance: owed } = await tx.one<{ wage_balance: Decimal }>(
    `select wage_balance from karigar where id = $1 for update`, [karigar.id]);
  if (compare(amount, owed) > 0) {
    throw new BusinessRuleError(`${karigar.name} is owed ${inr(owed)}; ${inr(amount)} cannot be paid.`, 'exceeds_owed');
  }
  const { paymentAccount } = await import('../purchase/purchase.service.js');
  const method = await paymentAccount(tx, input.paymentMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) {
    throw new BusinessRuleError(`${method.name} cannot pay a karigar. Choose cash, bank or UPI.`, 'payment_method_invalid');
  }
  if (method.requires_reference && !input.reference?.trim()) {
    throw new BusinessRuleError(`${method.name} needs a reference (UTR, cheque number).`, 'reference_required');
  }
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'payment', voucherDate: today, branchId, sourceType: 'karigar_payment', sourceId: karigar.id,
    narration: `Wages paid to ${karigar.name}`,
    money: [
      { accountCode: '2020', debit: amount, narration: `Paid to ${karigar.name}` },
      { ...method.account, credit: amount, narration: `By ${method.name}${input.reference ? ` · ${input.reference}` : ''}` },
    ],
  });
  await repo(tx, 'karigar_ledger').insert({
    karigar_id: karigar.id, entry_type: 'wage_paid', entry_date: today, branch_id: branchId,
    amount_debit: amount, voucher_id: voucherId, narration: `Wages paid by ${method.name}`,
  });
  await refreshKarigar(tx, karigar.id);
  return tx.one(`select * from karigar where id = $1`, [karigar.id]);
}

/* ------------------------------------------------------------------ detail */

export async function jobDetail(tx: Tx, jobId: string) {
  const job = await tx.maybeOne(
    `select j.*, k.name as karigar_name, k.phone as karigar_phone, k.workshop_name, m.name as metal_name,
            pu.code as purity_code, i.name as item_name, o.order_number, p.name as customer_name,
            lf.name as issued_from_location, lt.name as received_into_location, sp.tag_number
       from karigar_job j
       join karigar k on k.id = j.karigar_id
       join metal m on m.id = j.metal_id
       left join purity pu on pu.id = j.purity_id
       left join item i on i.id = j.item_id
       left join retail_order o on o.id = j.retail_order_id
       left join party p on p.id = o.customer_id
       left join stock_location lf on lf.id = j.issued_from_location_id
       left join stock_location lt on lt.id = j.received_into_location_id
       left join stock_piece sp on sp.id = j.piece_id
      where j.id = $1`, [jobId]);
  if (!job) throw new NotFoundError('Job', jobId);
  const custody = await tx.query(
    `select id, token_number, description, gross_weight, net_weight, status from order_custody_item where karigar_job_id = $1 order by line_number`,
    [jobId]);
  return { ...job, custody };
}

/** What each karigar is holding and what they are owed. */
export async function karigarBalances(tx: Tx) {
  return tx.query(
    `select k.id, k.code, k.name, k.workshop_name, k.engagement, k.phone, k.standard_ghat_percent,
            k.labour_rate_per_gram, k.metal_balance_fine, k.wage_balance, k.is_active,
            (select count(*)::int from karigar_job j where j.karigar_id = k.id and j.status = 'issued') as open_jobs
       from karigar k where k.deleted_at is null order by k.is_active desc, k.name`);
}
