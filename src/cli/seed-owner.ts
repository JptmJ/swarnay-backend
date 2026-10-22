/**
 * One business with its owner and every module on — and nothing else.
 *
 *   npx tsx src/cli/seed-owner.ts --code=myshop --name="My Jewellers" --email=owner@myshop.in --password="Secret@123"
 *
 * Optional: --owner="Owner Name"  --branch="Main Showroom"  --gstin=27ABCDE1234F1Z5  --state=27
 *
 * Creates what every business needs to start (owner, roles, first branch with
 * its locations, chart of accounts, metals, purities, payment modes, bill
 * numbering) and turns every module on, bought, with no end date. No
 * customers, stock, bills or any other data. The owner can sign in straight
 * away with the password given.
 */
import '../bootstrap.js';
import '../api/index.js';
import { asPlatform } from '../core/db/client.js';
import { closePool } from '../core/db/pool.js';
import { provisionTenant } from '../modules/tenancy/provisioning.service.js';
import { MODULE_CATALOG } from '../modules/tenancy/module-catalog.js';

function args(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of process.argv.slice(2)) {
    const m = /^--([a-z]+)=(.*)$/.exec(a);
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

async function main(): Promise<void> {
  const a = args();
  const code = (a.code ?? '').trim().toLowerCase();
  const name = (a.name ?? '').trim();
  const email = (a.email ?? '').trim().toLowerCase();
  const password = a.password ?? '';
  const problems = [
    !/^[a-z0-9][a-z0-9-]{1,39}$/.test(code) && '--code: letters, digits and dashes, 2–40 long (the shop code typed at sign-in)',
    name.length < 2 && '--name: the business name',
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && '--email: the owner’s email address',
    password.length < 8 && '--password: at least 8 characters',
  ].filter(Boolean);
  if (problems.length) {
    console.error(`Missing or wrong:\n  ${problems.join('\n  ')}\n\nExample:\n  npx tsx src/cli/seed-owner.ts --code=myshop --name="My Jewellers" --email=owner@myshop.in --password="Secret@123"`);
    process.exitCode = 1;
    return;
  }

  // The app keeps businesses apart with row-level security. A connection that
  // skips it (the postgres user) sees every business's rows, and setting up a
  // second business then fails with "Expected at most 1 row, got 2".
  const check = await asPlatform(async (tx) => {
    await tx.query(`set local app.bypass_rls = 'on'`);
    const role = await tx.one<{ name: string; skips: boolean }>(
      `select current_user as name, (rolsuper or rolbypassrls) as skips from pg_roles where rolname = current_user`);
    const taken = await tx.maybeOne(`select 1 from tenant where lower(code) = $1`, [code]);
    const others = await tx.one<{ n: number }>(`select count(*)::int as n from tenant where deleted_at is null`);
    return { role, taken: !!taken, others: others.n };
  });
  if (check.taken) {
    console.error(`A business with the code "${code}" already exists. Choose another --code.`);
    process.exitCode = 1;
    return;
  }
  if (check.role.skips && check.others > 0) {
    console.error(
      `The database user "${check.role.name}" skips row-level security, and ${check.others} business(es) already exist,\n` +
      `so setting up another one would mix their data. Either point DATABASE_URL in .env at a normal app role\n` +
      `(not postgres), or empty the database first (sql/wipe-keep-superadmin.sql), then run this again.`);
    process.exitCode = 1;
    return;
  }

  const made = await provisionTenant({
    code, legalName: name, displayName: name, kind: 'both',
    gstin: a.gstin || undefined, stateCode: a.state || undefined,
    owner: { email, fullName: a.owner?.trim() || 'Owner', password },
    firstBranch: { code: 'MAIN', name: a.branch?.trim() || 'Main Showroom' },
  });

  // Every module on and bought for good; the owner signs in with this password.
  await asPlatform(async (tx) => {
    await tx.query(`set local app.bypass_rls = 'on'`);
    for (const m of MODULE_CATALOG) {
      await tx.query(
        `insert into tenant_module (id, tenant_id, module_key, enabled, licence, trial_ends_at, expires_at, purchased_at)
         values (gen_random_uuid(), $1, $2, true, 'purchased', null, null, now())
         on conflict (tenant_id, module_key) do update
           set enabled = true, licence = 'purchased', trial_ends_at = null, expires_at = null,
               purchased_at = coalesce(tenant_module.purchased_at, now()), disabled_submodules = '[]'::jsonb, updated_at = now()`,
        [made.tenantId, m.key]);
    }
    await tx.query(`update app_user set must_change_password = false where id = $1`, [made.ownerUserId]);
  });

  console.log(`\nDone. Sign in with:\n  Shop code: ${code}\n  Email:     ${email}\n  Password:  (the one you gave)\n` +
    `\n${MODULE_CATALOG.length} modules on. No customers, stock or bills: add your own.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(closePool);
