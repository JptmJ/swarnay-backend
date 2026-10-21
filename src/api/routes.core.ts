/** Auth, tenancy, settings and dashboard endpoints. */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { defineRoute } from '../core/http/route-registry.js';
import { transaction } from '../core/db/client.js';
import { repo } from '../core/db/repository.js';
import { isProduction } from '../core/config/env.js';
import { limitFailures } from '../core/http/rate-limit.js';
import { UnauthorizedError } from '../core/errors/app-error.js';
import {
  changeOwnPassword, login, refreshSession, revokeRefreshToken, SESSION_HOURS, type Tokens,
} from '../modules/identity/auth.service.js';
import { describeSession } from '../modules/identity/access.service.js';
import { LICENCE_STATES, MODULE_CATALOG } from '../modules/tenancy/module-catalog.js';
import { describeConfig, setConfig } from '../core/config/config-service.js';
import { errorEnvelope, ok, record, uuid } from './schemas.js';
import { param } from '../core/http/middleware.js';

const TODAY = '2026-09-18';
const LOGIN_DAY = '2026-09-28';

/* ------------------------------------------------------------------ auth */

/**
 * The refresh token lives in an httpOnly cookie, so page scripts never see it.
 * The app either reaches the API on its own origin (Vite proxy, a rewrite) or on
 * a sibling subdomain listed in CORS_ORIGINS (erp.swarnay.com → api.swarnay.com).
 * Both are the same *site*, so a SameSite=Lax cookie is still first-party,
 * including in Safari. A backend on an unrelated domain would break this.
 */
const COOKIE = 'sw_rt';
const cookieOptions = { httpOnly: true, secure: isProduction, sameSite: 'lax', path: '/api' } as const;

const readRefreshCookie = (req: Request): string | undefined =>
  req.headers.cookie?.match(/(?:^|;\s*)sw_rt=([A-Za-z0-9_-]+)/)?.[1];

function sendTokens(res: Response, tokens: Tokens): string {
  res.cookie(COOKIE, tokens.refreshToken, {
    ...cookieOptions,
    ...(tokens.persistent ? { maxAge: SESSION_HOURS.persistent * 3_600_000 } : {}),
  });
  return tokens.accessToken;
}

const meta = (req: Request) => ({ userAgent: req.headers['user-agent'], ip: req.ip });

const session = z.object({
  user: z.object({
    id: uuid, fullName: z.string(), email: z.string().nullable(), phone: z.string().nullable(),
    mustChangePassword: z.boolean().describe('True: show only the change-password screen; every other call is refused until it is done.'),
  }),
  tenant: z.object({ id: uuid, code: z.string(), name: z.string(), kind: z.string(), status: z.string() }),
  branchId: uuid.nullable().describe('The branch this session works in. Send it back as `X-Branch-Id`.'),
  branches: z.array(z.object({ id: uuid, code: z.string(), name: z.string() })),
  roles: z.array(z.string()),
  permissions: z.array(z.string()).describe('At the active branch. `*` or `module.*` are wildcards.'),
  modules: z.array(z.object({
    key: z.string(), order: z.number(), group: z.string(), name: z.string(), shortName: z.string(),
    description: z.string(), statusLabel: z.string(),
    licence: z.enum(LICENCE_STATES), locked: z.boolean().describe('Held but lapsed: show disabled, with a renew prompt.'),
    trialEndsAt: z.string().nullable(), expiresAt: z.string().nullable(),
    subModules: z.array(z.object({ key: z.string(), name: z.string(), status: z.string() })),
    disabledSubModules: z.array(z.string())
      .describe('Sub-modules the super admin switched off, e.g. ["pos.purchase"]. Hide anything gated on a permission under them; the API answers 403 `module_disabled`.'),
  })).describe('Modules this shop may see. Absent means never shown — a module switched off by the super admin is absent, and its endpoints answer 403 `module_disabled`.'),
  theme: z.object({ preset_key: z.string(), css_variables: record, logo_url: z.string().nullable() }),
  support: z.object({
    sessionId: uuid, canWrite: z.boolean(), endsAt: z.string(),
  }).nullable().describe(
    'Non-null only when a Swarnay operator is inside this business through a support session. Show the support banner while it is set.',
  ),
});
const accessToken = z.string().describe('Send as `Authorization: Bearer <token>`. Lives 15 minutes; keep it in memory only.');
const cookieNote = 'The refresh token is set as the httpOnly `sw_rt` cookie; call with `credentials: "include"`.';

defineRoute({
  method: 'post', path: '/api/auth/login', module: 'identity', auth: false,
  summary: 'Sign in',
  description: `Returns an access token and the whole session, so the app can render straight away. ${cookieNote} After 20 failed attempts in a minute from one network for one shop, further attempts are refused for the rest of that minute.`,
  body: z.object({
    tenantCode: z.string().trim().min(1).max(40).describe('The shop code, e.g. "aarohi".'),
    identifier: z.string().trim().min(3).max(120).describe('Email address or mobile number.'),
    password: z.string().min(1).max(128),
    remember: z.boolean().default(true).describe('true: signed in for 30 days on this device. false: until the browser closes (12 hours at most).'),
  }),
  middleware: [limitFailures({
    limit: 20, windowMs: 60_000,
    key: (req) => `${req.ip}|${String(req.body.tenantCode).toLowerCase()}`,
    message: 'Too many failed sign-in attempts. Wait a minute and try again.',
  })],
  responses: [
    { status: 200, description: 'Signed in.', schema: z.object({ accessToken, session }) },
    { status: 401, description: 'See `error.code`: invalid_credentials, account_locked, account_inactive, tenant_inactive, no_branch.', schema: errorEnvelope },
    { status: 429, description: 'rate_limited.', schema: errorEnvelope },
  ],
  changelog: [
    { date: LOGIN_DAY, kind: 'changed', note: 'Refresh token moved to an httpOnly cookie. Response is now { accessToken, session }. Added `remember`. Failures carry specific codes.' },
    { date: '2026-09-26', kind: 'changed', note: 'Sign in with email or mobile; returns accessible branches. Permissions resolved from tenant roles.' },
    { date: TODAY, kind: 'added', note: 'Initial sign-in endpoint.' },
  ],
  handler: async (req, res) => {
    const { session: s, ...tokens } = await login(req.body, meta(req));
    return { accessToken: sendTokens(res, tokens), session: s };
  },
});

defineRoute({
  method: 'post', path: '/api/auth/refresh', module: 'identity', auth: false,
  summary: 'Get a new access token',
  description: 'Uses the `sw_rt` cookie and rotates it. Two calls within 30 seconds with the same cookie (a retry, or two tabs) both succeed; an old cookie presented later ends the whole sign-in.',
  responses: [
    { status: 200, description: 'A fresh access token; the cookie is rotated.', schema: z.object({ accessToken }) },
    { status: 401, description: 'session_expired, account_inactive or tenant_inactive — go to sign in and show the message.', schema: errorEnvelope },
  ],
  changelog: [
    { date: LOGIN_DAY, kind: 'changed', note: 'Reads the refresh token from the cookie instead of the body. 30-second grace for retries and parallel tabs.' },
    { date: '2026-09-26', kind: 'changed', note: 'Refresh tokens now rotate; reuse of an old token revokes the session.' },
    { date: TODAY, kind: 'added', note: 'Initial refresh endpoint.' },
  ],
  handler: async (req, res) => {
    const token = readRefreshCookie(req);
    if (!token) throw new UnauthorizedError('Please sign in.', 'session_expired');
    return { accessToken: sendTokens(res, await refreshSession(token, meta(req))) };
  },
});

defineRoute({
  method: 'post', path: '/api/auth/logout', module: 'identity', auth: false,
  summary: 'Sign out',
  description: 'Ends this sign-in on every tab and clears the cookie. Safe to call when already signed out.',
  responses: [{ status: 204, description: 'Signed out.' }],
  changelog: [
    { date: LOGIN_DAY, kind: 'changed', note: 'Uses the cookie; ends the whole sign-in, not just one token.' },
    { date: TODAY, kind: 'added', note: 'Initial logout endpoint.' },
  ],
  handler: async (req, res) => {
    const token = readRefreshCookie(req);
    if (token) await revokeRefreshToken(token);
    res.clearCookie(COOKIE, cookieOptions).status(204).end();
  },
});

defineRoute({
  method: 'post', path: '/api/me/password', module: 'identity',
  summary: 'Change your own password',
  description: `Signs out every other device and returns a new access token for this one. ${cookieNote}`,
  body: z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8).max(128) }),
  responses: [
    { status: 200, description: 'Changed.', schema: z.object({ accessToken }) },
    { status: 400, description: 'Current password is wrong, or the new one is the same.', schema: errorEnvelope },
  ],
  changelog: [
    { date: LOGIN_DAY, kind: 'changed', note: 'Returns { accessToken }; the refresh token is set as a cookie and keeps its remember-me setting.' },
    { date: '2026-09-26', kind: 'added', note: 'Self-service password change; required when mustChangePassword is true.' },
  ],
  handler: async (req, res) => ({
    accessToken: sendTokens(res, await changeOwnPassword(
      req.body.currentPassword, req.body.newPassword, readRefreshCookie(req), meta(req),
    )),
  }),
});

defineRoute({
  method: 'get', path: '/api/me', module: 'identity',
  summary: 'The session: user, shop, branch, permissions, modules and theme',
  description: 'The same `session` sign-in returns. Call it when the app opens, and with `X-Branch-Id` after switching branch.',
  responses: [
    { status: 200, description: 'The session at the active branch.', schema: session },
    { status: 403, description: 'branch_forbidden — that branch is not assigned to this user; call again without `X-Branch-Id`.', schema: errorEnvelope },
  ],
  changelog: [
    { date: LOGIN_DAY, kind: 'changed', note: 'Now returns the full session (user, shop, modules, theme) — replaces GET /api/tenancy/modules.' },
    { date: '2026-09-26', kind: 'added', note: 'Branch-aware access endpoint.' },
    { date: '2026-10-08', kind: 'added', note: '`modules[].disabledSubModules`. Re-fetch this after any 403 `module_disabled` so switched-off modules leave the dock.' },
  ],
  handler: async (req) => transaction((tx) => describeSession(tx, req.accessInfo!, req.ctx!.branchId)),
});

/* -------------------------------------------------------------- tenancy */

defineRoute({
  method: 'get', path: '/api/tenancy/catalog', module: 'platform',
  summary: 'The full module catalog, independent of any tenant',
  description: 'Every module the platform offers. Used by the SaaS admin screen when provisioning.',
  permission: 'platform.tenants.view',
  responses: [{ status: 200, description: 'All modules.', schema: z.object({ modules: z.array(record) }) }],
  changelog: [{ date: TODAY, kind: 'added', note: 'Catalog for the provisioning screen.' }],
  handler: async () => ({ modules: MODULE_CATALOG }),
});

/* ------------------------------------------------------------- settings */

defineRoute({
  method: 'get', path: '/api/settings/config', module: 'settings',
  summary: 'All settings with their effective values',
  description:
    'Each entry carries `value` (what applies now) and `source` (whether that came from a branch override, a tenant override, or the built-in default). Grouped by `group` so the settings screen can render tabs directly.',
  permission: 'settings.config.view',
  responses: [{ status: 200, description: 'Settings, grouped.', schema: z.object({ groups: record }) }],
  changelog: [{ date: TODAY, kind: 'added', note: 'Config engine read endpoint.' }],
  handler: async () => transaction(async (tx) => {
    const rows = await describeConfig(tx);
    const groups: Record<string, typeof rows> = {};
    for (const row of rows) (groups[row.group] ??= []).push(row);
    return { groups };
  }),
});

defineRoute({
  method: 'put', path: '/api/settings/config/:key', module: 'settings',
  summary: 'Change one setting',
  description:
    'Validated against the setting’s declared type. Settings marked `sensitive` change how past numbers are interpreted — warn before saving those.',
  permission: 'settings.config.update',
  params: z.object({ key: z.string().min(1).describe('Dotted key, e.g. pricing.wastage.basis') }),
  body: z.object({
    value: z.unknown().describe('Must match the setting’s declared type.'),
    branchId: uuid.nullish().describe('Only for branch-scoped settings.'),
    reason: z.string().max(500).optional(),
  }),
  responses: [
    { status: 200, description: 'Saved.', schema: z.object({ ok: z.boolean(), key: z.string() }) },
    { status: 400, description: 'Unknown key, or the value failed its type check.', schema: errorEnvelope },
  ],
  changelog: [{ date: TODAY, kind: 'added', note: 'Config engine write endpoint.' }],
  handler: async (req) => {
    const key = param(req, 'key');
    await transaction((tx) => setConfig(tx, key, req.body.value, {
      branchId: req.body.branchId ?? null, reason: req.body.reason,
    }));
    return { ok: true, key };
  },
});

defineRoute({
  method: 'get', path: '/api/settings/theme', module: 'settings',
  summary: 'The active theme',
  permission: 'settings.theme.view',
  responses: [{ status: 200, description: 'Theme preset and CSS variable overrides.', schema: record }],
  changelog: [{ date: TODAY, kind: 'added', note: 'Theme Studio read endpoint.' }],
  handler: async () => transaction(async (tx) =>
    (await tx.maybeOne(`select * from tenant_theme where branch_id is null and is_active = true limit 1`))
    ?? { preset_key: 'deep-forest', css_variables: {} }),
});

defineRoute({
  method: 'put', path: '/api/settings/theme', module: 'settings',
  summary: 'Change the theme',
  description: 'Preset keys match the frontend theme ids exactly.',
  permission: 'settings.theme.update',
  body: z.object({
    preset_key: z.enum(['deep-forest', 'royal-ruby', 'sapphire-platinum', 'obsidian-luxury', 'rose-gold', 'custom']),
    css_variables: z.record(z.string(), z.string()).optional().describe('CSS custom properties layered over the preset.'),
    logo_url: z.string().url().nullish(),
    branch_id: uuid.nullish().describe('Null sets the tenant default.'),
  }),
  responses: [{ status: 200, description: 'Saved.', schema: record }],
  changelog: [{ date: TODAY, kind: 'added', note: 'Theme Studio write endpoint.' }],
  handler: async (req) => transaction(async (tx) => {
    const existing = await tx.maybeOne<{ id: string }>(
      `select id from tenant_theme where branch_id is not distinct from $1`, [req.body.branch_id ?? null]);
    const values = {
      preset_key: req.body.preset_key,
      css_variables: JSON.stringify(req.body.css_variables ?? {}),
      logo_url: req.body.logo_url ?? null,
      branch_id: req.body.branch_id ?? null,
      is_active: true,
    };
    return existing ? repo(tx, 'tenant_theme').update(existing.id, values) : repo(tx, 'tenant_theme').insert(values);
  }),
});
