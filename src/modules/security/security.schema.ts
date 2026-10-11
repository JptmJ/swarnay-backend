/**
 * The security vault and the private admin entry.
 *
 * Both are configured by the super admin only. A business never sees or edits
 * the settings: its staff only *use* them — unlock the vault with the passcode,
 * or open the private entry with the click pattern. Everything that proves
 * someone did so lives here on the server, as a hashed token with an expiry,
 * so nothing the browser claims about itself is ever trusted.
 */
import { defineTable } from '../../core/db/schema/registry.js';
import { col } from '../../core/db/schema/columns.js';

export const VAULT_ROLE_TYPES = ['owner', 'admin', 'staff'] as const;
export const GRANT_KINDS = ['vault_unlock', 'gateway_grant', 'gateway_access'] as const;
export const LOCKOUT_KINDS = ['vault', 'gateway'] as const;

export const securityVaultTable = defineTable({
  name: 'security_vault',
  module: 'security',
  comment: 'The private-figures vault of one business: on/off, its passcode and who may unlock it. One row per tenant, written only by the super admin.',
  columns: {
    enabled: col.bool({ notNull: true, default: 'false', comment: 'Off = nobody can unlock; private figures stay hidden.' }),
    passcode_hash: col.text({ comment: 'scrypt salt:hash. Never returned by any endpoint.' }),
    passcode_changed_at: col.timestamptz(),
    unlock_minutes: col.int({ notNull: true, default: '15', check: '{col} between 1 and 240', comment: 'How long one unlock lasts before it locks again by itself.' }),
    allowed_role_types: col.jsonb({ notNull: true, default: `'["owner"]'::jsonb`, comment: 'Role types that may unlock: owner, admin, staff.' }),
    revision: col.int({ notNull: true, default: '0', comment: 'Bumped on every save. Unlocks granted under an older revision stop working.' }),
    updated_by_platform_user_id: col.fk('platform_user'),
  },
  uniques: [{ columns: ['tenant_id'] }],
});

export const privateGatewayTable = defineTable({
  name: 'private_gateway',
  module: 'security',
  comment: 'The hidden admin entry on the 404 page: a private path and three ordered points on the artwork. One row per tenant, written only by the super admin.',
  columns: {
    enabled: col.bool({ notNull: true, default: 'false' }),
    path: col.text({ notNull: true, default: "''", comment: 'Exact, case-sensitive pathname. Never listed anywhere a business user can read it.' }),
    points: col.jsonb({ notNull: true, default: "'[]'::jsonb", comment: '[{x,y}] ×3, normalised 0–1 over the 640×440 artwork.' }),
    revision: col.int({ notNull: true, default: '0', comment: 'Bumped on every save. Grants issued under an older revision stop working.' }),
    updated_by_platform_user_id: col.fk('platform_user'),
  },
  uniques: [{ columns: ['tenant_id'] }],
});

export const securityGrantTable = defineTable({
  name: 'security_grant',
  module: 'security',
  comment: 'Short-lived proof that someone unlocked the vault or passed the private entry. Only the sha256 of each token is kept.',
  columns: {
    kind: col.enum(GRANT_KINDS, {
      notNull: true,
      comment: 'vault_unlock: private figures visible. gateway_grant: one-use, 60 s, swapped for gateway_access. gateway_access: the welcome view, 5 min.',
    }),
    user_id: col.fk('app_user', { notNull: true, onDelete: 'cascade' }),
    branch_id: col.fk('branch'),
    token_hash: col.text({ notNull: true, comment: 'sha256 of the token. The token itself is never stored.' }),
    token_version: col.int({ notNull: true, comment: 'The user’s token_version when issued. A password or role change bumps it and the grant dies.' }),
    revision: col.int({ notNull: true, comment: 'The vault or gateway revision when issued.' }),
    expires_at: col.timestamptz({ notNull: true }),
    consumed_at: col.timestamptz({ comment: 'One-use grants: set the moment it is used.' }),
    revoked_at: col.timestamptz(),
    ip_address: col.text(),
  },
  indexes: [
    { columns: ['token_hash'], unique: true, global: true },
    { columns: ['user_id', 'kind'] },
    { columns: ['expires_at'] },
  ],
});

export const securityLockoutTable = defineTable({
  name: 'security_lockout',
  module: 'security',
  comment: 'Wrong vault passcodes and wrong private-entry patterns, per person. Five in a row locks that person out for a while.',
  columns: {
    kind: col.enum(LOCKOUT_KINDS, { notNull: true }),
    user_id: col.fk('app_user', { notNull: true, onDelete: 'cascade' }),
    failed_count: col.int({ notNull: true, default: '0' }),
    locked_until: col.timestamptz(),
    last_failed_at: col.timestamptz(),
  },
  uniques: [{ columns: ['kind', 'user_id'] }],
});
