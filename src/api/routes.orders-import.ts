/**
 * Bulk import of orders — a shop moving from other software brings its open
 * (and past) orders at once, often tens of thousands of them.
 *
 * The app reads the spreadsheet in the browser, lets the user say which column
 * is which, and sends it here in chunks of up to 1,000 rows. Each row becomes
 * one order with one line, priced by the same engine as an order typed in by
 * hand. Every rule the database would enforce is checked here first, so one
 * bad row is reported with its spreadsheet row number instead of sinking the
 * whole chunk. Rows carrying a `reference` (the order number in the old
 * software) are skipped if that reference was imported before, so running the
 * same file twice never duplicates an order.
 */
import { z } from 'zod';
import { defineRoute } from '../core/http/route-registry.js';
import { transaction, type Tx } from '../core/db/client.js';
import { repo } from '../core/db/repository.js';
import { recordAudit } from '../core/audit.js';
import { BusinessRuleError } from '../core/errors/app-error.js';
import { compare, sub, type Decimal } from '../core/util/decimal.js';
import { newId } from '../core/util/id.js';
import { normalizePhone } from '../modules/identity/auth.service.js';
import { reserveDocumentNumbers } from '../modules/numbering/numbering.service.js';
import { loadPricingSettings, priceLine, totalDocument } from '../modules/pricing/pricing.service.js';
import { masterRates, pipelineFor } from '../modules/orders/orders.service.js';
import { ALL_STAGE_KEYS, ORDER_TYPES, type OrderType, type StageSpec } from '../modules/orders/order-pipelines.js';
import { decimal, errorEnvelope } from './schemas.js';

type Raw = Record<string, unknown>;

/** Text exactly as typed, trimmed; blank means "not given". */
const text = (max: number) =>
  z.preprocess((v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() || undefined : v), z.string().max(max).optional());
/** A number as a person types it in a sheet: "6,450", "₹ 6450.50". Never negative. */
const amount = z.preprocess(
  (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[,₹\s]/g, '') || undefined : v),
  decimal.refine((v) => !v.startsWith('-'), 'Cannot be negative.').optional(),
);
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s-]+/g, '_') || undefined : v);

/** 2026-10-09, 09/10/2026, 9-10-26 (day first, as written in India) or an Excel day number. */
export function toIsoDate(v: unknown): unknown {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t) return undefined;
  let iso = t;
  const dmy = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (dmy) iso = `${dmy[3]!.length === 2 ? `20${dmy[3]}` : dmy[3]}-${dmy[2]!.padStart(2, '0')}-${dmy[1]!.padStart(2, '0')}`;
  else if (/^\d{5}$/.test(t)) iso = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86_400_000).toISOString().slice(0, 10);
  else if (/^\d{4}-\d{2}-\d{2}[T ]/.test(t)) iso = t.slice(0, 10);
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? t : iso;
}
const date = z.preprocess(toIsoDate, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-09 or 09/10/2026.'));

const PAYMENT_MODES = ['cash', 'card', 'upi', 'bank_transfer', 'cheque'] as const;

const orderRow = z.object({
  reference: text(80).describe('Order number in the old software. Re-importing skips it.'),
  customer_code: text(40), customer_phone: text(30), customer_name: text(120),
  order_type: z.preprocess(lower, z.enum(ORDER_TYPES).optional()),
  order_date: date.optional(),
  expected_delivery_date: date,
  title: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().min(1, 'Give the item or a short title.').max(200)),
  design_specification: text(2000),
  metal: text(40), purity: text(20),
  quantity: amount, gross_weight: amount, stone_weight: amount,
  rate_per_gram: amount,
  making_basis: z.preprocess(lower, z.enum(['per_gram', 'percent', 'flat']).optional()),
  making_rate: amount, wastage_percent: amount,
  stone_amount: amount, discount_amount: amount,
  advance_amount: amount,
  advance_mode: z.preprocess(lower, z.enum(PAYMENT_MODES).optional()),
  stage: z.preprocess(lower, z.string().max(40).optional()),
  karigar_code: text(40), hsn_code: text(8), notes: text(2000),
  company_name: text(200), po_reference: text(80),
  repair_item_description: text(500), event_date: date.optional(),
}).refine((r) => r.customer_code || r.customer_phone, { message: 'Give customer_phone or customer_code.', path: ['customer_phone'] });
type OrderRow = z.infer<typeof orderRow>;

interface Party { id: string; code: string; name: string; phone: string | null; state_code: string | null; is_customer: boolean }
interface Purity { id: string; code: string; metal_code: string; metal_name: string; fineness: Decimal }

const today = () => new Date().toISOString().slice(0, 10);
const issueText = (e: z.ZodError) => { const i = e.issues[0]!; return `${i.path.join('.') || 'row'}: ${i.message}`; };

async function lookups(tx: Tx, rows: OrderRow[]) {
  const codes = [...new Set(rows.map((r) => r.customer_code?.toUpperCase()).filter((v): v is string => !!v))];
  const phones = [...new Set(rows.map((r) => (r.customer_phone ? normalizePhone(r.customer_phone) : null)).filter((v): v is string => !!v))];
  const refs = [...new Set(rows.map((r) => r.reference).filter((v): v is string => !!v))];
  const karigars = [...new Set(rows.map((r) => r.karigar_code?.toUpperCase()).filter((v): v is string => !!v))];
  const [parties, purities, existing, karigarRows, branch] = await Promise.all([
    codes.length || phones.length
      ? tx.query<Party>(
          `select id, upper(code) as code, name, phone, state_code, is_customer from party
            where deleted_at is null and (upper(code) = any($1::text[]) or phone = any($2::text[]))`, [codes, phones])
      : Promise.resolve([] as Party[]),
    tx.query<Purity>(
      `select p.id, upper(p.code) as code, upper(m.code) as metal_code, m.name as metal_name, p.fineness_percent::text as fineness
         from purity p join metal m on m.id = p.metal_id where p.is_active and m.is_active`),
    refs.length
      ? tx.query<{ external_reference: string; order_number: string }>(
          `select external_reference, order_number from retail_order where external_reference = any($1::text[])`, [refs])
      : Promise.resolve([]),
    karigars.length
      ? tx.query<{ id: string; code: string }>(`select id, upper(code) as code from karigar where deleted_at is null and upper(code) = any($1::text[])`, [karigars])
      : Promise.resolve([]),
    tx.one<{ state_code: string | null }>(`select state_code from branch where id = $1`, [tx.context.branchId]),
  ]);
  return {
    byCode: new Map(parties.map((p) => [p.code, p])),
    byPhone: new Map(parties.filter((p) => p.phone).map((p) => [p.phone!, p])),
    purities,
    existing: new Map(existing.map((e) => [e.external_reference, e.order_number])),
    karigars: new Map(karigarRows.map((k) => [k.code, k.id])),
    branchState: branch.state_code,
  };
}

/** "22K", or "Gold 22K" when the same code exists for two metals (999 gold and 999 silver). */
function findPurity(purities: Purity[], code: string, metal: string | undefined): Purity | string {
  const wanted = code.toUpperCase().replace(/\s+/g, '');
  const m = metal?.toUpperCase();
  const matches = purities.filter((p) => p.code.replace(/\s+/g, '') === wanted && (!m || p.metal_code === m || p.metal_name.toUpperCase() === m));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) return `Purity "${code}"${metal ? ` for ${metal}` : ''} does not exist in Masters → Purity.`;
  return `Purity "${code}" exists for ${matches.map((p) => p.metal_name).join(' and ')} — add a metal column.`;
}

defineRoute({
  method: 'post', path: '/api/orders/import', module: 'orders',
  summary: 'Import orders in bulk',
  description:
    'Up to 1,000 rows a call; send a big file as several calls, passing `firstRow` so problems name the spreadsheet row. One row = one order with one line, at the branch in `X-Branch-Id`.\n\n' +
    '**Customer**: matched on `customer_code`, else `customer_phone`. A phone nobody has yet becomes a new customer when `customer_name` is given.\n' +
    '**Price**: `rate_per_gram`, else today’s sale rate in Masters → Rates for the purity. A purity with weight and no rate anywhere is refused (repairs excepted).\n' +
    '**Stage**: a stage key of that order type’s pipeline (default: its first). A terminal stage imports the order as completed.\n' +
    '**reference**: the old order number; a reference already imported is skipped, not duplicated.\n\n' +
    'Past order dates are allowed here even when back-dating is switched off, since bringing old orders across is the point.',
  permission: 'orders.import',
  body: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
    firstRow: z.number().int().min(1).default(2).describe('Spreadsheet row of rows[0] — 2 when row 1 holds the headings.'),
  }),
  responses: [
    { status: 200, description: 'What happened to each row.', schema: z.object({
      received: z.number(), inserted: z.number(),
      skipped: z.number().describe('Rows whose reference was imported before.'),
      customersCreated: z.number(),
      failed: z.array(z.object({ row: z.number(), message: z.string() })),
    }) },
    { status: 403, description: 'Missing `orders.import`.', schema: errorEnvelope },
    { status: 422, description: '`business_rule` — no branch selected.', schema: errorEnvelope },
  ],
  changelog: [{ date: '2026-10-10', kind: 'added', note: 'Bulk order import with customer matching, master-rate pricing and re-import protection.' }],
  handler: async (req) => transaction(async (tx) => {
    if (!tx.context.branchId) throw new BusinessRuleError('Select a branch before importing orders.');
    const { rows, firstRow } = req.body as { rows: Raw[]; firstRow: number };
    const failed: { row: number; message: string }[] = [];
    const fail = (row: number, message: string) => { failed.push({ row, message }); };

    const parsed: { row: number; data: OrderRow }[] = [];
    rows.forEach((raw, i) => {
      const r = orderRow.safeParse(raw);
      if (r.success) parsed.push({ row: firstRow + i, data: r.data });
      else fail(firstRow + i, issueText(r.error));
    });

    const lk = await lookups(tx, parsed.map((p) => p.data));
    const types = [...new Set(parsed.map((p) => p.data.order_type ?? 'booking'))];
    const pipelines = new Map<OrderType, StageSpec[]>(await Promise.all(types.map(async (t) => [t, await pipelineFor(tx, t)] as const)));
    const settings = await loadPricingSettings(tx);

    /* ---- check every row; nothing is written yet ---- */
    let skipped = 0;
    const seenRefs = new Map<string, number>();
    const newCustomers = new Map<string, { name: string; phone: string }>();
    const ready: { row: number; data: OrderRow; type: OrderType; stage: StageSpec; purity: Purity | null; party: Party | null; phone: string | null }[] = [];

    for (const { row, data } of parsed) {
      if (data.reference) {
        if (lk.existing.has(data.reference)) { skipped += 1; continue; }
        const earlier = seenRefs.get(data.reference);
        if (earlier) { fail(row, `reference ${data.reference} is also on row ${earlier}.`); continue; }
        seenRefs.set(data.reference, row);
      }
      const type = (data.order_type ?? 'booking') as OrderType;
      const stages = pipelines.get(type)!;
      const stage = data.stage ? stages.find((s) => s.key === data.stage) : stages[0];
      if (!stage) { fail(row, `Stage "${data.stage}" is not in the ${type} pipeline. Use one of: ${stages.map((s) => s.key).join(', ')}.`); continue; }
      if (!(ALL_STAGE_KEYS as readonly string[]).includes(stage.key)) { fail(row, `Stage "${stage.key}" cannot be imported. Import at another stage and move it on the board.`); continue; }

      const orderDate = data.order_date ?? today();
      if (data.expected_delivery_date < orderDate) { fail(row, 'expected_delivery_date is before the order date.'); continue; }
      if (type === 'corporate' && (!data.company_name || !data.po_reference)) { fail(row, 'Corporate orders need company_name and po_reference.'); continue; }
      if (data.stone_weight && compare(data.stone_weight, data.gross_weight ?? '0') > 0) { fail(row, 'stone_weight is more than gross_weight.'); continue; }
      if (data.quantity && !(compare(data.quantity, '0') > 0)) { fail(row, 'quantity must be more than 0.'); continue; }
      if (data.karigar_code && !lk.karigars.has(data.karigar_code.toUpperCase())) { fail(row, `Karigar "${data.karigar_code}" does not exist.`); continue; }

      let purity: Purity | null = null;
      if (data.purity) {
        const found = findPurity(lk.purities, data.purity, data.metal);
        if (typeof found === 'string') { fail(row, found); continue; }
        purity = found;
      } else if (data.gross_weight && compare(data.gross_weight, '0') > 0 && type !== 'repair') {
        fail(row, 'Give the purity for an order with a weight, so it can be priced.'); continue;
      }

      const phone = data.customer_phone ? normalizePhone(data.customer_phone) : null;
      if (phone && !/^\+\d{10,13}$/.test(phone)) { fail(row, `customer_phone "${data.customer_phone}" is not a phone number.`); continue; }
      const party = (data.customer_code ? lk.byCode.get(data.customer_code.toUpperCase()) : undefined) ?? (phone ? lk.byPhone.get(phone) : undefined) ?? null;
      if (party && !party.is_customer) { fail(row, `${party.name} is not marked as a customer.`); continue; }
      if (!party) {
        if (!phone || !data.customer_name) {
          fail(row, `No customer ${data.customer_code ?? data.customer_phone}. Add customer_name and customer_phone to create them, or import customers first.`);
          continue;
        }
        if (!newCustomers.has(phone)) newCustomers.set(phone, { name: data.customer_name, phone });
      }
      ready.push({ row, data, type, stage, purity, party, phone });
    }

    const rates = await masterRates(tx, ready.map((r) => r.purity?.id), tx.context.branchId);

    /* ---- price ---- */
    const priced = ready.flatMap((r) => {
      const rate = r.data.rate_per_gram ?? (r.purity ? rates.get(r.purity.id) : undefined);
      const hasWeight = r.data.gross_weight && compare(r.data.gross_weight, '0') > 0;
      if (!rate && hasWeight && r.type !== 'repair') {
        fail(r.row, `No rate for ${r.purity!.metal_name} ${r.purity!.code} in Masters → Rates. Set today’s rate there, or add a rate_per_gram column.`);
        return [];
      }
      const customerState = r.party?.state_code ?? null;
      const line = priceLine({
        quantity: r.data.quantity, grossWeight: r.data.gross_weight ?? '0', stoneWeight: r.data.stone_weight,
        purityPercent: r.purity?.fineness ?? '100', ratePerGram: rate ?? '0',
        makingBasis: r.data.making_basis, makingRate: r.data.making_rate, wastagePercent: r.data.wastage_percent,
        stoneAmount: r.data.stone_amount, discountAmount: r.data.discount_amount,
        interState: Boolean(lk.branchState && customerState && lk.branchState !== customerState),
      }, settings);
      const totals = totalDocument([line], settings);
      const advance = r.data.advance_amount ?? '0';
      if (compare(advance, totals.totalAmount) > 0) {
        fail(r.row, `advance_amount ${advance} is more than the order value ${totals.totalAmount}.`);
        return [];
      }
      if (compare(totals.totalAmount, '0') < 0) { fail(r.row, 'The discount is more than the order value.'); return []; }
      return [{ ...r, line, totals, advance }];
    });

    if (!priced.length) {
      return { received: rows.length, inserted: 0, skipped, customersCreated: 0, failed: failed.sort((a, b) => a.row - b.row) };
    }

    /* ---- new customers, only those still needed ---- */
    const needed = [...newCustomers.values()].filter((c) => priced.some((p) => !p.party && p.phone === c.phone));
    const created = new Map<string, string>();
    if (needed.length) {
      const { numbers } = await reserveDocumentNumbers(tx, 'party', needed.length);
      const inserted = await repo<{ id: string; phone: string }>(tx, 'party').insertMany(
        needed.map((c, i) => ({ code: numbers[i], name: c.name, phone: c.phone, is_customer: true })));
      for (const p of inserted) created.set(p.phone, p.id);
    }

    /* ---- numbers, by month so a {MM} or yearly reset in the series stays right ---- */
    const byMonth = new Map<string, typeof priced>();
    for (const p of priced) {
      const month = (p.data.order_date ?? today()).slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), p]);
    }
    const numberOf = new Map<number, string>();
    for (const [month, group] of byMonth) {
      const { numbers } = await reserveDocumentNumbers(tx, 'retail_order', group.length, {
        branchId: tx.context.branchId, date: new Date(`${month}-01T00:00:00Z`),
      });
      group.forEach((p, i) => numberOf.set(p.row, numbers[i]!));
    }

    /* ---- write ---- */
    const orders = priced.map((p) => ({ ...p, id: newId() }));
    await repo(tx, 'retail_order').insertMany(orders.map((p) => {
      const t = p.totals;
      const done = Boolean(p.stage.terminal);
      return {
        id: p.id, order_number: numberOf.get(p.row), order_type: p.type,
        status: done ? 'completed' : 'active', stage: p.stage.key,
        branch_id: tx.context.branchId, customer_id: p.party?.id ?? created.get(p.phone!),
        salesperson_id: tx.context.userId,
        karigar_id: p.data.karigar_code ? lk.karigars.get(p.data.karigar_code.toUpperCase()) : null,
        order_date: p.data.order_date ?? today(), expected_delivery_date: p.data.expected_delivery_date,
        delivered_at: done ? `${p.data.expected_delivery_date}T00:00:00Z` : null,
        rate_lock_type: 'today', locked_rate_per_gram: p.line.ratePerGram,
        rate_locked_at: compare(p.line.ratePerGram, '0') > 0 ? new Date() : null,
        metal_amount: t.metalAmount, making_amount: t.makingAmount, stone_amount: t.stoneAmount,
        discount_amount: t.discountAmount, taxable_amount: t.taxableAmount,
        cgst_amount: t.cgstAmount, sgst_amount: t.sgstAmount, igst_amount: t.igstAmount,
        total_amount: t.totalAmount, advance_amount: p.advance, balance_amount: sub(t.totalAmount, p.advance),
        total_gross_weight: t.totalGrossWeight, total_net_weight: t.totalNetWeight,
        design_approval: p.type === 'custom' ? 'pending' : null,
        production_status: p.type === 'custom' ? 'not_started' : null,
        repair_item_description: p.type === 'repair' ? p.data.repair_item_description ?? p.data.title : p.data.repair_item_description ?? null,
        event_date: p.data.event_date ?? null,
        company_name: p.data.company_name ?? null, po_reference: p.data.po_reference ?? null,
        notes: p.data.notes ?? null, external_reference: p.data.reference ?? null,
      };
    }));
    await repo(tx, 'order_line').insertMany(orders.map((p) => ({
      retail_order_id: p.id, line_number: 1, line_mode: p.type === 'custom' ? 'custom' : 'booking',
      title: p.data.title, design_specification: p.data.design_specification ?? null,
      purity_id: p.purity?.id ?? null, hsn_code: p.data.hsn_code ?? null,
      quantity: p.line.quantity, gross_weight: p.line.grossWeight, stone_weight: p.line.stoneWeight, net_weight: p.line.netWeight,
      rate_per_gram: p.line.ratePerGram, metal_amount: p.line.metalAmount,
      making_basis: p.line.makingBasis, making_rate: p.line.makingRate, making_amount: p.line.makingAmount,
      wastage_percent: p.line.wastagePercent, stone_amount: p.line.stoneAmount, discount_amount: p.line.discountAmount,
      taxable_amount: p.line.taxableAmount, gst_rate: p.line.gstRate,
      cgst_amount: p.line.cgstAmount, sgst_amount: p.line.sgstAmount, igst_amount: p.line.igstAmount, line_total: p.line.lineTotal,
    })));
    await repo(tx, 'order_stage_event').insertMany(orders.map((p) => ({
      retail_order_id: p.id, from_stage: null, to_stage: p.stage.key, direction: 'forward',
      note: p.data.reference ? `Imported (was ${p.data.reference})` : 'Imported', actor_user_id: tx.context.userId,
    })));
    const paid = orders.filter((p) => compare(p.advance, '0') > 0);
    await repo(tx, 'order_payment').insertMany(paid.map((p) => ({
      retail_order_id: p.id, mode: p.data.advance_mode ?? 'cash', amount: p.advance,
      received_at: `${p.data.order_date ?? today()}T00:00:00Z`, notes: 'Advance brought across in an import',
    })));

    await recordAudit(tx, 'retail_order.import', 'branch', tx.context.branchId, {
      received: rows.length, inserted: orders.length, skipped, customersCreated: created.size, failed: failed.length, firstRow,
    });
    return {
      received: rows.length, inserted: orders.length, skipped, customersCreated: created.size,
      failed: failed.sort((a, b) => a.row - b.row),
    };
  }),
});
