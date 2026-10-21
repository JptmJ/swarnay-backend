/**
 * One-time: gives every tenant its system roles and turns each user's old
 * role_code into a user_role row (every branch, which matches today's behaviour
 * where any branch could be selected). Safe to re-run.
 */
import '../bootstrap.js';
import { asPlatform, asTenant } from '../core/db/client.js';
import { closePool } from '../core/db/pool.js';
import { newId } from '../core/util/id.js';
import { seedSystemRoles } from '../modules/identity/role-seed.js';

async function main(): Promise<void> {
  const tenants = await asPlatform((tx) => tx.query<{ id: string; code: string }>(
    `select id, code from tenant where deleted_at is null order by created_at`,
  ));

  for (const tenant of tenants) {
    const linked = await asTenant(tenant.id, async (tx) => {
      const roleIds = await seedSystemRoles(tx);
      const users = await tx.query<{ id: string; role_code: string }>(
        `select id, role_code from app_user where deleted_at is null`,
      );
      let count = 0;
      for (const user of users) {
        const roleId = roleIds.get(user.role_code);
        if (!roleId) continue;
        const rows = await tx.query(
          `insert into user_role (id, tenant_id, user_id, role_id, branch_id)
           values ($1, $2, $3, $4, null)
           on conflict (tenant_id, user_id, role_id, branch_id) do nothing
           returning id`,
          [newId(), tenant.id, user.id, roleId],
        );
        count += rows.length;
      }
      return count;
    });
    console.log(`${tenant.code}: system roles ready, ${linked} user role(s) linked`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
