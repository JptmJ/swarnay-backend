/**
 * `npm run gen:docs` — writes the data dictionary and code-structure summary.
 *
 * Generated from the schema registry, so it describes the tables that actually
 * exist rather than the tables someone remembered to document.
 */
import '../bootstrap.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { allTables } from '../core/db/schema/registry.js';
import { MODULE_CATALOG } from '../modules/tenancy/module-catalog.js';
import type { ColumnDef, ResolvedTable } from '../core/db/schema/types.js';

const MODULE_NAMES = new Map(MODULE_CATALOG.map((m) => [m.key, m.name]));
MODULE_NAMES.set('core', 'Core / shared');
MODULE_NAMES.set('identity', 'Users & roles');
MODULE_NAMES.set('numbering', 'Document numbering');
MODULE_NAMES.set('inventory', 'Stock');
MODULE_NAMES.set('purchase', 'Purchase');
MODULE_NAMES.set('sales', 'Sales / POS');
MODULE_NAMES.set('tenancy', 'Tenancy');
MODULE_NAMES.set('security', 'Security vault & private entry');

/** Columns the framework adds to every table — listed once, not per table. */
const FRAMEWORK = new Set(['id', 'tenant_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'deleted_at']);

function friendlyType(def: ColumnDef): string {
  const t = def.type;
  if (t.startsWith('numeric(20,4)')) return 'money';
  if (t.startsWith('numeric(16,6)')) return 'weight (g)';
  if (t.startsWith('numeric(7,3)')) return 'purity %';
  if (t.startsWith('numeric(14,6)')) return 'rate';
  if (t.startsWith('numeric')) return t.replace('numeric', 'number');
  if (t === 'timestamptz') return 'timestamp';
  if (t === 'jsonb') return 'json';
  if (t === 'uuid') return def.references ? `→ ${def.references.table}` : 'uuid';
  return t;
}

function notes(name: string, def: ColumnDef): string {
  const bits: string[] = [];
  if (def.check) {
    const values = [...def.check.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    if (values.length) bits.push(`one of: ${values.join(', ')}`);
  }
  if (def.default !== undefined && def.default !== 'now()') {
    bits.push(`default ${def.default.replace(/::[a-z]+$/, '')}`);
  }
  if (def.unique) bits.push('unique');
  if (def.comment) bits.push(def.comment);
  return bits.join(' · ') || '';
}

function tableSection(t: ResolvedTable): string {
  const own = Object.entries(t.columns).filter(([name]) => !FRAMEWORK.has(name));
  const required = own.filter(([, d]) => d.notNull && d.default === undefined);

  const rows = own
    .map(([name, def]) => {
      const req = def.notNull ? (def.default !== undefined ? 'auto' : '**yes**') : 'no';
      return `| \`${name}\` | ${friendlyType(def)} | ${req} | ${notes(name, def)} |`;
    })
    .join('\n');

  const flags: string[] = [];
  if (!t.tenantScoped) flags.push('**platform-level** (not tenant-scoped)');
  if (t.softDelete) flags.push('soft delete');
  if (t.uniques.length) {
    flags.push(
      `unique: ${t.uniques.map((u) => u.columns.filter((c) => c !== 'tenant_id').join(' + ')).join('; ')}`,
    );
  }

  return `### \`${t.name}\`

${t.comment ?? ''}

${flags.length ? `${flags.join(' · ')}\n` : ''}
| Column | Type | Required | Notes |
|---|---|---|---|
${rows}

${required.length ? `**Must supply on insert:** ${required.map(([n]) => `\`${n}\``).join(', ')}` : '_Nothing is required beyond the automatic columns._'}
`;
}

function generate(): string {
  const tables = allTables().sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
  const byModule = new Map<string, ResolvedTable[]>();
  for (const t of tables) {
    byModule.set(t.module, [...(byModule.get(t.module) ?? []), t]);
  }

  const totalColumns = tables.reduce((n, t) => n + Object.keys(t.columns).length, 0);

  const overview = [...byModule.entries()]
    .map(([module, list]) => `| ${MODULE_NAMES.get(module) ?? module} | ${list.length} | ${list.map((t) => `\`${t.name}\``).join(', ')} |`)
    .join('\n');

  const sections = [...byModule.entries()]
    .map(([module, list]) => `## ${MODULE_NAMES.get(module) ?? module}\n\n${list.map(tableSection).join('\n---\n\n')}`)
    .join('\n\n');

  return `# Swarnay — Database Reference

Generated from the schema definitions on ${new Date().toISOString().slice(0, 10)}.
**Do not edit by hand** — run \`npm run gen:docs\`.

${tables.length} tables · ${totalColumns} columns.

---

## How to read this

**Required** says whether you must supply the value when inserting:

- **yes** — no default, and the database rejects a null
- **auto** — required, but filled in for you (a default, or set by the service)
- **no** — optional

**Every table also has these**, added automatically, so they are not repeated below:

| Column | Type | What it is |
|---|---|---|
| \`id\` | uuid | Primary key. UUID v7, so rows sort by creation time. |
| \`tenant_id\` | → tenant | Which business owns the row. Enforced by Postgres, not by queries. |
| \`created_at\` / \`updated_at\` | timestamp | Set automatically. |
| \`created_by\` / \`updated_by\` | → app_user | Who did it. |
| \`deleted_at\` | timestamp | Only on soft-delete tables. Non-null means hidden. |

A few conventions worth knowing:

- **Money is \`money\` (numeric 20,4) and weight is \`weight\` (numeric 16,6), never floats.** They travel as strings in JSON.
- **\`→ table\`** in the Type column means a foreign key to that table.
- **Weights are grams.** "Fine weight" means pure metal content: 10g of 22K is 9.16g fine.

---

## Tables by module

| Module | Tables | Names |
|---|---|---|
${overview}

---

${sections}
`;
}

const target = resolve(process.argv[2] ?? 'docs/DATABASE.md');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, generate(), 'utf8');
console.log(`Data dictionary written to ${target} (${allTables().length} tables).`);
