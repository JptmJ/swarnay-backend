/**
 * Every setting the application will ever read, declared in one place.
 *
 * A setting declared here gets, for free: a type, validation, a default, and a
 * row in the settings UI. Code never reads a raw string out of a table — it
 * calls `config.get('sales.rounding.invoice_total')` and gets a typed value.
 */
import { z } from 'zod';

/** Where a value may be overridden. Later levels win over earlier ones. */
export type ConfigScope = 'system' | 'tenant' | 'branch';

export interface ConfigDefinition<T = unknown> {
  key: string;
  /** Groups settings into screens: "units", "sales", "purchase", "gst"... */
  group: string;
  label: string;
  description: string;
  schema: z.ZodType<T>;
  default: T;
  /** The deepest level at which this may be overridden. */
  scope: ConfigScope;
  /** Changing this rewrites how past numbers are interpreted — warn loudly. */
  sensitive?: boolean;
  /** Never listed or changed through the settings screen (a password hash); it has its own route. */
  secret?: boolean;
}

const definitions = new Map<string, ConfigDefinition>();

export function defineConfig<T>(def: ConfigDefinition<T>): ConfigDefinition<T> {
  if (definitions.has(def.key)) throw new Error(`Config key "${def.key}" is defined twice`);
  definitions.set(def.key, def as ConfigDefinition);
  return def;
}

export const allConfigDefinitions = (): ConfigDefinition[] => [...definitions.values()];
export const getConfigDefinition = (key: string): ConfigDefinition | undefined => definitions.get(key);

/* ------------------------------------------------------------------ */
/* The starting set. Modules add their own as they are built.          */
/* ------------------------------------------------------------------ */

export const CONFIG = {
  /* --- units & measurement (Module 12.1) --- */
  weightUnit: defineConfig({
    key: 'units.weight.display',
    group: 'units',
    label: 'Weight unit shown on screen',
    description:
      'Weights are always stored in grams. This only changes what staff see and type.',
    schema: z.enum(['gram', 'tola', 'kilo', 'carat']),
    default: 'gram' as const,
    scope: 'tenant',
  }),
  tolaInGrams: defineConfig({
    key: 'units.weight.tola_in_grams',
    group: 'units',
    label: 'Grams per tola',
    description: 'The Indian standard is 11.6638 g. Some regions round it to 11.664.',
    schema: z.string(),
    default: '11.6638',
    scope: 'tenant',
  }),
  weightDecimals: defineConfig({
    key: 'units.weight.decimals',
    group: 'units',
    label: 'Decimal places for weight',
    description: 'How many decimals to show and round to on documents.',
    schema: z.number().int().min(0).max(6),
    default: 3,
    scope: 'tenant',
  }),
  purityFormat: defineConfig({
    key: 'units.purity.format',
    group: 'units',
    label: 'Purity display',
    description: 'Show purity as karat (22K) or as a percentage (91.60%).',
    schema: z.enum(['karat', 'percent', 'both']),
    default: 'karat' as const,
    scope: 'tenant',
  }),
  currencyDecimals: defineConfig({
    key: 'units.currency.decimals',
    group: 'units',
    label: 'Decimal places for money',
    description: 'Indian invoices normally use 2.',
    schema: z.number().int().min(0).max(4),
    default: 2,
    scope: 'tenant',
  }),

  /* --- pricing --- */
  makingChargeBasis: defineConfig({
    key: 'pricing.making_charge.basis',
    group: 'pricing',
    label: 'How making charges are calculated',
    description:
      'per_gram = rate x weight, percent = percentage of metal value, flat = a fixed amount per piece.',
    schema: z.enum(['per_gram', 'percent', 'flat']),
    default: 'per_gram' as const,
    scope: 'tenant',
  }),
  makingChargeOnGross: defineConfig({
    key: 'pricing.making_charge.on_gross_weight',
    group: 'pricing',
    label: 'Charge making on gross weight',
    description:
      'On means stones are included in the weight that making is charged on. Off means net metal weight only.',
    schema: z.boolean(),
    default: true,
    scope: 'tenant',
  }),
  wastageBasis: defineConfig({
    key: 'pricing.wastage.basis',
    group: 'pricing',
    label: 'How wastage is calculated',
    description: 'percent of metal weight, or a fixed number of grams per piece.',
    schema: z.enum(['percent', 'per_gram', 'none']),
    default: 'percent' as const,
    scope: 'tenant',
  }),
  rateRounding: defineConfig({
    key: 'pricing.rounding.line_total',
    group: 'pricing',
    label: 'Rounding on each line',
    description: 'Applied to every line before the invoice is totalled.',
    schema: z.enum(['none', 'nearest_1', 'nearest_10']),
    default: 'none' as const,
    scope: 'tenant',
  }),
  invoiceRounding: defineConfig({
    key: 'pricing.rounding.invoice_total',
    group: 'pricing',
    label: 'Rounding on the invoice total',
    description: 'The difference is posted to a "round off" account.',
    schema: z.enum(['none', 'nearest_1', 'nearest_10']),
    default: 'nearest_1' as const,
    scope: 'tenant',
  }),

  /* --- counter pricing: read by the shared engine (Masters → Formulas → Calculation Settings) --- */
  metalValueBasis: defineConfig({
    key: 'pricing.metal_value_basis',
    group: 'pricing',
    label: 'Metal value is worked out on',
    description:
      'net = net weight × the purity’s rate (e.g. 22K rate); fine = fine weight × the pure 24K/999 rate; gross = gross weight × the purity’s rate. Wastage % is taken of the same weight.',
    schema: z.enum(['net', 'fine', 'gross']),
    default: 'net' as const,
    scope: 'tenant',
    sensitive: true,
  }),
  makingWeightBasis: defineConfig({
    key: 'pricing.making_weight_basis',
    group: 'pricing',
    label: 'Making per gram is charged on',
    description: 'net = metal weight only; gross = including stones and other weight.',
    schema: z.enum(['net', 'gross']),
    default: 'net' as const,
    scope: 'tenant',
  }),
  makingGstTreatment: defineConfig({
    key: 'pricing.making_gst_treatment',
    group: 'pricing',
    label: 'GST on making',
    description: 'composite = the jewellery rate (3%) on the whole value; separate = making taxed as a service under its own SAC.',
    schema: z.enum(['composite', 'separate']),
    default: 'composite' as const,
    scope: 'tenant',
    sensitive: true,
  }),
  separateMakingSac: defineConfig({
    key: 'pricing.separate_making_sac',
    group: 'pricing',
    label: 'SAC for making billed separately',
    description: 'Its rate comes from Masters → HSN & GST.',
    schema: z.string().regex(/^\d{4,8}$/),
    default: '9988',
    scope: 'tenant',
  }),

  /* --- tax (Module 12.1) --- */
  gstEnabled: defineConfig({
    key: 'tax.gst.enabled',
    group: 'tax',
    label: 'GST applies',
    description: 'Turn off only for tenants outside India or below the threshold.',
    schema: z.boolean(),
    default: true,
    scope: 'tenant',
  }),
  gstOnMaking: defineConfig({
    key: 'tax.gst.making_charge_treatment',
    group: 'tax',
    label: 'GST on making charges',
    description:
      'composite = one 3% rate on the whole jewellery value; separate = 3% on metal and 5% on making.',
    schema: z.enum(['composite', 'separate']),
    default: 'composite' as const,
    scope: 'tenant',
    sensitive: true,
  }),
  gstMetalRate: defineConfig({
    key: 'tax.gst.metal_rate_percent',
    group: 'tax',
    label: 'GST rate on jewellery',
    description: 'Currently 3% in India.',
    schema: z.string(),
    default: '3',
    scope: 'tenant',
  }),
  gstMakingRate: defineConfig({
    key: 'tax.gst.making_rate_percent',
    group: 'tax',
    label: 'GST rate on making charges',
    description: 'Only used when making charges are taxed separately.',
    schema: z.string(),
    default: '5',
    scope: 'tenant',
  }),

  /* --- documents --- */
  allowBackdating: defineConfig({
    key: 'documents.allow_backdating',
    group: 'documents',
    label: 'Allow back-dated documents',
    description: 'Off means a document can never be dated before today.',
    schema: z.boolean(),
    default: false,
    scope: 'tenant',
  }),
  discountFreePercent: defineConfig({
    key: 'pos.discount_free_percent',
    group: 'pos',
    label: 'Discount the counter can give without approval',
    description: 'As a percentage of the making and wastage on the bill. Above it, a person with discount approval must approve.',
    schema: z.coerce.number().min(0).max(100),
    default: 10,
    scope: 'branch',
  }),

  /* --- old gold (Old Gold → Settings) --- */
  oldGoldValuation: defineConfig({
    key: 'oldgold.valuation_basis', group: 'oldgold', label: 'Old gold is valued on',
    description: 'fine = fine weight × the pure (24K/999) rate; purity = net weight × the rate of the nearest purity at or below the tested one.',
    schema: z.enum(['fine', 'purity']), default: 'fine' as const, scope: 'tenant', sensitive: true,
  }),
  oldGoldRateSource: defineConfig({
    key: 'oldgold.rate_source', group: 'oldgold', label: 'Rate used for old gold',
    description: 'buying = the buying rate from Masters → Rates; selling = the selling rate.',
    schema: z.enum(['buying', 'selling']), default: 'buying' as const, scope: 'tenant',
  }),
  oldGoldRateMargin: defineConfig({
    key: 'oldgold.rate_margin_percent', group: 'oldgold', label: 'Take this % off the rate',
    description: 'For shops that value old gold a set % below the chosen rate. 0 = the rate as it is.',
    schema: z.coerce.number().min(0).max(50), default: 0, scope: 'tenant',
  }),
  oldGoldLoss: defineConfig({
    key: 'oldgold.melting_loss_percent', group: 'oldgold', label: 'Melting loss deducted (%)',
    description: 'Taken off the fine metal of every article, before valuing it.',
    schema: z.coerce.number().min(0).max(50), default: 0, scope: 'tenant',
  }),
  oldGoldLossEditable: defineConfig({
    key: 'oldgold.loss_editable', group: 'oldgold', label: 'Staff can change the melting loss on an article',
    description: 'Off = every article uses the loss above.', schema: z.boolean(), default: true, scope: 'tenant',
  }),
  oldGoldAllowEstimate: defineConfig({
    key: 'oldgold.allow_estimate', group: 'oldgold', label: 'Allow an estimated purity (no test)',
    description: 'Off = every article needs XRF, touchstone or a hallmark.', schema: z.boolean(), default: true, scope: 'tenant',
  }),
  oldGoldBuyback: defineConfig({
    key: 'oldgold.buyback_enabled', group: 'oldgold', label: 'Buy old gold for money (buyback)',
    description: 'Off = old gold is only taken in exchange or as advance.', schema: z.boolean(), default: true, scope: 'tenant',
  }),
  oldGoldCashLimit: defineConfig({
    key: 'oldgold.cash_payout_limit', group: 'oldgold', label: 'Most cash paid out to one person in a day (₹)',
    description: 'Above it, pay by bank or UPI. 0 = never pay old gold in cash. (Cash over ₹10,000 a day is not an allowed expense, s.40A(3).)',
    schema: z.coerce.number().min(0), default: 10000, scope: 'tenant',
  }),
  oldGoldOwnEnabled: defineConfig({
    key: 'oldgold.own.enabled', group: 'oldgold', label: 'Special terms for jewellery this shop sold',
    description: 'On = a piece found by its tag or HUID as sold by this shop gets the loss and rate below.', schema: z.boolean(), default: false, scope: 'tenant',
  }),
  oldGoldOwnLoss: defineConfig({
    key: 'oldgold.own.loss_percent', group: 'oldgold', label: 'Melting loss on own jewellery (%)',
    description: 'Usually lower than on outside gold.', schema: z.coerce.number().min(0).max(50), default: 0, scope: 'tenant',
  }),
  oldGoldOwnRate: defineConfig({
    key: 'oldgold.own.rate_source', group: 'oldgold', label: 'Rate used for own jewellery',
    description: 'buying or selling rate from Masters → Rates.', schema: z.enum(['buying', 'selling']), default: 'selling' as const, scope: 'tenant',
  }),
  oldGoldKyc: defineConfig({
    key: 'oldgold.kyc_required', group: 'oldgold', label: 'Take proof of identity',
    description: 'never, only when buying for money, or on every intake.', schema: z.enum(['never', 'buyback', 'always']), default: 'buyback' as const, scope: 'tenant',
  }),
  oldGoldKycMin: defineConfig({
    key: 'oldgold.kyc_min_value', group: 'oldgold', label: 'Identity needed from this value (₹)',
    description: '0 = whenever the rule above applies.', schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  oldGoldHoldDays: defineConfig({
    key: 'oldgold.hold_days', group: 'oldgold', label: 'Days to hold old gold before melting',
    description: 'Some states ask second-hand gold to be kept unmelted for a period. 0 = melt any time.',
    schema: z.coerce.number().int().min(0).max(365), default: 0, scope: 'tenant',
  }),
  oldGoldRegisterColumns: defineConfig({
    key: 'oldgold.register_columns', group: 'oldgold', label: 'Columns in the old gold register',
    description: 'Chosen on the Register tab; printed in this order.',
    schema: z.array(z.string()).max(30),
    default: ['date', 'voucher', 'customer', 'phone', 'address', 'id_proof', 'description', 'gross', 'net', 'purity', 'test', 'fine', 'value', 'settlement'],
    scope: 'tenant',
  }),

  negativeStock: defineConfig({
    key: 'inventory.allow_negative_stock',
    group: 'inventory',
    label: 'Allow selling stock you do not have',
    description:
      'Off is strongly recommended. On is occasionally needed while opening balances are still being entered.',
    schema: z.boolean(),
    default: false,
    scope: 'branch',
  }),
  /* ---------------------------------------------------------------- orders */
  orderRateLock: defineConfig({
    key: 'orders.rate_lock.default', group: 'orders', label: 'Rate an order is priced at',
    description: 'booking = the rate on the day the order is taken, held until delivery; delivery = the rate on the day it is billed; fixed = a rate agreed and typed in. Staff can choose another on the order itself.',
    schema: z.enum(['booking', 'delivery', 'fixed']), default: 'booking' as const, scope: 'tenant', sensitive: true,
  }),
  orderRateLockDays: defineConfig({
    key: 'orders.rate_lock.days', group: 'orders', label: 'Days a booking rate is held',
    description: '0 = held until the order is delivered, however long that takes.',
    schema: z.coerce.number().int().min(0).max(3650), default: 0, scope: 'tenant',
  }),
  orderRateLockOnExpiry: defineConfig({
    key: 'orders.rate_lock.on_expiry', group: 'orders', label: 'When the held rate has run out',
    description: 'delivery_rate = bill at the rate on the delivery day; keep = honour the held rate anyway and say so on screen.',
    schema: z.enum(['delivery_rate', 'keep']), default: 'delivery_rate' as const, scope: 'tenant',
  }),
  orderRateLockAllowChange: defineConfig({
    key: 'orders.rate_lock.allow_change', group: 'orders', label: 'Staff may switch the rate at delivery',
    description: 'On = whoever bills the order can take today’s rate instead of the held one, or the other way round (needs orders.rate.override).',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  orderAdvanceMinPercent: defineConfig({
    key: 'orders.advance.min_percent', group: 'orders', label: 'Smallest advance to take an order (%)',
    description: '0 = an order can be booked without any advance.',
    schema: z.coerce.number().min(0).max(100), default: 0, scope: 'tenant',
  }),
  orderDeliveryNeedsFullPayment: defineConfig({
    key: 'orders.delivery.require_full_payment', group: 'orders', label: 'Orders are paid in full before delivery',
    description: 'Off = the rest can stay on the customer’s account, as at the counter.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  orderRepairInvoiceType: defineConfig({
    key: 'orders.repair.invoice_type', group: 'orders', label: 'A repair is billed as',
    description: 'service = labour only, on a SAC code at the service rate, nothing moves through stock; goods = a normal jewellery bill.',
    schema: z.enum(['service', 'goods']), default: 'service' as const, scope: 'tenant',
  }),
  orderRepairSac: defineConfig({
    key: 'orders.repair.service_sac', group: 'orders', label: 'SAC code for repair work',
    description: 'Printed on a service invoice. Check it against your own filings.',
    schema: z.string().trim().max(10), default: '998892', scope: 'tenant',
  }),
  orderRepairGstPercent: defineConfig({
    key: 'orders.repair.service_gst_percent', group: 'orders', label: 'GST on repair labour (%)',
    description: 'Used when a repair is billed as a service.',
    schema: z.coerce.number().min(0).max(50), default: 18, scope: 'tenant',
  }),
  orderKarigarExcessGhat: defineConfig({
    key: 'orders.karigar.excess_ghat', group: 'orders', label: 'Metal lost above the agreed ghat',
    description: 'recover = charged to the karigar against their wages; absorb = booked to Metal Gain / Loss as the shop’s loss.',
    schema: z.enum(['recover', 'absorb']), default: 'recover' as const, scope: 'tenant',
  }),
  orderSlaWarnDays: defineConfig({
    key: 'orders.sla.warn_days', group: 'orders', label: 'Warn this many days before delivery',
    description: 'Orders due within this many days are flagged on the board.',
    schema: z.coerce.number().int().min(0).max(90), default: 2, scope: 'tenant',
  }),
  /* --- schemes (Swarna Nidhi → Settings) --- */
  schemeBonusAccrual: defineConfig({
    key: 'schemes.bonus.accrual', group: 'schemes', label: 'When the bonus is added',
    description: 'maturity = the whole bonus lands when the account matures; monthly = it builds up with every installment, so the customer watches it grow in the passbook.',
    schema: z.enum(['maturity', 'monthly']), default: 'maturity' as const, scope: 'tenant', sensitive: true,
  }),
  schemeBonusTreatment: defineConfig({
    key: 'schemes.bonus.treatment', group: 'schemes', label: 'The bonus is booked as',
    description: 'expense = the shop pays for it (Scheme Bonus, 5300); discount = it comes off the redemption bill instead, so the customer simply buys for less.',
    schema: z.enum(['expense', 'discount']), default: 'expense' as const, scope: 'tenant',
  }),
  schemeBonusForfeit: defineConfig({
    key: 'schemes.bonus.forfeit_on_missed', group: 'schemes', label: 'Lose the bonus after too many missed months',
    description: 'Off = the bonus is paid however many months were missed. How many are allowed is set on each plan.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  schemeRateSource: defineConfig({
    key: 'schemes.rate_source', group: 'schemes', label: 'Rate used to turn money into grams',
    description: 'selling = what the shop sells gold at; buying = what it buys at. A weight plan reads this every time an installment is paid.',
    schema: z.enum(['selling', 'buying']), default: 'selling' as const, scope: 'tenant',
  }),
  schemeLateRateBasis: defineConfig({
    key: 'schemes.late.rate_basis', group: 'schemes', label: 'A late installment buys grams at',
    description: 'today = the rate on the day it is actually paid; due_date = the rate of the month it was due, which is kinder to the customer and costs the shop if gold has risen since.',
    schema: z.enum(['today', 'due_date']), default: 'today' as const, scope: 'tenant',
  }),
  schemeAllowAdvance: defineConfig({
    key: 'schemes.allow_advance', group: 'schemes', label: 'Allow paying months in advance',
    description: 'A customer can clear several installments at once. Off = one month at a time, in order.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  schemeAutoMature: defineConfig({
    key: 'schemes.auto_mature', group: 'schemes', label: 'Mature an account by itself once it is fully paid',
    description: 'Off = someone has to mature it by hand before it can be redeemed.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  schemeRedeemOnOrder: defineConfig({
    key: 'schemes.redemption.allow_order', group: 'schemes', label: 'A scheme can pay for an order',
    description: 'On = the balance can be put against a custom order, not only a counter bill.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  schemeRedeemPartial: defineConfig({
    key: 'schemes.redemption.allow_partial', group: 'schemes', label: 'Allow spending a scheme in parts',
    description: 'On = whatever is left stays on the account for next time. A plan can still refuse it.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  schemeRedeemWindow: defineConfig({
    key: 'schemes.redemption.window_days', group: 'schemes', label: 'Days after maturity to redeem',
    description: '0 = no limit. Past it the account is flagged on the screen; nothing is ever taken away.',
    schema: z.coerce.number().int().min(0).max(3650), default: 0, scope: 'tenant',
  }),
  schemeClosureAllowed: defineConfig({
    key: 'schemes.closure.allowed', group: 'schemes', label: 'Allow closing an account early',
    description: 'Off = a customer who stops paying leaves the money on the account until it matures.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  schemeClosureSettlement: defineConfig({
    key: 'schemes.closure.settlement', group: 'schemes', label: 'An account closed early pays out as',
    description: 'refund = money back through a payment mode; credit = it becomes credit to spend in the shop; ask = whoever closes it chooses at the time.',
    schema: z.enum(['refund', 'credit', 'ask']), default: 'ask' as const, scope: 'tenant',
  }),
  schemeClosureDeduction: defineConfig({
    key: 'schemes.closure.deduction_percent', group: 'schemes', label: 'Kept back on an early closure (%)',
    description: 'Taken off what is handed back. 0 = the customer gets back everything they paid. A bonus is never paid on an early closure.',
    schema: z.coerce.number().min(0).max(100), default: 0, scope: 'tenant',
  }),
  schemeClosureMinMonths: defineConfig({
    key: 'schemes.closure.min_months', group: 'schemes', label: 'Months that must be paid before closing early',
    description: '0 = an account can be closed whenever the customer asks.',
    schema: z.coerce.number().int().min(0).max(120), default: 0, scope: 'tenant',
  }),
  schemeMissedAfterDays: defineConfig({
    key: 'schemes.missed_after_days', group: 'schemes', label: 'Count a month missed this long after it was due',
    description: 'Counted from the due date, on top of the plan’s grace days. It decides what the due list shows and when the bonus is at risk.',
    schema: z.coerce.number().int().min(0).max(365), default: 30, scope: 'tenant',
  }),
  schemeReceiptPrint: defineConfig({
    key: 'schemes.receipt.print_on_collect', group: 'schemes', label: 'Open the receipt after collecting',
    description: 'Off = the receipt is still saved, and can be printed from the passbook whenever it is wanted.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  /* --- girvi (Girvi → Settings) --- */
  girviRateBasis: defineConfig({
    key: 'girvi.interest.rate_basis', group: 'girvi', label: 'Interest is quoted as',
    description: 'per_month = a % each month; per_year = a % a year; per_hundred = the old way, so many rupees per ₹100 a month. Whichever you pick, that is what staff type on the loan.',
    schema: z.enum(['per_month', 'per_year', 'per_hundred']), default: 'per_month' as const, scope: 'tenant', sensitive: true,
  }),
  girviDefaultRate: defineConfig({
    key: 'girvi.interest.default_rate', group: 'girvi', label: 'Rate on a new loan',
    description: 'In whatever you quote in above. Staff can change it on the loan if you let them.',
    schema: z.coerce.number().min(0).max(100), default: 2, scope: 'tenant',
  }),
  girviRateEditable: defineConfig({
    key: 'girvi.interest.rate_editable', group: 'girvi', label: 'Staff can change the rate on a loan',
    description: 'Off = every loan takes the rate above.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  girviInterestMethod: defineConfig({
    key: 'girvi.interest.method', group: 'girvi', label: 'Interest is',
    description: 'simple = always on the principal; compound = unpaid interest joins the principal and earns interest itself.',
    schema: z.enum(['simple', 'compound']), default: 'simple' as const, scope: 'tenant',
  }),
  girviCompoundEvery: defineConfig({
    key: 'girvi.interest.compound_months', group: 'girvi', label: 'Interest joins the principal every',
    description: 'Months. Only used when interest is compound.',
    schema: z.coerce.number().int().min(1).max(24), default: 12, scope: 'tenant',
  }),
  girviPeriodBasis: defineConfig({
    key: 'girvi.interest.period_basis', group: 'girvi', label: 'A month of interest means',
    description: 'calendar = the same date next month; thirty_days = every 30 days; actual_days = worked out day by day.',
    schema: z.enum(['calendar', 'thirty_days', 'actual_days']), default: 'calendar' as const, scope: 'tenant',
  }),
  girviMinimumMonths: defineConfig({
    key: 'girvi.interest.minimum_months', group: 'girvi', label: 'Least interest charged, in months',
    description: 'Most shops charge a full month even if the loan is redeemed the next day. 0 = charge only for the days it ran.',
    schema: z.coerce.number().min(0).max(12), default: 1, scope: 'tenant',
  }),
  girviPartMonth: defineConfig({
    key: 'girvi.interest.part_month', group: 'girvi', label: 'Part of a month is charged',
    description: 'full = rounded up to a whole month; pro_rata = only the days that ran.',
    schema: z.enum(['full', 'pro_rata']), default: 'full' as const, scope: 'tenant',
  }),
  girviGraceDays: defineConfig({
    key: 'girvi.interest.grace_days', group: 'girvi', label: 'Days before interest starts',
    description: '0 = from the day the loan is given.',
    schema: z.coerce.number().int().min(0).max(90), default: 0, scope: 'tenant',
  }),
  girviPenalRate: defineConfig({
    key: 'girvi.interest.penal_rate', group: 'girvi', label: 'Extra rate once the loan is overdue',
    description: 'Added to the normal rate after the due date, in the same units. 0 = no extra.',
    schema: z.coerce.number().min(0).max(100), default: 0, scope: 'tenant',
  }),
  girviAccrualBooking: defineConfig({
    key: 'girvi.interest.book_when', group: 'girvi', label: 'Interest reaches the books',
    description: 'accrued = each month as it is earned, which is the proper way; received = only when the customer pays, which is simpler for a small shop.',
    schema: z.enum(['accrued', 'received']), default: 'accrued' as const, scope: 'tenant', sensitive: true,
  }),
  girviRateSource: defineConfig({
    key: 'girvi.valuation.rate_source', group: 'girvi', label: 'Gold is valued at',
    description: 'buying = what you buy old gold at; selling = your selling rate. Most shops lend on the buying rate.',
    schema: z.enum(['buying', 'selling']), default: 'buying' as const, scope: 'tenant',
  }),
  girviRateMargin: defineConfig({
    key: 'girvi.valuation.margin_percent', group: 'girvi', label: 'Take this % off the rate',
    description: 'For shops that value collateral a set % below the chosen rate. 0 = the rate as it is.',
    schema: z.coerce.number().min(0).max(50), default: 0, scope: 'tenant',
  }),
  girviValuationBasis: defineConfig({
    key: 'girvi.valuation.basis', group: 'girvi', label: 'Collateral is valued on',
    description: 'fine = fine weight × the pure rate; purity = net weight × the rate of the tested purity.',
    schema: z.enum(['fine', 'purity']), default: 'fine' as const, scope: 'tenant',
  }),
  girviLtvPercent: defineConfig({
    key: 'girvi.ltv.percent', group: 'girvi', label: 'Lend up to this % of the value',
    description: 'The loan-to-value. Keep an eye on what the law allows you.',
    schema: z.coerce.number().min(1).max(95), default: 75, scope: 'tenant', sensitive: true,
  }),
  girviLtvMax: defineConfig({
    key: 'girvi.ltv.hard_cap', group: 'girvi', label: 'Never lend above this %',
    description: 'A ceiling nobody may exceed, whatever they type on the loan.',
    schema: z.coerce.number().min(1).max(95), default: 75, scope: 'tenant',
  }),
  girviLtvSilver: defineConfig({
    key: 'girvi.ltv.silver_percent', group: 'girvi', label: 'Lend up to this % on silver',
    description: 'Silver moves differently from gold, so it usually carries a lower limit. 0 = use the same as gold.',
    schema: z.coerce.number().min(0).max(95), default: 60, scope: 'tenant',
  }),
  girviMinLoan: defineConfig({
    key: 'girvi.loan.minimum_amount', group: 'girvi', label: 'Smallest loan (₹)',
    description: '0 = no minimum.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviMaxLoan: defineConfig({
    key: 'girvi.loan.maximum_amount', group: 'girvi', label: 'Largest loan (₹)',
    description: '0 = no maximum.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviRounding: defineConfig({
    key: 'girvi.loan.rounding', group: 'girvi', label: 'Round the loan amount to',
    description: 'The nearest ₹. 1 = no rounding.',
    schema: z.coerce.number().int().min(1).max(10000), default: 100, scope: 'tenant',
  }),
  girviAllowTopUp: defineConfig({
    key: 'girvi.loan.allow_top_up', group: 'girvi', label: 'Allow lending more on the same packet',
    description: 'On = a borrower can take more against collateral already held, up to the limit.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  girviTenureMonths: defineConfig({
    key: 'girvi.tenure.months', group: 'girvi', label: 'A loan runs for',
    description: 'Months, used to work out the due date. 0 = open-ended, with no due date.',
    schema: z.coerce.number().int().min(0).max(120), default: 12, scope: 'tenant',
  }),
  girviOverdueGrace: defineConfig({
    key: 'girvi.tenure.grace_days', group: 'girvi', label: 'Days past the due date before it counts as overdue',
    description: '',
    schema: z.coerce.number().int().min(0).max(365), default: 15, scope: 'tenant',
  }),
  girviFeeBasis: defineConfig({
    key: 'girvi.charges.processing_basis', group: 'girvi', label: 'Processing fee is',
    description: 'flat = a fixed amount; percent = a % of the loan.',
    schema: z.enum(['flat', 'percent']), default: 'flat' as const, scope: 'tenant',
  }),
  girviFeeValue: defineConfig({
    key: 'girvi.charges.processing_value', group: 'girvi', label: 'Processing fee',
    description: 'In rupees, or as a %, whichever you chose above. 0 = no fee.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviFeeTaken: defineConfig({
    key: 'girvi.charges.processing_taken', group: 'girvi', label: 'The fee is',
    description: 'deducted = taken out of what is handed over; added = added to what has to be repaid; separate = collected as cash there and then.',
    schema: z.enum(['deducted', 'added', 'separate']), default: 'deducted' as const, scope: 'tenant',
  }),
  girviAppraisalFee: defineConfig({
    key: 'girvi.charges.appraisal_fee', group: 'girvi', label: 'Appraisal or documentation charge (₹)',
    description: 'Taken the same way as the processing fee. 0 = none.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviPenaltyBasis: defineConfig({
    key: 'girvi.charges.penalty_basis', group: 'girvi', label: 'A late payment penalty is',
    description: 'none = no penalty; flat = a fixed amount; percent = a % of what is overdue; per_day = an amount for each day late.',
    schema: z.enum(['none', 'flat', 'percent', 'per_day']), default: 'none' as const, scope: 'tenant',
  }),
  girviPenaltyValue: defineConfig({
    key: 'girvi.charges.penalty_value', group: 'girvi', label: 'Late payment penalty',
    description: 'In rupees, a %, or rupees a day — whichever you chose above.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviStorageFee: defineConfig({
    key: 'girvi.charges.storage_per_month', group: 'girvi', label: 'Storage charge a month (₹)',
    description: 'For shops that charge for keeping the packet. 0 = none.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviAllocation: defineConfig({
    key: 'girvi.repayment.allocation', group: 'girvi', label: 'A payment clears',
    description: 'The order money is applied in. penalty_interest_principal is the usual one.',
    schema: z.enum(['penalty_interest_principal', 'interest_penalty_principal', 'principal_first']), default: 'penalty_interest_principal' as const, scope: 'tenant', sensitive: true,
  }),
  girviAllowInterestOnly: defineConfig({
    key: 'girvi.repayment.allow_interest_only', group: 'girvi', label: 'Allow interest-only payments',
    description: 'On = a borrower can keep the loan running by paying just the interest.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  girviAllowPartPrincipal: defineConfig({
    key: 'girvi.repayment.allow_part_principal', group: 'girvi', label: 'Allow paying off part of the principal',
    description: 'Off = the principal has to be cleared in one go at the end.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  girviMinRepayment: defineConfig({
    key: 'girvi.repayment.minimum_amount', group: 'girvi', label: 'Smallest payment accepted (₹)',
    description: '0 = any amount.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviForeclosure: defineConfig({
    key: 'girvi.repayment.allow_foreclosure', group: 'girvi', label: 'Allow closing a loan early',
    description: 'On = a borrower may settle before the due date.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  girviForeclosureFee: defineConfig({
    key: 'girvi.repayment.foreclosure_percent', group: 'girvi', label: 'Charge for closing early (%)',
    description: 'Of what is still owed. 0 = no charge.',
    schema: z.coerce.number().min(0).max(20), default: 0, scope: 'tenant',
  }),
  girviPacketRequired: defineConfig({
    key: 'girvi.custody.packet_required', group: 'girvi', label: 'Every loan needs a vault packet number',
    description: 'Off = the packet number is optional. On = one is given automatically if none is typed.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  girviWitness: defineConfig({
    key: 'girvi.custody.witness_required', group: 'girvi', label: 'A second person must witness the sealing',
    description: 'On = whoever seals the packet records who watched.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  girviKycRequired: defineConfig({
    key: 'girvi.kyc.required', group: 'girvi', label: 'Take proof of identity',
    description: 'Off = a name and mobile are enough.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  girviKycMinValue: defineConfig({
    key: 'girvi.kyc.min_value', group: 'girvi', label: 'Identity needed from this loan amount (₹)',
    description: '0 = on every loan.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  girviBorrowerPhoto: defineConfig({
    key: 'girvi.kyc.borrower_photo', group: 'girvi', label: 'Take the borrower’s photograph',
    description: '',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  girviArticlePhoto: defineConfig({
    key: 'girvi.custody.article_photo', group: 'girvi', label: 'Photograph every article',
    description: 'So nobody argues later about what was handed in or what condition it was in.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  girviNoticeAfterDays: defineConfig({
    key: 'girvi.default.notice_after_days', group: 'girvi', label: 'Days overdue before the first notice',
    description: '',
    schema: z.coerce.number().int().min(0).max(730), default: 30, scope: 'tenant',
  }),
  girviNoticeCount: defineConfig({
    key: 'girvi.default.notice_count', group: 'girvi', label: 'Notices before an auction',
    description: '',
    schema: z.coerce.number().int().min(1).max(5), default: 3, scope: 'tenant',
  }),
  girviNoticeGapDays: defineConfig({
    key: 'girvi.default.notice_gap_days', group: 'girvi', label: 'Days between notices',
    description: '',
    schema: z.coerce.number().int().min(1).max(180), default: 30, scope: 'tenant',
  }),
  girviAuctionAfterDays: defineConfig({
    key: 'girvi.default.auction_after_days', group: 'girvi', label: 'Days after the last notice before an auction',
    description: 'Check what the law requires of you before shortening this.',
    schema: z.coerce.number().int().min(0).max(730), default: 30, scope: 'tenant', sensitive: true,
  }),
  girviSurplus: defineConfig({
    key: 'girvi.default.surplus', group: 'girvi', label: 'Anything left after an auction',
    description: 'return = given back to the borrower, which is what the law generally expects; keep = kept by the shop.',
    schema: z.enum(['return', 'keep']), default: 'return' as const, scope: 'tenant', sensitive: true,
  }),
  girviCashDisbursalLimit: defineConfig({
    key: 'girvi.cash.disbursal_limit', group: 'girvi', label: 'Most cash handed to one borrower in a day (₹)',
    description: 'Set this to whatever your accountant advises. 0 = no limit checked here.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant', sensitive: true,
  }),
  girviCashRepaymentLimit: defineConfig({
    key: 'girvi.cash.repayment_limit', group: 'girvi', label: 'Most cash taken back from one borrower in a day (₹)',
    description: 'Set this to whatever your accountant advises. 0 = no limit checked here.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant', sensitive: true,
  }),
  girviPrintOnSanction: defineConfig({
    key: 'girvi.print.ticket_on_sanction', group: 'girvi', label: 'Open the pawn ticket when a loan is given',
    description: 'Off = it is still saved and can be printed from the loan whenever it is wanted.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),

  /* --- accounts (Accounts → Settings) --- */
  accGstRegistration: defineConfig({
    key: 'accounts.gst.registration', group: 'accounts', label: 'GST registration',
    description: 'regular = GST is charged on bills and input credit is claimed; composition = bills of supply with no GST, a flat tax on turnover, and no input credit. Ask your accountant which you are.',
    schema: z.enum(['regular', 'composition']), default: 'regular' as const, scope: 'tenant', sensitive: true,
  }),
  accCompositionRate: defineConfig({
    key: 'accounts.gst.composition_rate_percent', group: 'accounts', label: 'Composition tax on turnover (%)',
    description: 'Only used under composition. Currently 1% for traders and manufacturers.',
    schema: z.coerce.number().min(0).max(10), default: 1, scope: 'tenant', sensitive: true,
  }),
  accRevenueSplit: defineConfig({
    key: 'accounts.sales.revenue_split', group: 'accounts', label: 'How sales are written in the books',
    description: 'split = metal value, making, wastage, stones, hallmarking and discount each in their own ledger, so the profit report shows what really earned the money; single = one Sales ledger.',
    schema: z.enum(['split', 'single']), default: 'split' as const, scope: 'tenant',
  }),
  accCardCharges: defineConfig({
    key: 'accounts.card_charges.post', group: 'accounts', label: 'Book card and wallet fees automatically',
    description: 'On = when a payment mode has a fee % in Masters, that fee is written to Bank & Card Charges the moment the money comes in, so the bank balance matches the bank.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  accFyStartMonth: defineConfig({
    key: 'accounts.fy.start_month', group: 'accounts', label: 'Financial year starts in month',
    description: '4 = April, the Indian financial year.',
    schema: z.coerce.number().int().min(1).max(12), default: 4, scope: 'tenant', sensitive: true,
  }),
  accBooksStart: defineConfig({
    key: 'accounts.books.start_date', group: 'accounts', label: 'Books begin on',
    description: 'Opening balances are dated this day. Nothing can be posted earlier. Blank = no limit.',
    schema: z.string().regex(/^(\d{4}-\d{2}-\d{2})?$/), default: '', scope: 'tenant', sensitive: true,
  }),
  accDayOpening: defineConfig({
    key: 'accounts.day.count_on_open', group: 'accounts', label: 'Count the cash when the day opens',
    description: 'Off = the day opens with what the books say is in the drawer, no counting.',
    schema: z.boolean(), default: true, scope: 'branch',
  }),
  accDayLock: defineConfig({
    key: 'accounts.day.lock_on_close', group: 'accounts', label: 'Lock a day once it is closed',
    description: 'On = after the day close nothing more can be dated that day at that branch, unless the day is reopened.',
    schema: z.boolean(), default: true, scope: 'branch',
  }),
  accDayDenominations: defineConfig({
    key: 'accounts.day.denominations', group: 'accounts', label: 'Notes and coins counted',
    description: 'Comma separated, largest first.',
    schema: z.string().regex(/^\s*\d+(\s*,\s*\d+)*\s*$/), default: '500,200,100,50,20,10,5,2,1', scope: 'tenant',
  }),
  accDayTolerance: defineConfig({
    key: 'accounts.day.cash_tolerance', group: 'accounts', label: 'Cash difference allowed without a reason (₹)',
    description: 'A difference above this needs a note before the day can close.',
    schema: z.coerce.number().min(0), default: 0, scope: 'branch',
  }),
  accDayDifference: defineConfig({
    key: 'accounts.day.difference_posting', group: 'accounts', label: 'A cash short or excess is',
    description: 'post = written to Cash Short / Excess so the books match the drawer; record = only noted on the day close.',
    schema: z.enum(['post', 'record']), default: 'post' as const, scope: 'tenant',
  }),
  accMonthAutoLock: defineConfig({
    key: 'accounts.month.auto_lock', group: 'accounts', label: 'Lock each month automatically',
    description: 'On = a month locks by itself the given number of days after it ends, even if nobody closes it.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  accMonthLockDays: defineConfig({
    key: 'accounts.month.lock_after_days', group: 'accounts', label: 'Days after month end before it locks',
    description: 'Only used when months lock automatically. 10 leaves time to enter late bills.',
    schema: z.coerce.number().int().min(0).max(90), default: 10, scope: 'tenant',
  }),
  accMonthGst: defineConfig({
    key: 'accounts.month.gst_settlement', group: 'accounts', label: 'Set off GST when a month closes',
    description: 'On = closing a month moves output GST less input credit into GST Payable (Net), which is what you pay the government.',
    schema: z.boolean(), default: true, scope: 'tenant',
  }),
  accPeriodReopen: defineConfig({
    key: 'accounts.period.allow_reopen', group: 'accounts', label: 'A closed month or year can be reopened',
    description: 'Only by someone with the reopen permission, and the reason is kept.',
    schema: z.boolean(), default: true, scope: 'tenant', sensitive: true,
  }),
  accYearCloseTo: defineConfig({
    key: 'accounts.year.profit_to', group: 'accounts', label: 'The year’s profit is moved to',
    description: 'capital = the owner’s Capital Account, usual for a proprietor; retained = Retained Earnings, usual for a company.',
    schema: z.enum(['capital', 'retained']), default: 'capital' as const, scope: 'tenant',
  }),
  accExpenseApproval: defineConfig({
    key: 'accounts.expense.approval_required', group: 'accounts', label: 'Expenses need approval',
    description: 'On = an expense entered by staff waits for someone with approval rights before it reaches the books.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  accExpenseLimit: defineConfig({
    key: 'accounts.expense.approval_limit', group: 'accounts', label: 'Approval needed above (₹)',
    description: 'Only when approval is on. 0 = every expense needs approval.',
    schema: z.coerce.number().min(0), default: 0, scope: 'tenant',
  }),
  accTallyEnabled: defineConfig({
    key: 'accounts.tally.enabled', group: 'accounts', label: 'Export to Tally',
    description: 'On = the Tally export appears in Accounts, for an accountant who keeps the books in Tally.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  accTallyCompany: defineConfig({
    key: 'accounts.tally.company_name', group: 'accounts', label: 'Company name in Tally',
    description: 'Exactly as it is spelt in Tally. Blank = the business name.',
    schema: z.string().max(120), default: '', scope: 'tenant',
  }),
  accRevaluation: defineConfig({
    key: 'accounts.revaluation.enabled', group: 'accounts', label: 'Value metal stock at today’s rate at month end',
    description: 'On = closing a month shows the paper gain or loss on metal stock in the books for that day, and reverses it the next day. Off = stock stays at cost.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  accMetalRate: defineConfig({
    key: 'accounts.metal.valuation_rate', group: 'accounts', label: 'Metal is valued at the',
    description: 'buying = what you would pay for it today (the cautious figure); selling = what you would charge.',
    schema: z.enum(['buying', 'selling']), default: 'buying' as const, scope: 'tenant',
  }),
  accTdsEnabled: defineConfig({
    key: 'accounts.tds.enabled', group: 'accounts', label: 'Deduct TDS on payments',
    description: 'On = an expense or payment can hold back TDS, which is kept in TDS Payable until paid to the government.',
    schema: z.boolean(), default: false, scope: 'tenant',
  }),
  accTdsPercent: defineConfig({
    key: 'accounts.tds.default_percent', group: 'accounts', label: 'TDS rate suggested (%)',
    description: 'Staff can change it on the voucher.',
    schema: z.coerce.number().min(0).max(30), default: 10, scope: 'tenant',
  }),
  accWatchBackdate: defineConfig({
    key: 'accounts.watch.backdate_days', group: 'accounts', label: 'Flag entries dated this many days back',
    description: 'The watchlist shows any voucher entered more than this many days after its date.',
    schema: z.coerce.number().int().min(0).max(365), default: 3, scope: 'tenant',
  }),
  accWatchDiscount: defineConfig({
    key: 'accounts.watch.discount_percent', group: 'accounts', label: 'Flag bills discounted above (%)',
    description: 'Of the bill before discount.',
    schema: z.coerce.number().min(0).max(100), default: 10, scope: 'tenant',
  }),
  accWatchCash: defineConfig({
    key: 'accounts.watch.cash_limit', group: 'accounts', label: 'Flag cash from one person in a day at or above (₹)',
    description: 'Section 269ST bars taking ₹2 lakh or more in cash from one person in a day.',
    schema: z.coerce.number().min(0), default: 200000, scope: 'tenant',
  }),
  accForecastDays: defineConfig({
    key: 'accounts.forecast.days', group: 'accounts', label: 'Cash forecast looks ahead (days)',
    description: 'What is due in and due out over this many days.',
    schema: z.coerce.number().int().min(7).max(120), default: 30, scope: 'tenant',
  }),

  /* --- reports (Reports → Settings) --- */
  reportsDefaultRange: defineConfig({
    key: 'reports.default_range', group: 'reports', label: 'A report opens on',
    description: 'The period a report shows when none is chosen.',
    schema: z.enum(['today', 'this_week', 'this_month', 'last_month', 'this_quarter', 'this_fy', 'last_30', 'last_90']),
    default: 'this_month' as const, scope: 'tenant',
  }),
  reportsPageSize: defineConfig({
    key: 'reports.page_size', group: 'reports', label: 'Rows shown per page',
    description: 'A list longer than this is shown a page at a time. Totals always cover every row.',
    schema: z.coerce.number().int().min(20).max(2000), default: 200, scope: 'tenant',
  }),
  reportsExportMax: defineConfig({
    key: 'reports.export_max_rows', group: 'reports', label: 'Most rows in one download',
    description: 'Excel and CSV downloads stop at this many rows.',
    schema: z.coerce.number().int().min(1000).max(200000), default: 50000, scope: 'tenant',
  }),
  reportsSlowDays: defineConfig({
    key: 'reports.slow_moving_days', group: 'reports', label: 'Stock counts as slow-moving after (days)',
    description: 'Used by the slow-moving stock report.',
    schema: z.coerce.number().int().min(7).max(1825), default: 90, scope: 'tenant',
  }),
  reportsDormantDays: defineConfig({
    key: 'reports.dormant_days', group: 'reports', label: 'A customer has gone quiet after (days)',
    description: 'Used by the customers-gone-quiet report.',
    schema: z.coerce.number().int().min(30).max(3650), default: 365, scope: 'tenant',
  }),
  reportsHighValueBill: defineConfig({
    key: 'reports.high_value_bill', group: 'reports', label: 'High-value bill from (₹)',
    description: 'Bills at or above this are listed with PAN (Rule 114B asks for ₹2 lakh).',
    schema: z.coerce.number().min(0), default: 200000, scope: 'tenant',
  }),
  reportsInboxKeepDays: defineConfig({
    key: 'reports.inbox.keep_days', group: 'reports', label: 'Keep delivered reports for (days)',
    description: 'Older items in the Reports inbox are cleared away.',
    schema: z.coerce.number().int().min(7).max(730), default: 90, scope: 'tenant',
  }),

  dashboardRefreshSeconds: defineConfig({
    key: 'dashboard.refresh_seconds', group: 'dashboard', label: 'Refresh the figures every (seconds)',
    description: 'The Dashboard fetches its figures again on its own this often while it is open. 0 turns it off.',
    schema: z.coerce.number().int().min(0).max(3600), default: 300, scope: 'tenant',
  }),
  dashboardOrderDueDays: defineConfig({
    key: 'dashboard.order_due_days', group: 'dashboard', label: 'Warn about orders due within (days)',
    description: 'Orders promised within this many days are listed under Needs attention.',
    schema: z.coerce.number().int().min(0).max(60), default: 2, scope: 'tenant',
  }),
  dashboardKarigarDays: defineConfig({
    key: 'dashboard.karigar_overdue_days', group: 'dashboard', label: 'A karigar job is late after (days)',
    description: 'Used when a job has no due-back date of its own.',
    schema: z.coerce.number().int().min(1).max(365), default: 15, scope: 'tenant',
  }),
  dashboardLowStockPieces: defineConfig({
    key: 'dashboard.low_stock_pieces', group: 'dashboard', label: 'Low stock below (pieces per category)',
    description: 'A category that sold in the last 90 days and has fewer pieces than this in stock is flagged.',
    schema: z.coerce.number().int().min(0).max(10000), default: 3, scope: 'tenant',
  }),
  dashboardUnpaidDays: defineConfig({
    key: 'dashboard.unpaid_bill_days', group: 'dashboard', label: 'An unpaid bill needs a call after (days)',
    description: 'Bills with money still owed for longer than this are flagged.',
    schema: z.coerce.number().int().min(1).max(3650), default: 30, scope: 'tenant',
  }),
  dashboardAgeBuckets: defineConfig({
    key: 'dashboard.age_buckets', group: 'dashboard', label: 'Stock age bands (days)',
    description: 'Where the stock ageing chart splits, as rising day counts separated by commas, e.g. 30, 90, 180, 365.',
    schema: z.string().trim().regex(/^\d{1,4}(\s*,\s*\d{1,4}){0,7}$/, 'Give day counts separated by commas, e.g. 30, 90, 180.')
      .refine((v) => { const n = v.split(',').map((x) => Number(x.trim())); return n.every((x, i) => x > 0 && (i === 0 || x > n[i - 1]!)); },
        'Each band must be longer than the one before.'),
    default: '30, 90, 180, 365', scope: 'tenant',
  }),
  dashboardAlertsOff: defineConfig({
    key: 'dashboard.alerts_off', group: 'dashboard', label: 'Warnings switched off',
    description: 'Kinds of warning the Dashboard does not show.',
    schema: z.array(z.string().max(40)).max(30), default: [] as string[], scope: 'tenant',
  }),
  dashboardWeightUnit: defineConfig({
    key: 'dashboard.weight_unit', group: 'dashboard', label: 'Show weights in',
    description: 'Grams, kilograms or tola (11.6638 g).',
    schema: z.enum(['g', 'kg', 'tola']), default: 'g' as const, scope: 'tenant',
  }),

  stockValuation: defineConfig({
    key: 'inventory.valuation_method',
    group: 'inventory',
    label: 'How stock is valued',
    description: 'Weighted average is the usual choice for metal; FIFO suits tagged pieces.',
    schema: z.enum(['weighted_average', 'fifo']),
    default: 'weighted_average' as const,
    scope: 'tenant',
    sensitive: true,
  }),
} as const;
