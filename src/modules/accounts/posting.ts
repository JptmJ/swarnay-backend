/**
 * How a document becomes ledger lines — the parts every module shares, so a
 * bill, a return and a supplier invoice all write GST, revenue and card fees
 * the same way, and one setting changes all of them together.
 */
import type { Tx } from '../../core/db/client.js';
import { add, compare, div, isZero, mul, round, sub, type Decimal } from '../../core/util/decimal.js';
import { CONFIG } from '../../core/config/definitions.js';
import { getConfigMany } from '../../core/config/config-service.js';
import type { MoneyEntry } from './ledger.service.js';

const rs = (v: Decimal) => round(v, 2);
const neg = (v: Decimal) => sub('0', v);

export const POSTING_SETTINGS = {
  registration: CONFIG.accGstRegistration, compositionRate: CONFIG.accCompositionRate,
  revenueSplit: CONFIG.accRevenueSplit, cardCharges: CONFIG.accCardCharges,
};
export const postingSettings = (tx: Tx) => getConfigMany(tx, POSTING_SETTINGS);
export type PostingSettings = Awaited<ReturnType<typeof postingSettings>>;

/** A composition dealer issues bills of supply: no GST on the bill, ever. */
export async function isComposition(tx: Tx): Promise<boolean> {
  return (await postingSettings(tx)).registration === 'composition';
}

type Side = 'debit' | 'credit';
const flip = (s: Side): Side => (s === 'debit' ? 'credit' : 'debit');

/** One line on the side asked for — or the other side when the amount came out negative. */
export function line(accountCode: string, amount: Decimal, side: Side, narration: string, extra: Partial<MoneyEntry> = {}): MoneyEntry {
  const negative = compare(amount, '0') < 0;
  return { accountCode, [negative ? flip(side) : side]: negative ? neg(amount) : amount, narration, ...extra };
}

export interface RevenueParts {
  metal: Decimal; wastage: Decimal; making: Decimal; stone: Decimal; hallmark: Decimal; discount: Decimal;
  /** What the parts net to after discount; the lines always add up to exactly this. */
  taxable: Decimal;
}

/**
 * The sale's value in the books. Split, each component lands in its own ledger
 * and the discount shows on its own, so the profit report can say whether the
 * shop earns on metal, on making or on stones. Metal takes whatever is left,
 * so the lines always add up to the taxable value to the paisa.
 */
export function revenueEntries(s: PostingSettings, p: RevenueParts, narration: string, reverse = false): MoneyEntry[] {
  const cr: Side = reverse ? 'debit' : 'credit';
  if (s.revenueSplit === 'single') return [line('4000', p.taxable, cr, narration)];
  const others = add(add(p.wastage, p.making), add(p.stone, p.hallmark));
  const metal = add(sub(p.taxable, others), p.discount);
  return [
    line('4001', metal, cr, `${narration}: metal value`),
    line('4002', p.making, cr, `${narration}: making`),
    line('4003', p.wastage, cr, `${narration}: wastage`),
    line('4004', p.stone, cr, `${narration}: stones`),
    line('4005', p.hallmark, cr, `${narration}: hallmarking`),
    line('4009', p.discount, flip(cr), `${narration}: discount`),
  ].filter((e) => !isZero(e.debit ?? '0') || !isZero(e.credit ?? '0'));
}

export interface GstParts { cgst: Decimal; sgst: Decimal; igst: Decimal }

/** CGST, SGST and IGST each to their own ledger, so the return can be filed from the books. */
export function gstEntries(kind: 'output' | 'input', p: GstParts, side: Side, narration: string): MoneyEntry[] {
  const codes = kind === 'output' ? ['2201', '2202', '2203'] : ['1301', '1302', '1303'];
  return [
    line(codes[0]!, p.cgst, side, `${narration}: CGST`),
    line(codes[1]!, p.sgst, side, `${narration}: SGST`),
    line(codes[2]!, p.igst, side, `${narration}: IGST`),
  ].filter((e) => !isZero(e.debit ?? '0') || !isZero(e.credit ?? '0'));
}

/**
 * GST paid to a supplier. A regular dealer claims it back as input credit; a
 * composition dealer cannot, so it is simply part of what the goods cost.
 */
export function inputGstEntries(s: PostingSettings, p: GstParts, side: Side, narration: string): MoneyEntry[] {
  if (s.registration === 'composition') {
    return [line('5010', add(p.cgst, add(p.sgst, p.igst)), side, `${narration}: GST (no credit under composition)`)];
  }
  return gstEntries('input', p, side, narration);
}

/** Composition tax accrues on turnover as it is billed, so the quarter's figure is never a surprise. */
export function compositionEntries(s: PostingSettings, turnover: Decimal, narration: string, reverse = false): MoneyEntry[] {
  if (s.registration !== 'composition' || !(s.compositionRate > 0) || !(compare(turnover, '0') > 0)) return [];
  const tax = rs(div(mul(turnover, String(s.compositionRate)), '100'));
  if (isZero(tax)) return [];
  return [
    line('5600', tax, reverse ? 'credit' : 'debit', `${narration}: composition tax`),
    line('2210', tax, reverse ? 'debit' : 'credit', `${narration}: composition tax`),
  ];
}

/** Kinds that are not money arriving from outside, so carry no fee. */
const NO_FEE_KINDS = ['cash', 'credit', 'advance', 'old_gold', 'scheme'];

/**
 * The fee a card or wallet keeps. Booked when the money comes in so the bank
 * ledger shows what the bank will actually credit, not the gross.
 */
export function modeCharges(
  s: PostingSettings,
  method: { name: string; kind: string; charges_percent?: Decimal | null; account: { accountId?: string; accountCode?: string } },
  amount: Decimal,
  narration: string,
): MoneyEntry[] {
  if (!s.cardCharges || NO_FEE_KINDS.includes(method.kind)) return [];
  const pct = method.charges_percent ?? '0';
  if (!(compare(pct, '0') > 0) || !(compare(amount, '0') > 0)) return [];
  const fee = rs(div(mul(amount, pct), '100'));
  if (isZero(fee)) return [];
  return [
    { accountCode: '5410', debit: fee, narration: `${method.name} fee on ${narration}` },
    { ...method.account, credit: fee, narration: `${method.name} fee on ${narration}` },
  ];
}
