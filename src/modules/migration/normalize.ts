/**
 * Reading cells the way the old software wrote them.
 *
 * Nothing that arrives from another system is clean. Amounts come as
 * "₹ 1,23,456.00 Dr", weights as "12.350 gm" or "1 tola", dates as 31/03/24,
 * 31-Mar-2024 or an Excel serial number, purities as 22CT, 916 or 91.6%. Each
 * parser here takes one cell as text and gives back either the value in the
 * form the rest of the system uses, or a sentence saying what was wrong with
 * it — written for the operator who has to fix the file.
 */
import { compare, div, mul, round, type Decimal } from '../../core/util/decimal.js';

export type Parsed<T> = { ok: true; value: T; note?: string } | { ok: false; error: string };
const ok = <T>(value: T, note?: string): Parsed<T> => ({ ok: true, value, ...(note ? { note } : {}) });
const bad = (error: string): Parsed<never> => ({ ok: false, error });

/** Lower case, single spaces, punctuation gone: how headings and names are compared. */
export const normKey = (v: unknown): string =>
  String(v ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();

/** Like normKey but with the spaces gone too: "Mobile No." and "mobileno" are the same heading. */
export const squash = (v: unknown): string => normKey(v).replace(/ /g, '');

export const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && ['', '-', '--', 'na', 'n/a', 'nil', 'null', 'none', '#n/a'].includes(v.trim().toLowerCase()));

export const cellText = (v: unknown): string => (isBlank(v) ? '' : String(v).replace(/\s+/g, ' ').trim());

/* ------------------------------------------------------------- numbers */

const SCIENTIFIC = /^-?\d+(\.\d+)?e[+-]?\d+$/i;

/**
 * A number as people and old exports write it: Indian or western grouping,
 * currency marks, a trailing unit, (brackets) or a trailing minus for negative,
 * and Dr / Cr either side. `side` is set when Dr or Cr was written.
 */
export function parseNumber(raw: unknown): Parsed<{ value: Decimal; side?: 'Dr' | 'Cr' }> {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return bad('is not a number');
    return ok({ value: numberText(raw) });
  }
  let text = cellText(raw);
  if (!text) return bad('is empty');
  let side: 'Dr' | 'Cr' | undefined;
  const sideMatch = text.match(/\b(dr|cr|debit|credit)\.?\s*$/i) ?? text.match(/^\s*(dr|cr|debit|credit)\.?\b/i);
  if (sideMatch) {
    side = sideMatch[1]!.toLowerCase().startsWith('d') ? 'Dr' : 'Cr';
    text = text.replace(sideMatch[0], ' ').trim();
  }
  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }
  text = text
    .replace(/₹|rs\.?|inr|\$/gi, '')
    .replace(/(grams?|gms?|gm|gr|g|kgs?|mg|tolas?|carats?|cts?|ct|pcs?|nos?|%)\.?\s*$/i, '')
    .replace(/[\s,']/g, '')
    .trim();
  if (text.endsWith('-')) { negative = !negative; text = text.slice(0, -1); }
  if (text.startsWith('+')) text = text.slice(1);
  if (text.startsWith('-')) { negative = !negative; text = text.slice(1); }
  if (SCIENTIFIC.test(text)) text = numberText(Number(text));
  if (text.startsWith('.')) text = `0${text}`;
  if (!/^\d+(\.\d+)?$/.test(text)) return bad(`"${cellText(raw)}" is not a number`);
  const value = text.replace(/^0+(?=\d)/, '');
  return ok({ value: negative && !/^0(\.0+)?$/.test(value) ? `-${value}` : value, ...(side ? { side } : {}) });
}

/** A JavaScript number as plain decimal text, never in scientific notation. */
function numberText(n: number): string {
  if (Number.isInteger(n)) return BigInt(Math.round(n)).toString();
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

export function parseDecimal(raw: unknown, opts: { min?: string; max?: string; decimals?: number; negative?: boolean } = {}): Parsed<Decimal> {
  const n = parseNumber(raw);
  if (!n.ok) return n;
  let value = n.value.value;
  if (n.value.side === 'Cr') value = value.startsWith('-') ? value.slice(1) : `-${value}`;
  if (!opts.negative && value.startsWith('-')) return bad(`cannot be negative (${cellText(raw)})`);
  if (opts.decimals !== undefined) value = round(value, opts.decimals);
  if (opts.min !== undefined && compare(value, opts.min) < 0) return bad(`must be at least ${opts.min}`);
  if (opts.max !== undefined && compare(value, opts.max) > 0) return bad(`must be at most ${opts.max}`);
  return ok(value);
}

export const parseMoney = (raw: unknown, negative = false) => parseDecimal(raw, { decimals: 2, negative });
export const parsePercent = (raw: unknown) => {
  const n = parseDecimal(raw, { decimals: 3 });
  if (!n.ok) return n;
  // 0.085 typed for 8.5% happens; a fraction under 1 written with a % sign does not.
  return compare(n.value, '100') > 0 ? bad(`${n.value}% is more than 100%`) : n;
}

export function parseInteger(raw: unknown, opts: { min?: number; max?: number } = {}): Parsed<number> {
  const n = parseDecimal(raw, { negative: (opts.min ?? 0) < 0 });
  if (!n.ok) return n;
  if (!/^-?\d+(\.0+)?$/.test(n.value)) return bad(`must be a whole number (${n.value})`);
  const v = Number(n.value.split('.')[0]);
  if (opts.min !== undefined && v < opts.min) return bad(`must be at least ${opts.min}`);
  if (opts.max !== undefined && v > opts.max) return bad(`must be at most ${opts.max}`);
  return ok(v);
}

/**
 * A signed balance: Dr is positive (they owe the shop, or the shop holds it),
 * Cr is negative. Without Dr or Cr the sign of the number decides.
 */
export function parseBalance(raw: unknown, decimals = 2): Parsed<Decimal> {
  const n = parseNumber(raw);
  if (!n.ok) return n;
  let value = round(n.value.value, decimals);
  if (n.value.side === 'Cr') value = value.startsWith('-') ? value.slice(1) : `-${value}`;
  return ok(value === '-0' ? '0' : value);
}

/* ------------------------------------------------------------- weights */

export const WEIGHT_UNITS = ['g', 'kg', 'mg', 'tola', 'ct'] as const;
export type WeightUnit = (typeof WEIGHT_UNITS)[number];
const GRAMS_PER: Record<WeightUnit, Decimal> = { g: '1', kg: '1000', mg: '0.001', tola: '11.6638038', ct: '0.2' };

/** A unit written in the cell itself wins over the one chosen for the column. */
function unitIn(text: string): WeightUnit | null {
  const t = text.toLowerCase();
  if (/\bkgs?\b|\d\s*kgs?$/.test(t)) return 'kg';
  if (/\bmg\b|\d\s*mg$/.test(t)) return 'mg';
  if (/tola/.test(t)) return 'tola';
  if (/\bcts?\b|carat|\d\s*cts?$/.test(t)) return 'ct';
  if (/\b(g|gm|gms|gr|grams?)\b|\d\s*(g|gm|gms|gr)$/.test(t)) return 'g';
  return null;
}

/** Grams to three places, converted from the unit written or chosen. */
export function parseWeight(raw: unknown, unit: WeightUnit = 'g'): Parsed<Decimal> {
  const text = cellText(raw);
  const n = parseDecimal(raw, { negative: false });
  if (!n.ok) return n;
  const u = unitIn(text) ?? unit;
  return ok(round(mul(n.value, GRAMS_PER[u]), 3), u !== 'g' ? `${text} read as ${u}` : undefined);
}

/** Signed grams for a metal balance: Dr positive, Cr negative. */
export function parseSignedWeight(raw: unknown, unit: WeightUnit = 'g'): Parsed<Decimal> {
  const text = cellText(raw);
  const n = parseBalance(raw, 6);
  if (!n.ok) return n;
  const u = unitIn(text) ?? unit;
  return ok(round(mul(n.value, GRAMS_PER[u]), 3));
}

/* --------------------------------------------------------------- dates */

export const DATE_FORMATS = ['DMY', 'MDY', 'YMD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');
const validDay = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate() && y >= 1900 && y <= 2100;
const fullYear = (y: number) => (y >= 100 ? y : y < 50 ? 2000 + y : 1900 + y);
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * A date in any of the shapes old exports use. `format` settles 03/04/2024;
 * a date that only makes sense the other way round is read that way and said so.
 */
export function parseDate(raw: unknown, format: DateFormat = 'DMY'): Parsed<string> {
  const text = cellText(raw).replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
  if (!text) return bad('is empty');

  // An Excel serial day number (1 = 1900-01-01, with Excel's leap-year bug).
  if (/^\d{5}(\.\d+)?$/.test(text)) {
    const serial = Math.floor(Number(text));
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return ok(iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
    }
  }
  // 2024-03-31, 2024/03/31, 2024.03.31, optionally with a time after it.
  let m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validDay(y, mo, d) ? ok(iso(y, mo, d)) : bad(`"${text}" is not a real date`);
  }
  // 31-Mar-2024, 31 March 24, Mar 31, 2024, March 31 2024
  m = text.match(/^(\d{1,2})[\s\-/.]+([a-z]{3,9})[\s\-/.,]+(\d{2,4})/i);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    const [d, mo, y] = [Number(m[1]), MONTHS[m[2]!.toLowerCase()]!, fullYear(Number(m[3]))];
    return validDay(y, mo, d) ? ok(iso(y, mo, d)) : bad(`"${text}" is not a real date`);
  }
  m = text.match(/^([a-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2,4})/i);
  if (m && MONTHS[m[1]!.toLowerCase()]) {
    const [mo, d, y] = [MONTHS[m[1]!.toLowerCase()]!, Number(m[2]), fullYear(Number(m[3]))];
    return validDay(y, mo, d) ? ok(iso(y, mo, d)) : bad(`"${text}" is not a real date`);
  }
  // 31/03/2024, 03-31-24, 31.3.2024, 31032024
  m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:[ T].*)?$/) ?? text.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), fullYear(Number(m[3]))];
    const [d, mo] = format === 'MDY' ? [b, a] : [a, b];
    if (validDay(y, mo, d)) return ok(iso(y, mo, d));
    if (validDay(y, d, mo)) return ok(iso(y, d, mo), `"${text}" only makes sense as ${iso(y, d, mo)}, so it was read that way`);
    return bad(`"${text}" is not a real date`);
  }
  return bad(`"${text}" is not a date this import can read — use DD/MM/YYYY`);
}

/* ---------------------------------------------------- text and identity */

const TRUE_WORDS = new Set(['yes', 'y', 'true', 't', '1', 'active', 'on', 'x', '✓', '✔', 'haan', 'ha']);
const FALSE_WORDS = new Set(['no', 'n', 'false', 'f', '0', 'inactive', 'off', 'nahi']);

export function parseBool(raw: unknown): Parsed<boolean> {
  if (typeof raw === 'boolean') return ok(raw);
  const t = cellText(raw).toLowerCase();
  if (TRUE_WORDS.has(t)) return ok(true);
  if (FALSE_WORDS.has(t)) return ok(false);
  return bad(`"${cellText(raw)}" is not yes or no`);
}

/**
 * An Indian phone number, stored as +91XXXXXXXXXX the way the masters store it.
 * Where a cell holds two numbers ("98765 43210 / 99887 76655") the first is kept.
 */
export function parsePhone(raw: unknown): Parsed<string> {
  let text = cellText(raw);
  if (SCIENTIFIC.test(text)) text = numberText(Number(text));
  const parts = text.split(/[/,;|]|\s{2,}|\bor\b/i).map((p) => p.trim()).filter((p) => /\d/.test(p));
  const first = parts[0] ?? '';
  const digits = first.replace(/\D/g, '');
  const note = parts.length > 1 ? `more than one number in "${text}"; the first was kept` : undefined;
  if (digits.length === 10) return ok(`+91${digits}`, note);
  if (digits.length === 11 && digits.startsWith('0')) return ok(`+91${digits.slice(1)}`, note);
  if (digits.length === 12 && digits.startsWith('91')) return ok(`+${digits}`, note);
  if (digits.length === 13 && digits.startsWith('091')) return ok(`+${digits.slice(1)}`, note);
  if (digits.length >= 10 && digits.length <= 13) return ok(`+${digits}`, note);
  return bad(`"${text}" is not a phone number (10 to 13 digits)`);
}

export function parseEmail(raw: unknown): Parsed<string> {
  const t = cellText(raw).toLowerCase().replace(/^mailto:/, '');
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(t) ? ok(t) : bad(`"${cellText(raw)}" is not an email address`);
}

export function parseGstin(raw: unknown): Parsed<string> {
  const t = cellText(raw).toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(t) ? ok(t) : bad(`"${cellText(raw)}" is not a GSTIN`);
}

export function parsePan(raw: unknown): Parsed<string> {
  const t = cellText(raw).toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(t) ? ok(t) : bad(`"${cellText(raw)}" is not a PAN`);
}

export function parsePincode(raw: unknown): Parsed<string> {
  const t = cellText(raw).replace(/\s/g, '');
  return /^[1-9]\d{5}$/.test(t) ? ok(t) : bad(`"${cellText(raw)}" is not a 6-digit PIN code`);
}

/** Uppercase letters, digits and hyphens, the way codes are kept. */
export function parseCode(raw: unknown, max = 30): Parsed<string> {
  const t = cellText(raw).toUpperCase();
  if (t.length > max) return bad(`"${t}" is longer than ${max} characters`);
  return ok(t);
}

/** A code made from a name when the file has none: "Gold Chain 22K" → GOLD-CHAIN-22K. */
export function deriveCode(name: string, taken: Set<string>, max = 30): string {
  const base = (normKey(name).toUpperCase().replace(/ /g, '-') || 'ITEM').slice(0, max - 4);
  let code = base;
  for (let n = 2; taken.has(code); n++) code = `${base}-${n}`;
  taken.add(code);
  return code;
}

export interface EnumOption { value: string; label: string; synonyms?: string[] }

/** One of a closed set of values, written as its value, its label or a common synonym. */
export function parseEnum(raw: unknown, options: EnumOption[]): Parsed<string> {
  const k = squash(raw);
  const found = options.find((o) => [o.value, o.label, ...(o.synonyms ?? [])].some((s) => squash(s) === k));
  return found ? ok(found.value) : bad(`"${cellText(raw)}" is not one of ${options.map((o) => o.label).join(', ')}`);
}

/* ------------------------------------------------------------ purities */

/**
 * What a purity cell is saying, before it is matched to the shop's own
 * purities: 22K / 22 KT / 22ct → karat 22; 916 / 91.6 / 91.6% / 0.916 → 91.6% fine.
 */
export function purityHint(raw: unknown): { karat?: number; fineness?: Decimal; text: string } | null {
  const text = cellText(raw);
  if (!text) return null;
  const t = text.toLowerCase();
  const n = t.match(/\d+(\.\d+)?/);
  if (!n) return { text };
  const value = n[0];
  if (/k\b|kt|karat|carat|ct\b|k$/.test(t.replace(value, ' ')) || (Number(value) <= 24 && !t.includes('%') && !t.includes('.'))) {
    const karat = Number(value);
    if (karat > 0 && karat <= 24) return { karat, fineness: round(div(mul(String(karat), '100'), '24'), 3), text };
  }
  let fineness: Decimal;
  if (compare(value, '1') < 0) fineness = mul(value, '100');
  else if (compare(value, '100') <= 0) fineness = value;
  else if (compare(value, '1000') <= 0) fineness = div(value, '10');
  else return { text };
  return { fineness: round(fineness, 3), text };
}

/* ---------------------------------------------------------------- GST */

/** GST state codes, so a customer with only a state name still gets the right tax split. */
const STATES: Array<[string, string, string[]]> = [
  ['01', 'Jammu and Kashmir', ['j&k', 'jk', 'jammu kashmir']], ['02', 'Himachal Pradesh', ['hp']], ['03', 'Punjab', ['pb']],
  ['04', 'Chandigarh', ['ch']], ['05', 'Uttarakhand', ['uttaranchal', 'uk']], ['06', 'Haryana', ['hr']], ['07', 'Delhi', ['new delhi', 'nct of delhi', 'dl']],
  ['08', 'Rajasthan', ['rj']], ['09', 'Uttar Pradesh', ['up']], ['10', 'Bihar', ['br']], ['11', 'Sikkim', ['sk']],
  ['12', 'Arunachal Pradesh', ['ar']], ['13', 'Nagaland', ['nl']], ['14', 'Manipur', ['mn']], ['15', 'Mizoram', ['mz']],
  ['16', 'Tripura', ['tr']], ['17', 'Meghalaya', ['ml']], ['18', 'Assam', ['as']], ['19', 'West Bengal', ['wb', 'bengal']],
  ['20', 'Jharkhand', ['jh']], ['21', 'Odisha', ['orissa', 'od']], ['22', 'Chhattisgarh', ['chattisgarh', 'cg']],
  ['23', 'Madhya Pradesh', ['mp']], ['24', 'Gujarat', ['gj', 'gujrat']], ['26', 'Dadra and Nagar Haveli and Daman and Diu', ['daman', 'diu', 'dadra', 'dnh']],
  ['27', 'Maharashtra', ['mh', 'maharastra']], ['29', 'Karnataka', ['ka']], ['30', 'Goa', ['ga']], ['31', 'Lakshadweep', ['ld']],
  ['32', 'Kerala', ['kl']], ['33', 'Tamil Nadu', ['tn', 'tamilnadu']], ['34', 'Puducherry', ['pondicherry', 'py']],
  ['35', 'Andaman and Nicobar Islands', ['andaman', 'an']], ['36', 'Telangana', ['ts', 'tg']], ['37', 'Andhra Pradesh', ['ap']], ['38', 'Ladakh', ['la']],
];

export function stateCodeFor(state: unknown): string | null {
  const k = normKey(state).replace(/&/g, 'and');
  if (!k) return null;
  if (/^\d{1,2}$/.test(k)) return k.padStart(2, '0');
  const hit = STATES.find(([, name, alt]) => normKey(name) === k || alt.includes(k) || normKey(name).replace(/ /g, '') === k.replace(/ /g, ''));
  return hit?.[0] ?? null;
}

export const stateNameFor = (code: string | null | undefined): string | null => STATES.find(([c]) => c === code)?.[1] ?? null;

/** Headings old exports give a mobile number column. */
export const PHONE_WORDS = [
  'mobile', 'mobile no', 'mob no', 'mob', 'mobile number', 'phone', 'phone no', 'ph no', 'contact', 'contact no',
  'contact number', 'cell', 'cell no', 'whatsapp', 'whatsapp no',
];
