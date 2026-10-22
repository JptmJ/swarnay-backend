/**
 * Who can do what.
 *
 * One platform operator, and three kinds of role inside a jewellery business.
 *
 *   PLATFORM   the super admin. One account, every right, no tenant.
 *   TENANT     owner · branch admin · staff
 *
 * A platform token is refused by every tenant route and a tenant token by every
 * platform route, so the only way from the console into a business's data is a
 * logged support session.
 */

/* =========================================================== PLATFORM */

/**
 * There is exactly one platform role and exactly one account holding it,
 * created by `npm run seed:superadmin` and never through the API. It holds `*`:
 * the account that can reach every tenant on the platform is not something to
 * carve into tiers, and not something a form should be able to multiply.
 */
export const SUPER_ADMIN = {
  code: 'super_admin',
  name: 'Super Admin',
  description: 'The platform owner. Every tenant, every entitlement, every flag. Creates tenants, branches, roles and all users.',
  permissions: ['*'],
} as const;

export type PlatformRoleCode = typeof SUPER_ADMIN.code;
export const PLATFORM_ROLE_CODES: string[] = [SUPER_ADMIN.code];

export const platformRole = (code: string) => (code === SUPER_ADMIN.code ? SUPER_ADMIN : undefined);

/** The permissions a platform operator's token carries. */
export function platformPermissionsFor(roleCode: string): string[] {
  return roleCode === SUPER_ADMIN.code ? [...SUPER_ADMIN.permissions] : [];
}

/* ============================================================= TENANT */

/**
 * The three kinds of role a business can have.
 *
 *   owner   the proprietor. Everything, every branch. One per business.
 *   admin   runs a branch. Everything within it, including its own staff's
 *           activation and the shop's branch list. One per branch.
 *   staff   everyone else — and the reason this is a *type* rather than a role.
 *
 * `staff` is deliberately open: one shop's accountant handles billing only,
 * another's handles billing and tagging. Rather than guess a fixed ladder, the
 * super admin names a role per business ("Accountant", "Counter Staff") and
 * ticks exactly the permissions it carries. Two shops can both have an
 * "Accountant" that means two different things, which is what actually happens.
 */
export const ROLE_TYPES = ['owner', 'admin', 'staff'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

export interface RoleTemplate {
  code: string;
  name: string;
  type: RoleType;
  description: string;
  /** At most one holder per branch, or one covering every branch. */
  isBranchAdmin: boolean;
  permissions: string[];
}

/**
 * Seeded into every new business. Only these two: staff roles are created per
 * business by the super admin, because a seeded one would be a guess about how
 * that shop is run.
 */
export const TENANT_ROLES: RoleTemplate[] = [
  {
    code: 'owner',
    name: 'Owner',
    type: 'owner',
    description: 'The proprietor. Full access to the business, every branch, every module.',
    isBranchAdmin: true,
    permissions: ['*'],
  },
  {
    code: 'admin',
    name: 'Branch Admin',
    type: 'admin',
    description:
      'Runs a branch: billing, orders, stock, old gold, rates, reports and the shop’s branch list. Can deactivate a staff account, but cannot create one or decide what it may reach — that is the super admin’s.',
    isBranchAdmin: true,
    permissions: [
      'orders.*', 'stock.*', 'tagging.*', 'pos.*', 'oldgold.*',
      'schemes.*', 'girvi.*', 'master.*', 'reports.*', 'accounts.*', 'dashboard.*',
      'settings.config.view', 'settings.config.update',
      'settings.theme.view', 'settings.theme.update',
      'settings.numbering.view', 'settings.numbering.update',
      /*
       * Staff: see the list and switch someone off, nothing else. Creating a
       * person, naming their role or choosing what it reaches stays with the
       * super admin, and the endpoints for those no longer exist here.
       *
       * `master.*` above is what lets an admin add and edit branches, within
       * whatever branch limit the business is on.
       */
      'settings.users.view', 'settings.users.status', 'settings.roles.view',
    ],
  },
];

export type TenantRoleCode = string;
export const TENANT_ROLE_CODES: string[] = TENANT_ROLES.map((r) => r.code);

export const tenantRole = (code: string) => TENANT_ROLES.find((r) => r.code === code);

/**
 * The permissions a template carries. A staff role has no template — its
 * permissions live in `role_permission` rows and are read from the database,
 * which is the whole point of the type.
 */
export function permissionsFor(roleCode: string): string[] {
  return [...(tenantRole(roleCode)?.permissions ?? [])];
}

export const ADMIN_ROLE = 'admin';
export const OWNER_ROLE = 'owner';
export const isAdminRole = (code: string): boolean => code === ADMIN_ROLE;

/** Roles limited to one holder per branch. Staff roles are not. */
export const isBranchAdminRole = (code: string): boolean =>
  tenantRole(code)?.isBranchAdmin === true;
