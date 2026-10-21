/**
 * One-time: brings existing tenants up to the current master setup. Safe to re-run.
 *  - categories, GST defaults and payment methods
 *  - one shared numbering counter per document type (per-branch counters with the
 *    same format would hand two branches the same bill number)
 *  - a head office, when none is marked
 */
import '../bootstrap.js';
import type { Tx } from '../core/db/client.js';
import { asPlatform, asTenant } from '../core/db/client.js';
import { closePool } from '../core/db/pool.js';
import { createMasterDefaults } from '../modules/tenancy/provisioning.service.js';

async function shareNumbering(tx: Tx): Promise<number> {
  let fixed = 0;
  const types = await tx.query<{ doc_type: string }>(
    `select distinct doc_type from numbering_series where branch_id is not null and prefix || suffix not like '%{BRANCH}%'`,
  );
  for (const { doc_type } of types) {
    const rows = await tx.query<{ id: string; branch_id: string | null; next_number: string; current_period: string | null }>(
      `select id, branch_id, next_number, current_period from numbering_series
        where doc_type = $1 and (branch_id is null or prefix || suffix not like '%{BRANCH}%')
        order by next_number desc`,
      [doc_type],
    );
    const shared = rows.find((r) => r.branch_id === null);
    const highest = rows[0]!;
    if (shared) {
      await tx.query(
        `update numbering_series set next_number = $2, current_period = coalesce(current_period, $3), is_active = true where id = $1`,
        [shared.id, highest.next_number, highest.current_period],
      );
    } else {
      await tx.query(`update numbering_series set branch_id = null, is_active = true where id = $1`, [highest.id]);
    }
    const keep = shared?.id ?? highest.id;
    await tx.query(
      `update numbering_series set is_active = false where doc_type = $1 and id <> $2 and prefix || suffix not like '%{BRANCH}%'`,
      [doc_type, keep],
    );
    fixed += 1;
  }
  return fixed;
}

async function main(): Promise<void> {
  const tenants = await asPlatform((tx) => tx.query<{ id: string; code: string }>(
    `select id, code from tenant where deleted_at is null order by created_at`,
  ));
  for (const tenant of tenants) {
    await asTenant(tenant.id, async (tx) => {
      await createMasterDefaults(tx);
      const shared = await shareNumbering(tx);
      await tx.query(
        `update branch set is_head_office = true
          where id = (select id from branch where deleted_at is null order by created_at limit 1)
            and not exists (select 1 from branch where is_head_office and deleted_at is null)`,
      );
      console.log(`${tenant.code}: master defaults ready, ${shared} numbering series now shared`);
    });
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
