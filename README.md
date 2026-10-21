# Swarnay Backend

Multi-tenant backend for jewellery manufacturers and retailers.
Node.js · TypeScript · PostgreSQL · Express 5.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for how it is built and why.

---

## Getting started

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL's password and JWT_SECRET
npm run dev               # connects, brings the tables up to date, serves on :4000
npm run seed:superadmin -- --password='...'   # once: the super admin
```

### The database

**One database, `swarnay_erp`, one schema, `swarnay_schema`** — the same for
your laptop and the server. Tables are declared in code (`*.schema.ts`); there
are no migration files.

- **Every start applies new changes.** When the server starts — `npm run dev`
  on a laptop, the Docker container on the server — it compares the code with
  the database and applies everything that *adds*: new tables, columns,
  indexes, keys. There is no setting for this; it is the same everywhere.
- **Deletions wait for you.** A change that would delete data (a column or
  table the code no longer has) is listed in the log and left alone until you
  run `npm run db:migrate -- --force`.
- **`npm run db:migrate`** does the same as a start, on demand:
  `-- --dry-run` lists the differences and changes nothing; `-- --force` also
  applies the deletions, including removing old copies of the tables left in
  other schemas (`public`, `app`).

The app must **not** connect as a Postgres superuser — superusers bypass Row
Level Security, which is what keeps tenants apart. A dedicated role needs only
`CREATE` on the database (it creates `swarnay_schema` and the `pg_trgm`
extension itself):

```sql
CREATE ROLE swarnay_user LOGIN PASSWORD '...' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT ALL ON DATABASE swarnay_erp TO swarnay_user;
```

Postgres 15 or newer (uses `UNIQUE NULLS NOT DISTINCT`).

### Deploying

On the server, with Docker:

```bash
git pull
cp .env.example .env      # first time only — fill in the real values
docker compose up -d --build
```

Starting the container brings the tables up to date, so deploying new code is
the only step. When a deploy removes a column or table, also run once:

```bash
docker compose exec backend npm run db:migrate -- --force
```

---

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Bring the tables up to date, then serve on :4000 with reload |
| `npm run start` | The same, from the compiled build (what production runs) |
| `npm run db:migrate` | Bring the tables up to date now. `-- --dry-run` only lists the differences; `-- --force` also applies what deletes data |
| `npm run seed:superadmin` | Create or reset the super admin (`-- --password=...`) |
| `npm test` | Run the test suite — needs a `.env.test` with a database used only by the tests |
| `npm run typecheck` | Type-check without emitting |
| `npm run build` | Compile to `dist/` |
| `npm run gen:docs` | Regenerate `docs/DATABASE.md` from the table definitions |

---

## Layout

```
src/
  core/                    machinery every module uses
    db/
      schema/              ← the self-updating schema engine
        types.ts             what a table definition looks like
        columns.ts           col.money(), col.weight(), col.fk()...
        registry.ts          the list of every table
        introspect.ts        read the real database
        diff.ts              compare, and rate each change by risk
        sync.ts              apply what is safe, refuse what is not
      client.ts            tenant-scoped transactions
      repository.ts        insert/update/find without boilerplate
    config/                the settings engine (Module 12.1)
    context/               who is making this request
    http/                  auth, permissions, validation, errors
    util/                  decimal maths, ids, logging

  modules/
    tenancy/               tenants and which modules they see
    identity/              users, roles, sign-in
    masters/               branch, party, item, purity, rates (Module 10)
    numbering/             document numbering (Module 4.3)
    accounts/              dual ledger (Module 9)
    inventory/             stock journal and balances (Module 3)
    pricing/               weights → money, config-driven
    purchase/              Module 5.1
    sales/                 Module 5.2

  bootstrap.ts             imports every module → registry is complete
  app.ts                   routes
  server.ts                boot: connect → sync schema → listen
```

---

## Adding a module

1. Write `src/modules/<name>/<name>.schema.ts` using `defineTable`
2. Add one import line to `src/bootstrap.ts`
3. Write the service and routes, wire the router into `app.ts`
4. Restart — the tables appear

No migration files. The database is brought in line with the code on boot.

---

## Environment

Two files: `.env` (the real values — never in git) and `.env.example` (its
template). Laptop and server use the same variables.

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required. The `swarnay_erp` database |
| `DATABASE_SSL` | `false` | `true`, `false`, or `no-verify` for managed providers |
| `JWT_SECRET` | — | Required, 16+ characters. Production refuses a `<…>` placeholder |
| `NODE_ENV` | `development` | `production` on the server (docker-compose sets it) |
| `CORS_ORIGINS` | — | Web apps that call the API from another origin |
| `PORT` | `4000` | |

---

## API

| Method | Path | Permission |
|---|---|---|
| `POST` | `/api/auth/login` | — |
| `POST` | `/api/auth/refresh` | — |
| `GET` | `/api/tenancy/modules` | any signed-in user |
| `GET` `PUT` | `/api/settings/config` | `settings.config.*` |
| `GET` `POST` `PATCH` `DELETE` | `/api/masters/{branches,parties,items,purities}` | `masters.*` |
| `GET` `POST` | `/api/masters/rates` | `settings.rates.*` |
| `POST` | `/api/purchase/invoices` | `trade.purchase.create` |
| `POST` | `/api/purchase/invoices/:id/post` | `trade.purchase.post` |
| `POST` | `/api/purchase/invoices/:id/cancel` | `trade.purchase.cancel` |
| `POST` | `/api/sales/invoices` | `trade.sales.create` |
| `POST` | `/api/sales/invoices/:id/post` | `trade.sales.post` |
| `POST` | `/api/sales/invoices/:id/cancel` | `trade.sales.cancel` |
| `GET` | `/api/inventory/balances` | `stock.*.view` |
| `GET` | `/api/inventory/movements` | `stock.*.view` |

Send `Authorization: Bearer <token>`, and optionally `X-Branch-Id` to act at a
specific branch.


alter extension pg_trgm set schema swarnay_schema; drop schema public;
