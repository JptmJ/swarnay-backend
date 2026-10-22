# Swarnay Backend — How It Is Built

Plain-language guide to the database and backend design.

---

## 1. The four decisions everything else follows from

| # | Decision | Why |
|---|---|---|
| 1 | **One database, `tenant_id` on every row, enforced by Postgres itself** | One place to back up, one place to upgrade. The database refuses cross-tenant reads even if the code has a bug. |
| 2 | **The code describes the tables; the app fixes the database on boot** | You never hand-write a migration. You edit a TypeScript file and restart. |
| 3 | **Nothing stores a balance — it stores what happened** | "Why is 4 grams missing?" is answerable, because every movement is still there. |
| 4 | **Two ledgers: rupees and grams** | A jewellery business owes money *and* metal. One number cannot express both. |

---

## 2. How a request travels

```mermaid
flowchart TD
    A["Client<br/>POST /api/sales/invoices"] --> B["requestId<br/>tag the call so logs can be traced"]
    B --> C["authenticate<br/>read the token → who, which tenant, which branch"]
    C --> D["requirePermission<br/>'trade.sales.create'?"]
    D --> E["validate<br/>Zod checks the body"]
    E --> F["Service<br/>the actual business rules"]
    F --> G["transaction()<br/>BEGIN + SET LOCAL app.tenant_id"]
    G --> H[("Postgres<br/>RLS filters every row")]

    style C fill:#fef3c7,stroke:#d97706
    style G fill:#dbeafe,stroke:#2563eb
    style H fill:#dcfce7,stroke:#16a34a
```

The important step is **G**. Every query runs inside a transaction that has already
been told which tenant it belongs to. Because `SET LOCAL` is undone when the
transaction ends, a connection can never go back to the pool still carrying the
last request's tenant.

---

## 3. Multi-tenancy — why `tenant_id` is not enough on its own

You said tenant id, not tenant tables. Agreed. But a column alone only works
while every single query remembers to filter on it. One forgotten `WHERE` and a
customer sees another jeweller's books.

So the column is backed by **Row Level Security** — a rule inside Postgres:

```mermaid
flowchart LR
    subgraph APP["Application"]
      Q["select * from party"]
    end
    subgraph PG["Postgres"]
      P["Policy:<br/>tenant_id = current_setting('app.tenant_id')"]
      T[("party<br/>all tenants' rows")]
    end
    Q --> P --> T
    P -.->|"no tenant set<br/>→ zero rows"| X["∅"]

    style P fill:#fee2e2,stroke:#dc2626
```

Three things make this real rather than decorative:

1. **`FORCE ROW LEVEL SECURITY`** — without it the table's owner (your app,
   because it creates the tables) quietly bypasses every policy.
2. **The app connects as a non-superuser.** Superusers ignore RLS entirely.
3. **No tenant set means no rows**, not all rows. Deny by default.

**Proven on the running system:**

```
no tenant set        → 0 parties visible
tenant = demo        → 2 parties, 2 sales invoices
tenant = rival       → 0 parties, 0 sales invoices
demo writes a row tagged 'rival'
                     → ERROR: new row violates row-level security policy
```

> **One setup step this requires:** the app must not connect as a superuser.
> Create a dedicated role (`swarnay_app`) that owns the schema. The local dev
> database is already set up this way.

---

## 4. The self-updating schema

This is the piece you asked for specifically: *the app checks the database at
startup and fixes it if it does not match.*

### The loop

```mermaid
flowchart TD
    A["Boot"] --> B["Import every module<br/>each one declares its tables"]
    B --> C["Take a lock<br/>so two instances never migrate at once"]
    C --> D["Read the real database<br/>columns, indexes, constraints, policies"]
    D --> E["Compare wanted vs actual"]
    E --> F{"Any differences?"}
    F -->|No| K["Start serving — typically ~50ms"]
    F -->|Yes| G["Sort each change by risk"]
    G --> H["SAFE<br/>new table, new column,<br/>new index"]
    G --> I["WARN<br/>foreign key, unique,<br/>NOT NULL"]
    G --> J["STOP<br/>drop column, drop table,<br/>narrow a type"]
    H --> L["Apply automatically"]
    I --> L
    J --> M["Refuse. Log it. Wait for a human."]
    L --> N["Write to _schema_change_log"]
    N --> K
    M --> K

    style H fill:#dcfce7,stroke:#16a34a
    style I fill:#fef3c7,stroke:#d97706
    style J fill:#fee2e2,stroke:#dc2626
```

### The rule that makes it safe to run on every boot

> **Adding is automatic. Removing and rewriting is not.**

Nothing that can destroy data ever runs by itself. If you delete a column from
the code, the app tells you the database still has it — and leaves it alone.

### Declaring a table

```ts
export const salesInvoiceTable = defineTable({
  name: 'sales_invoice',
  module: 'sales',
  columns: {
    ...documentHeaderColumns({ partyLabel: 'customer' }),
    channel: col.enum(['counter', 'wholesale', 'export', 'online'], { notNull: true, default: "'counter'" }),
    paid_amount: col.money({ notNull: true, default: '0' }),
  },
  uniques: [{ columns: ['doc_number'] }],
  indexes: [{ columns: ['customer_id', 'doc_date'] }],
});
```

You did not write `id`, `tenant_id`, `created_at`, `updated_at`, `created_by`,
`updated_by`, the tenant index, or the RLS policies. Those are added for you,
the same way on every table, so they cannot be forgotten on the one table where
it matters.

`uniques` is worth noticing: on a tenant-scoped table `['doc_number']` silently
becomes `['tenant_id', 'doc_number']`. Otherwise the first tenant to use
`INV/2026-27/00001` would lock every other tenant out of that number forever.

### One behaviour, everywhere

There is no setting. Every start — `npm run dev` on a laptop, the container on
the server — applies everything that adds and refuses everything that removes.
The same engine runs on demand:

| Command | Behaviour |
|---|---|
| `npm run db:migrate -- --dry-run` | List the differences, change nothing |
| `npm run db:migrate` | What every start does: apply everything that adds |
| `npm run db:migrate -- --force` | Also apply what deletes data — the only way anything is dropped |

One database (`swarnay_erp`), one schema (`swarnay_schema`): settings that
picked a schema or a sync mode per machine are what once left the tables in
two copies with the rows split between them, so they no longer exist.

### Actual output from this repository

```
Model declares 38 tables.
339 change(s) pending:
  SAFE  create table sales_invoice (40 columns)
  WARN  link sales_invoice.customer_id -> party
  WARN  make tenant_id + doc_number unique on sales_invoice
  SAFE  index sales_invoice (customer_id, doc_date)
  SAFE  turn on tenant isolation for sales_invoice
  ...
  168 safe · 171 needs care · 0 blocked

→ applied: 339, blocked: 0, failed: 0
→ second run: "Database matches the application model." (49ms)
```

---

## 5. The shape of the database

38 tables today, in six families:

```mermaid
flowchart TB
    subgraph PLATFORM["Platform — the only tables without tenant_id"]
        TEN["tenant"]
        TMOD["tenant_module<br/>which modules are switched on"]
    end
    subgraph WHO["Who"]
        USR["app_user"] --- ROLE["role"] --- UR["user_role"]
        AUD["audit_log"]
    end
    subgraph REF["Reference data — Module 10"]
        BR["branch"] --> LOC["stock_location"]
        MET["metal"] --> PUR["purity"]
        ITM["item"]
        PTY["party<br/>customer AND supplier"]
        RATE["metal_rate<br/>never edited, only appended"]
    end
    subgraph OPS["Operations — Modules 3 and 5"]
        PI["purchase_invoice"] --> PIL["purchase_invoice_line"]
        SI["sales_invoice"] --> SIL["sales_invoice_line"]
        SI --> PAY["sales_payment"]
        MOV["stock_movement<br/>append-only"] --> BAL["stock_balance<br/>derived"]
        PIECE["stock_piece<br/>one tagged item"]
    end
    subgraph BOOKS["The books — Module 9"]
        VCH["voucher"] --> LE["ledger_entry<br/>rupees"]
        VCH --> MLE["metal_ledger_entry<br/>grams"]
    end
    subgraph CFG["Settings — Module 12"]
        CV["config_value"]
        NS["numbering_series"]
    end

    TEN -.->|"every row points here"| REF
    PI --> MOV
    SI --> MOV
    PI --> VCH
    SI --> VCH

    style PLATFORM fill:#f1f5f9,stroke:#475569
    style BOOKS fill:#fef3c7,stroke:#d97706
```

### Three modelling choices worth explaining

**`party` is one table, not `customer` + `supplier`.**
In this trade the same firm is routinely both — you buy findings from a jeweller
on Monday and sell them a bangle on Friday. One row means one balance, instead
of two that someone has to reconcile by hand.

**`item.tracking` is either `lot` or `piece`.**
Raw metal is a pool measured in grams. A tagged finished piece is one unique
object. Almost every difference between raw-material stock and showroom stock
falls out of this single field — including, as we found while testing, that a
*piece count* is meaningless for bulk gold: you buy 100g once and sell it across
thirty bills.

**Money is `numeric(20,4)`, weight is `numeric(16,6)`. Never floats.**
`0.1 + 0.2` is `0.30000000000000004` in JavaScript. In a jewellery shop that is
a real rupee somebody has to explain. Numbers travel as strings end to end and
are added with integer maths.

---

## 6. Every document has the same life

```mermaid
stateDiagram-v2
    [*] --> draft: created
    draft --> draft: edit freely
    draft --> confirmed: checked
    confirmed --> posted: POST — stock moves, books move
    draft --> cancelled: abandoned
    confirmed --> cancelled: abandoned
    posted --> cancelled: reversed, never edited
    posted --> [*]
    cancelled --> [*]
```

**A draft is scratch paper. Posting is the moment everything happens at once.**

Posting a sales invoice, in one transaction:

```
    stock out (at cost)  ·  revenue recognised  ·  GST payable
    customer debited     ·  metal ledger out    ·  piece marked sold
```

All of it, or none of it.

After posting, the document is **read-only**. A mistake is fixed with a
reversing document, never by editing history. That one rule is what lets an
auditor trust the numbers a year later — and it is why `stock_movement` rows are
never updated or deleted, only mirrored:

```
  direction | reason | net_weight |   kind
  ----------+--------+------------+----------
  out       | sale   |  12.500000 | original
  in        | sale   |  12.500000 | reversal     ← the correction, not an erasure
```

---

## 7. Stock: a journal, not a counter

```mermaid
flowchart LR
    A["Purchase posted<br/>+100g"] --> J[("stock_movement<br/>append-only journal")]
    B["Sale posted<br/>−5g"] --> J
    C["Transfer<br/>−10g here, +10g there"] --> J
    D["Stock-take<br/>adjustment"] --> J
    J -->|"updated in the same<br/>transaction"| K["stock_balance<br/>fast lookup"]
    J -.->|"can always be rebuilt from"| K

    style J fill:#dbeafe,stroke:#2563eb
    style K fill:#f1f5f9,stroke:#64748b
```

Nothing ever writes "the balance is now X". Every change appends a row saying
what moved and why, and the balance follows. `stock_balance` is only a cache —
`POST /api/inventory/balances/rebuild` recomputes every figure from the journal.
Nothing should ever need it, which is exactly why it exists.

---

## 8. The dual ledger

A customer who leaves 10g of old gold against a future purchase is owed **metal**,
not money. If the rate moves overnight, the rupee value of that debt moves and
the gram figure does not. So two journals hang off one voucher:

```mermaid
flowchart TD
    D["Posted document"] --> V["voucher<br/>one per posted document"]
    V --> M["ledger_entry<br/>debit / credit in rupees<br/><i>must balance to zero</i>"]
    V --> G["metal_ledger_entry<br/>in / out in fine grams<br/><i>22K and 24K comparable</i>"]

    style M fill:#dcfce7,stroke:#16a34a
    style G fill:#fef3c7,stroke:#d97706
```

Weights are stored as **fine weight** — pure metal content — so 10g of 22K
(9.16g fine) and 10g of 18K (7.5g fine) can be added together meaningfully.

`postVoucher` refuses to write anything if the rupee side does not balance.
There is no API for a half-entry.

**From the running system after one purchase and one sale:**

```
 code | name               |   debit    |   credit
------+--------------------+------------+------------
 1000 | Cash in Hand       |  50,000.00 |
 1010 | Bank Accounts      |  26,941.00 |
 1200 | Stock in Hand      | 620,000.00 |  62,000.00
 1300 | GST Input Credit   |  18,600.00 |
 2000 | Sundry Creditors   |            | 638,600.00
 2200 | GST Output Payable |            |   2,241.00
 4000 | Sales              |            |  74,700.00
 5100 | Cost of Goods Sold |  62,000.00 |
                             ──────────   ──────────
                             777,541.00   777,541.00   BALANCED

 Metal Stock: 91.600g in − 9.160g out = 82.440g
```

That 82.440g comes from the metal ledger. The stock journal independently says
82.440g fine. Two separate systems agreeing is the cross-check that catches
mistakes.

---

## 9. Config-driven, and what that actually means

Settings are **declared in code** with a type, a default and a description, then
**overridden per tenant or per branch** in the database.

```mermaid
flowchart TD
    A["config.get('pricing.wastage.basis')"] --> B{"branch override?"}
    B -->|yes| C["use it"]
    B -->|no| D{"tenant override?"}
    D -->|yes| E["use it"]
    D -->|no| F["use the default from code"]

    style F fill:#f1f5f9,stroke:#64748b
```

Because the setting is declared once, the settings screen builds itself, and a
value that no longer validates falls back to the default with a warning instead
of taking a request down.

The pricing engine reads these keys, so when a tenant flips
*"charge making on gross weight"* to off, **every screen in the product changes
together** — because there is only one place that prices a line.

```
  net weight   = gross 10.000 − stones 1.000            =  9.000 g
  fine weight  = net 9.000 × 91.6%                      =  8.244 g
  metal        = net 9.000 × ₹6,500                     = 58,500.00
  wastage 8%   = 0.720 g × ₹6,500                       =  4,680.00
  making       = 10.000 g × ₹450   ← gross, per config  =  4,500.00
  stones                                                 =  8,000.00
                                                          ──────────
  taxable                                                = 75,680.00
  GST 3%, same state → CGST 1,135.20 + SGST 1,135.20     =  2,270.40
                                                          ──────────
  line total                                             = 77,950.40
```

Module visibility works the same way. `GET /api/tenancy/modules` returns what
this tenant should see, so a retailer simply never receives the production
module:

```
Demo Jewellers (retailer) → orders, stock, tagging, trade, old_gold,
                            scheme, mortgage, accounts, masters, reports, settings
                            ↑ no "production" — that is manufacturer-only
```

---

## 10. Build order

You said you want to go step by step, starting with the base processes. That is
the right instinct — purchase and sales exercise every piece of shared
machinery, so everything after them is mostly filling in shapes.

```mermaid
flowchart LR
    subgraph DONE["Built and tested"]
        A["Core<br/>schema sync, tenancy,<br/>config, numbering"]
        B["Masters<br/>branch, party,<br/>item, purity, rates"]
        C["Purchase<br/>Module 5.1"]
        D["Sales<br/>Module 5.2"]
        E["Stock + Ledger<br/>Modules 3, 9"]
    end
    subgraph NEXT["Next"]
        F["Old Gold<br/>Module 6"]
        G["Tagging<br/>Module 4"]
        H["Orders<br/>Module 1"]
    end
    subgraph LATER["After that"]
        I["Production<br/>Module 2"]
        J["Schemes<br/>Module 7"]
        K["Mortgage<br/>Module 8"]
        L["Reports<br/>Module 11"]
    end
    DONE --> NEXT --> LATER

    style DONE fill:#dcfce7,stroke:#16a34a
    style NEXT fill:#fef3c7,stroke:#d97706
```

**Why this order.** Old Gold is next because it is the most common thing a
jewellery POS does that a generic ERP cannot, and it reuses the sales invoice
you already have (it becomes a payment tender). Tagging follows because
piece-tracked stock needs tags before showroom inventory is usable. Orders after
that, because an order is a sales invoice that has not happened yet. Production
is the biggest single module and only matters to manufacturer tenants, so it
waits until the retail side is solid.

### Adding a module — the whole checklist

1. `src/modules/<name>/<name>.schema.ts` — declare the tables
2. Add one import line to `src/bootstrap.ts`
3. `<name>.service.ts` — the business rules
4. `<name>.routes.ts` — the HTTP endpoints, wired up in `app.ts`
5. Restart. The tables appear.

---

## 11. Things to decide as you go

Flagging these now because they are cheap to change today and expensive later.

| Question | Current behaviour | Worth revisiting when |
|---|---|---|
| **Does wastage remove metal from stock?** | No — wastage is charged to the customer but the weight issued is the actual weight. The difference is margin. | You reconcile physical stock and find the gap. Some shops treat wastage as real metal consumed. |
| **Valuation method** | Weighted average per item + purity + location | You need FIFO for tagged pieces. The config key already exists; the FIFO path is not written. |
| **Dates and time zones** | `date` columns are kept as plain `YYYY-MM-DD` strings | Never, hopefully — but this is why. A JS `Date` serialised an invoice dated 14 Sep as `2026-09-13T18:30:00Z` in IST. Fixed by not parsing dates at all. |
| **GST on making charges** | One composite 3% rate | Your accountant asks for the separate 3% + 5% treatment. The config key exists; the calculation branch is not written. |
| **e-Invoice / IRN** | Columns exist, no portal integration | You cross the turnover threshold. |
| **Audit log** | Table exists, nothing writes to it yet | Before go-live. Posting and cancelling should both write a row. |

---

## 12. Running it

Setup, the database and deploying are in the [README](../README.md).
