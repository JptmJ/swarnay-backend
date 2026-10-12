/**
 * Old Gold: taking in customers' jewellery, paying for it, and melting it.
 *
 * Every document posts as it is saved, in one transaction, like Purchase and POS.
 * An intake puts the metal into stock as old gold (by fine weight, no fixed purity)
 * and credits its value to the customer's account (2400). That credit is spent on a
 * bill (exchange), paid out (buyback), or kept as advance. Valuation follows the
 * shop's Old Gold settings: fine or purity basis, buying or selling rate, margin,
 * melting loss, and separate terms for jewellery the shop sold itself.
 */
import type { Tx } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { add, compare, div, fixed, isZero, mul, round, sub, sum, type Decimal } from '../../core/util/decimal.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import { businessDate } from '../../core/util/business-date.js';
import { hasPermission } from '../identity/permissions.js';
import { reserveDocumentNumbers } from '../numbering/numbering.service.js';
import { recordMovements, reverseMovementsFor, type MovementInput } from '../inventory/stock.service.js';
import { postVoucher, reverseVoucher, type MetalEntry, type MoneyEntry } from '../accounts/ledger.service.js';
import { paymentAccount } from '../purchase/purchase.service.js';
import type { OLD_GOLD_TEST_METHODS } from './oldgold.schema.js';

const g3 = (v: Decimal) => round(v, 3);
const rs = (v: Decimal) => round(v, 2);
const inr = (v: Decimal | number) => `₹${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const PAN_LIMIT = '200000';
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const WALK_IN = 'WALKIN';

const SETTINGS = {
  valuation: CONFIG.oldGoldValuation, rateSource: CONFIG.oldGoldRateSource, margin: CONFIG.oldGoldRateMargin,
  loss: CONFIG.oldGoldLoss, lossEditable: CONFIG.oldGoldLossEditable, allowEstimate: CONFIG.oldGoldAllowEstimate,
  buyback: CONFIG.oldGoldBuyback, cashLimit: CONFIG.oldGoldCashLimit, ownEnabled: CONFIG.oldGoldOwnEnabled,
  ownLoss: CONFIG.oldGoldOwnLoss, ownRate: CONFIG.oldGoldOwnRate, kyc: CONFIG.oldGoldKyc, kycMin: CONFIG.oldGoldKycMin,
  holdDays: CONFIG.oldGoldHoldDays,
};
const settingsOf = (tx: Tx) => getConfigMany(tx, SETTINGS);
/** The Old Gold settings as the desk and the counter need them (anyone who handles old gold may read them). */
export const oldGoldSettings = (tx: Tx) => getConfigMany(tx, { ...SETTINGS, registerColumns: CONFIG.oldGoldRegisterColumns });
type Settings = Awaited<ReturnType<typeof settingsOf>>;

function branchOf(tx: Tx): string {
  if (!tx.context.branchId) throw new BusinessRuleError('Select a branch first.', 'branch_required');
  return tx.context.branchId;
}

/* --------------------------------------------------------------- valuation */

export type TestMethod = (typeof OLD_GOLD_TEST_METHODS)[number];

export interface OldGoldLineInput {
  description: string;
  metalId?: string;
  itemCategoryId?: string | null;
  grossWeight: Decimal;
  stoneWeight?: Decimal;
  dirtWeight?: Decimal;
  testMethod: TestMethod;
  /** As tested or estimated. For the shop's own piece, its purity is used when left out. */
  testedPurityPercent?: Decimal;
  declaredPurityPercent?: Decimal;
  testInstrument?: string;
  huid?: string;
  /** Tag number or HUID of a piece this shop sold: own-jewellery terms apply. */
  ownPiece?: string;
  /** Used only when the settings let staff change it. */
  lossPercent?: Decimal;
  notes?: string;
}

export interface ValuedLine {
  input: OldGoldLineInput; metalId: string; ownPieceId: string | null; purity: Decimal; net: Decimal; lossPercent: Decimal;
  lossWeight: Decimal; fine: Decimal; basis: 'fine' | 'purity'; rate: Decimal; value: Decimal; rateNote: string;
}

interface RateRow { metal_id: string; purity_id: string | null; rate_per_gram: Decimal | null; buying_rate_per_gram: Decimal | null }

/**
 * Values every article the way the shop has set Old Gold up. Reads rates,
 * purities and any own pieces once, whatever the number of articles.
 */
export async function valueLines(tx: Tx, lines: OldGoldLineInput[], settings?: Settings): Promise<ValuedLine[]> {
  if (lines.length === 0) throw new ValidationError('Add at least one article.');
  const s = settings ?? await settingsOf(tx);
  const branchId = branchOf(tx);
  const codes = [...new Set(lines.flatMap((l) => (l.ownPiece?.trim() ? [l.ownPiece.trim().toUpperCase()] : [])))];
  if (codes.length && !s.ownEnabled) {
    throw new BusinessRuleError('Own-jewellery terms are off. Turn them on in Old Gold → Settings, or leave the tag out.', 'own_terms_off');
  }
  const pieces = codes.length ? await tx.query<{ id: string; tag_number: string; huid: string | null; status: string; fineness: Decimal; metal_id: string;
    bought_on: string | null }>(
    `select p.id, p.tag_number, p.huid, p.status, pu.fineness_percent as fineness, pu.metal_id,
            (select g.voucher_number from old_gold_item gi join old_gold_intake g on g.id = gi.old_gold_intake_id
              where gi.own_piece_id = p.id and g.status = 'posted' limit 1) as bought_on
       from stock_piece p join purity pu on pu.id = p.purity_id
      where upper(p.tag_number) = any($1::text[]) or upper(p.huid) = any($1::text[])`, [codes]) : [];
  const pieceOf = (code: string) => pieces.find((p) => p.tag_number.toUpperCase() === code || p.huid?.toUpperCase() === code);

  const metalIds = [...new Set(lines.map((l) => (l.ownPiece?.trim() ? pieceOf(l.ownPiece.trim().toUpperCase())?.metal_id : l.metalId)).filter((v): v is string => !!v))];
  const [metals, purities, rates] = await Promise.all([
    tx.query<{ id: string; name: string }>(`select id, name from metal where id = any($1::uuid[])`, [metalIds]),
    tx.query<{ id: string; code: string; metal_id: string; fineness: Decimal }>(
      `select id, code, metal_id, fineness_percent as fineness from purity where metal_id = any($1::uuid[]) and is_active`, [metalIds]),
    tx.query<RateRow>(
      `select distinct on (metal_id, purity_id) metal_id, purity_id, rate_per_gram, buying_rate_per_gram
         from metal_rate where metal_id = any($1::uuid[]) and effective_from <= now() and retired_at is null and (branch_id = $2 or branch_id is null)
        order by metal_id, purity_id, effective_from desc, branch_id nulls last`, [metalIds, branchId]),
  ]);
  const metalName = (id: string) => metals.find((m) => m.id === id)?.name ?? 'this metal';
  const rateOf = (r: RateRow, source: 'buying' | 'selling') => (source === 'buying' ? r.buying_rate_per_gram : r.rate_per_gram);
  const priced = (metalId: string, source: 'buying' | 'selling') => purities
    .filter((p) => p.metal_id === metalId)
    .flatMap((p) => { const r = rates.find((x) => x.purity_id === p.id); const v = r && rateOf(r, source); return v && compare(v, '0') > 0 ? [{ p, rate: v }] : []; })
    .sort((a, b) => compare(b.p.fineness, a.p.fineness));

  /** Per gram of pure metal: a base (no-purity) rate, else the purest purity's rate brought up to 100%. */
  const pureRate = (metalId: string, source: 'buying' | 'selling'): [Decimal, string] => {
    const base = rates.find((r) => r.metal_id === metalId && r.purity_id === null && rateOf(r, source));
    if (base) return [rateOf(base, source)!, `pure ${source} rate`];
    const top = priced(metalId, source)[0];
    if (!top) throw new BusinessRuleError(`No ${source} rate is set for ${metalName(metalId)}. Enter it in Masters → Rates.`, 'rate_required');
    return [rs(div(mul(top.rate, '100'), top.p.fineness)), `${top.p.code} ${source} rate at 100%`];
  };
  /** The rate of the nearest purity at or below the tested one. */
  const purityRate = (metalId: string, purity: Decimal, source: 'buying' | 'selling'): [Decimal, string] => {
    const hit = priced(metalId, source).find((x) => compare(x.p.fineness, purity) <= 0);
    if (!hit) throw new BusinessRuleError(`No ${metalName(metalId)} purity at or below ${fixed(purity, 2)}% has a ${source} rate. Add it in Masters, or value on fine weight in Old Gold → Settings.`, 'rate_required');
    return [hit.rate, `${hit.p.code} ${source} rate`];
  };

  return lines.map((l, i) => {
    const n = lines.length > 1 ? `Article ${i + 1}: ` : '';
    const fail = (message: string, code: string): never => { throw new BusinessRuleError(n + message, code); };
    let own: (typeof pieces)[number] | undefined;
    if (l.ownPiece?.trim()) {
      const code = l.ownPiece.trim().toUpperCase();
      own = pieceOf(code);
      if (!own) fail(`No piece has tag or HUID ${code}.`, 'piece_not_found');
      if (own!.status !== 'sold') fail(`${own!.tag_number} is ${own!.status.replace('_', ' ')}, not sold. Only pieces this shop sold get own-jewellery terms.`, 'own_piece_not_sold');
      if (own!.bought_on) fail(`${own!.tag_number} was already bought back on ${own!.bought_on}.`, 'own_piece_repeated');
    }
    const metalId = own?.metal_id ?? l.metalId;
    if (!metalId) fail('Choose the metal.', 'metal_required');
    if (!metals.some((m) => m.id === metalId)) fail('That metal does not exist.', 'metal_invalid');
    if (l.testMethod === 'estimate' && !s.allowEstimate) fail('Estimated purity is not allowed. Test it (XRF or touchstone) or read the hallmark.', 'estimate_not_allowed');
    const purity = l.testedPurityPercent ?? own?.fineness;
    if (!purity || !(compare(purity, '0') > 0) || compare(purity, '100') > 0) fail('Enter the purity found, above 0% and at most 100%.', 'purity_invalid');

    const stone = l.stoneWeight ?? '0';
    const dirt = l.dirtWeight ?? '0';
    if (!(compare(l.grossWeight, '0') > 0)) fail('Gross weight must be more than 0 g.', 'weight_required');
    if (compare(stone, '0') < 0 || compare(dirt, '0') < 0) fail('Deductions cannot be negative.', 'weights_inconsistent');
    const net = g3(sub(sub(l.grossWeight, stone), dirt));
    if (!(compare(net, '0') > 0)) fail(`Stones (${fixed(stone, 3)} g) and dirt (${fixed(dirt, 3)} g) leave no metal in ${fixed(l.grossWeight, 3)} g.`, 'weights_inconsistent');

    const lossPercent = own ? String(s.ownLoss) : (s.lossEditable && l.lossPercent !== undefined ? l.lossPercent : String(s.loss));
    if (compare(lossPercent, '0') < 0 || compare(lossPercent, '50') > 0) fail('Melting loss must be between 0% and 50%.', 'loss_invalid');
    const fineBefore = g3(div(mul(net, purity!), '100'));
    const lossWeight = g3(div(mul(fineBefore, lossPercent), '100'));
    const fine = sub(fineBefore, lossWeight);

    const source = own ? s.ownRate : s.rateSource;
    const [baseRate, rateNote] = s.valuation === 'fine' ? pureRate(metalId!, source) : purityRate(metalId!, purity!, source);
    const rate = own || isZero(String(s.margin)) ? baseRate : rs(mul(baseRate, sub('1', div(String(s.margin), '100'))));
    // Fine basis values the fine metal; purity basis values the metal weight left after the melting loss.
    const value = rs(s.valuation === 'fine' ? mul(fine, rate) : mul(mul(net, sub('1', div(lossPercent, '100'))), rate));
    return { input: l, metalId: metalId!, ownPieceId: own?.id ?? null, purity: purity!, net, lossPercent, lossWeight, fine, basis: s.valuation, rate, value,
      rateNote: own ? `own jewellery, ${rateNote}` : !isZero(String(s.margin)) ? `${rateNote} less ${s.margin}%` : rateNote };
  });
}

/** The counter's and the desk's live price: exactly what an intake will credit. */
export async function quoteIntake(tx: Tx, lines: OldGoldLineInput[]) {
  const valued = await valueLines(tx, lines);
  return {
    lines: valued.map((v) => ({ metalId: v.metalId, ownPieceId: v.ownPieceId, netWeight: v.net, purityPercent: v.purity, lossPercent: v.lossPercent,
      lossWeight: v.lossWeight, fineWeight: v.fine, basis: v.basis, ratePerGram: v.rate, rateNote: v.rateNote, value: v.value })),
    totals: { gross: sum(lines.map((l) => l.grossWeight)), net: sum(valued.map((v) => v.net)), fine: sum(valued.map((v) => v.fine)),
      ...credited(sum(valued.map((v) => v.value))) },
  };
}

/** Articles keep their paise; the customer is credited whole rupees, like a bill. */
const credited = (exact: Decimal) => { const value = round(exact, 0); return { exactValue: exact, roundOff: sub(value, exact), value }; };

/* ------------------------------------------------------------------ intake */

interface Customer { id: string; code: string; name: string; pan: string | null }

async function customerOf(tx: Tx, id: string): Promise<Customer> {
  const c = await tx.maybeOne<Customer & { is_customer: boolean; is_active: boolean }>(
    `select id, code, name, pan, is_customer, is_active from party where id = $1 and deleted_at is null`, [id]);
  if (!c) throw new NotFoundError('Customer', id);
  if (!c.is_customer) throw new BusinessRuleError(`${c.name} is not marked as a customer.`, 'not_a_customer');
  if (!c.is_active) throw new BusinessRuleError(`${c.name} is inactive.`, 'party_inactive');
  return c;
}

/** One lot item per metal holds all old gold, by weight, with no fixed purity. Made the first time it is needed. */
async function oldGoldItem(tx: Tx, metalId: string): Promise<string> {
  const metal = await tx.one<{ code: string; name: string }>(`select code, name from metal where id = $1`, [metalId]);
  const code = `OLD-${metal.code}`;
  const found = await tx.maybeOne<{ id: string }>(`select id from item where upper(code) = $1 and deleted_at is null`, [code]);
  if (found) return found.id;
  return (await repo<{ id: string }>(tx, 'item').insert({
    code, name: `Old ${metal.name}`, nature: 'raw_metal', tracking: 'lot', metal_id: metalId, hsn_code: '7112', uom: 'gram', is_active: true,
  })).id;
}

async function stockLocation(tx: Tx, branchId: string, locationId?: string): Promise<string> {
  const loc = await tx.maybeOne<{ id: string }>(
    locationId
      ? `select id from stock_location where id = $2 and branch_id = $1 and is_active and deleted_at is null and kind <> 'transit'`
      : `select id from stock_location where branch_id = $1 and is_active and deleted_at is null and kind <> 'transit'
          order by is_default desc, (kind = 'counter') desc, code limit 1`, locationId ? [branchId, locationId] : [branchId]);
  if (!loc) throw new BusinessRuleError('Choose an active stock location at this branch for the old gold.', 'location_invalid');
  return loc.id;
}

export interface IdProof { type: 'aadhaar' | 'pan' | 'voter_id' | 'driving_licence' | 'passport' | 'other'; number: string }

export interface IntakeInput {
  customerId: string;
  locationId?: string;
  settlement: 'exchange' | 'buyback';
  /** Buyback: how the money is paid. */
  payout?: { paymentMethodId: string; reference?: string };
  idProof?: IdProof;
  pan?: string;
  lines: OldGoldLineInput[];
  notes?: string;
}

/** Proof of identity and PAN, as the settings and the ₹2 lakh rule ask. Saves a PAN given for the first time. */
async function checkIdentity(tx: Tx, s: Settings, customer: Customer, value: Decimal, buying: boolean, idProof: IdProof | null | undefined, pan?: string) {
  const need = s.kyc === 'always' || (s.kyc === 'buyback' && buying);
  if (need && compare(value, String(s.kycMin)) >= 0 && !(idProof?.type && idProof.number?.trim())) {
    throw new BusinessRuleError(`Take ${customer.name}'s proof of identity (type and number)${Number(s.kycMin) > 0 ? ` — needed from ${inr(s.kycMin)}` : ''}. Old Gold settings ask for it.`, 'id_proof_required');
  }
  if (buying && compare(value, PAN_LIMIT) >= 0 && !customer.pan) {
    const p = pan?.trim().toUpperCase();
    if (!p) throw new BusinessRuleError(`Buying old gold for ${inr(value)} needs ${customer.name}'s PAN (₹2 lakh or more).`, 'pan_required');
    if (!PAN_PATTERN.test(p)) throw new BusinessRuleError('PAN is 5 letters, 4 digits and a letter, like ABCDE1234F.', 'pan_invalid');
    await tx.query(`update party set pan = $2, updated_at = now(), updated_by = $3 where id = $1`, [customer.id, p, tx.context.userId]);
  }
}

/** Pays the customer from their old-gold credit: a payout row and its voucher. */
async function payOut(tx: Tx, s: Settings, intake: { id: string; voucher_number: string }, customer: Customer, branchId: string, date: string,
  input: { paymentMethodId: string; reference?: string }, amount: Decimal) {
  if (!s.buyback) throw new BusinessRuleError('Buying old gold for money is off. Turn it on in Old Gold → Settings.', 'buyback_disabled');
  if (!hasPermission(tx.context.permissions, 'oldgold.payout')) throw new ForbiddenError('You cannot pay out for old gold.');
  const method = await paymentAccount(tx, input.paymentMethodId, branchId);
  if (['credit', 'advance', 'old_gold', 'scheme'].includes(method.kind)) {
    throw new BusinessRuleError(`${method.name} cannot pay a customer. Choose cash, bank or UPI.`, 'payment_method_invalid');
  }
  if (method.requires_reference && !input.reference?.trim()) throw new BusinessRuleError(`${method.name} needs a reference (UTR, cheque number).`, 'reference_required');
  if (method.max_amount && compare(amount, method.max_amount) > 0) throw new BusinessRuleError(`${method.name} allows at most ${inr(method.max_amount)} at once.`, 'payment_limit');
  if (method.kind === 'cash') {
    const limit = String(s.cashLimit);
    if (isZero(limit)) throw new BusinessRuleError('Old gold is not paid in cash (Old Gold settings). Pay by bank or UPI.', 'cash_limit');
    const today = await tx.one<{ cash: Decimal }>(
      `select coalesce(sum(o.amount), 0)::text as cash from old_gold_payout o join payment_method m on m.id = o.payment_method_id
        where o.customer_id = $1 and o.doc_date = $2 and m.kind = 'cash'`, [customer.id, date]);
    if (compare(add(today.cash, amount), limit) > 0) {
      throw new BusinessRuleError(`Cash for old gold to ${customer.name} today would be ${inr(add(today.cash, amount))}, above the ${inr(limit)} limit in Old Gold settings. Pay the rest by bank or UPI.`, 'cash_limit');
    }
  }
  const payout = await repo<{ id: string }>(tx, 'old_gold_payout').insert({
    old_gold_intake_id: intake.id, customer_id: customer.id, doc_date: date, payment_method_id: method.id, amount, reference: input.reference?.trim() || null,
  });
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'old_gold', voucherDate: date, branchId, sourceType: 'old_gold_payout', sourceId: payout.id,
    narration: `Paid for old gold ${intake.voucher_number} to ${customer.name}`,
    money: [
      { accountCode: '2400', partyId: customer.id, debit: amount, narration: `Old gold ${intake.voucher_number} paid out` },
      { ...method.account, credit: amount, narration: `${method.name}${input.reference ? ` ${input.reference}` : ''}` },
    ],
  });
  await tx.query(`update old_gold_payout set voucher_id = $2 where id = $1`, [payout.id, voucherId]);
  await tx.query(
    `update old_gold_intake set paid_out_amount = paid_out_amount + $2, payout_method_id = $3, payout_reference = coalesce($4, payout_reference), updated_at = now()
      where id = $1`, [intake.id, amount, method.id, input.reference?.trim() || null]);
}

/**
 * Takes old gold in. Stock goes up as old gold, the value is credited to the
 * customer, and for a buyback it is paid out at once. `channel: counter` is
 * used by POS checkout, which may take it from a walk-in on the same bill.
 */
export async function createIntake(tx: Tx, input: IntakeInput & { channel?: 'desk' | 'counter' }) {
  const branchId = branchOf(tx);
  const s = await settingsOf(tx);
  const customer = await customerOf(tx, input.customerId);
  const channel = input.channel ?? 'desk';
  if (customer.code === WALK_IN && channel === 'desk') {
    throw new BusinessRuleError("Old gold needs the customer's name. Choose or add the customer.", 'walk_in_not_allowed');
  }
  const buying = input.settlement === 'buyback';
  if (buying && !input.payout) throw new BusinessRuleError('Choose how the customer is paid.', 'payout_required');
  const locationId = await stockLocation(tx, branchId, input.locationId);
  const valued = await valueLines(tx, input.lines, s);
  const { exactValue, roundOff, value } = credited(sum(valued.map((v) => v.value)));
  await checkIdentity(tx, s, customer, value, buying, input.idProof, input.pan);

  const date = await businessDate(tx);
  const { numbers: [number] } = await reserveDocumentNumbers(tx, 'old_gold', 1, { branchId, date: new Date(date) });
  const gross = sum(input.lines.map((l) => l.grossWeight));
  const net = sum(valued.map((v) => v.net));
  const intake = await repo<{ id: string; voucher_number: string }>(tx, 'old_gold_intake').insert({
    voucher_number: number, voucher_date: date, branch_id: branchId, customer_id: customer.id, location_id: locationId, status: 'posted',
    settlement_type: input.settlement, channel, tested_by: tx.context.userId,
    total_gross_weight: gross, total_deduction_weight: sub(gross, net), total_net_weight: net,
    total_loss_weight: sum(valued.map((v) => v.lossWeight)), total_fine_weight: sum(valued.map((v) => v.fine)),
    gross_value: exactValue, net_value: value, id_proof_type: input.idProof?.type ?? null, id_proof_number: input.idProof?.number?.trim() || null,
    notes: input.notes ?? null,
  });
  const items = await repo<{ id: string }>(tx, 'old_gold_item').insertMany(valued.map((v, i) => ({
    old_gold_intake_id: intake.id, line_number: i + 1, description: v.input.description.trim(), item_category_id: v.input.itemCategoryId ?? null,
    metal_id: v.metalId, gross_weight: v.input.grossWeight, stone_weight: v.input.stoneWeight ?? '0', dirt_weight: v.input.dirtWeight ?? '0',
    net_weight: v.net, test_method: v.input.testMethod, tested_purity_percent: v.purity, declared_purity_percent: v.input.declaredPurityPercent ?? null,
    test_instrument: v.input.testInstrument?.trim() || null, huid: v.input.huid?.trim().toUpperCase() || null, own_piece_id: v.ownPieceId,
    loss_percent: v.lossPercent, loss_weight: v.lossWeight, fine_weight: v.fine, rate_basis: v.basis, rate_per_gram: v.rate, value: v.value,
    notes: v.input.notes ?? null,
  })));

  const itemIds = new Map<string, string>();
  for (const metalId of new Set(valued.map((v) => v.metalId))) itemIds.set(metalId, await oldGoldItem(tx, metalId));
  await recordMovements(tx, valued.map((v, i): MovementInput => ({
    direction: 'in', reason: 'old_gold_intake', tracking: 'lot', itemId: itemIds.get(v.metalId)!, purityId: null, locationId,
    quantity: '0', grossWeight: v.input.grossWeight, netWeight: v.net, fineWeight: v.fine, value: v.value,
    sourceType: 'old_gold_intake', sourceId: intake.id, sourceLineId: items[i]!.id, note: number,
  })));

  const metal: MetalEntry[] = [...new Set(valued.map((v) => v.metalId))].map((metalId) => {
    const mine = valued.filter((v) => v.metalId === metalId);
    const fine = sum(mine.map((v) => v.fine));
    return { accountCode: '1210', metalId, weightIn: fine, ratePerGram: rs(div(sum(mine.map((v) => v.value)), fine)), narration: `Old gold ${number}` };
  });
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'old_gold', voucherDate: date, branchId, sourceType: 'old_gold_intake', sourceId: intake.id,
    narration: `Old gold ${number} from ${customer.name}`,
    money: [
      { accountCode: '1200', debit: exactValue, narration: 'Old gold taken in' },
      { accountCode: '2400', partyId: customer.id, credit: value, narration: `Old gold ${number}` },
      compare(roundOff, '0') >= 0 ? { accountCode: '4900', debit: roundOff, narration: 'Round off' } : { accountCode: '4900', credit: sub('0', roundOff), narration: 'Round off' },
    ],
    metal,
  });
  await tx.query(`update old_gold_intake set voucher_id = $2 where id = $1`, [intake.id, voucherId]);
  if (buying) await payOut(tx, s, intake, customer, branchId, date, input.payout!, value);
  return intakeDetail(tx, intake.id);
}

export async function intakeDetail(tx: Tx, id: string) {
  const [intake, lines, payouts] = await Promise.all([
    tx.one(`select g.*, p.name as customer_name, p.code as customer_code, p.phone as customer_phone, p.address_line1 as customer_address,
                   p.city as customer_city, p.pan as customer_pan, l.name as location_name, si.doc_number as invoice_number,
                   u.full_name as tested_by_name,
                   b.name as branch_name, b.gstin as branch_gstin, b.address_line1 as branch_address, b.city as branch_city, b.phone as branch_phone,
                   g.net_value - g.paid_out_amount as credit_amount
              from old_gold_intake g join party p on p.id = g.customer_id join stock_location l on l.id = g.location_id
              join branch b on b.id = g.branch_id left join sales_invoice si on si.id = g.applied_to_invoice_id
              left join app_user u on u.id = g.tested_by where g.id = $1`, [id]),
    tx.query(`select gi.*, m.name as metal_name, sp.tag_number as own_tag_number, mb.batch_number as melt_batch_number
                from old_gold_item gi join metal m on m.id = gi.metal_id left join stock_piece sp on sp.id = gi.own_piece_id
                left join melt_batch mb on mb.id = gi.melt_batch_id
               where gi.old_gold_intake_id = $1 order by gi.line_number`, [id]),
    tx.query(`select o.id, o.doc_date, o.amount, o.reference, m.name as method_name, m.kind as method_kind
                from old_gold_payout o join payment_method m on m.id = o.payment_method_id where o.old_gold_intake_id = $1 order by o.created_at`, [id]),
  ]);
  return { ...intake, lines, payouts };
}

/** Customer's credit on 2400 (advances, credit notes and old gold together). */
async function customerCredit(tx: Tx, customerId: string): Promise<Decimal> {
  const row = await tx.one<{ advance: Decimal }>(
    `select coalesce(sum(e.credit - e.debit), 0)::text as advance from ledger_entry e join account a on a.id = e.account_id
      where e.party_id = $1 and a.code = '2400'`, [customerId]);
  return row.advance;
}

/** Pays out some or all of an intake's credit later (a buyback after all). */
export async function payoutIntake(tx: Tx, id: string, input: { paymentMethodId: string; amount?: Decimal; reference?: string; idProof?: IdProof; pan?: string }) {
  const branchId = branchOf(tx);
  const s = await settingsOf(tx);
  const intake = await tx.one<{ id: string; voucher_number: string; status: string; customer_id: string; net_value: Decimal; paid_out_amount: Decimal;
    id_proof_type: IdProof['type'] | null; id_proof_number: string | null }>(`select * from old_gold_intake where id = $1 for update`, [id]);
  if (intake.status !== 'posted') throw new BusinessRuleError(`${intake.voucher_number} is ${intake.status}.`, 'not_posted');
  const customer = await customerOf(tx, intake.customer_id);
  const left = sub(intake.net_value, intake.paid_out_amount);
  const amount = rs(input.amount ?? left);
  if (!(compare(amount, '0') > 0) || compare(amount, left) > 0) throw new BusinessRuleError(`At most ${inr(left)} of ${intake.voucher_number} is left to pay out.`, 'payout_exceeds');
  const credit = await customerCredit(tx, customer.id);
  if (compare(amount, credit) > 0) {
    throw new BusinessRuleError(`${customer.name} has ${inr(credit)} of credit left; the rest of ${intake.voucher_number} was already used on a bill.`, 'credit_used');
  }
  const idProof = input.idProof ?? (intake.id_proof_type ? { type: intake.id_proof_type, number: intake.id_proof_number ?? '' } : null);
  await checkIdentity(tx, s, customer, intake.net_value, true, idProof, input.pan);
  if (input.idProof && !intake.id_proof_type) {
    await tx.query(`update old_gold_intake set id_proof_type = $2, id_proof_number = $3 where id = $1`, [id, input.idProof.type, input.idProof.number.trim()]);
  }
  await payOut(tx, s, intake, customer, branchId, await businessDate(tx), input, amount);
  return intakeDetail(tx, id);
}

/**
 * Undoes an intake entered by mistake: while the metal is not melted, nothing
 * was paid out and the credit is unspent. One taken in on a bill is undone by
 * cancelling the bill (`fromInvoice`).
 */
export async function cancelIntake(tx: Tx, id: string, reason: string, fromInvoice = false) {
  const intake = await tx.one<{ id: string; voucher_number: string; status: string; customer_id: string; net_value: Decimal; paid_out_amount: Decimal;
    voucher_id: string | null; applied_to_invoice_id: string | null }>(`select * from old_gold_intake where id = $1 for update`, [id]);
  if (intake.status !== 'posted') throw new BusinessRuleError(`${intake.voucher_number} is already ${intake.status}.`, 'not_posted');
  const melted = await tx.maybeOne<{ batch_number: string }>(
    `select mb.batch_number from old_gold_item gi join melt_batch mb on mb.id = gi.melt_batch_id where gi.old_gold_intake_id = $1 limit 1`, [id]);
  if (melted) throw new BusinessRuleError(`Old gold from ${intake.voucher_number} went into ${melted.batch_number}; it can no longer be cancelled.`, 'intake_melted');
  if (compare(intake.paid_out_amount, '0') > 0) {
    throw new BusinessRuleError(`${inr(intake.paid_out_amount)} was paid out on ${intake.voucher_number}; it can no longer be cancelled.`, 'intake_paid_out');
  }
  if (intake.applied_to_invoice_id && !fromInvoice) {
    const bill = await tx.one<{ doc_number: string }>(`select doc_number from sales_invoice where id = $1`, [intake.applied_to_invoice_id]);
    throw new BusinessRuleError(`${intake.voucher_number} was taken in on bill ${bill.doc_number}. Cancel the bill instead.`, 'intake_on_bill');
  }
  if (!fromInvoice && compare(await customerCredit(tx, intake.customer_id), intake.net_value) < 0) {
    throw new BusinessRuleError(`The credit from ${intake.voucher_number} was already used on a bill.`, 'credit_used');
  }
  await reverseMovementsFor(tx, 'old_gold_intake', id, `Cancelled: ${reason}`, true);
  if (intake.voucher_id) await reverseVoucher(tx, intake.voucher_id, reason);
  return tx.one(`update old_gold_intake set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() where id = $1 returning *`, [id, reason]);
}

/* -------------------------------------------------------- melt and refine */

export interface MeltOutput { outputItemId: string; outputPurityId: string; outputWeight: Decimal; assayPercent?: Decimal; locationId?: string }

/** The bullion that came out: a lot item of the batch's metal, its purity, weight and assay. */
async function outputOf(tx: Tx, branchId: string, metalId: string, o: MeltOutput) {
  const [item, purity] = await Promise.all([
    tx.maybeOne<{ name: string; tracking: string; metal_id: string | null; is_active: boolean }>(`select name, tracking, metal_id, is_active from item where id = $1 and deleted_at is null`, [o.outputItemId]),
    tx.maybeOne<{ code: string; metal_id: string; fineness: Decimal }>(`select code, metal_id, fineness_percent as fineness from purity where id = $1 and is_active`, [o.outputPurityId]),
  ]);
  if (!item || !item.is_active) throw new BusinessRuleError('Choose the bullion item the metal goes into.', 'item_invalid');
  if (item.tracking !== 'lot') throw new BusinessRuleError(`${item.name} is tagged piece by piece; choose a bullion item counted by weight.`, 'item_is_piece_tracked');
  if (!purity || purity.metal_id !== metalId || (item.metal_id && item.metal_id !== metalId)) throw new BusinessRuleError('The bullion item and purity must be of the batch’s metal.', 'purity_metal_mismatch');
  if (!(compare(o.outputWeight, '0') > 0)) throw new BusinessRuleError('Enter the weight that came out.', 'weight_required');
  const assay = o.assayPercent ?? purity.fineness;
  if (!(compare(assay, '0') > 0) || compare(assay, '100') > 0) throw new BusinessRuleError('Enter the assay, above 0% and at most 100%.', 'purity_invalid');
  return { locationId: await stockLocation(tx, branchId, o.locationId), assay, fine: g3(div(mul(o.outputWeight, assay), '100')) };
}

/**
 * Melts old gold in-house (`melt`: the bullion comes out at once) or sends it
 * to a refiner (`refine`: received later). Takes chosen articles of one metal.
 */
export async function createMeltBatch(tx: Tx, input: { kind: 'melt' | 'refine'; itemIds: string[]; refinerId?: string; output?: MeltOutput; notes?: string }) {
  const branchId = branchOf(tx);
  const s = await settingsOf(tx);
  const ids = [...new Set(input.itemIds)];
  if (ids.length === 0) throw new ValidationError('Choose the old gold going in.');
  const lines = await tx.query<{ id: string; metal_id: string; gross_weight: Decimal; net_weight: Decimal; fine_weight: Decimal; value: Decimal;
    melt_batch_id: string | null; status: string; branch_id: string; location_id: string; voucher_number: string; voucher_date: string }>(
    `select gi.id, gi.metal_id, gi.gross_weight, gi.net_weight, gi.fine_weight, gi.value, gi.melt_batch_id, g.status, g.branch_id, g.location_id,
            g.voucher_number, g.voucher_date::text as voucher_date
       from old_gold_item gi join old_gold_intake g on g.id = gi.old_gold_intake_id where gi.id = any($1::uuid[]) for update of gi`, [ids]);
  if (lines.length !== ids.length) throw new BusinessRuleError('Some of that old gold does not exist.', 'not_found');
  const today = await businessDate(tx);
  for (const l of lines) {
    if (l.status !== 'posted') throw new BusinessRuleError(`${l.voucher_number} is cancelled.`, 'not_posted');
    if (l.branch_id !== branchId) throw new BusinessRuleError(`${l.voucher_number} is at another branch.`, 'other_branch');
    if (l.melt_batch_id) throw new BusinessRuleError(`Old gold from ${l.voucher_number} is already melted or at the refiner.`, 'already_melted');
    if (s.holdDays > 0) {
      const free = new Date(`${l.voucher_date}T00:00:00Z`); free.setUTCDate(free.getUTCDate() + s.holdDays);
      const from = free.toISOString().slice(0, 10);
      if (from > today) throw new BusinessRuleError(`${l.voucher_number} can be melted from ${from} (held ${s.holdDays} days, Old Gold settings).`, 'on_hold');
    }
  }
  const metalId = lines[0]!.metal_id;
  if (lines.some((l) => l.metal_id !== metalId)) throw new BusinessRuleError('A batch takes one metal. Melt gold and silver separately.', 'metal_mixed');
  const input_ = { gross: sum(lines.map((l) => l.gross_weight)), net: sum(lines.map((l) => l.net_weight)), fine: sum(lines.map((l) => l.fine_weight)), value: sum(lines.map((l) => l.value)) };

  let refiner: { id: string; name: string } | null = null;
  if (input.kind === 'refine') {
    if (!input.refinerId) throw new BusinessRuleError('Choose the refiner.', 'refiner_required');
    refiner = await tx.maybeOne<{ id: string; name: string }>(`select id, name from party where id = $1 and is_supplier and is_active and deleted_at is null`, [input.refinerId]);
    if (!refiner) throw new BusinessRuleError('The refiner must be an active supplier in Masters.', 'refiner_invalid');
  } else if (!input.output) throw new BusinessRuleError('Enter what came out of the melt.', 'output_required');
  const out = input.kind === 'melt' ? await outputOf(tx, branchId, metalId, input.output!) : null;

  const { numbers: [number] } = await reserveDocumentNumbers(tx, 'melt_batch', 1, { branchId, date: new Date(today) });
  const batch = await repo<{ id: string }>(tx, 'melt_batch').insert({
    batch_number: number, batch_date: today, branch_id: branchId, metal_id: metalId, kind: input.kind, status: input.kind === 'melt' ? 'melted' : 'sent',
    input_gross_weight: input_.gross, input_net_weight: input_.net, input_fine_weight: input_.fine, input_value: input_.value,
    refiner_id: refiner?.id ?? null, sent_at: refiner ? new Date() : null, notes: input.notes ?? null,
    ...(out ? { output_item_id: input.output!.outputItemId, output_purity_id: input.output!.outputPurityId, output_weight: input.output!.outputWeight,
      output_purity_percent: out.assay, output_fine_weight: out.fine, loss_fine_weight: sub(input_.fine, out.fine), received_into_location_id: out.locationId, received_at: new Date() } : {}),
  });
  await tx.query(`update old_gold_item set melt_batch_id = $2, updated_at = now() where id = any($1::uuid[])`, [ids, batch.id]);

  // Old gold leaves stock from where each intake kept it.
  const oldItem = await oldGoldItem(tx, metalId);
  const byLocation = new Map<string, typeof lines>();
  for (const l of lines) byLocation.set(l.location_id, [...(byLocation.get(l.location_id) ?? []), l]);
  const reason = input.kind === 'melt' ? 'melting' as const : 'refining' as const;
  const movements: MovementInput[] = [...byLocation].map(([locationId, ls]) => ({
    direction: 'out', reason, tracking: 'lot', itemId: oldItem, purityId: null, locationId, quantity: '0',
    grossWeight: sum(ls.map((l) => l.gross_weight)), netWeight: sum(ls.map((l) => l.net_weight)), fineWeight: sum(ls.map((l) => l.fine_weight)),
    value: sum(ls.map((l) => l.value)), sourceType: 'melt_batch', sourceId: batch.id, note: number,
  }));
  if (out) {
    movements.push({ direction: 'in', reason: 'melting', tracking: 'lot', itemId: input.output!.outputItemId, purityId: input.output!.outputPurityId,
      locationId: out.locationId, quantity: '0', grossWeight: input.output!.outputWeight, netWeight: input.output!.outputWeight, fineWeight: out.fine,
      value: input_.value, sourceType: 'melt_batch', sourceId: batch.id, note: number });
  }
  await recordMovements(tx, movements);

  const { voucherId } = await postVoucher(tx, {
    voucherType: 'old_gold', voucherDate: today, branchId, sourceType: 'melt_batch', sourceId: batch.id,
    narration: out ? `Melt ${number}: ${fixed(input_.fine, 3)} g fine in, ${fixed(out.fine, 3)} g out` : `Old gold ${number} sent to ${refiner!.name}`,
    money: out ? [] : [
      { accountCode: '1220', partyId: refiner!.id, debit: input_.value, narration: `With ${refiner!.name}, ${number}` },
      { accountCode: '1200', credit: input_.value, narration: 'Old gold sent to refiner' },
    ],
    metal: [
      { accountCode: '1210', metalId, weightOut: input_.fine, narration: `Old gold into ${number}` },
      out
        ? { accountCode: '1210', metalId, purityId: input.output!.outputPurityId, grossWeight: input.output!.outputWeight, weightIn: out.fine, narration: `Bullion from ${number}` }
        : { accountCode: '1220', partyId: refiner!.id, metalId, weightIn: input_.fine, narration: `Sent to ${refiner!.name}` },
    ],
  });
  await tx.query(`update melt_batch set voucher_id = $2 where id = $1`, [batch.id, voucherId]);
  return meltBatchDetail(tx, batch.id);
}

/** What came back from the refiner, and the refining charge owed to them. */
export async function receiveMeltBatch(tx: Tx, id: string, input: MeltOutput & { refiningCharge?: Decimal; certificateNumber?: string }) {
  const branchId = branchOf(tx);
  const batch = await tx.one<{ id: string; batch_number: string; status: string; kind: string; metal_id: string; refiner_id: string; input_fine_weight: Decimal;
    input_value: Decimal }>(`select * from melt_batch where id = $1 for update`, [id]);
  if (batch.kind !== 'refine' || batch.status !== 'sent') throw new BusinessRuleError(`${batch.batch_number} is not waiting at a refiner.`, 'not_sent');
  const out = await outputOf(tx, branchId, batch.metal_id, input);
  const charge = rs(input.refiningCharge ?? '0');
  if (compare(charge, '0') < 0) throw new ValidationError('The refining charge cannot be negative.');
  const refiner = await tx.one<{ name: string }>(`select name from party where id = $1`, [batch.refiner_id]);
  const date = await businessDate(tx);
  await recordMovements(tx, [{ direction: 'in', reason: 'refining', tracking: 'lot', itemId: input.outputItemId, purityId: input.outputPurityId,
    locationId: out.locationId, quantity: '0', grossWeight: input.outputWeight, netWeight: input.outputWeight, fineWeight: out.fine,
    value: add(batch.input_value, charge), sourceType: 'melt_batch', sourceId: id, note: batch.batch_number }]);
  const { voucherId } = await postVoucher(tx, {
    voucherType: 'old_gold', voucherDate: date, branchId, sourceType: 'melt_batch', sourceId: id,
    narration: `Refined ${batch.batch_number} back from ${refiner.name}`,
    money: [
      { accountCode: '1200', debit: add(batch.input_value, charge), narration: 'Refined bullion received' },
      { accountCode: '1220', partyId: batch.refiner_id, credit: batch.input_value, narration: `Back from ${refiner.name}` },
      { accountCode: '2000', partyId: batch.refiner_id, credit: charge, narration: `Refining charge ${batch.batch_number}` },
    ],
    metal: [
      { accountCode: '1220', partyId: batch.refiner_id, metalId: batch.metal_id, weightOut: batch.input_fine_weight, narration: `From ${refiner.name}` },
      { accountCode: '1210', metalId: batch.metal_id, purityId: input.outputPurityId, grossWeight: input.outputWeight, weightIn: out.fine, narration: `Bullion from ${batch.batch_number}` },
    ],
  });
  await tx.query(
    `update melt_batch set status = 'received', output_item_id = $2, output_purity_id = $3, output_weight = $4, output_purity_percent = $5,
            output_fine_weight = $6, loss_fine_weight = input_fine_weight - $6, refining_charge = $7, assay_certificate_number = $8,
            received_into_location_id = $9, received_at = now(), receive_voucher_id = $10, updated_at = now() where id = $1`,
    [id, input.outputItemId, input.outputPurityId, input.outputWeight, out.assay, out.fine, charge, input.certificateNumber?.trim() || null, out.locationId, voucherId]);
  return meltBatchDetail(tx, id);
}

/** Undoes a batch while its bullion is still in stock: the old gold is back, unmelted. */
export async function cancelMeltBatch(tx: Tx, id: string, reason: string) {
  const batch = await tx.one<{ batch_number: string; status: string; voucher_id: string | null; receive_voucher_id: string | null }>(
    `select * from melt_batch where id = $1 for update`, [id]);
  if (batch.status === 'cancelled') throw new BusinessRuleError(`${batch.batch_number} is already cancelled.`, 'not_posted');
  await reverseMovementsFor(tx, 'melt_batch', id, `Cancelled: ${reason}`, true);
  for (const v of [batch.receive_voucher_id, batch.voucher_id]) if (v) await reverseVoucher(tx, v, reason);
  await tx.query(`update old_gold_item set melt_batch_id = null, updated_at = now() where melt_batch_id = $1`, [id]);
  return tx.one(`update melt_batch set status = 'cancelled', cancelled_at = now(), cancel_reason = $2, updated_at = now() where id = $1 returning *`, [id, reason]);
}

export async function meltBatchDetail(tx: Tx, id: string) {
  const [batch, lines] = await Promise.all([
    tx.one(`select mb.*, m.name as metal_name, p.name as refiner_name, i.name as output_item_name, pu.code as output_purity_code, l.name as location_name
              from melt_batch mb join metal m on m.id = mb.metal_id left join party p on p.id = mb.refiner_id left join item i on i.id = mb.output_item_id
              left join purity pu on pu.id = mb.output_purity_id left join stock_location l on l.id = mb.received_into_location_id where mb.id = $1`, [id]),
    tx.query(`select gi.id, gi.description, gi.gross_weight, gi.net_weight, gi.fine_weight, gi.value, g.voucher_number, g.voucher_date, p.name as customer_name
                from old_gold_item gi join old_gold_intake g on g.id = gi.old_gold_intake_id join party p on p.id = g.customer_id
               where gi.melt_batch_id = $1 order by g.voucher_number, gi.line_number`, [id]),
  ]);
  return { ...batch, lines };
}
