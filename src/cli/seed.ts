/**
 * `npm run db:seed` — demo businesses with realistic data, for local testing.
 *
 *   npm run db:seed                  -- make 2 demo businesses
 *   npm run db:seed -- --count=5     -- make 5
 *   npm run db:seed -- --fresh       -- delete every demo business first, then make them again
 *
 * The same generator as the super admin console's "Demo accounts" button
 * (modules/platform/demo.service.ts), so a seeded demo and a console demo have
 * exactly the same shape — and both have the shape of real data, because they
 * are made through the real services. Run `npm run seed:superadmin` once
 * before this: every tenant is created by the super admin.
 *
 * Never point this at production: --fresh deletes data.
 */
import '../bootstrap.js';
// The staff roles a demo is given are picked from the live routes' permissions.
import '../api/index.js';
import { closePool, checkConnection, pool } from '../core/db/pool.js';
import { asPlatform } from '../core/db/client.js';
import { syncSchema } from '../core/db/schema/sync.js';
import { isProduction, isProtectedDatabase } from '../core/config/env.js';
import { createBranch, createTenant, createTenantUser } from '../modules/platform/provisioning.service.js';
import { createOrder } from '../modules/orders/orders.service.js';
import { checkout } from '../modules/sales/sales.service.js';
import { createInward } from '../modules/purchase/purchase.service.js';
import { repo } from '../core/db/repository.js';
import { logger } from '../core/util/logger.js';
import type { Tx } from '../core/db/client.js';
import type { TenantKind } from '../modules/tenancy/module-catalog.js';

const has = (flag: string): boolean => process.argv.includes(`--${flag}`);
const valueOf = (flag: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${flag}=`))?.split('=')[1];

async function main(): Promise<void> {
  if (isProduction || isProtectedDatabase) {
    console.error(`\nRefusing to seed demo data ${isProduction ? 'while NODE_ENV=production' : 'into the deployed database (DB_TARGET=deployed)'}.\n`);
    process.exitCode = 1;
    return;
  }
  const count = Math.min(MAX_DEMOS_PER_JOB, Math.max(1, Number(valueOf('count') ?? 2) || 2));

  await checkConnection();
  await syncSchema(pool, 'safe');

  const superAdmin = await asPlatform((tx) => tx.maybeOne<{ id: string }>(
    `select id from platform_user where is_active = true and deleted_at is null order by created_at limit 1`));
  if (!superAdmin) {
    console.error(`
There is no super admin yet, and every tenant is created by one. Run this first:

  npm run seed:superadmin -- --password='...'
`);
    process.exitCode = 1;
    return;
  }

  if (has('fresh')) {
    const demos = await asPlatform((tx) => tx.query<{ id: string; code: string }>(`select id, code from tenant where is_demo`));
    await deleteTenantData(demos.map((d) => d.id));
    console.log(`  deleted ${demos.length} demo business${demos.length === 1 ? '' : 'es'}`);
  }

  for (let i = 1; i <= count; i++) {
    process.stdout.write(`\n  demo ${i} of ${count}: `);
    const demo = await createDemoTenant(superAdmin.id, undefined, (step) => process.stdout.write(`\n    ${step}`));
    console.log(`

  ${demo.displayName} (${demo.city}) — tenant code ${demo.code}, password ${demo.password}, ${demo.seconds}s
${demo.logins.map((l) => `    ${l.roleName.padEnd(18)} ${l.branch.padEnd(26)} ${l.email}`).join('\n')}
    made: ${Object.entries(demo.data).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}${
      demo.warnings.length ? `\n    skipped:\n${demo.warnings.map((w) => `      - ${w}`).join('\n')}` : ''}`);
  }
  console.log('\n  Docs: http://localhost:4000/dev-docs\n');
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(closePool);
