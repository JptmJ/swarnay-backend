/**
 * Every permission a role may be given. Built from the routes (each declares
 * its permission) plus the role templates, so it can never drift from the API.
 */
import { allRoutes } from '../../core/http/route-registry.js';
import { ValidationError } from '../../core/errors/app-error.js';
import { TENANT_ROLES } from '../platform/roles.js';

export interface PermissionEntry { module: string; code: string; description: string }

/** Permissions that gate UI or fields rather than a route (e.g. "stock.field.cost_value.view"). */
const EXTRA: PermissionEntry[] = [
  ...([
    ['reports.sales.view', 'Sales reports'], ['reports.stock.view', 'Stock reports'], ['reports.purchase.view', 'Purchase reports'],
    ['reports.oldgold.view', 'Old gold reports'], ['reports.orders.view', 'Order and karigar reports'], ['reports.schemes.view', 'Gold savings reports'],
    ['reports.girvi.view', 'Girvi reports'], ['reports.customers.view', 'Customer reports'], ['reports.accounts.view', 'Reports on the books'],
    ['reports.compliance.view', 'Compliance reports'], ['reports.staff.view', 'Staff reports'],
    ['reports.cost.view', 'See cost and margin in reports'],
  ] as const).map(([code, description]) => ({ module: 'reports', code, description })),
];

export function permissionCatalog(): PermissionEntry[] {
  const byCode = new Map<string, PermissionEntry>();
  const add = (code: string, description: string) => {
    if (code === '*' || code.endsWith('.*') || byCode.has(code)) return;
    byCode.set(code, { module: code.split('.')[0]!, code, description });
  };
  for (const route of allRoutes()) if (route.permission) add(route.permission, route.summary);
  for (const role of TENANT_ROLES) for (const p of role.permissions) add(p, p);
  for (const e of EXTRA) byCode.set(e.code, e);
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export function assertKnownPermissions(permissions: string[]): void {
  const catalog = permissionCatalog();
  const codes = new Set(catalog.map((c) => c.code));
  /* Every prefix a `.*` may stand for: "master.*" and "master.customer.*". */
  const prefixes = new Set<string>();
  for (const { code } of catalog) {
    const parts = code.split('.');
    for (let i = 1; i < parts.length; i++) prefixes.add(parts.slice(0, i).join('.'));
  }

  const unknown = permissions.filter(
    (p) => !(p === '*' || codes.has(p) || (p.endsWith('.*') && prefixes.has(p.slice(0, -2)))),
  );
  if (unknown.length) throw new ValidationError(`Unknown permission(s): ${unknown.join(', ')}`);
}

/* ------------------------------------------------------- the tree */

/** Friendly names for the top level, matching what the module dock calls them. */
const MODULE_NAMES: Record<string, string> = {
  accounts: 'Accounts & Ledgers', core: 'Core', dashboard: 'Dashboard', girvi: 'Girvi (Gold Loans)',
  master: 'Master Data', oldgold: 'Old Gold', orders: 'Orders', pos: 'Billing & POS',
  purchase: 'Purchase', reports: 'Reports', schemes: 'Gold Savings', settings: 'Settings',
  stock: 'Stock', tagging: 'Tagging', identity: 'Sign-in', platform: 'Platform',
};

/** And for the areas within a module, where the key alone reads poorly. */
const GROUP_NAMES: Record<string, string> = {
  'master.customer': 'Customers', 'master.rates': 'Metal Rates', 'master.item': 'Items',
  'master.purity': 'Purity', 'master.branch': 'Shops & Branches', 'master.karigar': 'Karigars',
  'pos.purchase': 'Purchase & GRN', 'stock.transfer': 'Stock Transfer', 'stock.count': 'Stock Count',
  'stock.adjustment': 'Stock Adjustment', 'stock.opening': 'Opening Stock',
  'schemes.accounts': 'Scheme Accounts', 'schemes.collection': 'Installment Collection',
  'settings.config': 'Business Rules', 'settings.theme': 'Theme', 'settings.numbering': 'Numbering',
  'settings.users': 'Staff', 'settings.roles': 'Roles', 'dashboard.layout': 'Dashboard layouts',
};

const titleise = (s: string) =>
  s.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export interface PermissionTreeNode {
  key: string;
  name: string;
  wildcard: string;
  groups: Array<{
    key: string;
    name: string;
    /** Null when the group is the module's own actions rather than a sub-area. */
    wildcard: string | null;
    permissions: Array<{ code: string; action: string; description: string }>;
  }>;
}

/**
 * The catalog arranged as module → group → action, for the role builder.
 *
 * A code is `module.action` or `module.group.action`; the former lands in a
 * group named after its own module, so a screen can render one shape. Nothing
 * is invented here — every leaf is a permission some route checks, which is why
 * the builder cannot offer a switch that does nothing.
 */
export function permissionTree(): PermissionTreeNode[] {
  const modules = new Map<string, Map<string, PermissionTreeNode['groups'][number]>>();

  for (const entry of permissionCatalog()) {
    const parts = entry.code.split('.');
    if (parts.length < 2) continue;

    const moduleKey = parts[0]!;
    const action = parts[parts.length - 1]!;
    const groupKey = parts.length === 2 ? moduleKey : parts.slice(0, -1).join('.');

    const groups = modules.get(moduleKey) ?? new Map();
    modules.set(moduleKey, groups);

    const group = groups.get(groupKey) ?? {
      key: groupKey,
      name: groupKey === moduleKey
        ? (MODULE_NAMES[moduleKey] ?? titleise(moduleKey))
        : (GROUP_NAMES[groupKey] ?? titleise(groupKey.split('.').slice(1).join(' '))),
      wildcard: groupKey === moduleKey ? null : `${groupKey}.*`,
      permissions: [],
    };
    groups.set(groupKey, group);
    group.permissions.push({ code: entry.code, action, description: entry.description });
  }

  return [...modules.entries()]
    .map(([key, groups]) => ({
      key,
      name: MODULE_NAMES[key] ?? titleise(key),
      wildcard: `${key}.*`,
      groups: [...groups.values()]
        // The module's own actions first, then its sub-areas by name.
        .sort((a, b) => (a.key === key ? -1 : b.key === key ? 1 : a.name.localeCompare(b.name)))
        .map((g) => ({ ...g, permissions: g.permissions.sort((x, y) => x.action.localeCompare(y.action)) })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
