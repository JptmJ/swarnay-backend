# Swarnay Backend — Standing Instructions

> **Attach this file to every backend prompt, however small the change.**
> It is what keeps the API, `/dev-docs` and the generated frontend client from
> drifting apart. Nothing here is optional.

---

## The one rule everything else serves

**An endpoint is declared once, in `defineRoute()`, and that single declaration
feeds three things: the live route, `/dev-docs`, and the typed client.**

Never add an endpoint with `router.get(...)` / `app.post(...)` directly. A route
that bypasses the registry is invisible to the docs and missing from the client,
which is exactly the drift this setup exists to prevent.

---

## Every change, every time

Work through this list before saying a task is done.

### 1. Declare the route properly

```ts
defineRoute({
  method: 'post',
  path: '/api/orders/:id/stage',
  module: 'orders',                 // must be a key from MODULE_CATALOG
  summary: 'Move an order to another stage',   // one line, shows in the list
  description: 'Longer explanation...',        // shows when expanded
  permission: 'orders.update',                 // omit only for public routes
  params: idParam,
  body: z.object({ /* ... */ }),
  responses: [
    { status: 200, description: 'Moved.', schema: /* ... */ },
    { status: 422, description: 'Why it might be refused.', schema: errorEnvelope },
  ],
  changelog: [{ date: 'YYYY-MM-DD', kind: 'added', note: 'What changed.' }],
  handler: async (req) => { /* ... */ },
});
```

### 2. Record the change in `changelog`

This is the "Recently updated" feed at the top of `/dev-docs`, and it is the
first thing the frontend developer reads.

- `kind`: `added` · `changed` · `fixed` · `removed` · `deprecated`
- `date`: today's date, `YYYY-MM-DD`
- `note`: written for whoever consumes the endpoint, not for yourself.
  *"Backward moves now require a reason"* — not *"refactored moveStage"*.

**Append, never rewrite.** The history is the point.

### 3. Describe every non-obvious field

`.describe()` text becomes the "Notes" column in the docs **and** a JSDoc
comment in the generated client. It is the cheapest documentation you will ever
write.

```ts
tracking: z.enum(['lot', 'piece'])
  .describe('piece = individually tagged and counted. lot = bulk metal, grams only.'),
```

### 4. Document every response you actually return

Include the failure cases. If the handler can throw `insufficient_stock`, list
the 422. The frontend switches on `error.code`, so an undocumented code is a
bug waiting to happen.

New error code? Add it to `src/core/docs/error-catalog.ts` with the
`frontendAction` filled in — what the UI should *do*, not just what went wrong.

### 5. Regenerate the client

```bash
npm run gen:client
```

Then copy `generated/swarnay-client.ts` into the frontend. The diff in that
file *is* the change the frontend needs.

### 6. Verify before declaring done

```bash
npm run typecheck && npm test && npm run db:migrate -- --dry-run
```

The dry run must end with **"The database already matches"** — if it shows
pending changes, run `npm run db:migrate` and check the result.

Run all three against a development database (`DB_TARGET=local` or `supabase`),
never `DB_TARGET=deployed`. `npm test` needs a `.env.test` pointing at a
database used only by the tests, and refuses to start without one.

---

## Database rules

**Tables are declared in `*.schema.ts`, never in SQL files.** Add the table,
add one import line to `src/bootstrap.ts`, restart. The schema engine does the
rest.

**One schema: `swarnay_schema`.** Every table lives there, on every database
(laptop, Supabase, deployed). The name is fixed in `core/db/search-path.ts` —
never make it configurable, never add another schema to the search_path, and
never schema-qualify a table to reach another copy. Two developers once ran
with different schemas (`public`, `app`) against the same database: every
table existed twice, rows were split between the copies, and some foreign keys
pointed across them. `npm run db:migrate -- --force` removes any other copy —
see `docs/ENVIRONMENTS.md`.

**`npm run db:migrate` is the only way to change a database's structure.** It
makes the database match the code; `--force` also applies what deletes data.
Never fix structure by hand in the SQL editor — the next migrate would see
drift or undo it.

- **Defaults are raw SQL.** `default: "'draft'"` — a string literal needs its
  own quotes. `default: 'draft'` is read as a column reference. There is a
  guard that catches this at import time, so trust the error message.
- **Money is `col.money()`, weight is `col.weight()`.** Never `float`, never
  `number` in TypeScript. Values travel as strings end to end.
- **Every business table is tenant-scoped** (the default). `tenantScoped: false`
  is only for platform tables — `tenant`, `feature_flag`, `support_session`.
- **Unique constraints on tenant tables get `tenant_id` prepended automatically.**
  Write `uniques: [{ columns: ['doc_number'] }]` and let it happen.
- **Nullable column in a unique constraint?** Add `nullsNotDistinct: true`, or
  Postgres will treat two NULLs as different and let duplicates through.
- **Never drop or rename a column to "fix" something.** The sync engine refuses
  destructive changes by design. Add the new column, backfill, then retire the
  old one deliberately in a separate step.

### Money and weight

```ts
import { add, sub, mul, div, round, compare, fineWeight } from '../core/util/decimal.js';
```

Never `Number(x) + Number(y)`. `0.1 + 0.2` is `0.30000000000000004`, and in a
jewellery shop that is a real rupee somebody has to explain.

---

## Business rules that are easy to get wrong

- **Posting is irreversible.** A posted document is read-only. Corrections are
  reversing documents, never edits. `stock_movement` and ledger rows are
  append-only.
- **Stock and pieces move together.** Creating a `stock_piece` without a
  `stock_movement` leaves a piece in the vault the balance says does not exist.
  Use `tagPiece()`.
- **Weight is the stock measure for `lot` items; pieces are counted only for
  `tracking: 'piece'`.** Counting bulk gold in pieces makes a full vault look
  empty.
- **Fine weight is the comparable number.** 10g of 22K and 10g of 18K are not
  the same amount of gold. Ledger entries store fine grams.
- **GST:** same state → CGST + SGST (half each); different state → IGST;
  export → zero-rated. Split halves so they sum back exactly.
- **Each order type has its own pipeline.** Read `GET /api/orders/pipelines`.
  Never hardcode stage names — tenants can override them.

---

## Environments

- **A laptop picks its database with `DB_TARGET`** (`local` · `supabase` ·
  `deployed`) and one `DATABASE_URL_<TARGET>` per database in `.env`. Servers
  set `DATABASE_URL` directly. Details: `docs/ENVIRONMENTS.md`.
- **`DB_TARGET=deployed` is the live shops' data.** Sync is verify-only there,
  and anything that changes tables or rewrites data in bulk calls
  `assertMayChange()` (`core/db/protected.ts`), so it needs
  `--confirm=<database>` on the command line. A new CLI that writes in bulk
  calls it first; one that seeds demo data refuses the deployed target outright.
- **The frontends switch backend with `npm run dev` / `npm run dev:deployed`**,
  driven by their committed `.env.<mode>` files. Never edit a committed env
  file to switch.
- **Credentials never go in a committed file.** `.env.example` holds
  placeholders only. The production database password was once committed there;
  it sits in public git history and had to be rotated.

---

## Security

- **The app must never connect as a role that bypasses Row Level Security** —
  a superuser, or any role with `rolbypassrls = true`, silently voids every
  isolation policy. Supabase's `postgres` role is one; there the app connects
  as `ratnagrid_app` (`rolbypassrls = false`). The startup log warns when the
  connected role bypasses RLS.
- **Never write a query that filters by `tenant_id` by hand.** RLS does it.
  Adding it manually suggests you are working around the context, which is a
  sign something is wrong.
- **`asPlatform()` is the only cross-tenant escape hatch**, and it is
  deliberately awkward to type. Use it for provisioning and SaaS admin only.

---

## Conventions

| Thing | Convention |
|---|---|
| Table names | `snake_case`, singular — `sales_invoice`, not `SalesInvoices` |
| API paths | `/api/<module>/<resource>`, plural resources |
| JSON fields | Request bodies are `camelCase`; DB rows come back `snake_case` |
| Permissions | `module.submodule.action` — `orders.update`, `pos.purchase.post` |
| Dates | `date` columns are plain `YYYY-MM-DD` strings, never JS `Date` |
| Errors | `throw new BusinessRuleError(msg, code)` — message for humans, code for the frontend |

Error messages are read by someone standing at a counter with a customer
waiting. *"Not enough stock. Available: 80g — tried to remove 200g."* — not
*"Constraint violation on stock_balance"*.

---

## Quick reference

```bash
npm run dev          # sync schema, then serve on :4000
npm run db:migrate   # make the database match the code (-- --dry-run to look, -- --force to also delete)
DB_TARGET=deployed npm run dev   # local backend on the live data (protected)
npm run db:seed      # demo tenants (--fresh wipes first)
npm run gen:client   # regenerate the frontend client
npm test             # unit tests
npm run typecheck    # types only
```

- Docs: <http://localhost:4000/dev-docs>
- Machine-readable: <http://localhost:4000/dev-docs.json>
- Module catalog: `src/modules/tenancy/module-catalog.ts`
- Error catalogue: `src/core/docs/error-catalog.ts`

---

## When asked for something that breaks these rules

Say so, explain the consequence in one or two sentences, and offer the nearest
thing that does not. If the answer is still "do it anyway", do it — but say
what will need watching.
