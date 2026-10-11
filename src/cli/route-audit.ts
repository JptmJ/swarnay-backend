/** Lists signed-in tenant routes that anyone with a login can call — each needs a permission. */
import '../bootstrap.js';
import '../api/index.js';
import { liveRoutes, routeScope } from '../core/http/route-registry.js';

const ALLOWED_OPEN = new Set(['GET /api/me', 'POST /api/me/password', 'GET /api/tenancy/modules']);

// Hidden routes are audited too: being left out of the docs is no excuse for missing a permission.
const open = liveRoutes().filter(
  (r) =>
    r.auth !== false &&
    routeScope(r) === 'tenant' &&
    !r.permission &&
    !ALLOWED_OPEN.has(`${r.method.toUpperCase()} ${r.path}`),
);

console.log(`\n${open.length} signed-in route(s) with NO permission check:\n`);
for (const r of open) {
  console.log(`  ${r.method.toUpperCase().padEnd(6)} ${r.path.padEnd(45)} [module: ${r.module}]`);
}
process.exitCode = open.length > 0 ? 1 : 0;
