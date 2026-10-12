/**
 * Importing this file is what makes the schema registry complete.
 *
 * Every module's `*.schema.ts` calls `defineTable(...)` at import time, so the
 * registry only knows about a table if its module is listed here. Adding a new
 * module is therefore two steps: write the schema file, add the import below.
 * The next boot creates the tables.
 */

/* core */
import './core/config/config-service.js';

/* platform + identity */
import './modules/tenancy/tenancy.schema.js';
import './modules/identity/identity.schema.js';
import './modules/platform/platform.schema.js';
import './modules/security/security.schema.js';

/* reference data */
import './modules/masters/masters.schema.js';
import './modules/masters/pricing.schema.js';
import './modules/numbering/numbering.schema.js';

/* the books */
import './modules/accounts/accounts.schema.js';

/* operations */
import './modules/inventory/inventory.schema.js';
import './modules/tagging/tagging.schema.js';
import './modules/purchase/purchase.schema.js';
import './modules/sales/sales.schema.js';
import './modules/orders/orders.schema.js';

/* commercial */
import './modules/oldgold/oldgold.schema.js';
import './modules/schemes/schemes.schema.js';

/* finance */
import './modules/girvi/girvi.schema.js';
import './modules/reports/reports.schema.js';
import './modules/karigar/karigar.schema.js';

export { allTables } from './core/db/schema/registry.js';
