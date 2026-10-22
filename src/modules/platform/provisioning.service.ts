/**
 * What the super admin does. Which is everything structural:
 *
 *     Super Admin ──creates──► Tenant (a jewellery shop)
 *                  ──creates──► its branches
 *                  ──creates──► every user in every branch
 *
 * All tenant mutations run with the correct tenant context so repo() and RLS
 * stamp the proper tenant_id.
 */
import { randomBytes } from 'node:crypto';
import type { Tx } from '../../core/db/client.js';
import { asPlatform, asTenant, withTenant } from '../../core/db/client.js';
import { repo } from '../../core/db/repository.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { newId } from '../../core/util/id.js';
import { logger } from '../../core/util/logger.js';
import { hashPassword, normalizePhone } from '../identity/auth.service.js';
import { invalidateUserAccess } from '../identity/access.service.js';
import { seedSystemRoles } from '../identity/role-seed.js';
import { provisionTenant } from '../tenancy/provisioning.service.js';
import { createBranchWithLocations, type BranchInput } from '../tenancy/branch.service.js';
import { MODULE_CATALOG, isLocked, moduleSpec, subModulesOf, type TenantKind } from '../tenancy/module-catalog.js';
import { ADMIN_ROLE, isAdminRole, TENANT_ROLES } from './roles.js';
import { audit } from './platform-auth.service.js';

export interface CreateTenantInput {
  code: string;
  legalName: string;
  displayName?: string;
  kind: TenantKind;
  gstin?: string;
  pan?: string;
  stateCode?: string;
  /** The first branch admin/owner. */
  admin: { email?: string | null; fullName: string; password: string; phone?: string | null };
  /** The first branch. More can be added afterwards. */
  branch?: { code: string; name: string; city?: string; state?: string; stateCode?: string; kind?: 'showroom' | 'factory' | 'warehouse' | 'office' };
  /** How many branches they may have. Omitted means no limit. */
  maxBranches?: number | null;
  /** Module keys to switch on. Omit to use each module's default licence. */
  modules?: Array<{ key: string; licence: 'included' | 'purchased' | 'trial'; trialDays?: number; enabled?: boolean }>;
}

/**
 * Creates the tenant, its chart of accounts, purities, numbering, roles,
 * the owner user and the first branch in one platform transaction.
 */
export async function createTenant(input: CreateTenantInput, actorId: string, ip?: string) {
  if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(input.code)) {
    throw new ValidationError('Tenant code must be lowercase letters, numbers and hyphens, 2–30 characters.');
  }
  if (input.admin.password.length < 8) {
    throw new ValidationError('The admin password must be at least 8 characters.');
  }

  for (const m of input.modules ?? []) {
    const spec = moduleSpec(m.key);
    if (!spec) throw new ValidationError(`There is no module called "${m.key}".`);
    if (spec.required && m.enabled === false) {
      throw new BusinessRuleError(`${spec.name} cannot be switched off — every other module depends on it.`, 'module_required');
    }
  }

  return asPlatform(async (tx) => {
    const taken = await tx.maybeOne<{ id: string }>(`select id from tenant where lower(code) = lower($1)`, [input.code]);
    if (taken) throw new ConflictError(`A tenant with code "${input.code}" already exists.`);

    const tenant = await repo<{ id: string }>(tx, 'tenant').insert({
      code: input.code,
      legal_name: input.legalName,
      display_name: input.displayName ?? input.legalName,
      kind: input.kind,
      status: 'active',
      gstin: input.gstin ?? null,
      pan: input.pan ?? null,
      max_branches: input.maxBranches ?? null,
    });

    let branchId = '';
    let ownerUserId = '';

    // 2–3. Everything inside the tenant is written AS the tenant, on this same
    // transaction, so repo() and RLS stamp the right tenant_id.
    await withTenant(tx, tenant.id as string, async (ttx) => {
      const prov = await provisionTenant(ttx, tenant.id as string, {
        legalName: input.legalName,
        displayName: input.displayName,
        stateCode: input.branch?.stateCode ?? input.stateCode,
        gstin: input.gstin,
        kind: input.kind,
        firstBranch: input.branch ? { code: input.branch.code, name: input.branch.name, kind: input.branch.kind } : undefined,
      });
      branchId = prov.branchId;
      await seedSystemRoles(ttx);
      if (input.admin) {
        const owner = await createUserInternal(ttx, {
          email: input.admin.email,
          fullName: input.admin.fullName,
          password: input.admin.password,
          phone: input.admin.phone,
          roleCode: 'owner',
          branchId: null,
        });
        ownerUserId = owner.id;
      }
      if (input.branch) {
        await ttx.query(
          `update branch set city = $2, state = $3, state_code = coalesce($4, state_code) where id = $1`,
          [branchId, input.branch.city ?? null, input.branch.state ?? null, input.branch.stateCode ?? null],
        );
      }
      if (input.modules?.length) {
        for (const m of input.modules) {
          const trialEnds = m.licence === 'trial'
            ? new Date(Date.now() + (m.trialDays ?? 30) * 86_400_000)
            : null;
          await ttx.query(
            `update tenant_module set licence = $2, trial_ends_at = $3, enabled = $4, updated_at = now()
              where module_key = $1`,
            [m.key, m.licence, trialEnds, m.enabled !== false],
          );
        }
      }
    });

    await audit(tx, actorId, 'tenant.create', {
      tenantId: tenant.id, targetType: 'tenant', targetId: tenant.id, ip,
      changes: { code: input.code, kind: input.kind, adminEmail: input.admin.email },
    });

    logger.info({ tenantId: tenant.id, code: input.code, actorId }, 'Tenant created by super admin');
    return { tenantId: tenant.id, branchId, adminUserId: ownerUserId };
  });
}

export async function updateTenant(
  tenantId: string,
  changes: Partial<{
    displayName: string; legalName: string; status: string; gstin: string; pan: string;
    kind: TenantKind; maxBranches: number | null;
  }>,
  actorId: string,
  ip?: string,
) {
  return asPlatform(async (tx) => {
    const existing = await tx.maybeOne<Record<string, unknown>>(`select * from tenant where id = $1`, [tenantId]);
    if (!existing) throw new NotFoundError('Tenant', tenantId);

    /*
     * A limit below what the business already has is allowed: it stops them
     * adding more without taking away a branch they are trading from.
     */
    const map: Record<string, string> = {
      displayName: 'display_name', legalName: 'legal_name', status: 'status',
      gstin: 'gstin', pan: 'pan', kind: 'kind', maxBranches: 'max_branches',
    };
    const sets: string[] = []; const params: unknown[] = [tenantId];
    for (const [key, column] of Object.entries(map)) {
      const value = (changes as Record<string, unknown>)[key];
      if (value === undefined) continue;
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return existing;

    const updated = await tx.one(
      `update tenant set ${sets.join(', ')}, updated_at = now() where id = $1 returning *`, params);
    await audit(tx, actorId, 'tenant.update', { tenantId, targetType: 'tenant', targetId: tenantId, changes, ip });
    return updated;
  });
}

/** One shape for a branch, wherever it is created from. */
export type CreateBranchInput = BranchInput;

/** A branch is useless without somewhere for stock to sit, so locations come with it. */
export async function createBranch(tenantId: string, input: CreateBranchInput, actorId: string | null, ip?: string) {
  // The same path the shop's own Masters screen uses, so a branch is a branch
  // however it was added — same locations, same code check, same limit.
  const branch = await asTenant(tenantId, (tx) => createBranchWithLocations(tx, input as BranchInput));

  if (actorId) {
    await asPlatform(async (tx) => {
      await audit(tx, actorId, 'branch.create', {
        tenantId, targetType: 'branch', targetId: branch.id, ip, changes: { code: input.code, name: input.name },
      });
    });
  }
  return branch;
}

export interface CreateUserInput {
  email?: string | null;
  phone?: string | null;
  fullName: string;
  password: string;
  roleCode: string;
  branchId?: string | null;
}

/** Runs on a tenant-scoped tx (see withTenant) — repo() stamps tenant_id. */
async function createUserInternal(tx: Tx, input: CreateUserInput) {
  const role = await tx.maybeOne<{ id: string }>(
    `select id from role where code = $1 and deleted_at is null`, [input.roleCode],
  );
  if (!role) throw new ValidationError(`Role "${input.roleCode}" does not exist for this business.`);

  const user = await repo<{ id: string }>(tx, 'app_user').insert({
    email: input.email?.trim().toLowerCase() || null,
    phone: input.phone?.trim() ? normalizePhone(input.phone) : null,
    full_name: input.fullName.trim(),
    password_hash: await hashPassword(input.password),
    default_branch_id: input.branchId ?? null,
    must_change_password: true,
    is_active: true,
  });
  await repo(tx, 'user_role').insert({ user_id: user.id, role_id: role.id, branch_id: input.branchId ?? null });
  return user;
}

/**
 * Creates a staff member inside a tenant via platform transaction.
 */
export async function createTenantUser(
  tenantId: string,
  input: CreateUserInput,
  options: { actorPlatformUserId?: string; ip?: string } = {},
) {
  if (input.password.length < 8) throw new ValidationError('Password must be at least 8 characters.');

  const user = await asPlatform(async (tx) => {
    return withTenant(tx, tenantId, (ttx) => createUserInternal(ttx, input));
  });

  if (options.actorPlatformUserId) {
    await asPlatform(async (tx) => {
      await audit(tx, options.actorPlatformUserId!, 'user.create', {
        tenantId, targetType: 'app_user', targetId: user.id, ip: options.ip,
        changes: { email: input.email, phone: input.phone, roleCode: input.roleCode },
      });
    });
  }

  return user;
}

export async function setUserActive(
  tenantId: string, userId: string, isActive: boolean,
  options: { actorPlatformUserId?: string; ip?: string } = {},
) {
  await asPlatform(async (tx) => {
    await tx.query(
      `update app_user set is_active = $1, token_version = token_version + 1, updated_at = now()
        where id = $2 and tenant_id = $3`,
      [isActive, userId, tenantId],
    );
    if (!isActive) {
      await tx.query(`update refresh_token set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
    }
    invalidateUserAccess(tenantId, userId);

    if (options.actorPlatformUserId) {
      await audit(tx, options.actorPlatformUserId, isActive ? 'user.activate' : 'user.deactivate', {
        tenantId, targetType: 'app_user', targetId: userId, ip: options.ip,
      });
    }
  });
}

/**
 * A branch has at most one admin. Either every branch has its own, or one admin
 * covers all of them — a null `branchId` is that second shape, and it conflicts
 * with every branch at once.
 *
 * Enforced here because no database constraint can express it: the rule spans
 * `user_role` rows and treats null as "all branches" rather than "no branch".
 */
async function assertBranchAdminFree(
  ttx: Tx, roleCode: string, branchId: string | null, exceptUserId: string | null,
) {
  if (!isAdminRole(roleCode)) return;

  const clash = await ttx.maybeOne<{ full_name: string; branch_id: string | null }>(
    `select u.full_name, ur.branch_id
       from user_role ur
       join role r on r.id = ur.role_id
       join app_user u on u.id = ur.user_id
      where r.code = $1
        and u.is_active = true and u.deleted_at is null
        and ($2::uuid is null or ur.branch_id is null or ur.branch_id = $2)
        and ($3::uuid is null or u.id <> $3)
      limit 1`,
    [ADMIN_ROLE, branchId, exceptUserId],
  );

  if (clash) {
    throw new ConflictError(
      clash.branch_id === null
        ? `${clash.full_name} already covers every branch as admin. Move them to one branch first.`
        : `That branch already has an admin: ${clash.full_name}.`,
    );
  }
}

export async function changeUserRole(
  tenantId: string, userId: string, newRoleCode: string, operatorId: string,
  branchId?: string | null,
) {
  return asPlatform(async (tx) => {
    const from = await withTenant(tx, tenantId, async (ttx) => {
      const user = await ttx.maybeOne<{ id: string; default_branch_id: string | null }>(
        `select id, default_branch_id from app_user where id = $1 and deleted_at is null for update`, [userId]);
      if (!user) throw new NotFoundError('User', userId);
      const role = await ttx.maybeOne<{ id: string }>(`select id from role where code = $1 and deleted_at is null`, [newRoleCode]);
      if (!role) throw new ValidationError(`Role "${newRoleCode}" does not exist for this business.`);

      // Undefined means "leave their branch alone"; null means "all branches".
      const target = branchId === undefined ? user.default_branch_id : branchId;
      await assertBranchAdminFree(ttx, newRoleCode, target, userId);

      const before = await ttx.query<{ code: string; branch_id: string | null }>(
        `select r.code, ur.branch_id from user_role ur join role r on r.id = ur.role_id where ur.user_id = $1`, [userId],
      );
      await ttx.query(`delete from user_role where user_id = $1`, [userId]);
      await repo(ttx, 'user_role').insert({ user_id: userId, role_id: role.id, branch_id: target });
      if (branchId !== undefined) {
        await ttx.query(`update app_user set default_branch_id = $2 where id = $1`, [userId, branchId]);
      }
      await ttx.query(`update app_user set token_version = token_version + 1 where id = $1`, [userId]);
      invalidateUserAccess(tenantId, userId);
      return before;
    });
    await audit(tx, operatorId, 'user.role_change', {
      tenantId, targetType: 'app_user', targetId: userId,
      changes: { from, to: newRoleCode, branchId: branchId === undefined ? 'unchanged' : branchId },
    });
  });
}

/**
 * Name, contact details and branch.
 *
 * This has no tenant-side equivalent any more: a shop cannot edit its own staff,
 * so if this did not exist nobody could correct a misspelled name.
 */
export async function updateTenantUserDetails(
  tenantId: string, userId: string,
  changes: Partial<{ fullName: string; email: string | null; phone: string | null; branchId: string | null }>,
  operatorId: string, ip?: string,
) {
  return asPlatform(async (tx) => {
    const result = await withTenant(tx, tenantId, async (ttx) => {
      const user = await ttx.maybeOne<{ id: string }>(
        `select id from app_user where id = $1 and deleted_at is null for update`, [userId]);
      if (!user) throw new NotFoundError('User', userId);

      if (changes.branchId !== undefined) {
        const held = await ttx.maybeOne<{ code: string }>(
          `select r.code from user_role ur join role r on r.id = ur.role_id where ur.user_id = $1 limit 1`, [userId]);
        if (held) await assertBranchAdminFree(ttx, held.code, changes.branchId, userId);
      }

      if (changes.email !== undefined && changes.email) {
        const taken = await ttx.maybeOne<{ id: string }>(
          `select id from app_user where lower(email) = lower($1) and id <> $2 and deleted_at is null`,
          [changes.email, userId]);
        if (taken) throw new ConflictError(`${changes.email} is already used by someone in this business.`);
      }

      const map: Record<string, string> = {
        fullName: 'full_name', email: 'email', phone: 'phone', branchId: 'default_branch_id',
      };
      const sets: string[] = [];
      const params: unknown[] = [userId];
      for (const [key, column] of Object.entries(map)) {
        const value = (changes as Record<string, unknown>)[key];
        if (value === undefined) continue;
        params.push(
          key === 'phone' && typeof value === 'string' && value.trim() ? normalizePhone(value)
          : key === 'email' && typeof value === 'string' ? value.trim().toLowerCase() || null
          : value,
        );
        sets.push(`${column} = $${params.length}`);
      }
      if (!sets.length) return null;

      // A branch move changes which grants apply, so the token has to turn over.
      if (changes.branchId !== undefined) sets.push('token_version = token_version + 1');

      const row = await ttx.one<Record<string, unknown>>(
        `update app_user set ${sets.join(', ')}, updated_at = now() where id = $1
         returning id, email, full_name, phone, is_active, default_branch_id`,
        params);
      if (changes.branchId !== undefined) {
        await ttx.query(`update user_role set branch_id = $2 where user_id = $1`, [userId, changes.branchId]);
      }
      invalidateUserAccess(tenantId, userId);
      return row;
    });

    if (result) {
      await audit(tx, operatorId, 'user.update', {
        tenantId, targetType: 'app_user', targetId: userId, changes, ip,
      });
    }
    return result ?? { id: userId, unchanged: true };
  });
}

/**
 * A new temporary password, returned once.
 *
 * The recovery path for a locked-out shop. The tenant-side reset is gone, so
 * without this a business whose only admin forgets their password has nobody to
 * turn to.
 */
export async function resetTenantUserPassword(
  tenantId: string, userId: string, operatorId: string, ip?: string,
): Promise<{ temporaryPassword: string }> {
  const password = randomBytes(9).toString('base64url');

  return asPlatform(async (tx) => {
    await withTenant(tx, tenantId, async (ttx) => {
      const user = await ttx.maybeOne<{ id: string }>(
        `select id from app_user where id = $1 and deleted_at is null`, [userId]);
      if (!user) throw new NotFoundError('User', userId);

      await ttx.query(
        `update app_user
            set password_hash = $2, must_change_password = true,
                failed_login_count = 0, locked_until = null,
                token_version = token_version + 1, updated_at = now()
          where id = $1`,
        [userId, await hashPassword(password)]);
      // Signed out everywhere: a reset they did not ask for should not leave an
      // existing session running.
      await ttx.query(
        `update refresh_token set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
      invalidateUserAccess(tenantId, userId);
    });

    await audit(tx, operatorId, 'user.password_reset', {
      tenantId, targetType: 'app_user', targetId: userId, ip,
    });
    return { temporaryPassword: password };
  });
}

/** Everything the super admin's tenant detail screen needs. */
interface ModuleRowDb {
  module_key: string; enabled: boolean; licence: 'included' | 'purchased' | 'trial' | 'expired';
  trial_ends_at: string | null; expires_at: string | null; disabled_submodules: string[] | null;
}

/**
 * Every module that applies to this kind of business, in catalog order, with
 * its stored state. A module with no row is on with its default licence —
 * exactly how the tenant's dock and the API gate treat it — so the console
 * shows it rather than leaving a switch the operator cannot reach.
 */
function moduleRows(kind: TenantKind, rows: ModuleRowDb[], catalog: Map<string, (typeof MODULE_CATALOG)[number]>) {
  const stored = new Map(rows.map((r) => [r.module_key, r]));
  const applies = (a: TenantKind) => a === 'both' || kind === 'both' || a === kind;
  const keys = [
    ...MODULE_CATALOG.filter((m) => applies(m.appliesTo) || stored.has(m.key)).map((m) => m.key),
    ...rows.map((r) => r.module_key).filter((k) => !catalog.has(k)),
  ];
  return keys.map((key) => {
    const spec = catalog.get(key);
    const row = stored.get(key);
    const state = row
      ? { enabled: row.enabled, licence: row.licence, trialEndsAt: row.trial_ends_at, expiresAt: row.expires_at, disabled: row.disabled_submodules ?? [] }
      : null;
    return {
      module_key: key,
      name: spec?.name ?? key,
      group: spec?.group ?? 'core',
      description: spec?.description ?? null,
      enabled: row?.enabled ?? true,
      licence: row?.licence ?? spec?.defaultLicence ?? 'included',
      trial_ends_at: row?.trial_ends_at ?? null,
      expires_at: row?.expires_at ?? null,
      locked: state ? isLocked(state) : false,
      disabled_submodules: row?.disabled_submodules ?? [],
      required: spec?.required === true,
      /** False for a module the business's kind does not use; shown only because a row exists. */
      applies: spec ? applies(spec.appliesTo) : false,
      sub_modules: subModulesOf(key).filter((s) => applies(s.appliesTo)),
    };
  });
}

export async function tenantDetail(tenantId: string) {
  const header = await asPlatform(async (tx) => {
    const tenant = await tx.maybeOne<Record<string, unknown>>(`select * from tenant where id = $1`, [tenantId]);
    if (!tenant) throw new NotFoundError('Tenant', tenantId);
    return tenant;
  });

  const inner = await asTenant(tenantId, async (tx: Tx) => {
    const [branches, users, modules] = await Promise.all([
      tx.query(`select b.*,
                       (select count(*) from stock_location l where l.branch_id = b.id) as location_count,
                       (select u.full_name from app_user u
                         join user_role ur on ur.user_id = u.id
                         join role r on r.id = ur.role_id
                        where (ur.branch_id = b.id or ur.branch_id is null) and r.code in ('admin', 'owner')
                          and u.is_active = true and u.deleted_at is null limit 1) as admin_name,
                       (select u.email from app_user u
                         join user_role ur on ur.user_id = u.id
                         join role r on r.id = ur.role_id
                        where (ur.branch_id = b.id or ur.branch_id is null) and r.code in ('admin', 'owner')
                          and u.is_active = true and u.deleted_at is null limit 1) as admin_email
                  from branch b where b.deleted_at is null order by b.code`),
      tx.query(`select u.id, u.email, u.full_name, u.phone, u.is_active, u.last_login_at, u.created_at,
                       u.default_branch_id,
                       coalesce((select r.code from user_role ur join role r on r.id = ur.role_id where ur.user_id = u.id limit 1), 'sales') as role_code,
                       (select r.name from user_role ur join role r on r.id = ur.role_id where ur.user_id = u.id limit 1) as role_label,
                       b.name as branch_name, b.code as branch_code
                  from app_user u
                  left join branch b on b.id = u.default_branch_id
                 where u.deleted_at is null
                 order by b.code nulls first, u.full_name`),
      tx.query(`select module_key, enabled, licence, trial_ends_at, expires_at, disabled_submodules from tenant_module order by module_key`),
    ]);
    return { branches, users, modules };
  });

  const catalog = new Map(MODULE_CATALOG.map((m) => [m.key, m]));
  const roleNames = new Map<string, string>(TENANT_ROLES.map((r) => [r.code as string, r.name as string]));
  // Staff roles are named per business, so their name comes from the row; owner and admin keep the template's.
  const users: Array<Record<string, unknown>> = (inner.users as Array<Record<string, unknown>>).map(({ role_label, ...u }) => ({
    ...u,
    role_name: roleNames.get(String(u.role_code)) ?? role_label ?? u.role_code,
  }));

  return {
    tenant: header,
    ...inner,
    users,
    /** The admin covering every branch, if there is one. */
    globalAdmin: users.find((u) => (u.role_code === 'admin' || u.role_code === 'owner') && u.default_branch_id === null) ?? null,
    modules: moduleRows(header.kind as TenantKind, inner.modules as ModuleRowDb[], catalog),
  };
}
