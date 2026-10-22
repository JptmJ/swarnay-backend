/**
 * Pricing with the database: finds the rate, rules and GST that apply to each
 * line, runs the pure engine, and returns every source row it used. That
 * snapshot is what documents copy onto their lines — the reason an old
 * invoice can always be explained, even after rates and rules change.
 *
 * A whole bill is priced from one read of rates, rules, GST and settings, so a
 * 20-line bill costs the same few queries as a 1-line bill.
 */
import { Decimal } from 'decimal.js';
import type { Tx } from '../../../core/db/client.js';
import { priceLine, PricingError, type DiscountOn, type MetalBasis, type PriceLineResult, type RuleSnapshot } from './engine.js';
import { CONFIG } from '../../../core/config/definitions.js';
import { getConfigMany } from '../../../core/config/config-service.js';

export interface PriceRequest {
  metalId: string;
  purityId: string;
  itemId?: string | null;
  categoryId?: string | null;
  hsnCode?: string | null;
  quantity: number;
  grossWeightG: string;
  stoneWeightG?: string;
  otherWeightG?: string;
  stoneAmount?: string;
  hallmarkAmount?: string;
  /** The piece carries a HUID: a Formulas hallmark rule applies when no amount is given. */
  hallmarked?: boolean;
  discount?: { amount: string; on: DiscountOn } | null;
  customerStateCode?: string | null;
  /** Making and wastage written on a piece's tag; each wins over Masters → Formulas. */
  tag?: { making?: RuleSnapshot | null; wastage?: RuleSnapshot | null };
  /** Typed at the counter. Posting endpoints must check an override permission before passing these. */
  override?: { ratePerGram?: string; making?: RuleSnapshot };
}

type GstKey = 'metal' | 'making' | 'stone' | 'hallmark';

export interface PricedLine extends PriceLineResult {
  warnings: string[];
  snapshot: {
    hsnCode: string;
    ratePerGram: string;
    /** net or gross = the purity's rate; fine = the pure rate (Masters → Formulas → Calculation Settings). */
    metalOn: MetalBasis;
    rateId: string | null;
    rateEffectiveFrom: string | null;
    rateDerivedFromPure: boolean;
    rateOverridden: boolean;
    making: RuleSnapshot | null;
    wastage: RuleSnapshot | null;
    /** Where making and wastage came from — shown on the bill so the counter can explain the price. */
    makingSource: ChargeSource;
    wastageSource: ChargeSource;
    makingGstTreatment: 'composite' | 'separate';
    gstRateIds: Record<GstKey, string | null>;
  };
}

export type ChargeSource = 'counter' | 'tag' | 'formula' | 'none';

interface RateRow { id: string; metal_id: string; purity_id: string | null; rate: string; effective_from: string; effective_date: string }
interface RuleRow {
  id: string; applies_to: 'making' | 'wastage' | 'hallmark'; basis: RuleSnapshot['basis']; rate: string | null; flat_amount: string | null;
  slabs: RuleSnapshot['slabs']; slab_mode: 'whole' | 'tiered'; minimum_amount: string | null; priority: number; effective_from: string;
  item_id: string | null; item_category_id: string | null; purity_id: string | null; metal_id: string | null; branch_id: string | null;
  /** Categories that link this rule as their making formula (Masters → Categories). */
  linked_categories: string[];
}
interface GstRow { id: string; hsn_code: string; component: string; rate: string }

const SETTINGS = {
  metalOn: CONFIG.metalValueBasis, makingOn: CONFIG.makingWeightBasis, treatment: CONFIG.makingGstTreatment, sac: CONFIG.separateMakingSac,
  /* A composition dealer issues a bill of supply: no GST on anything. */
  registration: CONFIG.accGstRegistration,
};

/** Most specific rule wins: item › category › purity › metal › branch, then priority, then the latest. */
const specificity = (r: RuleRow) =>
  Number(!!r.item_id) * 16 + Number(!!r.item_category_id) * 8 + Number(!!r.purity_id) * 4 + Number(!!r.metal_id) * 2 + Number(!!r.branch_id);

const toRule = (r: RuleRow | undefined): RuleSnapshot | null => r ? {
  id: r.id, basis: r.basis, rate: r.rate, flatAmount: r.flat_amount, slabs: r.slabs, slabMode: r.slab_mode, minimumAmount: r.minimum_amount,
} : null;

/**
 * Reads what the given lines need and returns a function that prices any of
 * them — so a bill can be priced again (with a discount spread over it)
 * without going back to the database.
 */
export async function loadPricer(tx: Tx, reqs: PriceRequest[]): Promise<(req: PriceRequest) => PricedLine> {
  const branchId = tx.context.branchId;
  if (!branchId) throw new PricingError('Select a branch before pricing.');
  const ids = (pick: (r: PriceRequest) => string | null | undefined) => [...new Set(reqs.map(pick).filter((v): v is string => !!v))];

  // Everything the bill needs, read together.
  const [place, settings, purities, items, rates, rules] = await Promise.all([
    tx.one<{ today: string; timezone: string; state_code: string | null }>(
      `select (now() at time zone t.timezone)::date::text as today, t.timezone, b.state_code
         from branch b join tenant t on t.id = b.tenant_id where b.id = $1`, [branchId]),
    getConfigMany(tx, SETTINGS),
    // Every purity of the metals on the bill: fine weight is valued at the purest one's rate.
    tx.query<{ id: string; metal_id: string; code: string; fineness: string }>(
      `select id, metal_id, code, fineness_percent::text as fineness from purity where id = any($1::uuid[]) or metal_id = any($2::uuid[])`,
      [ids((r) => r.purityId), ids((r) => r.metalId)]),
    tx.query<{ id: string; hsn_code: string | null; category_id: string | null; category_hsn: string | null }>(
      `select i.id, i.hsn_code, i.category_id, c.hsn_code as category_hsn
         from item i left join item_category c on c.id = i.category_id
        where i.id = any($1::uuid[]) and i.deleted_at is null`, [ids((r) => r.itemId)]),
    tx.query<RateRow>(
      `select distinct on (metal_id, purity_id) id, metal_id, purity_id, rate_per_gram::text as rate,
              effective_from::text as effective_from,
              (effective_from at time zone (select timezone from tenant where id = $3))::date::text as effective_date
         from metal_rate
        where metal_id = any($1::uuid[]) and effective_from <= now() and retired_at is null and (branch_id = $2 or branch_id is null)
        order by metal_id, purity_id, effective_from desc, branch_id nulls last`,
      [ids((r) => r.metalId), branchId, tx.context.tenantId]),
    tx.query<RuleRow>(
      `select id, applies_to, basis, rate::text as rate, flat_amount::text as flat_amount, slabs, slab_mode,
              minimum_amount::text as minimum_amount, priority, effective_from::text as effective_from,
              item_id, item_category_id, purity_id, metal_id, branch_id,
              array(select c.id::text from item_category c where c.making_rule_id = price_rule.id) as linked_categories
         from price_rule
        where applies_to in ('making', 'wastage', 'hallmark') and is_active and deleted_at is null
          and effective_from <= (now() at time zone (select timezone from tenant where id = $2))::date
          and (effective_to is null or effective_to >= (now() at time zone (select timezone from tenant where id = $2))::date)
          and (branch_id is null or branch_id = $1)`, [branchId, tx.context.tenantId]),
  ]);

  const { metalOn, makingOn, treatment, sac } = settings;
  const purityById = new Map(purities.map((p) => [p.id, p]));
  const itemById = new Map(items.map((i) => [i.id, i]));
  const categoryIds = [...new Set(reqs.map((r) => r.categoryId ?? itemById.get(r.itemId ?? '')?.category_id).filter((v): v is string => !!v))];
  const categoryHsn = new Map((categoryIds.length
    ? await tx.query<{ id: string; hsn_code: string | null }>(`select id, hsn_code from item_category where id = any($1::uuid[])`, [categoryIds])
    : []).map((c) => [c.id, c.hsn_code]));

  const hsnFor = (r: PriceRequest) => {
    const item = itemById.get(r.itemId ?? '');
    const categoryId = r.categoryId ?? item?.category_id ?? null;
    return r.hsnCode ?? item?.hsn_code ?? item?.category_hsn ?? (categoryId ? categoryHsn.get(categoryId) : null) ?? null;
  };
  const gstRows = await tx.query<GstRow>(
    `select distinct on (hsn_code, component) id, hsn_code, component, gst_rate::text as rate
       from hsn_gst_rate
      where hsn_code = any($1::text[]) and effective_from <= $2::date and (effective_to is null or effective_to >= $2::date)
      order by hsn_code, component, effective_from desc`,
    [[...new Set([...reqs.map(hsnFor).filter((v): v is string => !!v), sac])], place.today]);
  const gst = new Map(gstRows.map((g) => [`${g.hsn_code}|${g.component}`, g]));

  return (req) => {
    const warnings: string[] = [];
    const purity = purityById.get(req.purityId);
    if (!purity || purity.metal_id !== req.metalId) throw new PricingError('That purity does not belong to the selected metal.');
    const item = req.itemId ? itemById.get(req.itemId) : undefined;
    const categoryId = req.categoryId ?? item?.category_id ?? null;
    const hsnCode = hsnFor(req);
    if (!hsnCode) throw new PricingError('No HSN code for this item. Set one on the item or its category in Masters.');

    // Rate: override → (fine basis) the pure rate → this purity → pure rate × fineness
    let rate: { value: string; id: string | null; effectiveFrom: string | null; derived: boolean; overridden: boolean };
    if (req.override?.ratePerGram) {
      rate = { value: req.override.ratePerGram, id: null, effectiveFrom: null, derived: false, overridden: true };
    } else if (metalOn === 'fine') {
      // A base rate is already per pure gram; otherwise the purest purity's rate, brought up to 100%.
      const base = rates.find((r) => r.metal_id === req.metalId && r.purity_id === null);
      const purest = rates.filter((r) => r.metal_id === req.metalId && r.purity_id && purityById.has(r.purity_id))
        .sort((a, b) => Number(purityById.get(b.purity_id!)!.fineness) - Number(purityById.get(a.purity_id!)!.fineness))[0];
      const found = base ?? purest;
      if (!found) throw new PricingError('Metal is valued on fine weight, but no pure (24K / 999) rate is set. Enter it in Masters → Rates.');
      const fineness = base ? '100' : purityById.get(found.purity_id!)!.fineness;
      const value = new Decimal(found.rate).mul(100).div(fineness).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
      rate = { value, id: found.id, effectiveFrom: found.effective_from, derived: !base && Number(fineness) !== 100, overridden: false };
      if (found.effective_date < place.today) {
        warnings.push(`The pure rate was last set on ${found.effective_date}. Update today's rate before billing.`);
      }
    } else {
      const own = rates.find((r) => r.metal_id === req.metalId && r.purity_id === req.purityId);
      const found = own ?? rates.find((r) => r.metal_id === req.metalId && r.purity_id === null);
      if (!found) throw new PricingError(`No rate has been set for ${purity.code}. Enter today's rate in Masters → Rates.`);
      const value = own
        ? own.rate
        : new Decimal(found.rate).mul(purity.fineness).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
      rate = { value, id: found.id, effectiveFrom: found.effective_from, derived: !own, overridden: false };
      if (found.effective_date < place.today) {
        warnings.push(`The ${purity.code} rate was last set on ${found.effective_date}. Update today's rate before billing.`);
      }
    }

    // A formula linked on Masters → Categories belongs to those categories: it counts as their own rule and applies nowhere else.
    const linkedHere = (r: RuleRow) => !!categoryId && r.linked_categories.includes(categoryId);
    const rank = (r: RuleRow) => (linkedHere(r) ? Math.max(specificity(r), 8) : specificity(r));
    const pick = (appliesTo: RuleRow['applies_to']) => rules
      .filter((r) => r.applies_to === appliesTo
        && (!r.linked_categories.length || r.item_category_id || linkedHere(r))
        && (!r.item_id || r.item_id === req.itemId) && (!r.item_category_id || r.item_category_id === categoryId)
        && (!r.purity_id || r.purity_id === req.purityId) && (!r.metal_id || r.metal_id === req.metalId))
      .sort((a, b) => rank(b) - rank(a) || b.priority - a.priority || b.effective_from.localeCompare(a.effective_from))[0];

    // Counter override › the tag › Masters → Formulas. Nothing else is assumed.
    const formulaMaking = toRule(pick('making'));
    const making = req.override?.making ?? req.tag?.making ?? formulaMaking;
    const makingSource: ChargeSource = req.override?.making ? 'counter' : req.tag?.making ? 'tag' : formulaMaking ? 'formula' : 'none';
    if (!making) warnings.push('No making on the tag and no formula matches this item — making is ₹0. Set it on the tag or in Masters → Formulas.');
    const formulaWastage = toRule(pick('wastage'));
    const wastage = req.tag?.wastage ?? formulaWastage;
    const wastageSource: ChargeSource = req.tag?.wastage ? 'tag' : formulaWastage ? 'formula' : 'none';

    const metalGst = gst.get(`${hsnCode}|metal`);
    if (!metalGst) throw new PricingError(`No GST rate for HSN ${hsnCode} on ${place.today}. Add it in Masters → GST & Tax.`);
    let makingGst = metalGst;
    if (treatment === 'separate') {
      const found = gst.get(`${sac}|making`);
      if (!found) throw new PricingError(`Making is billed separately, but there is no GST rate for SAC ${sac}. Add it in Masters → GST & Tax.`);
      makingGst = found;
    }
    const stoneGst = gst.get(`${hsnCode}|stone`) ?? metalGst;
    const hallmarkGst = gst.get(`${hsnCode}|hallmark`) ?? metalGst;
    const interState = Boolean(place.state_code && req.customerStateCode && place.state_code !== req.customerStateCode);

    const result = priceLine({
      quantity: req.quantity,
      grossWeightG: req.grossWeightG,
      stoneWeightG: req.stoneWeightG,
      otherWeightG: req.otherWeightG,
      finenessPercent: purity.fineness,
      ratePerGram: rate.value,
      metalOn,
      making,
      makingOn,
      wastage,
      stoneAmount: req.stoneAmount,
      hallmarkAmount: req.hallmarkAmount,
      hallmark: req.hallmarkAmount === undefined && req.hallmarked ? toRule(pick('hallmark')) : null,
      discount: req.discount,
      gstPercent: settings.registration === 'composition'
        ? { metal: '0', making: '0', stone: '0', hallmark: '0' }
        : { metal: metalGst.rate, making: makingGst.rate, stone: stoneGst.rate, hallmark: hallmarkGst.rate },
      interState,
    });

    return {
      ...result,
      warnings,
      snapshot: {
        hsnCode,
        ratePerGram: rate.value,
        metalOn,
        rateId: rate.id,
        rateEffectiveFrom: rate.effectiveFrom,
        rateDerivedFromPure: rate.derived,
        rateOverridden: rate.overridden,
        making,
        wastage,
        makingSource,
        wastageSource,
        makingGstTreatment: treatment,
        gstRateIds: { metal: metalGst.id, making: makingGst.id, stone: stoneGst.id, hallmark: hallmarkGst.id },
      },
    };
  };
}

export async function priceLines(tx: Tx, reqs: PriceRequest[]): Promise<PricedLine[]> {
  const price = await loadPricer(tx, reqs);
  return reqs.map(price);
}
