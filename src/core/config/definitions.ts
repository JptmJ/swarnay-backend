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
