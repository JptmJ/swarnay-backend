/**
 * One-time: brings existing orders up to the current Orders design. Safe to re-run.
 *
 * Two things changed under rows that already exist:
 *
 *   - How an order is priced is now named for what it means — `booking` (the
 *     rate the day it was taken), `delivery` (the rate the day it is billed)
 *     and `fixed` (agreed and typed in) — instead of today / floating /
 *     fixed_future.
 *   - An order advance goes through Masters → Payment Modes like every other
 *     tender, so it carries a payment method, a date and a receipt number
 *     rather than a loose `mode` word.
 *
 * Old advances were never posted to the books by the code that wrote them, so
 * this only makes their rows valid; it does not invent ledger entries for them.
 * Run this before `npm run db:migrate`.
 */
import '../bootstrap.js';
import { asPlatform, asTenant } from '../core/db/client.js';
import { closePool } from '../core/db/pool.js';

const RATE_LOCK: Record<string, string> = { today: 'booking', floating: 'delivery', fixed_future: 'fixed' };
/** The old free-text mode, matched to the kind of payment method a shop actually has. */
const MODE_KIND: Record<string, string> = {
  cash: 'cash', card: 'card', upi: 'upi', bank_transfer: 'bank', cheque: 'cheque', emi: 'card',
  old_gold: 'old_gold', scheme: 'scheme',
};

async function main(): Promise<void> {
  const tenants = await asPlatform((tx) => tx.query<{ id: string; code: string }>(
    `select id, code from tenant where deleted_at is null order by created_at`,
  ));

  for (const tenant of tenants) {
    await asTenant(tenant.id, async (tx) => {
      const notes: string[] = [];

      /* 1. The rate lock, renamed. The old rule only allows the old words, so it
         goes first; db:migrate puts the new one back. */
      await tx.query(`alter table retail_order drop constraint if exists ck_retail_order_rate_lock_type`);
      let locks = 0;
      for (const [from, to] of Object.entries(RATE_LOCK)) {
        const moved = await tx.query(
          `update retail_order set rate_lock_type = $2, updated_at = now() where rate_lock_type = $1 returning id`, [from, to]);
        locks += moved.length;
      }
      if (locks) notes.push(`${locks} order(s) renamed to the new rate lock`);

      /* 2. Advances onto the Payment Modes master. The columns are added here,
         nullable, so the rows can be filled before db:migrate makes them required. */
      await tx.query(`alter table order_payment add column if not exists payment_method_id uuid`);
      await tx.query(`alter table order_payment add column if not exists doc_date date`);
      await tx.query(`alter table order_payment add column if not exists status text not null default 'posted'`);
      await tx.query(`alter table order_payment add column if not exists cancelled_at timestamptz`);
      await tx.query(`alter table order_payment add column if not exists cancel_reason text`);

      const methods = await tx.query<{ id: string; kind: string }>(
        `select id, kind from payment_method where is_active and deleted_at is null order by code`);
      const byKind = new Map(methods.map((m) => [m.kind, m.id]));
      const fallback = byKind.get('cash') ?? methods[0]?.id ?? null;
      /* Shops migrated earlier no longer carry the old free-text mode; those
         advances fall back to the shop's cash mode, which is what they were. */
      const hasMode = Boolean(await tx.maybeOne(
        `select 1 from information_schema.columns where table_name = 'order_payment' and column_name = 'mode'`));

      const pending = await tx.query<{ id: string; mode: string | null; received_at: string }>(
        `select id, ${hasMode ? 'mode' : 'null::text as mode'}, received_at from order_payment where payment_method_id is null`);
      let filled = 0;
      for (const p of pending) {
        const methodId = byKind.get(MODE_KIND[p.mode ?? ''] ?? '') ?? fallback;
        if (!methodId) continue;                  // a shop with no payment modes at all
        await tx.query(
          `update order_payment set payment_method_id = $2, doc_date = coalesce(doc_date, received_at::date) where id = $1`,
          [p.id, methodId]);
        filled += 1;
      }
      if (filled) notes.push(`${filled} advance(s) moved onto Payment Modes`);

      /* 3. A receipt number for advances taken before they had one. */
      const unnumbered = await tx.query<{ id: string }>(
        `select id from order_payment where receipt_number is null or btrim(receipt_number) = '' order by received_at`);
      for (const [i, row] of unnumbered.entries()) {
        await tx.query(`update order_payment set receipt_number = $2 where id = $1`, [row.id, `RCT-LEGACY-${String(i + 1).padStart(5, '0')}`]);
      }
      if (unnumbered.length) notes.push(`${unnumbered.length} advance(s) given a receipt number`);

      const stillEmpty = await tx.one<{ n: number }>(
        `select count(*)::int n from order_payment where payment_method_id is null or doc_date is null`);
      if (stillEmpty.n > 0) {
        notes.push(`${stillEmpty.n} advance(s) could NOT be filled — add a payment mode in Masters, then run this again`);
      }
      console.log(`${tenant.code}: ${notes.length ? notes.join('; ') : 'already up to date'}`);
    });
  }
  console.log('\nDone. Now run: npm run db:migrate');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(closePool);
