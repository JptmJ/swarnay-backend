/**
 * Importing this file registers every endpoint.
 *
 * Order matters only for readability — the registry sorts by module for the
 * docs and Express matches on the declared path.
 */
import './routes.core.js';
import './routes.master.js';
import './routes.master-pricing.js';
import './routes.master-setup.js';
import './routes.master-import.js';
import './routes.orders.js';
import './routes.orders-import.js';
import './routes.pos.js';
import './routes.purchase.js';
import './routes.oldgold.js';
import './routes.schemes.js';
import './routes.girvi.js';
import './routes.security.js';
import './routes.stock.js';
import './routes.accounts.js';
import './routes.reports.js';
import './routes.dashboard.js';
import './routes.users.js';
import './routes.pricing.js';

/* Platform (super admin) routes — mounted on a separate router in app.ts. */
import './routes.platform.js';
import './routes.platform-import.js';

export { buildRouter, allRoutes, changeFeed } from '../core/http/route-registry.js';
