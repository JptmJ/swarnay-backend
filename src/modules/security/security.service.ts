/**
 * The security vault and the private entry, from both sides.
 *
 * Shop side: a person unlocks the vault with the passcode, or passes the
 * private entry with the click pattern. Each success is a random token whose
 * sha256 is stored with an expiry, the user's token_version and the settings
 * revision — so a password change, a role change or a new setting from the
 * super admin ends it on the next check, without anyone having to log out.
 *
 * Platform side: the super admin reads and writes the settings. Nothing here
 * ever returns the passcode, and only the super admin can read the path and
 * points of the private entry.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Tx } from '../../core/db/client.js';
import { asPlatform, withTenant } from '../../core/db/client.js';
import { recordAudit } from '../../core/audit.js';
import { AppError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors/app-error.js';
import { hashPassword, verifyPassword } from '../identity/auth.service.js';
import { audit } from '../platform/platform-auth.service.js';
import {
  ACCESS_LIFETIME_MS, ARTWORK_VERSION, GRANT_LIFETIME_MS, matchesPattern,
  validGatewayPath, validGatewayPoints, type GatewayPoint,
} from './gateway-rules.js';
import { VAULT_ROLE_TYPES } from './security.schema.js';

const VAULT_MAX_WRONG = 5;
const VAULT_LOCK_MINUTES = 15;
const GATEWAY_MAX_WRONG = 5;
const GATEWAY_LOCK_MINUTES = 5;

type LockoutKind = 'vault' | 'gateway';
export type VaultRoleType = (typeof VAULT_ROLE_TYPES)[number];

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const epochMs = (column: string) => `(extract(epoch from ${column}) * 1000)::bigint::text`;

interface VaultRow {
  id: string;
  enabled: boolean;
  passcode_hash: string | null;
  unlock_minutes: number;
  allowed_role_types: VaultRoleType[];
  revision: number;
}

interface GatewayRow { id: string; enabled: boolean; path: string; points: GatewayPoint[]; revision: number }

/* ------------------------------------------------------------ helpers */

/** owner / admin / staff — what the signed-in person's roles are, at this branch. */
async function roleTypes(tx: Tx): Promise<Set<string>> {
  if (!tx.context.userId || !tx.context.roles.length) return new Set();
  const rows = await tx.query<{ role_type: string }>(
    `select distinct role_type from role where code = any($1::text[]) and is_active and deleted_at is null`,
    [tx.context.roles],
  );
  return new Set(rows.map((r) => r.role_type));
}

async function tokenVersion(tx: Tx): Promise<number> {
  const row = await tx.one<{ token_version: number }>(`select token_version from app_user where id = $1`, [tx.context.userId]);
  return row.token_version;
}

/** Minutes left on a lockout, or null when the person is free to try. */
async function lockedMinutes(tx: Tx, kind: LockoutKind): Promise<number | null> {
  const row = await tx.maybeOne<{ minutes: number | null }>(
    `select case when locked_until > now() then ceil(extract(epoch from locked_until - now()) / 60)::int end as minutes
       from security_lockout where kind = $1 and user_id = $2`,
    [kind, tx.context.userId],
  );
  return row?.minutes ?? null;
}

/**
 * Counts one wrong try. A count restarts once a lock has run out, or after an
 * hour with no mistakes — four slips last week are not a reason to lock today.
 */
async function recordFailure(tx: Tx, kind: LockoutKind, limit: number, lockMinutes: number) {
  const restart = `(security_lockout.locked_until <= now() or security_lockout.last_failed_at < now() - interval '1 hour')`;
  const next = `case when ${restart} then 1 else security_lockout.failed_count + 1 end`;
  return tx.one<{ failed_count: number; minutes: number | null }>(
    `insert into security_lockout (id, tenant_id, kind, user_id, failed_count, locked_until, last_failed_at, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, 1, case when $4 <= 1 then now() + make_interval(mins => $5) end, now(), $3, $3)
     on conflict (tenant_id, kind, user_id) do update set
       failed_count = ${next},
       locked_until = case when ${next} >= $4 then now() + make_interval(mins => $5)
                           when ${restart} then null
                           else security_lockout.locked_until end,
       last_failed_at = now(), updated_at = now()
     returning failed_count,
               case when locked_until > now() then ceil(extract(epoch from locked_until - now()) / 60)::int end as minutes`,
    [tx.context.tenantId, kind, tx.context.userId, limit, lockMinutes],
  );
}

const clearFailures = (tx: Tx, kind: LockoutKind) =>
  tx.query(`delete from security_lockout where kind = $1 and user_id = $2`, [kind, tx.context.userId]);

/** Old grants are only clutter; each new one sweeps that person's expired ones. */
const sweepGrants = (tx: Tx) =>
  tx.query(`delete from security_grant where user_id = $1 and expires_at < now() - interval '1 day'`, [tx.context.userId]);

async function issueGrant(
  tx: Tx, kind: 'vault_unlock' | 'gateway_grant' | 'gateway_access', revision: number, lifetime: { ms: number }, ip?: string,
): Promise<{ token: string; expiresAt: number }> {
  await sweepGrants(tx);
  const token = newToken();
  const row = await tx.one<{ expires_at: string }>(
    `insert into security_grant (id, tenant_id, kind, user_id, branch_id, token_hash, token_version, revision, expires_at, ip_address, created_by, updated_by)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8), $9, $3, $3)
     returning ${epochMs('expires_at')} as expires_at`,
    [tx.context.tenantId, kind, tx.context.userId, tx.context.branchId, hashToken(token),
     await tokenVersion(tx), revision, lifetime.ms / 1000, ip ?? null],
  );
  return { token, expiresAt: Number(row.expires_at) };
}

/* ------------------------------------------------------- shop: vault */

const loadVault = (tx: Tx) => tx.maybeOne<VaultRow>(
  `select id, enabled, passcode_hash, unlock_minutes, allowed_role_types, revision from security_vault`,
);

const ROLE_NAMES: Record<string, string> = { owner: 'the owner', admin: 'branch admins', staff: 'staff' };
const whoMay = (types: string[]) => types.map((t) => ROLE_NAMES[t] ?? t).join(' and ');

export interface VaultStatus {
  enabled: boolean;
  canUnlock: boolean;
  unlockMinutes: number;
  /** Why this person cannot unlock: the vault is off, or their role is not allowed. */
  reason: 'disabled' | 'role' | null;
  message: string | null;
}

export async function vaultStatus(tx: Tx): Promise<VaultStatus> {
  const vault = await loadVault(tx);
  if (!vault?.enabled || !vault.passcode_hash) {
    return {
      enabled: false, canUnlock: false, unlockMinutes: vault?.unlock_minutes ?? 15, reason: 'disabled',
      message: 'The security vault is switched off for this business. Ask Swarnay support to turn it on.',
    };
  }
  const types = await roleTypes(tx);
  const allowed = vault.allowed_role_types.some((t) => types.has(t));
  return {
    enabled: true, canUnlock: allowed, unlockMinutes: vault.unlock_minutes, reason: allowed ? null : 'role',
    message: allowed ? null : `Only ${whoMay(vault.allowed_role_types)} can unlock private figures here.`,
  };
}

export type UnlockOutcome = { ok: true; token: string; expiresAt: number } | { ok: false; error: AppError };

/**
 * Checks the passcode. Returns the refusal instead of throwing it, so the
 * wrong-try counter is committed with the transaction rather than rolled back
 * along with the error.
 */
export async function unlockVault(tx: Tx, passcode: string, ip?: string): Promise<UnlockOutcome> {
  const status = await vaultStatus(tx);
  if (status.reason === 'disabled') return { ok: false, error: new BusinessRuleError(status.message!, 'vault_disabled') };
  if (status.reason === 'role') return { ok: false, error: new ForbiddenError(status.message!, 'vault_not_allowed') };

  const vault = (await loadVault(tx))!;
  const locked = await lockedMinutes(tx, 'vault');
  if (locked) {
    return { ok: false, error: new AppError(`Too many wrong passcodes. Try again in ${locked} minute${locked === 1 ? '' : 's'}.`, 429, 'vault_locked') };
  }

  if (!(await verifyPassword(passcode, vault.passcode_hash!))) {
    const failure = await recordFailure(tx, 'vault', VAULT_MAX_WRONG, VAULT_LOCK_MINUTES);
    await recordAudit(tx, 'security.vault.unlock_failed', 'security_vault', vault.id, { failedCount: failure.failed_count, locked: !!failure.minutes });
    if (failure.minutes) {
      return { ok: false, error: new AppError(`Too many wrong passcodes. The vault is locked for you for ${failure.minutes} minutes.`, 429, 'vault_locked') };
    }
    const left = VAULT_MAX_WRONG - failure.failed_count;
    return { ok: false, error: new BusinessRuleError(`That passcode is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 'vault_passcode_invalid') };
  }

  await clearFailures(tx, 'vault');
  const grant = await issueGrant(tx, 'vault_unlock', vault.revision, { ms: vault.unlock_minutes * 60_000 }, ip);
  await recordAudit(tx, 'security.vault.unlock', 'security_vault', vault.id, { expiresAt: new Date(grant.expiresAt).toISOString() });
  return { ok: true, ...grant };
}

/**
 * Is this unlock still good? Re-checks everything that could have changed since:
 * the vault switched off or re-configured, the person's password or roles changed.
 */
export async function checkVaultUnlock(tx: Tx, token: string): Promise<{ expiresAt: number } | null> {
  const row = await tx.maybeOne<{ expires_at: string; allowed_role_types: string[] }>(
    `select ${epochMs('g.expires_at')} as expires_at, v.allowed_role_types
       from security_grant g
       join security_vault v on v.enabled and v.passcode_hash is not null and v.revision = g.revision
       join app_user u on u.id = g.user_id and u.token_version = g.token_version and u.is_active and u.deleted_at is null
      where g.token_hash = $1 and g.kind = 'vault_unlock' and g.user_id = $2
        and g.revoked_at is null and g.expires_at > now()`,
    [hashToken(token), tx.context.userId],
  );
  if (!row) return null;
  const types = await roleTypes(tx);
  return row.allowed_role_types.some((t) => types.has(t)) ? { expiresAt: Number(row.expires_at) } : null;
}

export async function lockVault(tx: Tx, token: string): Promise<void> {
  await tx.query(
    `update security_grant set revoked_at = now(), updated_at = now()
      where token_hash = $1 and user_id = $2 and kind = 'vault_unlock' and revoked_at is null`,
    [hashToken(token), tx.context.userId],
  );
}

/* ----------------------------------------------- shop: private entry */

/** Owners and branch admins only. Staff never get as far as the settings being read. */
const isGatewayAdmin = async (tx: Tx) => {
  const types = await roleTypes(tx);
  return types.has('owner') || types.has('admin');
};

/**
 * Three clicks on the 404 artwork. Every refusal — wrong path, wrong points,
 * switched off, locked out, not an admin — is the same `null`, so the response
 * says nothing about which part was wrong.
 */
export async function gatewayGesture(
  tx: Tx, input: { path: string; points: GatewayPoint[]; artworkVersion: number }, ip?: string,
): Promise<{ grant: string; expiresAt: number } | null> {
  if (input.artworkVersion !== ARTWORK_VERSION || !(await isGatewayAdmin(tx))) return null;
  const gateway = await tx.maybeOne<GatewayRow>(`select id, enabled, path, points, revision from private_gateway`);
  if (!gateway?.enabled || !validGatewayPath(gateway.path) || !validGatewayPoints(gateway.points)) return null;
  // A different path is just an ordinary missing page, not a wrong try.
  if (gateway.path !== input.path) return null;
  if (await lockedMinutes(tx, 'gateway')) return null;

  if (!matchesPattern(gateway.points, input.points)) {
    const failure = await recordFailure(tx, 'gateway', GATEWAY_MAX_WRONG, GATEWAY_LOCK_MINUTES);
    await recordAudit(tx, 'security.gateway.failed', 'private_gateway', gateway.id, { failedCount: failure.failed_count, locked: !!failure.minutes });
    return null;
  }

  await clearFailures(tx, 'gateway');
  // One pending grant per person: a new success cancels the last one.
  await tx.query(
    `update security_grant set revoked_at = now(), updated_at = now()
      where user_id = $1 and kind = 'gateway_grant' and consumed_at is null and revoked_at is null`,
    [tx.context.userId],
  );
  const { token, expiresAt } = await issueGrant(tx, 'gateway_grant', gateway.revision, { ms: GRANT_LIFETIME_MS }, ip);
  await recordAudit(tx, 'security.gateway.passed', 'private_gateway', gateway.id);
  return { grant: token, expiresAt };
}

/** Swaps a one-use grant for the five-minute welcome view. Replays and cross-branch use get `null`. */
export async function gatewayWelcome(tx: Tx, grant: string, ip?: string): Promise<{ expiresAt: number } | null> {
  // The update is the lock: two requests racing for one grant cannot both see it unconsumed.
  const used = await tx.maybeOne<{ revision: number; token_version: number }>(
    `update security_grant set consumed_at = now(), updated_at = now()
      where token_hash = $1 and kind = 'gateway_grant' and user_id = $2
        and consumed_at is null and revoked_at is null and expires_at > now()
        and branch_id is not distinct from $3
     returning revision, token_version`,
    [hashToken(grant), tx.context.userId, tx.context.branchId],
  );
  if (!used) return null;
  const [gateway, version, admin] = await Promise.all([
    tx.maybeOne<{ enabled: boolean; revision: number }>(`select enabled, revision from private_gateway`),
    tokenVersion(tx),
    isGatewayAdmin(tx),
  ]);
  if (!gateway?.enabled || gateway.revision !== used.revision || version !== used.token_version || !admin) return null;
  const access = await issueGrant(tx, 'gateway_access', used.revision, { ms: ACCESS_LIFETIME_MS }, ip);
  return { expiresAt: access.expiresAt };
}

/* ------------------------------------------------- platform: settings */

async function assertTenant(tx: Tx, tenantId: string): Promise<void> {
  const tenant = await tx.maybeOne(`select id from tenant where id = $1 and deleted_at is null`, [tenantId]);
  if (!tenant) throw new NotFoundError('Tenant', tenantId);
}

export interface TenantSecurity {
  vault: {
    enabled: boolean; hasPasscode: boolean; passcodeChangedAt: string | null; unlockMinutes: number;
    allowedRoleTypes: VaultRoleType[]; revision: number; updatedAt: string | null;
  };
  gateway: { enabled: boolean; path: string; points: GatewayPoint[]; revision: number; updatedAt: string | null };
  activeUnlocks: number;
  lockouts: { kind: LockoutKind; userId: string; userName: string; lockedUntil: string }[];
}

export async function tenantSecurity(tenantId: string): Promise<TenantSecurity> {
  return asPlatform(async (tx) => {
    await assertTenant(tx, tenantId);
    return withTenant(tx, tenantId, async (t) => {
      const [vault, gateway, unlocks, lockouts] = await Promise.all([
        t.maybeOne<VaultRow & { passcode_changed_at: string | null; updated_at: string }>(
          `select id, enabled, passcode_hash, passcode_changed_at, unlock_minutes, allowed_role_types, revision, updated_at from security_vault`),
        t.maybeOne<GatewayRow & { updated_at: string }>(`select id, enabled, path, points, revision, updated_at from private_gateway`),
        t.one<{ count: string }>(
          `select count(*)::text as count from security_grant where kind = 'vault_unlock' and revoked_at is null and expires_at > now()`),
        t.query<{ kind: LockoutKind; user_id: string; full_name: string; locked_until: string }>(
          `select l.kind, l.user_id, u.full_name, l.locked_until from security_lockout l
             join app_user u on u.id = l.user_id where l.locked_until > now() order by l.locked_until desc`),
      ]);
      return {
        vault: {
          enabled: vault?.enabled ?? false,
          hasPasscode: Boolean(vault?.passcode_hash),
          passcodeChangedAt: vault?.passcode_changed_at ?? null,
          unlockMinutes: vault?.unlock_minutes ?? 15,
          allowedRoleTypes: vault?.allowed_role_types ?? ['owner'],
          revision: vault?.revision ?? 0,
          updatedAt: vault?.updated_at ?? null,
        },
        gateway: {
          enabled: gateway?.enabled ?? false, path: gateway?.path ?? '', points: gateway?.points ?? [],
          revision: gateway?.revision ?? 0, updatedAt: gateway?.updated_at ?? null,
        },
        activeUnlocks: Number(unlocks.count),
        lockouts: lockouts.map((l) => ({ kind: l.kind, userId: l.user_id, userName: l.full_name, lockedUntil: l.locked_until })),
      };
    });
  });
}

const stale = () => new ConflictError('These settings were changed a moment ago. Reload and try again.');

export async function saveVault(
  tenantId: string,
  input: { enabled: boolean; passcode?: string; unlockMinutes: number; allowedRoleTypes: VaultRoleType[]; revision: number },
  actor: string, ip?: string,
): Promise<TenantSecurity['vault']> {
  if (!input.allowedRoleTypes.length) throw new ValidationError('Choose at least one role that may unlock the vault.');
  const newHash = input.passcode ? await hashPassword(input.passcode) : null;

  await asPlatform(async (tx) => {
    await assertTenant(tx, tenantId);
    const saved = await withTenant(tx, tenantId, async (t) => {
      const current = await t.maybeOne<{ passcode_hash: string | null; revision: number }>(
        `select passcode_hash, revision from security_vault for update`);
      if ((current?.revision ?? 0) !== input.revision) throw stale();
      const hash = newHash ?? current?.passcode_hash ?? null;
      if (input.enabled && !hash) {
        throw new BusinessRuleError('Set a passcode before switching the vault on.', 'vault_passcode_required');
      }
      const row = await t.one<{ id: string }>(
        `insert into security_vault (id, tenant_id, enabled, passcode_hash, passcode_changed_at, unlock_minutes,
                                     allowed_role_types, revision, updated_by_platform_user_id)
         values (gen_random_uuid(), $1, $2, $3, case when $4 then now() end, $5, $6::jsonb, $7, $8)
         on conflict (tenant_id) do update set
           enabled = excluded.enabled, passcode_hash = excluded.passcode_hash,
           passcode_changed_at = case when $4 then now() else security_vault.passcode_changed_at end,
           unlock_minutes = excluded.unlock_minutes, allowed_role_types = excluded.allowed_role_types,
           revision = excluded.revision, updated_by_platform_user_id = excluded.updated_by_platform_user_id,
           updated_at = now()
         returning id`,
        [tenantId, input.enabled, hash, newHash !== null, input.unlockMinutes,
         JSON.stringify([...new Set(input.allowedRoleTypes)]), input.revision + 1, actor],
      );
      // Every save locks the vault for everyone; a new passcode also forgives old wrong tries.
      await t.query(`update security_grant set revoked_at = now(), updated_at = now() where kind = 'vault_unlock' and revoked_at is null`);
      if (newHash) await t.query(`delete from security_lockout where kind = 'vault'`);
      return row;
    });
    await audit(tx, actor, 'security.vault.update', {
      tenantId, targetType: 'security_vault', targetId: saved.id, ip,
      changes: { enabled: input.enabled, unlockMinutes: input.unlockMinutes, allowedRoleTypes: input.allowedRoleTypes, passcodeChanged: newHash !== null },
    });
  });
  return (await tenantSecurity(tenantId)).vault;
}

export async function saveGateway(
  tenantId: string,
  input: { enabled: boolean; path: string; points: GatewayPoint[]; revision: number },
  actor: string, ip?: string,
): Promise<TenantSecurity['gateway']> {
  const path = input.path.trim();
  const blank = path === '' && input.points.length === 0;
  if (input.enabled || !blank) {
    if (!validGatewayPath(path)) {
      throw new ValidationError('Use a private path like /quiet-door: lowercase letters, digits and hyphens, not a path the app already uses.',
        [{ field: 'path', message: 'Not a usable private path.' }]);
    }
    if (!validGatewayPoints(input.points)) {
      throw new ValidationError('Pick exactly three points inside the grid, with space between their circles.',
        [{ field: 'points', message: 'Three separate points are needed.' }]);
    }
  }

  await asPlatform(async (tx) => {
    await assertTenant(tx, tenantId);
    const saved = await withTenant(tx, tenantId, async (t) => {
      const current = await t.maybeOne<{ revision: number }>(`select revision from private_gateway for update`);
      if ((current?.revision ?? 0) !== input.revision) throw stale();
      const row = await t.one<{ id: string }>(
        `insert into private_gateway (id, tenant_id, enabled, path, points, revision, updated_by_platform_user_id)
         values (gen_random_uuid(), $1, $2, $3, $4::jsonb, $5, $6)
         on conflict (tenant_id) do update set
           enabled = excluded.enabled, path = excluded.path, points = excluded.points, revision = excluded.revision,
           updated_by_platform_user_id = excluded.updated_by_platform_user_id, updated_at = now()
         returning id`,
        [tenantId, input.enabled, path, JSON.stringify(input.points.map((p) => ({ x: p.x, y: p.y }))), input.revision + 1, actor],
      );
      await t.query(`update security_grant set revoked_at = now(), updated_at = now()
                      where kind in ('gateway_grant', 'gateway_access') and revoked_at is null`);
      await t.query(`delete from security_lockout where kind = 'gateway'`);
      return row;
    });
    // The path and points are the secret; the audit records only that they changed.
    await audit(tx, actor, 'security.gateway.update', {
      tenantId, targetType: 'private_gateway', targetId: saved.id, ip, changes: { enabled: input.enabled },
    });
  });
  return (await tenantSecurity(tenantId)).gateway;
}

/** Lets people back in before their lockout runs out — the owner who mistyped the passcode five times. */
export async function clearLockouts(tenantId: string, userId: string | undefined, actor: string, ip?: string): Promise<{ cleared: number }> {
  return asPlatform(async (tx) => {
    await assertTenant(tx, tenantId);
    const rows = await withTenant(tx, tenantId, (t) => t.query(
      `delete from security_lockout where ($1::uuid is null or user_id = $1) returning id`, [userId ?? null]));
    await audit(tx, actor, 'security.lockouts.clear', { tenantId, targetType: 'security_lockout', ip, changes: { userId: userId ?? 'all', cleared: rows.length } });
    return { cleared: rows.length };
  });
}
