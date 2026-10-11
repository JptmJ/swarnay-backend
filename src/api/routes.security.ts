/**
 * The security vault and the private admin entry.
 *
 * A business only *uses* these: it unlocks the vault, or passes the private
 * entry. Switching them on, the passcode, who may unlock, and the private
 * path and points are set by the super admin under /api/platform/tenants/:id/security.
 *
 * Every response here is `Cache-Control: private, no-store`.
 */
import { z } from 'zod';
import { defineRoute } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { limitFailures, limitRequests } from '../core/http/rate-limit.js';
import { param, platformUserId } from '../core/http/middleware.js';
import {
  checkVaultUnlock, clearLockouts, gatewayGesture, gatewayWelcome, lockVault, saveGateway, saveVault,
  tenantSecurity, unlockVault, vaultStatus,
} from '../modules/security/security.service.js';
import { VAULT_ROLE_TYPES } from '../modules/security/security.schema.js';
import { errorEnvelope, idParam, uuid } from './schemas.js';

const DAY = '2026-10-10';
const added = (note: string) => [{ date: DAY, kind: 'added' as const, note }];
const UNLOCK = 'settings.vault.unlock';

const token = z.string().min(32).max(200).describe('The token returned by unlock. Keep it in memory for this tab only.');
const expiry = z.object({ expiresAt: z.number().describe('Unix milliseconds.') });
const point = z.object({ x: z.number().finite(), y: z.number().finite() });
const byUser = (req: { ctx?: { tenantId: string; userId: string | null } }) => `${req.ctx?.tenantId}:${req.ctx?.userId}`;

/* -------------------------------------------------------------- vault */

defineRoute({
  method: 'get', path: '/api/security/vault', module: 'settings',
  summary: 'Can this person unlock private figures?',
  description:
    'Whether the vault is on for this business and whether the signed-in person may unlock it. No secret is returned. When `canUnlock` is false, show `message` instead of the passcode box.',
  permission: UNLOCK, noStore: true,
  responses: [{ status: 200, description: 'Vault status.', schema: z.object({
    enabled: z.boolean().describe('False = switched off by the super admin; private figures stay hidden.'),
    canUnlock: z.boolean(),
    unlockMinutes: z.number().describe('How long one unlock lasts.'),
    reason: z.enum(['disabled', 'role']).nullable(),
    message: z.string().nullable().describe('Plain-English reason when canUnlock is false.'),
  }) }],
  changelog: added('Vault status. The vault is configured by the super admin only.'),
  handler: async () => transaction((tx) => vaultStatus(tx)),
});

defineRoute({
  method: 'post', path: '/api/security/vault/unlock', module: 'settings',
  summary: 'Unlock private figures with the vault passcode',
  description:
    'Checks the passcode against the hash the super admin set. Five wrong tries lock that person out for 15 minutes. The token is valid for the configured minutes, and stops working early if the vault is switched off or re-configured, or the person’s password or role changes.',
  permission: UNLOCK, noStore: true,
  middleware: [limitFailures({ limit: 20, windowMs: 15 * 60_000, key: (req) => `vault:${req.ip}`, message: 'Too many wrong passcodes from this network. Wait 15 minutes.' })],
  body: z.object({ passcode: z.string().min(1).max(128) }),
  responses: [
    { status: 200, description: 'Unlocked.', schema: z.object({ token: z.string(), expiresAt: z.number().describe('Unix milliseconds.') }) },
    { status: 403, description: '`vault_not_allowed` — this person’s role may not unlock.', schema: errorEnvelope },
    { status: 422, description: '`vault_passcode_invalid` (wrong passcode, message says tries left) or `vault_disabled`.', schema: errorEnvelope },
    { status: 429, description: '`vault_locked` — too many wrong passcodes; or `rate_limited` from one network.', schema: errorEnvelope },
  ],
  changelog: added('Replaces POST /api/private-screen/unlock and POST /api/private-screen/password, which are gone. The passcode is set by the super admin.'),
  handler: async (req) => {
    const outcome = await transaction((tx) => unlockVault(tx, req.body.passcode, req.ip));
    if (!outcome.ok) throw outcome.error;
    return { token: outcome.token, expiresAt: outcome.expiresAt };
  },
});

defineRoute({
  method: 'post', path: '/api/security/vault/session', module: 'settings',
  summary: 'Is this unlock still good?',
  description: 'Send the token from unlock. Returns its expiry, or `null` once it has expired or been ended for any reason — then lock the screen.',
  permission: UNLOCK, noStore: true,
  body: z.object({ token }),
  responses: [{ status: 200, description: 'Still unlocked, or null.', schema: expiry.nullable() }],
  changelog: added('Re-checks an unlock after a reload.'),
  handler: async (req) => transaction((tx) => checkVaultUnlock(tx, req.body.token)),
});

defineRoute({
  method: 'post', path: '/api/security/vault/lock', module: 'settings',
  summary: 'Lock private figures now',
  permission: UNLOCK, noStore: true,
  body: z.object({ token }),
  responses: [{ status: 204, description: 'Locked.' }],
  changelog: added('Ends an unlock before it runs out.'),
  handler: async (req, res) => { await transaction((tx) => lockVault(tx, req.body.token)); res.status(204).end(); },
});

/* ------------------------------------------------------ private entry */

const gestureLimit = limitRequests({ limit: 30, windowMs: 60_000, key: byUser, message: 'Please wait a minute.' });

defineRoute({
  method: 'post', path: '/api/private-screen/gesture', module: 'settings', hidden: true, noStore: true,
  summary: 'Private entry: three ordered clicks on the 404 artwork',
  description: 'Every refusal is `null`. A match returns a one-use grant valid for 60 seconds, to be exchanged at /welcome.',
  permission: 'settings.config.update', middleware: [gestureLimit],
  body: z.object({
    path: z.string().min(1).max(200),
    points: z.array(point).length(3),
    artworkVersion: z.number().int(),
  }),
  responses: [{ status: 200, description: 'A grant, or null.', schema: z.object({ grant: z.string(), expiresAt: z.number() }).nullable() }],
  changelog: added('Verified on the server against the pattern the super admin set.'),
  handler: async (req) => transaction((tx) => gatewayGesture(tx, req.body, req.ip)),
});

defineRoute({
  method: 'post', path: '/api/private-screen/welcome', module: 'settings', hidden: true, noStore: true,
  summary: 'Private entry: exchange the grant for the welcome view',
  permission: 'settings.config.update', middleware: [gestureLimit],
  body: z.object({ grant: z.string().min(32).max(200) }),
  responses: [{ status: 200, description: 'Five minutes of access, or null.', schema: expiry.nullable() }],
  changelog: added('Consumes the grant atomically; a replay gets null.'),
  handler: async (req) => transaction((tx) => gatewayWelcome(tx, req.body.grant, req.ip)),
});

/* ------------------------------------------------------- super admin */

const M = 'platform';
const vaultShape = z.object({
  enabled: z.boolean(), hasPasscode: z.boolean(), passcodeChangedAt: z.string().nullable(),
  unlockMinutes: z.number(), allowedRoleTypes: z.array(z.enum(VAULT_ROLE_TYPES)), revision: z.number(), updatedAt: z.string().nullable(),
});
const gatewayShape = z.object({
  enabled: z.boolean(), path: z.string(), points: z.array(point), revision: z.number(), updatedAt: z.string().nullable(),
});

defineRoute({
  method: 'get', path: '/api/platform/tenants/:id/security', module: M, noStore: true,
  summary: 'A business’s security vault and private entry settings',
  description: 'The passcode itself is never returned — only whether one is set. Includes how many vault unlocks are open right now and who is locked out.',
  permission: 'platform.tenants.view', params: idParam,
  responses: [
    { status: 200, description: 'Settings.', schema: z.object({
      vault: vaultShape, gateway: gatewayShape, activeUnlocks: z.number(),
      lockouts: z.array(z.object({ kind: z.enum(['vault', 'gateway']), userId: uuid, userName: z.string(), lockedUntil: z.string() })),
    }) },
    { status: 404, description: 'No such tenant.', schema: errorEnvelope },
  ],
  changelog: added('Security vault configuration moved here from the shop’s own Settings.'),
  handler: async (req) => tenantSecurity(param(req, 'id')),
});

defineRoute({
  method: 'put', path: '/api/platform/tenants/:id/security/vault', module: M, noStore: true,
  summary: 'Switch the vault on or off, set its passcode and who may unlock it',
  description:
    'Send the whole setting with the `revision` you loaded; a stale revision gets 409. Leave `passcode` out to keep the current one. Every save locks the vault for everyone who had it open, and a new passcode clears old wrong-try lockouts.',
  permission: 'platform.tenants.update', params: idParam,
  body: z.object({
    enabled: z.boolean(),
    passcode: z.string().min(6, 'Use at least 6 characters.').max(128).optional().describe('Only when setting or changing it. Never stored readable.'),
    unlockMinutes: z.number().int().min(1).max(240).describe('How long one unlock lasts.'),
    allowedRoleTypes: z.array(z.enum(VAULT_ROLE_TYPES)).min(1).describe('owner, admin (branch admins) and/or staff.'),
    revision: z.number().int().min(0),
  }),
  responses: [
    { status: 200, description: 'Saved.', schema: vaultShape },
    { status: 400, description: 'Passcode under 6 characters, or no role chosen.', schema: errorEnvelope },
    { status: 409, description: '`conflict` — changed by someone else since it was loaded.', schema: errorEnvelope },
    { status: 422, description: '`vault_passcode_required` — switched on with no passcode set.', schema: errorEnvelope },
  ],
  changelog: added('Vault on/off, passcode and roles, set by the super admin only.'),
  handler: async (req) => saveVault(param(req, 'id'), req.body, platformUserId(req), req.ip),
});

defineRoute({
  method: 'put', path: '/api/platform/tenants/:id/security/gateway', module: M, noStore: true,
  summary: 'Set the private entry path and its three points',
  description:
    'Points are normalised over the 404 artwork (x 0.07–0.93, y 0.10–0.90) and at least 96 artwork units apart. Switching it on needs a valid path and three points. Every save ends any open private-entry grant.',
  permission: 'platform.tenants.update', params: idParam,
  body: z.object({
    enabled: z.boolean(),
    path: z.string().max(200).describe('e.g. /quiet-door. Lowercase letters, digits and hyphens; not a path the app uses.'),
    points: z.array(point).max(3),
    revision: z.number().int().min(0),
  }),
  responses: [
    { status: 200, description: 'Saved.', schema: gatewayShape },
    { status: 400, description: 'Path or points not usable.', schema: errorEnvelope },
    { status: 409, description: '`conflict` — changed by someone else since it was loaded.', schema: errorEnvelope },
  ],
  changelog: added('Private entry configuration moved here from the shop’s own Settings.'),
  handler: async (req) => saveGateway(param(req, 'id'), req.body, platformUserId(req), req.ip),
});

defineRoute({
  method: 'post', path: '/api/platform/tenants/:id/security/lockouts/clear', module: M, noStore: true,
  summary: 'Let locked-out people try again now',
  description: 'Omit `userId` to clear everyone in this business.',
  permission: 'platform.tenants.update', params: idParam,
  body: z.object({ userId: uuid.optional() }),
  responses: [{ status: 200, description: 'How many were cleared.', schema: z.object({ cleared: z.number() }) }],
  changelog: added('Clears vault and private-entry lockouts.'),
  handler: async (req) => clearLockouts(param(req, 'id'), req.body.userId, platformUserId(req), req.ip),
});
