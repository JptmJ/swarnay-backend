/**
 * Signing in.
 *
 * Passwords use scrypt from Node's own crypto module — deliberately memory-hard
 * and with no native dependency to compile, which keeps deploys boring.
 *
 * A session is a short-lived access token (kept in memory by the app) plus a
 * refresh token (an httpOnly cookie the page's scripts can never read). Refresh
 * tokens rotate on every use; all rotations of one sign-in share a family.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { Tx } from '../../core/db/client.js';
import { asPlatform, transaction } from '../../core/db/client.js';
import { runWithContext } from '../../core/context/request-context.js';
import { env } from '../../core/config/env.js';
import { UnauthorizedError, ValidationError } from '../../core/errors/app-error.js';
import { newId } from '../../core/util/id.js';
import {
  describeSession, invalidateUserAccess, loadUserAccess, primeUserAccess, resolveBranch,
  TENANT_INACTIVE_MESSAGE, type Session,
} from './access.service.js';

const scrypt = promisify(scryptCallback) as (p: string, s: Buffer, k: number) => Promise<Buffer>;
const KEY_LENGTH = 64;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
/** Worked out by the database, whose clock set the lock. */
const LOCKED_MINUTES =
  'case when locked_until > now() then ceil(extract(epoch from locked_until - now()) / 60)::int end as locked_minutes';
/** Remember me: 30 days. Otherwise the cookie dies with the browser and the server gives up after 12 hours. */
export const SESSION_HOURS = { persistent: 24 * 30, browser: 12 } as const;
/** A rotated token presented again this soon is a retry or a second tab, not theft. */
const REUSE_GRACE_SECONDS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), KEY_LENGTH);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Kept deliberately small: permissions are resolved per request, not carried in the token. */
export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  tv: number;
}

export const signAccessToken = (claims: AccessTokenClaims): string =>
  jwt.sign(claims, env.JWT_SECRET, { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_TTL as never, issuer: 'swarnay' });

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], issuer: 'swarnay' }) as AccessTokenClaims;
  } catch {
    throw new UnauthorizedError('Your session has expired. Please sign in again.', 'session_expired');
  }
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const sessionExpired = () => new UnauthorizedError('Your session has expired. Please sign in again.', 'session_expired');
const lockedFor = (minutes: number) => new UnauthorizedError(
  `Too many wrong passwords. Try again in ${minutes} minutes.`,
  'account_locked',
);

export interface Tokens { accessToken: string; refreshToken: string; persistent: boolean }
export interface ClientMeta { userAgent?: string; ip?: string }

/** Indian numbers are stored as +91 and the 10 digits: 98765 43210 and 022 2344 8899 alike. */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  return `+${digits}`;
}

async function issueTokens(
  tx: Tx, user: { id: string; tenantId: string; tokenVersion: number }, persistent: boolean,
  meta: ClientMeta, familyId: string | null = null,
): Promise<Tokens> {
  const refreshToken = randomBytes(48).toString('base64url');
  await tx.query(
    `insert into refresh_token
       (id, tenant_id, user_id, family_id, token_hash, expires_at, persistent, user_agent, ip_address, created_by, updated_by)
     values ($1, $2, $3, coalesce($4, gen_random_uuid()), $5, now() + make_interval(hours => $6), $7, $8, $9, $3, $3)`,
    [newId(), user.tenantId, user.id, familyId, hashToken(refreshToken),
     persistent ? SESSION_HOURS.persistent : SESSION_HOURS.browser, persistent, meta.userAgent ?? null, meta.ip ?? null],
  );
  return {
    accessToken: signAccessToken({ sub: user.id, tenantId: user.tenantId, tv: user.tokenVersion }),
    refreshToken,
    persistent,
  };
}

/**
 * Finding the user has a chicken-and-egg problem: we need the tenant to scope
 * the query, but the tenant is what we are trying to work out. So this one
 * lookup runs at platform level, matching on shop code + email/phone, and
 * everything after it is properly tenant-scoped.
 *
 * Nothing about the account (inactive, no branch) is revealed until the
 * password is right, so the response cannot be used to discover accounts.
 */
export async function login(
  input: { tenantCode: string; identifier: string; password: string; remember: boolean },
  meta: ClientMeta = {},
): Promise<Tokens & { session: Session }> {
  const isEmail = input.identifier.includes('@');
  const found = await asPlatform((tx) =>
    tx.maybeOne<{
      id: string; tenant_id: string; password_hash: string; is_active: boolean;
      locked_minutes: number | null; token_version: number; tenant_status: string;
    }>(
      `select u.id, u.tenant_id, u.password_hash, u.is_active, u.token_version, ${LOCKED_MINUTES},
              t.status as tenant_status
         from app_user u join tenant t on t.id = u.tenant_id
        where lower(t.code) = lower($1) and ${isEmail ? 'u.email' : 'u.phone'} = $2
          and u.deleted_at is null and t.deleted_at is null`,
      [input.tenantCode.trim(), isEmail ? input.identifier.trim().toLowerCase() : normalizePhone(input.identifier)],
    ),
  );

  const rejection = new UnauthorizedError('Shop code, email/mobile or password is not correct.', 'invalid_credentials');
  if (!found) {
    // Burn roughly the same time a real verification would take.
    await scrypt(input.password, randomBytes(16), KEY_LENGTH);
    throw rejection;
  }
  if (found.locked_minutes) throw lockedFor(found.locked_minutes);

  if (!(await verifyPassword(input.password, found.password_hash))) {
    const lockedMinutes = await recordFailedLogin(found.id);
    throw lockedMinutes ? lockedFor(lockedMinutes) : rejection;
  }
  if (found.tenant_status === 'suspended' || found.tenant_status === 'closed') {
    throw new UnauthorizedError(TENANT_INACTIVE_MESSAGE, 'tenant_inactive');
  }
  if (!found.is_active) {
    throw new UnauthorizedError('Your user has been deactivated. Ask your shop admin.', 'account_inactive');
  }

  const context = {
    requestId: `login:${found.id.slice(0, 8)}`,
    tenantId: found.tenant_id,
    userId: found.id,
    branchId: null,
    roles: [] as string[],
    permissions: new Set<string>(),
  };

  return runWithContext(context, () => transaction(async (tx) => {
    const access = await loadUserAccess(tx, found.id);
    if (!access?.branches.length) {
      throw new UnauthorizedError('No branch has been assigned to you yet. Ask your shop admin.', 'no_branch');
    }
    await tx.query(
      `update app_user set last_login_at = now(), failed_login_count = 0, locked_until = null where id = $1`,
      [found.id],
    );
    await tx.query(
      `delete from refresh_token where user_id = $1 and (expires_at < now() or revoked_at < now() - interval '7 days')`,
      [found.id],
    );
    const tokens = await issueTokens(
      tx, { id: found.id, tenantId: found.tenant_id, tokenVersion: found.token_version }, input.remember, meta,
    );
    primeUserAccess(found.tenant_id, access);
    return { ...tokens, session: await describeSession(tx, access, resolveBranch(access, undefined)) };
  }));
}

/** Counts a wrong password. Returns the minutes the account is now locked for, if it is. */
async function recordFailedLogin(userId: string): Promise<number | null> {
  return asPlatform(async (tx) => {
    // A lock that has already run out starts the count again, rather than
    // re-locking on the very next mistake.
    const row = await tx.one<{ locked_minutes: number | null }>(
      `update app_user
          set failed_login_count = case when locked_until <= now() then 1 else failed_login_count + 1 end,
              locked_until = case
                when (case when locked_until <= now() then 1 else failed_login_count + 1 end) >= $2
                  then now() + make_interval(mins => $3)
                when locked_until <= now() then null
                else locked_until end
        where id = $1
       returning ${LOCKED_MINUTES}`,
      [userId, MAX_FAILED_LOGINS, LOCK_MINUTES],
    );
    return row.locked_minutes;
  });
}

export async function refreshSession(refreshToken: string, meta: ClientMeta = {}): Promise<Tokens> {
  const outcome = await asPlatform(async (tx) => {
    const row = await tx.maybeOne<{
      id: string; user_id: string; tenant_id: string; family_id: string; persistent: boolean;
      replaced_by_id: string | null; in_grace: boolean; usable: boolean;
      token_version: number; user_active: boolean; tenant_active: boolean;
    }>(
      `select rt.id, rt.user_id, rt.tenant_id, rt.family_id, rt.persistent, rt.replaced_by_id,
              rt.revoked_at > now() - make_interval(secs => $2) as in_grace,
              rt.revoked_at is null and rt.expires_at > now() as usable,
              u.token_version, u.is_active and u.deleted_at is null as user_active,
              t.status not in ('suspended', 'closed') and t.deleted_at is null as tenant_active
         from refresh_token rt
         join app_user u on u.id = rt.user_id
         join tenant t on t.id = rt.tenant_id
        where rt.token_hash = $1
        for update of rt`,
      [hashToken(refreshToken), REUSE_GRACE_SECONDS],
    );
    if (!row) return sessionExpired();

    const revokeFamily = () =>
      tx.query(`update refresh_token set revoked_at = now() where family_id = $1 and revoked_at is null`, [row.family_id]);
    const user = { id: row.user_id, tenantId: row.tenant_id, tokenVersion: row.token_version };

    if (!row.tenant_active || !row.user_active) {
      await revokeFamily();
      return row.tenant_active
        ? new UnauthorizedError('Your user has been deactivated. Ask your shop admin.', 'account_inactive')
        : new UnauthorizedError(TENANT_INACTIVE_MESSAGE, 'tenant_inactive');
    }
    if (row.replaced_by_id) {
      if (row.in_grace) return issueTokens(tx, user, row.persistent, meta, row.family_id);
      // An old token presented again, long after it was rotated, means it was copied.
      await revokeFamily();
      return sessionExpired();
    }
    if (!row.usable) return sessionExpired();

    const next = await issueTokens(tx, user, row.persistent, meta, row.family_id);
    await tx.query(
      `update refresh_token set revoked_at = now(),
              replaced_by_id = (select id from refresh_token where token_hash = $2)
        where id = $1`,
      [row.id, hashToken(next.refreshToken)],
    );
    await tx.query(
      `delete from refresh_token where family_id = $1 and revoked_at < now() - interval '7 days'`, [row.family_id],
    );
    return next;
  });

  if (outcome instanceof UnauthorizedError) throw outcome;
  return outcome;
}

/**
 * Signing out ends this sign-in on every tab that shares it, and closes any
 * vault unlock or private entry the person had open.
 */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await asPlatform(async (tx) => {
    const ended = await tx.query<{ user_id: string }>(
      `update refresh_token set revoked_at = now()
        where family_id = (select family_id from refresh_token where token_hash = $1) and revoked_at is null
       returning user_id`,
      [hashToken(refreshToken)],
    );
    if (ended.length) {
      await tx.query(
        `update security_grant set revoked_at = now(), updated_at = now()
          where user_id = $1 and revoked_at is null and expires_at > now()`,
        [ended[0]!.user_id],
      );
    }
  });
}

/**
 * The signed-in user changes their own password. Ends every other session and
 * returns a fresh one, so this device stays signed in, as persistent as before.
 */
export async function changeOwnPassword(
  currentPassword: string, newPassword: string, refreshToken: string | undefined, meta: ClientMeta = {},
): Promise<Tokens> {
  return transaction(async (tx) => {
    const userId = tx.context.userId!;
    const user = await tx.one<{ password_hash: string; persistent: boolean | null }>(
      `select u.password_hash, (select persistent from refresh_token where token_hash = $2) as persistent
         from app_user u where u.id = $1 for update`,
      [userId, refreshToken ? hashToken(refreshToken) : null],
    );
    // 400, not 401 — a 401 would make the client try to refresh its token.
    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      throw new ValidationError('Your current password is not correct.');
    }
    if (currentPassword === newPassword) throw new ValidationError('Choose a password different from your current one.');

    const updated = await tx.one<{ token_version: number }>(
      `update app_user
          set password_hash = $2, must_change_password = false, password_changed_at = now(),
              token_version = token_version + 1
        where id = $1
       returning token_version`,
      [userId, await hashPassword(newPassword)],
    );
    await tx.query(`update refresh_token set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
    invalidateUserAccess(tx.context.tenantId, userId);
    return issueTokens(
      tx, { id: userId, tenantId: tx.context.tenantId, tokenVersion: updated.token_version }, user.persistent ?? true, meta,
    );
  });
}
