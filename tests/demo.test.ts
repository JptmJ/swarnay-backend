import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import '../src/bootstrap.js';
import { createApp } from '../src/app.js';
import { asPlatform } from '../src/core/db/client.js';
import { hashPassword } from '../src/modules/identity/auth.service.js';
import { newId } from '../src/core/util/id.js';
import { SUPER_ADMIN } from '../src/modules/platform/roles.js';

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Demo businesses, the way the console makes them: ask for a count, poll the
 * job, hand out the logins. What matters is that a demo is genuinely usable —
 * every login signs straight in, staff carry the permissions their role was
 * given, every module has something in it, and the books balance — and that
 * the delete that cleans demos up can never touch a real business.
 */
describe('Demo businesses', { timeout: 900_000 }, () => {
  let server: Server;
  let base: string;
  let operator: string;
  let demo: Body;
  const run = Date.now().toString(36);
  const email = `demo-op-${run}@swarnay.test`;
  const PASSWORD = 'operator-pass-1';

  async function call(path: string, init: { method?: string; body?: unknown; token?: string; branch?: string } = {}) {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.branch) headers['x-branch-id'] = init.branch;
    const res = await fetch(`${base}${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers, body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Body };
  }
  const asOperator = (path: string, init: { method?: string; body?: unknown } = {}) => call(path, { ...init, token: operator });

  beforeAll(async () => {
    server = createApp().listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await asPlatform(async (tx) => tx.query(
      `insert into platform_user (id, email, full_name, password_hash, role, is_active) values ($1, $2, 'Demo Operator', $3, $4, true)`,
      [newId(), email, await hashPassword(PASSWORD), SUPER_ADMIN.code]));
    operator = (await call('/api/platform/auth/login', { body: { email, password: PASSWORD } })).body.accessToken;
  });

  afterAll(async () => {
    await asPlatform(async (tx) => {
      const op = `(select id from platform_user where email = $1)`;
      await tx.query(`delete from platform_audit_log where platform_user_id in ${op}`, [email]);
      await tx.query(`delete from platform_refresh_token where platform_user_id in ${op}`, [email]);
      await tx.query(`delete from platform_user where email = $1`, [email]);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('refuses a count it cannot honour', async () => {
    expect((await asOperator('/api/platform/demo-tenants', { body: { count: 0 } })).status).toBe(400);
    expect((await asOperator('/api/platform/demo-tenants', { body: { count: 21 } })).status).toBe(400);
  });

  it('makes a demo in the background and reports its progress', async () => {
    const started = await asOperator('/api/platform/demo-tenants', { body: { count: 1 } });
    expect(started.status).toBe(202);
    expect(started.body.count).toBe(1);
    expect(started.body).not.toHaveProperty('operatorId');

    // A count typed by mistake: queued behind the first and stopped at once, it makes nothing.
    const mistake = await asOperator('/api/platform/demo-tenants', { body: { count: 5 } });
    const stopped = await asOperator(`/api/platform/demo-tenants/jobs/${mistake.body.id}/stop`, { method: 'POST' });
    expect(stopped.body.stopped).toBe(true);

    let job = started.body;
    const steps = new Set<string>();
    while (job.status !== 'done') {
      await new Promise((r) => setTimeout(r, 1500));
      job = (await asOperator(`/api/platform/demo-tenants/jobs/${started.body.id}`)).body;
      if (job.current) steps.add(job.current.step);
    }
    expect(job.failures).toEqual([]);
    expect(job.accounts).toHaveLength(1);
    expect(steps.size).toBeGreaterThan(1);
    demo = job.accounts[0];

    let after = (await asOperator(`/api/platform/demo-tenants/jobs/${mistake.body.id}`)).body;
    while (after.status !== 'done') {
      await new Promise((r) => setTimeout(r, 500));
      after = (await asOperator(`/api/platform/demo-tenants/jobs/${mistake.body.id}`)).body;
    }
    expect(after.accounts).toEqual([]);
    expect(after.failures).toEqual([]);

    expect(demo.code).toMatch(/^demo-[0-9a-f]{5}$/);
    expect(demo.warnings).toEqual([]);
    expect(demo.password.length).toBeGreaterThanOrEqual(8);
    // Every module was given something to show.
    for (const key of ['customers', 'suppliers', 'pieces_in_stock', 'invoices', 'purchases', 'orders', 'old_gold', 'scheme_members', 'girvi_loans']) {
      expect(demo.data[key], key).toBeGreaterThan(0);
    }
    expect(demo.roles.length).toBeGreaterThanOrEqual(2);
    for (const r of demo.roles) expect(r.permissions.length).toBeGreaterThan(0);
    const roleKinds = new Set(demo.logins.map((l: Body) => l.role));
    expect([...roleKinds].sort()).toEqual(['admin', 'owner', 'staff']);
    // One admin per branch, or one covering all of them.
    const admins = demo.logins.filter((l: Body) => l.role === 'admin');
    expect(admins.length === demo.branches.length || (admins.length === 1 && admins[0].branch === 'All branches')).toBe(true);
  });

  it('lets every login in at once, with the permissions its role was given', async () => {
    for (const login of demo.logins) {
      const res = await call('/api/auth/login', { body: { tenantCode: demo.code, identifier: login.email, password: demo.password } });
      expect(res.status, login.email).toBe(200);
      expect(res.body.session.user.mustChangePassword).toBe(false);
      if (login.role === 'staff') {
        const role = demo.roles.find((r: Body) => r.name === login.roleName);
        expect(new Set(res.body.session.permissions)).toEqual(new Set(role.permissions));
      }
    }
  });

  it('keeps the books balanced', async () => {
    const owner = await call('/api/auth/login', { body: { tenantCode: demo.code, identifier: `owner@${demo.code}.test`, password: demo.password } });
    const tb = await call('/api/accounts/reports/trial-balance', { token: owner.body.accessToken, branch: owner.body.session.branchId });
    expect(tb.status).toBe(200);
    expect(tb.body.balanced).toBe(true);
  });

  it('lists the demo as a demo', async () => {
    const demos = (await asOperator('/api/platform/tenants?demo=true&limit=200')).body.rows as Body[];
    expect(demos.find((t) => t.id === demo.tenantId)?.is_demo).toBe(true);
    const real = (await asOperator('/api/platform/tenants?demo=false&limit=200')).body.rows as Body[];
    expect(real.some((t) => t.id === demo.tenantId)).toBe(false);
  });

  it('deletes a demo completely, and never a real business', async () => {
    const realId = await asPlatform(async (tx) => (await tx.one<{ id: string }>(`select id from tenant where not is_demo limit 1`)).id);
    const refused = await asOperator(`/api/platform/tenants/${realId}`, { method: 'DELETE' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('tenant_not_demo');

    expect((await asOperator(`/api/platform/tenants/${demo.tenantId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await asOperator(`/api/platform/tenants/${demo.tenantId}`)).status).toBe(404);
    const left = await asPlatform((tx) => tx.one<{ n: number }>(
      `select (select count(*) from app_user where tenant_id = $1) + (select count(*) from sales_invoice where tenant_id = $1)
            + (select count(*) from ledger_entry where tenant_id = $1) as n`, [demo.tenantId]));
    expect(Number(left.n)).toBe(0);
    const signIn = await call('/api/auth/login', { body: { tenantCode: demo.code, identifier: `owner@${demo.code}.test`, password: demo.password } });
    expect(signIn.status).toBe(401);
  });
});
