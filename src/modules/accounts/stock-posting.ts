/**
 * Stock that changes without a bill — a shortage, a count, an opening balance,
 * a parcel between branches — still changes what the business owns. These
 * write that change to the books, in rupees and in fine grams, so Stock in
 * Hand in the balance sheet is the stock in the safe.
 */
import type { Tx } from '../../core/db/client.js';
import { add, compare, isZero, sub, type Decimal } from '../../core/util/decimal.js';
import { businessDate } from '../../core/util/business-date.js';
import type { VoucherType } from './accounts.schema.js';
import { postVoucher, type MetalEntry, type MoneyEntry } from './ledger.service.js';

export interface StockMove {
  direction: 'in' | 'out';
  locationId: string;
  purityId?: string | null;
  grossWeight?: Decimal;
  fineWeight?: Decimal;
  value?: Decimal;
}

/**
 * Posts the net effect of some stock movements, one voucher per branch: the
 * value against `counterCode` (Stock Adjustments, Opening Balance Difference,
 * Branch Transfers in Transit) and the fine grams on Metal Stock by purity.
 * Nothing is posted when nothing changed.
 */
export async function postStockValue(tx: Tx, input: {
  voucherType: VoucherType; counterCode: string; sourceType: string; sourceId: string;
  narration: string; moves: StockMove[]; voucherDate?: string;
}): Promise<string[]> {
  const moves = input.moves.filter((m) => !isZero(m.value ?? '0') || !isZero(m.fineWeight ?? '0'));
  if (moves.length === 0) return [];
  const [locations, purities] = await Promise.all([
    tx.query<{ id: string; branch_id: string }>(`select id, branch_id from stock_location where id = any($1::uuid[])`,
      [[...new Set(moves.map((m) => m.locationId))]]),
    tx.query<{ id: string; metal_id: string }>(`select id, metal_id from purity where id = any($1::uuid[])`,
      [[...new Set(moves.flatMap((m) => (m.purityId ? [m.purityId] : [])))]]),
  ]);
  const branchOf = new Map(locations.map((l) => [l.id, l.branch_id]));
  const metalOf = new Map(purities.map((p) => [p.id, p.metal_id]));
  const date = input.voucherDate ?? (await businessDate(tx));

  const byBranch = new Map<string, StockMove[]>();
  for (const m of moves) {
    const branch = branchOf.get(m.locationId);
    if (!branch) continue;
    byBranch.set(branch, [...(byBranch.get(branch) ?? []), m]);
  }
  const vouchers: string[] = [];
  for (const [branchId, list] of byBranch) {
    const signed = (m: StockMove, v: Decimal | undefined) => (m.direction === 'in' ? v ?? '0' : sub('0', v ?? '0'));
    const value = list.reduce((s, m) => add(s, signed(m, m.value)), '0');
    const money: MoneyEntry[] = compare(value, '0') === 0 ? [] : compare(value, '0') > 0
      ? [{ accountCode: '1200', debit: value, narration: input.narration }, { accountCode: input.counterCode, credit: value, narration: input.narration }]
      : [{ accountCode: input.counterCode, debit: sub('0', value), narration: input.narration }, { accountCode: '1200', credit: sub('0', value), narration: input.narration }];

    const byPurity = new Map<string, { fine: Decimal; gross: Decimal }>();
    for (const m of list) {
      if (!m.purityId || !metalOf.has(m.purityId)) continue;
      const t = byPurity.get(m.purityId) ?? { fine: '0', gross: '0' };
      byPurity.set(m.purityId, { fine: add(t.fine, signed(m, m.fineWeight)), gross: add(t.gross, signed(m, m.grossWeight)) });
    }
    const metal: MetalEntry[] = [...byPurity].filter(([, t]) => !isZero(t.fine)).map(([purityId, t]) => ({
      accountCode: '1210', metalId: metalOf.get(purityId)!, purityId,
      grossWeight: compare(t.gross, '0') < 0 ? sub('0', t.gross) : t.gross,
      ...(compare(t.fine, '0') > 0 ? { weightIn: t.fine } : { weightOut: sub('0', t.fine) }),
      narration: input.narration,
    }));
    if (money.length === 0 && metal.length === 0) continue;
    const { voucherId } = await postVoucher(tx, {
      voucherType: input.voucherType, voucherDate: date, branchId, sourceType: input.sourceType, sourceId: input.sourceId,
      narration: input.narration, money, metal,
    });
    vouchers.push(voucherId);
  }
  return vouchers;
}
