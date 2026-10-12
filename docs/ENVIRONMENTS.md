# Environments — which app talks to what

Three apps, each able to point at a local or a deployed counterpart:

```
jewellery-erp  (Vite, :5173)  ── /api ──┐
                                        ├──▶  backend (:4000 local, or https://api.swarnay.com)  ──▶  Postgres
swarnay-super-admin (Next, :4100) ──────┘                                                        local | supabase | deployed
```

Nothing is switched by editing a committed file. Each repo has one obvious knob.

---

## 1. Backend → database: `DB_TARGET`

Keep one URL per database in `swarnay-backend/.env` (never committed) and pick one:

```bash
DB_TARGET=supabase

DATABASE_URL_LOCAL=postgres://postgres:postgres@localhost:5432/swarnay
DATABASE_SSL_LOCAL=false

DATABASE_URL_SUPABASE=postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
DATABASE_SSL_SUPABASE=no-verify

DATABASE_URL_DEPLOYED=postgresql://swarnay_user:<password>@35.153.24.32:5432/swarnay_erp
DATABASE_SSL_DEPLOYED=false
```

Switch for one run without editing anything (macOS / Linux):

```bash
DB_TARGET=deployed npm run dev
```

| Target | What it is | Notes |
|---|---|---|
| `local` | Postgres on your machine | Your own sandbox. |
| `supabase` | The shared development database | Use the **session pooler** string (Dashboard → Connect → Session pooler, port 5432). The direct `db.<ref>.supabase.co` host is IPv6-only and most networks cannot reach it (`ENOTFOUND`). `DATABASE_SSL_SUPABASE=no-verify`. |
| `deployed` | The live shops' database | **Protected** — see below. |

A server (production, CI) does not use `DB_TARGET`; it sets `DATABASE_URL` and
`DATABASE_SSL` directly. Setting both is refused.

### `deployed` is protected

With `DB_TARGET=deployed` the app works normally — sign in, read, save — but:

- The startup log says, in a warning, that this is live data.
- Schema sync never changes tables: `safe`/`force` are lowered to `verify`. If
  your branch's tables differ from the deployed ones, the server refuses to
  start and lists the difference. Run the code that is deployed, or use
  `SCHEMA_SYNC_MODE=off` if you know the difference is harmless.
- `db:migrate`, `seed:superadmin` and the backfills need
  `--confirm=swarnay_erp` (the database name) on the command line.
- `db:seed` and the test suite refuse outright.

---

## 2. Frontends → backend

| App | Local backend (:4000) | Deployed backend |
|---|---|---|
| jewellery-erp | `npm run dev` | `npm run dev:deployed` |
| swarnay-super-admin | `npm run dev` | `npm run dev:deployed` |

The URLs live in committed `.env.<mode>` files (`.env.development`,
`.env.deployed`, `.env.production`), so they are the same for everyone. Put a
personal override in `.env.development.local` (never committed).

Neither app needs CORS in development: the ERP calls `/api` on its own origin and
Vite proxies it; the super admin calls the backend from its server. The refresh
cookie therefore behaves exactly as in production.

### Common combinations

| I want to… | backend | ERP / super admin |
|---|---|---|
| Work on everything against the shared dev data | `DB_TARGET=supabase npm run dev` | `npm run dev` |
| Debug live data with my local backend code | `DB_TARGET=deployed npm run dev` | `npm run dev` |
| Try my frontend changes against the deployed API | — (not needed) | `npm run dev:deployed` |
| Work fully offline | `DB_TARGET=local npm run dev` | `npm run dev` |

---

## 3. One schema: `swarnay_schema`

Every table lives in the schema `swarnay_schema` — on a laptop's Postgres, on
Supabase and on the deployed server alike. The name is fixed in code
(`src/core/db/search-path.ts`); there is no setting for it. A leftover
`DATABASE_SCHEMA` in any `.env` stops the server with a message saying so.

**Why.** The old Render deployment and one developer's `.env` ran with
`DATABASE_SCHEMA=app`; everyone else used the default, `public`. Schema sync
built a full set of tables in each, so every database both touched ended up with
two copies: rows written by one setup in `app`, by the other in `public`, and
the app only ever seeing one of them. A few foreign keys even crossed between
the copies (`public.item.category_id → app.item_category`).

What keeps it that way:

- The search_path is `swarnay_schema, extensions` and nothing else.
- Schema sync creates `swarnay_schema` itself, adds foreign keys only after
  every table exists, and re-points any key that reaches into another schema.
- The server and `db:migrate` log an error while a copy of the tables exists in
  any other schema.
- `public` is left empty. On plain Postgres `db:migrate -- --force` drops it;
  on Supabase it stays, because Supabase's own services expect it.

---

## 4. `npm run db:migrate` — make the database match the code

One command, for every database. It compares the code with the database, prints
every difference, then applies it — all in one transaction, so a failure part
way changes nothing.

```bash
npm run db:migrate -- --dry-run     # show everything, change nothing
npm run db:migrate                  # apply what adds (tables, columns, indexes, keys)
npm run db:migrate -- --force       # also what deletes: dropped columns and tables,
                                    # and every other copy of the tables (public, app, app_test…)
npm run db:migrate -- --force --keep-data-from=app
                                    # first move that copy — rows and all — into an empty
                                    # swarnay_schema, then the same as --force
```

Against the deployed database from a laptop, add `--confirm=swarnay_erp`.

### First run on a database that still has `public` / `app`

1. Stop every backend pointed at it, and remove `DATABASE_SCHEMA` from every
   `.env` and from the deployed server's environment.
2. Back it up: `pg_dump "<url>" -Fc -f before-swarnay-schema.dump`.
3. `npm run db:migrate -- --dry-run` (add `--force --keep-data-from=<schema>`
   to preview keeping a copy's rows). Read it: every `BLOCKED` line deletes
   something.
4. Run it for real with `--force` (and `--keep-data-from=…` if you chose to).
5. On an empty `swarnay_schema`, create the operator again:
   `npm run seed:superadmin -- --password='…'`.
6. Start the backend. Its log must not mention a second copy.

### Extensions

The search indexes need `pg_trgm`. Sync installs it when missing (in
Supabase's `extensions` schema, otherwise in `swarnay_schema`). One already
installed — typically in `public` — is used where it is; Postgres does not let
the app's role move it. To get `public` dropped on plain Postgres as well, a
superuser runs once: `alter extension pg_trgm set schema swarnay_schema; drop schema public;`

---

## 5. Tests

`npm test` force-syncs the schema and writes real rows, so it needs a
**database of its own** — a separate schema is no longer possible. It refuses to
run without a `.env.test`, against `DB_TARGET=deployed`, or against the same
database as `.env`.

```bash
# .env.test — a Postgres on your machine
DB_TARGET=local

# or, on Supabase: run `create database swarnay_test;` once, then
DB_TARGET=
DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-ap-south-1.pooler.supabase.com:5432/swarnay_test
DATABASE_SSL=no-verify
```

---

## 6. Credentials

- Real passwords go in `.env` / `.env.test` only (both gitignored).
  `.env.example` and the frontends' committed `.env.*` files hold placeholders
  and public URLs only.
- Connect as a role that does **not** bypass Row Level Security
  (`rolbypassrls = false`, not a superuser). The startup log warns when it does.
