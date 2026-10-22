/**
 * Handing out document numbers.
 *
 * The counter is bumped with `update ... returning`, which takes a row lock for
 * the rest of the transaction. Two tills billing at the same instant queue up
 * for a moment and get consecutive numbers — never the same one.
 *
 * Because the number is taken inside the caller's transaction, a rolled-back
 * invoice also rolls back its number. That is deliberate: GST auditors expect a
 * sequence with no holes in it.
 */
import type { Tx } from '../../core/db/client.js';
import { BusinessRuleError } from '../../core/errors/app-error.js';

export interface SeriesRow {
  id: string;
  doc_type: string;
  branch_id: string | null;
  prefix: string;
  suffix: string;
  padding: number;
  next_number: string;
  reset_period: 'never' | 'yearly' | 'financial_yearly' | 'monthly';
  current_period: string | null;
}

/** Indian financial year: April to March, so 15 Jan 2026 is "2025-26". */
export function financialYear(date: Date): string {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

export function periodKey(reset: SeriesRow['reset_period'], date: Date): string | null {
  switch (reset) {
    case 'never':
      return null;
    case 'yearly':
      return String(date.getFullYear());
    case 'monthly':
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    case 'financial_yearly':
      return financialYear(date);
  }
}

/**
 * Tokens a prefix or suffix may use:
 *   {FY} 2026-27 · {FYS} 26-27 · {FYY} 2026 (year the FY starts)
 *   {YYYY} 2026 · {YY} 26 · {MM} 09 (calendar) · {BRANCH} branch code
 */
function expandTokens(template: string, date: Date, branchCode: string | null): string {
  const fy = financialYear(date);
  return template
    .replaceAll('{FYS}', fy.slice(2))
    .replaceAll('{FYY}', fy.slice(0, 4))
    .replaceAll('{FY}', fy)
    .replaceAll('{YYYY}', String(date.getFullYear()))
    .replaceAll('{YY}', String(date.getFullYear() % 100).padStart(2, '0'))
    .replaceAll('{MM}', String(date.getMonth() + 1).padStart(2, '0'))
    .replaceAll('{BRANCH}', branchCode ?? '');
}

/** The counter the next document will take — 1 again once the reset period has rolled over. */
export function nextCounter(series: Pick<SeriesRow, 'next_number' | 'reset_period' | 'current_period'>, date: Date): bigint {
  const period = periodKey(series.reset_period, date);
  return period !== null && series.current_period !== period ? 1n : BigInt(series.next_number);
}

export function formatSeriesNumber(
  series: Pick<SeriesRow, 'prefix' | 'suffix' | 'padding'>, counter: bigint, date: Date, branchCode: string | null,
): string {
  return `${expandTokens(series.prefix, date, branchCode)}${counter.toString().padStart(series.padding, '0')}${expandTokens(series.suffix, date, branchCode)}`;
}

export async function nextDocumentNumber(
  tx: Tx,
  docType: string,
  options: { branchId?: string | null; date?: Date } = {},
): Promise<{ number: string; seriesId: string }> {
  const { numbers, seriesId } = await reserveDocumentNumbers(tx, docType, 1, options);
  return { number: numbers[0]!, seriesId };
}

/** Takes `count` consecutive numbers in one step — a bulk import of 1,000 customers is one update, not 1,000. */
export async function reserveDocumentNumbers(
  tx: Tx,
  docType: string,
  count: number,
  options: { branchId?: string | null; date?: Date } = {},
): Promise<{ numbers: string[]; seriesId: string }> {
  const date = options.date ?? new Date();
  const branchId = options.branchId ?? tx.context.branchId ?? null;

  // Prefer a series defined for this branch; fall back to the shared one. The
  // branch code printed is always the branch raising the document.
  const find = () => tx.maybeOne<SeriesRow & { branch_code: string | null }>(
    `select s.*, b.code as branch_code
       from numbering_series s
       left join branch b on b.id = coalesce(s.branch_id, $2)
      where s.doc_type = $1
        and s.is_active = true
        and (s.branch_id = $2 or s.branch_id is null)
      order by s.branch_id nulls last
      limit 1
      for update of s`,
    [docType, branchId],
  );

  let series = await find();
  const standard = DEFAULT_SERIES.find((s) => s.doc_type === docType);
  if (!series && standard) {
    // A document type added after this business was set up gets its standard series on first use.
    await tx.query(
      `insert into numbering_series (id, tenant_id, doc_type, name, prefix, padding, reset_period, created_by, updated_by)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $7) on conflict do nothing`,
      [tx.context.tenantId, standard.doc_type, standard.name, standard.prefix,
       'padding' in standard ? standard.padding : 5, 'reset_period' in standard ? standard.reset_period : 'financial_yearly',
       tx.context.userId],
    );
    series = await find();
  }
  if (!series) {
    throw new BusinessRuleError(
      `No numbering series is set up for "${docType}". Add one under Masters > Bill Numbers.`,
      'numbering_series_missing',
    );
  }

  const first = nextCounter(series, date);
  await tx.query(
    `update numbering_series
        set next_number = $2, current_period = $3, updated_at = now()
      where id = $1`,
    [series.id, (first + BigInt(count)).toString(), periodKey(series.reset_period, date)],
  );

  const numbers = Array.from({ length: count }, (_, i) => formatSeriesNumber(series!, first + BigInt(i), date, series!.branch_code));
  return { numbers, seriesId: series.id };
}

/** Records a number that was issued but whose document never got saved. */
export async function recordNumberGap(tx: Tx, seriesId: string, docNumber: string, reason: string): Promise<void> {
  await tx.query(
    `insert into numbering_gap (id, tenant_id, series_id, doc_number, reason, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $5)`,
    [tx.context.tenantId, seriesId, docNumber, reason, tx.context.userId],
  );
}

/** The series a new business starts with. Formats read like INV-26-27-00042. */
export const DEFAULT_SERIES = [
  { doc_type: 'purchase_order', name: 'Purchase Order', prefix: 'PO-{FYS}-' },
  { doc_type: 'goods_receipt', name: 'Goods Receipt', prefix: 'GRN-{FYS}-' },
  { doc_type: 'purchase_invoice', name: 'Purchase Invoice', prefix: 'PI-{FYS}-' },
  { doc_type: 'purchase_return', name: 'Return to Vendor', prefix: 'PR-{FYS}-' },
  { doc_type: 'sales_invoice', name: 'Sales Invoice', prefix: 'INV-{FYS}-' },
  { doc_type: 'sales_return', name: 'Customer Return', prefix: 'CRN-{FYS}-' },
  { doc_type: 'customer_receipt', name: 'Customer Receipt', prefix: 'RCT-{FYS}-' },
  { doc_type: 'supplier_settlement', name: 'Supplier Payment', prefix: 'SPY-{FYS}-' },
  { doc_type: 'approval_memo', name: 'Approval Memo', prefix: 'APM-{FYS}-' },
  { doc_type: 'stock_transfer', name: 'Stock Transfer', prefix: 'ST-{FYS}-' },
  { doc_type: 'stock_adjustment', name: 'Stock Adjustment', prefix: 'ADJ-{FYS}-' },
  { doc_type: 'stock_count', name: 'Stock Count', prefix: 'SC-{FYS}-' },
  { doc_type: 'tag', name: 'Item Tag', prefix: 'T', padding: 7, reset_period: 'never' as const },
  { doc_type: 'voucher', name: 'Accounting Voucher', prefix: 'V-{FYS}-', padding: 6 },
  { doc_type: 'retail_order', name: 'Retail Order', prefix: 'ORD-{FYS}-' },
  { doc_type: 'karigar_job', name: 'Karigar Job Card', prefix: 'KJB-{FYS}-' },
  { doc_type: 'old_gold', name: 'Old Gold Voucher', prefix: 'OG-{FYS}-' },
  { doc_type: 'melt_batch', name: 'Melt Batch', prefix: 'MELT-{FYS}-' },
  { doc_type: 'scheme_account', name: 'Scheme Account', prefix: 'SN-{FYS}-' },
  { doc_type: 'scheme_receipt', name: 'Scheme Receipt', prefix: 'SNC-{FYS}-' },
  { doc_type: 'scheme_redemption', name: 'Scheme Redemption', prefix: 'SNR-{FYS}-' },
  { doc_type: 'girvi_loan', name: 'Girvi Loan', prefix: 'GRV-{FYS}-' },
  { doc_type: 'girvi_receipt', name: 'Girvi Receipt', prefix: 'GRC-{FYS}-' },
  { doc_type: 'girvi_release', name: 'Girvi Release', prefix: 'GRL-{FYS}-' },
  { doc_type: 'girvi_packet', name: 'Girvi Vault Packet', prefix: 'PKT-{FYS}-' },
  { doc_type: 'acc_payment', name: 'Payment Voucher', prefix: 'PV-{FYS}-' },
  { doc_type: 'acc_receipt', name: 'Receipt Voucher', prefix: 'RV-{FYS}-' },
  { doc_type: 'acc_contra', name: 'Contra Voucher', prefix: 'CV-{FYS}-' },
  { doc_type: 'acc_journal', name: 'Journal Voucher', prefix: 'JV-{FYS}-' },
  { doc_type: 'acc_expense', name: 'Expense Voucher', prefix: 'EXP-{FYS}-' },
  { doc_type: 'acc_opening', name: 'Opening Balance', prefix: 'OB-{FYS}-' },
  { doc_type: 'acc_system', name: 'Closing Entry', prefix: 'CL-{FYS}-' },
  { doc_type: 'party', name: 'Customer / Supplier Code', prefix: 'C', padding: 6, reset_period: 'never' as const },
  { doc_type: 'karigar', name: 'Karigar Code', prefix: 'K', padding: 4, reset_period: 'never' as const },
] as const;
