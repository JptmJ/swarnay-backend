import dns from 'node:dns';
dns.setDefaultResultOrder('ipv4first');

import dotenv from 'dotenv';
dotenv.config({ path: '.env.test', override: true });

import '../src/bootstrap.js';
import { pool, closePool } from '../src/core/db/pool.js';
import { asPlatform } from '../src/core/db/client.js';
import { syncSchema } from '../src/core/db/schema/sync.js';
import { provisionTenant } from '../src/modules/tenancy/provisioning.service.js';
import { assertSafeTestDatabase } from './safety.js';

async function ensureTestFixtures(): Promise<void> {
  const hasTenant = await asPlatform(async (tx) => {
    const res = await tx.maybeOne<{ id: string }>('select id from tenant limit 1');
    return Boolean(res);
  });
  if (hasTenant) return;

  await provisionTenant({
    code: 'testjewels',
    legalName: 'Test Jewellers Pvt Ltd',
    displayName: 'Test Jewellers',
    kind: 'both',
    gstin: '27AABCT0000A1Z1',
    stateCode: '27',
    owner: {
      email: 'owner@test.swarnay.com',
      fullName: 'Test Owner',
      password: 'password123',
    },
    firstBranch: {
      code: 'MAIN',
      name: 'Test Main Showroom',
      kind: 'showroom',
    },
  });

  await asPlatform(async (tx) => {
    await tx.query('update app_user set must_change_password = false');
  });
}

export async function setup(): Promise<void> {
  assertSafeTestDatabase();
  await syncSchema(pool, 'force');
  await ensureTestFixtures();
}

export async function teardown(): Promise<void> {
  await closePool();
}
