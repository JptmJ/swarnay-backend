/**
 * One-time: the Dashboard used to be opened with `reports.owner.view`; it now
 * has its own permission. Every role that had the old one gets `dashboard.view`
 * (and loses the old key), and Branch Admin roles that hold `reports.*` get
 * `dashboard.*`, so nobody loses their Dashboard. Safe to re-run.
 */
import '../bootstrap.js';
import '../api/index.js';
import { asPlatform, asTenant } from '../core/db/client.js';
import { closePool } from '../core/db/pool.js';

async function main(): Promise<void> {
  const tenants = await asPlatform((tx) => tx.query<{ id: string; code: string }>(
    `select id, code from tenant where deleted_at is null order by created_at`,
  ));

  for (const tenant of tenants) {
    const done = await asTenant(tenant.id, async (tx) => {
      const grant = async (permission: string, fromSql: string) => (await tx.query(
        `insert into role_permission (id, tenant_id, role_id, permission)
         select gen_random_uuid(), $1, r.id, $2 from role r where r.deleted_at is null and (${fromSql})
         on conflict (tenant_id, role_id, permission) do nothing returning id`,
        [tenant.id, permission],
      )).length;
      const view = await grant('dashboard.view',
        `exists (select 1 from role_permission p where p.role_id = r.id and p.permission = 'reports.owner.view')`);
      const admin = await grant('dashboard.*',
        `r.code = 'admin' and exists (select 1 from role_permission p where p.role_id = r.id and p.permission = 'reports.*')`);
      const removed = (await tx.query(`delete from role_permission where permission = 'reports.owner.view' returning id`)).length;
      return { view, admin, removed };
    });
    console.log(`${tenant.code}: dashboard.view → ${done.view} role(s), dashboard.* → ${done.admin} admin role(s), old key removed from ${done.removed}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
