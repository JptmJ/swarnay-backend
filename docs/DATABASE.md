# Swarnay — Database Reference

Generated from the schema definitions on 2026-10-21.
**Do not edit by hand** — run `npm run gen:docs`.

104 tables · 2233 columns.

---

## How to read this

**Required** says whether you must supply the value when inserting:

- **yes** — no default, and the database rejects a null
- **auto** — required, but filled in for you (a default, or set by the service)
- **no** — optional

**Every table also has these**, added automatically, so they are not repeated below:

| Column | Type | What it is |
|---|---|---|
| `id` | uuid | Primary key. UUID v7, so rows sort by creation time. |
| `tenant_id` | → tenant | Which business owns the row. Enforced by Postgres, not by queries. |
| `created_at` / `updated_at` | timestamp | Set automatically. |
| `created_by` / `updated_by` | → app_user | Who did it. |
| `deleted_at` | timestamp | Only on soft-delete tables. Non-null means hidden. |

A few conventions worth knowing:

- **Money is `money` (numeric 20,4) and weight is `weight` (numeric 16,6), never floats.** They travel as strings in JSON.
- **`→ table`** in the Type column means a foreign key to that table.
- **Weights are grams.** "Fine weight" means pure metal content: 10g of 22K is 9.16g fine.

---

## Tables by module

| Module | Tables | Names |
|---|---|---|
| Dual-Metal & Cash Ledgers | 9 | `account`, `accounting_period`, `bank_statement_line`, `cash_day`, `journal_entry`, `journal_entry_line`, `ledger_entry`, `metal_ledger_entry`, `voucher` |
| Core / shared | 1 | `config_value` |
| Business Dashboard | 1 | `dashboard_layout` |
| Mortgage / Girvi (Pawn Loans) | 4 | `girvi_accrual`, `girvi_collateral`, `girvi_loan`, `girvi_repayment` |
| Users & roles | 6 | `app_user`, `audit_log`, `refresh_token`, `role`, `role_permission`, `user_role` |
| Stock | 9 | `stock_adjustment`, `stock_balance`, `stock_count`, `stock_count_line`, `stock_movement`, `stock_piece`, `stock_transfer`, `stock_transfer_line`, `tagging_lot` |
| Master Data & Rate Hub | 2 | `karigar`, `karigar_ledger` |
| masters | 13 | `branch`, `document_format`, `hsn_gst_rate`, `item`, `item_category`, `metal`, `metal_rate`, `party`, `payment_method`, `payment_method_branch`, `price_rule`, `purity`, `stock_location` |
| Document numbering | 2 | `numbering_gap`, `numbering_series` |
| Old Gold Exchange & Melt | 4 | `melt_batch`, `old_gold_intake`, `old_gold_item`, `old_gold_payout` |
| Custom Orders & Karigar | 10 | `karigar_job`, `order_acknowledgement`, `order_attachment`, `order_communication`, `order_custody_item`, `order_line`, `order_payment`, `order_pipeline`, `order_stage_event`, `retail_order` |
| Platform Operator & SaaS Admin | 7 | `import_batch`, `import_row`, `platform_audit_log`, `platform_refresh_token`, `platform_user`, `support_session`, `tenant_module` |
| Purchase | 8 | `goods_receipt`, `goods_receipt_line`, `purchase_invoice`, `purchase_order`, `purchase_order_line`, `purchase_return`, `purchase_return_line`, `supplier_settlement` |
| Executive & Owner BI | 6 | `report_alert`, `report_inbox`, `report_pin`, `report_run`, `report_schedule`, `report_view` |
| Sales / POS | 8 | `approval_memo`, `approval_memo_line`, `customer_receipt`, `sales_invoice`, `sales_invoice_line`, `sales_payment`, `sales_return`, `sales_return_line` |
| Swarna Nidhi (Chit Schemes) | 4 | `scheme_account`, `scheme_installment`, `scheme_plan`, `scheme_redemption` |
| Security vault & private entry | 4 | `private_gateway`, `security_grant`, `security_lockout`, `security_vault` |
| Settings & Theme Studio | 1 | `tenant_theme` |
| Tagging & Barcoding | 4 | `huid_assignment`, `tag_print_job`, `tag_print_job_item`, `tag_template` |
| Tenancy | 1 | `tenant` |

---

## Dual-Metal & Cash Ledgers

### `account`

Chart of accounts (Module 9.2): groups and the ledgers under them.

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `account_type` | text | **yes** | one of: asset, liability, equity, income, expense |
| `parent_id` | → account | no |  |
| `is_group` | boolean | auto | default false |
| `is_direct` | boolean | auto | default false |
| `ledger_kind` | text | auto | one of: cash, bank, general · default 'general' |
| `is_control` | boolean | auto | default false |
| `control_for` | text | no | one of: customer, supplier, karigar |
| `tracks_metal` | boolean | auto | default false |
| `is_system` | boolean | auto | default false |
| `is_active` | boolean | auto | default true |
| `description` | text | no |  |
| `bank_name` | text | no |  |
| `bank_account_number` | text | no |  |
| `bank_ifsc` | text | no |  |
| `tally_name` | text | no |  |

**Must supply on insert:** `code`, `name`, `account_type`

---

### `accounting_period`

A month or a financial year, and whether it is closed to new entries.

unique: period_type + start_date

| Column | Type | Required | Notes |
|---|---|---|---|
| `period_type` | text | **yes** | one of: month, year |
| `start_date` | date | **yes** |  |
| `end_date` | date | **yes** |  |
| `status` | text | auto | one of: open, closed · default 'open' |
| `closed_by` | → app_user | no |  |
| `closed_at` | timestamp | no |  |
| `reopened_by` | → app_user | no |  |
| `reopened_at` | timestamp | no |  |
| `reopen_reason` | text | no |  |
| `summary` | json | no |  |
| `voucher_id` | → voucher | no |  |

**Must supply on insert:** `period_type`, `start_date`, `end_date`

---

### `bank_statement_line`

A line off the bank statement, matched against the books.


| Column | Type | Required | Notes |
|---|---|---|---|
| `account_id` | → account | **yes** |  |
| `txn_date` | date | **yes** |  |
| `description` | text | no |  |
| `reference` | text | no |  |
| `withdrawal` | money | auto | default 0 |
| `deposit` | money | auto | default 0 |
| `balance` | money | no |  |
| `import_batch` | text | no |  |
| `status` | text | auto | one of: unmatched, matched, ignored · default 'unmatched' |
| `matched_entry_id` | → ledger_entry | no |  |
| `matched_by` | → app_user | no |  |
| `matched_at` | timestamp | no |  |
| `note` | text | no |  |

**Must supply on insert:** `account_id`, `txn_date`

---

### `cash_day`

The cash drawer, counted when the shop opens and again when it shuts.

unique: branch_id + business_date + account_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `branch_id` | → branch | **yes** |  |
| `business_date` | date | **yes** |  |
| `account_id` | → account | **yes** |  |
| `status` | text | auto | one of: open, closed · default 'open' |
| `opening_expected` | money | auto | default 0 |
| `opening_counted` | money | auto | default 0 |
| `opening_denominations` | json | no |  |
| `opened_by` | → app_user | no |  |
| `opened_at` | timestamp | no |  |
| `closing_expected` | money | no |  |
| `closing_counted` | money | no |  |
| `closing_denominations` | json | no |  |
| `difference` | money | no |  |
| `difference_voucher_id` | → voucher | no |  |
| `summary` | json | no | Money in and out by where it came from, frozen at close. |
| `note` | text | no |  |
| `closed_by` | → app_user | no |  |
| `closed_at` | timestamp | no |  |
| `reopened_by` | → app_user | no |  |
| `reopened_at` | timestamp | no |  |
| `reopen_reason` | text | no |  |

**Must supply on insert:** `branch_id`, `business_date`, `account_id`

---

### `journal_entry`

A voucher typed in Accounts: an expense, a payment, cash to bank, a journal, an opening balance.

unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_type` | text | **yes** | one of: payment, receipt, contra, journal, expense, opening, gst_settlement, year_close, cash_difference, revaluation |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `status` | text | auto | one of: pending_approval, posted, rejected, cancelled · default 'posted' |
| `party_id` | → party | no |  |
| `payee` | text | no |  |
| `amount` | money | auto | default 0 |
| `narration` | text | no |  |
| `reference` | text | no |  |
| `bill_number` | text | no |  |
| `bill_date` | date | no |  |
| `attachment_key` | text | no |  |
| `source_type` | text | no |  |
| `source_id` | uuid | no |  |
| `approved_by` | → app_user | no |  |
| `approved_at` | timestamp | no |  |
| `reject_reason` | text | no |  |
| `cancelled_by` | → app_user | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |
| `auto_reverse_on` | date | no |  |
| `voucher_id` | → voucher | no |  |

**Must supply on insert:** `doc_number`, `doc_type`, `doc_date`, `branch_id`

---

### `journal_entry_line`

One side of a typed voucher. Money, grams, or both.

unique: journal_entry_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `journal_entry_id` | → journal_entry | **yes** |  |
| `line_number` | integer | **yes** |  |
| `account_id` | → account | **yes** |  |
| `party_id` | → party | no |  |
| `debit` | money | auto | default 0 |
| `credit` | money | auto | default 0 |
| `metal_id` | → metal | no |  |
| `purity_id` | → purity | no |  |
| `weight_in` | weight (g) | auto | default 0 |
| `weight_out` | weight (g) | auto | default 0 |
| `narration` | text | no |  |

**Must supply on insert:** `journal_entry_id`, `line_number`, `account_id`

---

### `ledger_entry`

The money side. Debits and credits in the base currency.


| Column | Type | Required | Notes |
|---|---|---|---|
| `voucher_id` | → voucher | **yes** |  |
| `account_id` | → account | **yes** |  |
| `party_id` | → party | no |  |
| `branch_id` | → branch | **yes** |  |
| `entry_date` | date | **yes** |  |
| `debit` | money | auto | default 0 |
| `credit` | money | auto | default 0 |
| `narration` | text | no |  |
| `against_type` | text | no |  |
| `against_id` | uuid | no |  |
| `bank_cleared_on` | date | no |  |

**Must supply on insert:** `voucher_id`, `account_id`, `branch_id`, `entry_date`

---

### `metal_ledger_entry`

The metal side. Weights in fine grams, so 22K and 24K are directly comparable.


| Column | Type | Required | Notes |
|---|---|---|---|
| `voucher_id` | → voucher | **yes** |  |
| `account_id` | → account | **yes** |  |
| `party_id` | → party | no |  |
| `branch_id` | → branch | **yes** |  |
| `entry_date` | date | **yes** |  |
| `metal_id` | → metal | **yes** |  |
| `purity_id` | → purity | no |  |
| `gross_weight` | weight (g) | auto | default 0 |
| `weight_in` | weight (g) | auto | default 0 |
| `weight_out` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | no |  |
| `narration` | text | no |  |

**Must supply on insert:** `voucher_id`, `account_id`, `branch_id`, `entry_date`, `metal_id`

---

### `voucher`

The accounting header. Every posted document creates exactly one.

unique: voucher_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `voucher_number` | text | **yes** |  |
| `voucher_type` | text | **yes** | one of: opening, purchase, purchase_return, sale, sales_return, receipt, payment, journal, old_gold, scheme, mortgage, production, contra, expense, stock_journal, branch_transfer, gst_settlement, year_close, cash_difference, revaluation |
| `voucher_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `narration` | text | no |  |
| `source_type` | text | **yes** |  |
| `source_id` | uuid | **yes** |  |
| `is_reversed` | boolean | auto | default false |
| `reverses_voucher_id` | → voucher | no |  |
| `exported_at` | timestamp | no |  |

**Must supply on insert:** `voucher_number`, `voucher_type`, `voucher_date`, `branch_id`, `source_type`, `source_id`


## Core / shared

### `config_value`

Per-tenant and per-branch overrides of the settings declared in code.

unique: branch_id + config_key

| Column | Type | Required | Notes |
|---|---|---|---|
| `branch_id` | → branch | no | Null means the value applies to the whole tenant. |
| `config_key` | text | **yes** |  |
| `value` | json | **yes** | Always an object: { "v": <the value> }. |
| `updated_reason` | text | no |  |

**Must supply on insert:** `config_key`, `value`


## Business Dashboard

### `dashboard_layout`



unique: user_id + role_code

| Column | Type | Required | Notes |
|---|---|---|---|
| `user_id` | → app_user | no | Null when this is a role default. |
| `role_code` | text | no | Set instead of user_id for a role-level default. |
| `widgets` | json | auto | default '[]' |
| `widget_settings` | json | auto | default '{}' |
| `is_default` | boolean | auto | default false |

_Nothing is required beyond the automatic columns._


## Mortgage / Girvi (Pawn Loans)

### `girvi_accrual`

One row per interest period. Written once, never recalculated.

unique: girvi_loan_id + period_start + kind

| Column | Type | Required | Notes |
|---|---|---|---|
| `girvi_loan_id` | → girvi_loan | **yes** |  |
| `period_start` | date | **yes** |  |
| `period_end` | date | **yes** |  |
| `principal_base` | money | **yes** |  |
| `rate_monthly` | rate | **yes** |  |
| `days` | integer | **yes** |  |
| `interest_amount` | money | **yes** |  |
| `kind` | text | auto | one of: interest, penal, storage · default 'interest' |
| `is_waived` | boolean | auto | default false |
| `waive_reason` | text | no |  |
| `voucher_id` | → voucher | no |  |

**Must supply on insert:** `girvi_loan_id`, `period_start`, `period_end`, `principal_base`, `rate_monthly`, `days`, `interest_amount`

---

### `girvi_collateral`

The individual articles held against the loan.

unique: girvi_loan_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `girvi_loan_id` | → girvi_loan | **yes** |  |
| `line_number` | integer | **yes** |  |
| `description` | text | **yes** |  |
| `item_category_id` | → item_category | no |  |
| `metal_id` | → metal | **yes** |  |
| `purity_id` | → purity | no |  |
| `quantity` | integer | auto | default 1 |
| `gross_weight` | weight (g) | **yes** |  |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | **yes** |  |
| `fine_weight` | weight (g) | auto | default 0 |
| `tested_purity_percent` | purity % | no |  |
| `test_method` | text | auto | one of: xrf, touchstone, declared · default 'xrf' |
| `appraised_value` | money | auto | default 0 |
| `condition_notes` | text | no |  |
| `photo_storage_key` | text | no |  |
| `is_released` | boolean | auto | default false |
| `released_at` | timestamp | no |  |

**Must supply on insert:** `girvi_loan_id`, `line_number`, `description`, `metal_id`, `gross_weight`, `net_weight`

---

### `girvi_loan`

The pawn agreement.

unique: loan_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `loan_number` | text | **yes** |  |
| `status` | text | auto | one of: draft, sanctioned, active, overdue, redeemed, defaulted, auctioned, cancelled · default 'draft' |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | no |  |
| `borrower_name` | text | **yes** |  |
| `borrower_phone` | text | **yes** |  |
| `borrower_address` | text | no |  |
| `borrower_id_type` | text | no | one of: aadhaar, pan, voter, driving_licence, passport |
| `borrower_id_number` | text | no |  |
| `borrower_photo_key` | text | no |  |
| `sanctioned_on` | date | no |  |
| `due_date` | date | no |  |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `appraised_value` | money | auto | default 0 |
| `ltv_percent` | rate | auto | default 75 |
| `max_eligible_amount` | money | auto | default 0 |
| `principal_amount` | money | auto | default 0 |
| `interest_rate_monthly` | rate | auto | default 0 · Always stored as a % a month, whatever the shop quotes in. |
| `quoted_rate` | rate | auto | default 0 · The number staff actually typed. |
| `quoted_rate_basis` | text | auto | one of: per_month, per_year, per_hundred · default 'per_month' |
| `interest_method` | text | auto | one of: simple, compound · default 'simple' |
| `compound_months` | integer | auto | default 12 |
| `period_basis` | text | auto | one of: calendar, thirty_days, actual_days · default 'calendar' |
| `minimum_months` | number(6,3) | auto | default 1 |
| `part_month` | text | auto | one of: full, pro_rata · default 'full' |
| `grace_days` | integer | auto | default 0 |
| `penal_rate_monthly` | rate | auto | default 0 |
| `allocation_order` | text | auto | one of: penalty_interest_principal, interest_penalty_principal, principal_first · default 'penalty_interest_principal' |
| `overdue_grace_days` | integer | auto | default 15 |
| `processing_fee` | money | auto | default 0 |
| `appraisal_fee` | money | auto | default 0 |
| `fee_treatment` | text | auto | one of: deducted, added, separate · default 'deducted' |
| `storage_per_month` | money | auto | default 0 |
| `penalty_accrued` | money | auto | default 0 |
| `penalty_paid` | money | auto | default 0 |
| `disbursed_amount` | money | auto | default 0 |
| `disbursal_method_id` | → payment_method | no |  |
| `disbursal_reference` | text | no |  |
| `disbursed_at` | timestamp | no |  |
| `interest_accrued` | money | auto | default 0 |
| `interest_paid` | money | auto | default 0 |
| `principal_repaid` | money | auto | default 0 |
| `outstanding_amount` | money | auto | default 0 |
| `last_accrued_on` | date | no |  |
| `vault_packet_number` | text | no | The sealed packet the collateral sits in. |
| `vault_location_id` | → stock_location | no |  |
| `packet_sealed_at` | timestamp | no |  |
| `packet_opened_at` | timestamp | no |  |
| `packet_witness_name` | text | no | Who watched the packet being sealed, where the shop asks for it. |
| `redeemed_at` | timestamp | no |  |
| `release_receipt_number` | text | no |  |
| `released_to_name` | text | no |  |
| `foreclosure_fee` | money | auto | default 0 |
| `notice_count` | integer | auto | default 0 |
| `last_notice_at` | timestamp | no |  |
| `default_notice_sent_at` | timestamp | no |  |
| `auction_date` | date | no |  |
| `auction_proceeds` | money | no |  |
| `surplus_returned` | money | no |  |
| `voucher_id` | → voucher | no |  |
| `notes` | text | no |  |

**Must supply on insert:** `loan_number`, `branch_id`, `borrower_name`, `borrower_phone`

---

### `girvi_repayment`

Money coming back in. Interest is cleared before principal.

unique: receipt_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `girvi_loan_id` | → girvi_loan | **yes** |  |
| `receipt_number` | text | **yes** |  |
| `paid_on` | date | **yes** |  |
| `amount` | money | **yes** |  |
| `interest_component` | money | auto | default 0 |
| `principal_component` | money | auto | default 0 |
| `penalty_component` | money | auto | default 0 |
| `fee_component` | money | auto | default 0 |
| `payment_method_id` | → payment_method | no |  |
| `reference` | text | no |  |
| `collected_by` | → app_user | no |  |
| `voucher_id` | → voucher | no |  |
| `status` | text | auto | one of: posted, cancelled · default 'posted' |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |
| `outstanding_after` | money | auto | default 0 |
| `notes` | text | no |  |

**Must supply on insert:** `girvi_loan_id`, `receipt_number`, `paid_on`, `amount`


## Users & roles

### `app_user`

A person who can sign in. Scoped to one tenant. Created only by the super admin.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `email` | text | no |  |
| `phone` | text | no |  |
| `full_name` | text | **yes** |  |
| `password_hash` | text | **yes** | scrypt: salt:hash, both hex. |
| `role_code` | text | no | Legacy. Roles live in user_role; kept only so old rows are not lost. |
| `token_version` | integer | auto | default 0 · Bumped on role change, deactivation or password reset — older access tokens stop working. |
| `must_change_password` | boolean | auto | default false |
| `password_changed_at` | timestamp | no |  |
| `is_active` | boolean | auto | default true |
| `default_branch_id` | → branch | no |  |
| `last_login_at` | timestamp | no |  |
| `failed_login_count` | integer | auto | default 0 |
| `locked_until` | timestamp | no |  |

**Must supply on insert:** `full_name`, `password_hash`

---

### `audit_log`




| Column | Type | Required | Notes |
|---|---|---|---|
| `at` | timestamp | auto |  |
| `user_id` | → app_user | no |  |
| `branch_id` | → branch | no |  |
| `action` | text | **yes** | e.g. "sales_invoice.post" |
| `entity_table` | text | no |  |
| `entity_id` | uuid | no |  |
| `changes` | json | no |  |
| `request_id` | text | no |  |
| `ip_address` | text | no |  |
| `support_session_id` | → support_session | no |  |

**Must supply on insert:** `action`

---

### `refresh_token`




| Column | Type | Required | Notes |
|---|---|---|---|
| `user_id` | → app_user | **yes** |  |
| `family_id` | uuid | auto | default gen_random_uuid() · All rotations of one login share a family. Reuse of a rotated token revokes the family. |
| `replaced_by_id` | → refresh_token | no |  |
| `token_hash` | text | **yes** | sha256 of the token — the token itself is never stored. |
| `expires_at` | timestamp | **yes** |  |
| `revoked_at` | timestamp | no |  |
| `persistent` | boolean | auto | default true · Remember me: 30-day cookie. False: browser-session cookie, 12 hours server-side. |
| `user_agent` | text | no |  |
| `ip_address` | text | no |  |

**Must supply on insert:** `user_id`, `token_hash`, `expires_at`

---

### `role`

A role inside one business. owner and admin are seeded; staff roles are named per business by the super admin.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `role_type` | text | auto | one of: owner, admin, staff · default 'staff' |
| `description` | text | no |  |
| `is_system` | boolean | auto | default false |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`

---

### `role_permission`

Permission strings granted to a role, e.g. "pos.create" or "orders.*".

unique: role_id + permission

| Column | Type | Required | Notes |
|---|---|---|---|
| `role_id` | → role | **yes** |  |
| `permission` | text | **yes** |  |

**Must supply on insert:** `role_id`, `permission`

---

### `user_role`

A role held by a user, at one branch or (branch_id null) at every branch.


| Column | Type | Required | Notes |
|---|---|---|---|
| `user_id` | → app_user | **yes** |  |
| `role_id` | → role | **yes** |  |
| `branch_id` | → branch | no |  |

**Must supply on insert:** `user_id`, `role_id`


## Stock

### `stock_adjustment`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `reason` | text | **yes** | one of: shortage, damage, loss, write_off, found, weighing_correction, stock_count, tagging_difference |
| `note` | text | **yes** |  |
| `source_type` | text | no | stock_count or stock_piece when posted from those. |
| `source_id` | uuid | no |  |
| `piece_count` | integer | auto | default 0 |
| `net_weight_in` | weight (g) | auto | default 0 |
| `net_weight_out` | weight (g) | auto | default 0 |
| `value` | money | auto | default 0 · Net value change at cost; negative is a loss. |

**Must supply on insert:** `doc_number`, `branch_id`, `reason`, `note`

---

### `stock_balance`

A running total, kept in step with stock_movement inside the same transaction.

unique: item_id + purity_id + location_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `location_id` | → stock_location | **yes** |  |
| `quantity` | number(14,3) | auto | default 0 |
| `gross_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `value` | money | auto | default 0 |
| `average_rate` | money | auto | default 0 |
| `last_movement_at` | timestamp | no |  |

**Must supply on insert:** `item_id`, `location_id`

---

### `stock_count`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `location_id` | → stock_location | **yes** |  |
| `status` | text | auto | one of: open, posted, cancelled · default 'open' |
| `note` | text | no |  |
| `posted_at` | timestamp | no |  |
| `posted_by` | → app_user | no |  |
| `adjustment_id` | → stock_adjustment | no |  |

**Must supply on insert:** `doc_number`, `branch_id`, `location_id`

---

### `stock_count_line`



unique: stock_count_id + tag_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `stock_count_id` | → stock_count | **yes** |  |
| `kind` | text | **yes** | one of: piece, lot |
| `tag_number` | text | no |  |
| `piece_id` | → stock_piece | no |  |
| `outcome` | text | **yes** | one of: found, elsewhere, unknown, lot |
| `item_id` | → item | no |  |
| `purity_id` | → purity | no |  |
| `counted_net_weight` | weight (g) | no |  |

**Must supply on insert:** `stock_count_id`, `kind`, `outcome`

---

### `stock_movement`

Append-only. Never updated, never deleted — a mistake is corrected by a reversing row.


| Column | Type | Required | Notes |
|---|---|---|---|
| `moved_at` | timestamp | auto |  |
| `direction` | text | **yes** | one of: in, out |
| `reason` | text | **yes** | one of: opening, purchase, purchase_return, sale, sales_return, transfer_out, transfer_in, production_issue, production_receipt, old_gold_intake, melting, refining, adjustment, memo_out, memo_in, metal_payment |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `location_id` | → stock_location | **yes** |  |
| `piece_id` | → stock_piece | no | Set for piece-tracked items, null for bulk metal. |
| `quantity` | number(14,3) | auto | default 0 · Piece count, or units for consumables. |
| `gross_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `value` | money | auto | default 0 |
| `source_type` | text | **yes** |  |
| `source_id` | uuid | **yes** |  |
| `source_line_id` | uuid | no |  |
| `reverses_movement_id` | → stock_movement | no |  |
| `note` | text | no |  |

**Must supply on insert:** `direction`, `reason`, `item_id`, `location_id`, `source_type`, `source_id`

---

### `stock_piece`

One row per physically tagged item. Only used by items with tracking = piece.

unique: tag_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `tag_number` | text | **yes** | What is printed on the label. |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `location_id` | → stock_location | **yes** |  |
| `status` | text | auto | one of: in_stock, on_memo, sold, in_transit, with_karigar, in_repair, melted, written_off · default 'in_stock' |
| `gross_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 · Metal only — what purity applies to. |
| `stone_weight` | weight (g) | auto | default 0 |
| `other_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 · net_weight x purity — the pure metal content. |
| `stone_count` | integer | no |  |
| `huid` | text | no |  |
| `hallmark_centre` | text | no |  |
| `cost_value` | money | auto | default 0 |
| `making_cost` | money | auto | default 0 |
| `stone_cost` | money | auto | default 0 |
| `making_basis` | text | no | one of: per_gram, flat, percent |
| `making_rate` | rate | no | ₹/g, ₹/piece or % of metal value, per making_basis. |
| `wastage_percent` | rate | no | % of net weight charged as extra metal at the day rate. |
| `design_id` | uuid | no | Filled in once Module 2 exists. |
| `supplier_id` | → party | no |  |
| `received_at` | timestamp | auto |  |
| `sold_at` | timestamp | no |  |
| `image_urls` | json | auto | default '[]' |
| `attributes` | json | auto | default '{}' |
| `tagging_lot_id` | → tagging_lot | no |  |
| `label_printed_at` | timestamp | no |  |
| `label_print_count` | integer | auto | default 0 |
| `reserved_order_id` | → retail_order | no |  |
| `reserved_at` | timestamp | no |  |

**Must supply on insert:** `tag_number`, `item_id`, `location_id`

---

### `stock_transfer`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `from_branch_id` | → branch | **yes** |  |
| `from_location_id` | → stock_location | **yes** |  |
| `to_branch_id` | → branch | **yes** |  |
| `to_location_id` | → stock_location | **yes** |  |
| `status` | text | **yes** | one of: in_transit, received, cancelled |
| `piece_count` | integer | auto | default 0 |
| `gross_weight` | weight (g) | auto | default 0 |
| `note` | text | no |  |
| `dispatched_at` | timestamp | auto |  |
| `dispatched_by` | → app_user | no |  |
| `received_at` | timestamp | no |  |
| `received_by` | → app_user | no |  |

**Must supply on insert:** `doc_number`, `from_branch_id`, `from_location_id`, `to_branch_id`, `to_location_id`, `status`

---

### `stock_transfer_line`




| Column | Type | Required | Notes |
|---|---|---|---|
| `stock_transfer_id` | → stock_transfer | **yes** |  |
| `piece_id` | → stock_piece | no | Set for a tagged piece; lots carry item, purity and weights. |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `quantity` | number(14,3) | auto | default 0 |
| `gross_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `value` | money | auto | default 0 |

**Must supply on insert:** `stock_transfer_id`, `item_id`

---

### `tagging_lot`




| Column | Type | Required | Notes |
|---|---|---|---|
| `goods_receipt_line_id` | → goods_receipt_line | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `location_id` | → stock_location | **yes** |  |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | **yes** |  |
| `supplier_id` | → party | **yes** |  |
| `pieces_expected` | integer | **yes** |  |
| `gross_expected` | weight (g) | **yes** |  |
| `net_expected` | weight (g) | **yes** |  |
| `fine_expected` | weight (g) | **yes** |  |
| `cost_value` | money | auto | default 0 |
| `pieces_tagged` | integer | auto | default 0 |
| `gross_tagged` | weight (g) | auto | default 0 |
| `net_tagged` | weight (g) | auto | default 0 |
| `fine_tagged` | weight (g) | auto | default 0 |
| `cost_tagged` | money | auto | default 0 |
| `status` | text | auto | one of: open, closed · default 'open' |
| `closed_at` | timestamp | no |  |
| `close_note` | text | no |  |

**Must supply on insert:** `goods_receipt_line_id`, `branch_id`, `location_id`, `item_id`, `purity_id`, `supplier_id`, `pieces_expected`, `gross_expected`, `net_expected`, `fine_expected`


## Master Data & Rate Hub

### `karigar`

Goldsmith master. Can be an employee or an outside workshop.

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `workshop_name` | text | no |  |
| `engagement` | text | auto | one of: in_house, external · default 'external' |
| `speciality` | text | no |  |
| `phone` | text | no |  |
| `address` | text | no |  |
| `pan` | text | no |  |
| `gstin` | text | no |  |
| `standard_ghat_percent` | rate | auto | default 0 |
| `labour_rate_per_gram` | money | auto | default 0 |
| `metal_balance_fine` | weight (g) | auto | default 0 |
| `wage_balance` | money | auto | default 0 |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`

---

### `karigar_ledger`

Metal and wages per karigar. Append-only.


| Column | Type | Required | Notes |
|---|---|---|---|
| `karigar_id` | → karigar | **yes** |  |
| `entry_type` | text | **yes** | one of: issue, return, ghat_allowed, ghat_excess, wage_earned, wage_paid, adjustment |
| `entry_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `metal_id` | → metal | no |  |
| `purity_id` | → purity | no |  |
| `gross_weight` | weight (g) | auto | default 0 |
| `weight_in` | weight (g) | auto | default 0 |
| `weight_out` | weight (g) | auto | default 0 |
| `amount_debit` | money | auto | default 0 |
| `amount_credit` | money | auto | default 0 |
| `retail_order_id` | → retail_order | no |  |
| `job_card_id` | uuid | no | Reserved for the manufacturer production module. |
| `voucher_id` | → voucher | no |  |
| `narration` | text | no |  |

**Must supply on insert:** `karigar_id`, `entry_type`, `entry_date`, `branch_id`


## masters

### `branch`

A physical location. Stock always sits at a branch, never at "the company".

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `kind` | text | auto | one of: showroom, factory, warehouse, office · default 'showroom' |
| `gstin` | text | no |  |
| `state_code` | text | no | GST state code — decides CGST+SGST versus IGST. |
| `address_line1` | text | no |  |
| `address_line2` | text | no |  |
| `city` | text | no |  |
| `state` | text | no |  |
| `pincode` | text | no |  |
| `phone` | text | no |  |
| `email` | text | no |  |
| `is_head_office` | boolean | auto | default false |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`

---

### `document_format`



unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `doc_type` | text | **yes** | one of: invoice, advance_receipt, old_gold_voucher, scheme_receipt, girvi_pawn_ticket |
| `title` | text | **yes** |  |
| `paper_size` | text | auto | one of: A4, A5, Thermal_80mm, Thermal_3inch · default 'A4' |
| `header_style` | text | auto | one of: logo_top, letterhead_preprinted, minimal · default 'logo_top' |
| `numbering_doc_type` | text | no | The numbering series whose number prints on it, e.g. sales_invoice. |
| `field_toggles` | json | auto | default '{}' |
| `terms` | text | auto | default '' |

**Must supply on insert:** `code`, `doc_type`, `title`

---

### `hsn_gst_rate`

GST per HSN/SAC code and price component, versioned by date.

unique: hsn_code + component + effective_from

| Column | Type | Required | Notes |
|---|---|---|---|
| `hsn_code` | text | **yes** | HSN for goods (e.g. 7113), SAC for services (e.g. 9988). |
| `code_type` | text | auto | one of: hsn, sac · default 'hsn' · HSN for goods, SAC for services. |
| `description` | text | no |  |
| `component` | text | **yes** | one of: metal, making, stone, service, hallmark, other |
| `gst_rate` | rate | **yes** | Total GST %. Split into CGST+SGST or IGST at billing time. |
| `cess_rate` | rate | auto | default 0 |
| `is_reverse_charge` | boolean | auto | default false |
| `effective_from` | date | **yes** |  |
| `effective_to` | date | no | Null = still in force. Filled in when a newer version is added. |
| `source_note` | text | no | Why this rate — notification number or CA confirmation. |

**Must supply on insert:** `hsn_code`, `component`, `gst_rate`, `effective_from`

---

### `item`

The product master. One row per thing you can buy, make or sell.

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `nature` | text | auto | one of: raw_metal, finished, stone, consumable, service · default 'finished' |
| `tracking` | text | auto | one of: lot, piece · default 'piece' |
| `category_id` | → item_category | no |  |
| `metal_id` | → metal | no |  |
| `default_purity_id` | → purity | no |  |
| `hsn_code` | text | no |  |
| `uom` | text | auto | one of: gram, piece, carat, millilitre · default 'gram' |
| `is_active` | boolean | auto | default true |
| `attributes` | json | auto | default '{}' |

**Must supply on insert:** `code`, `name`

---

### `item_category`



unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `parent_id` | → item_category | no |  |
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `hsn_code` | text | no |  |
| `sub_categories` | json | auto | default '[]' · Names, e.g. ["Temple", "Antique"]. |
| `applicable_metals` | json | auto | default '[]' · Metal codes, e.g. ["GOLD", "SILVER"]. Empty = any. |
| `making_rule_id` | → price_rule | no | Default making-charge rule for the category. |
| `sort_order` | integer | auto | default 0 |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`

---

### `metal`

Gold, silver, platinum. Kept as data so a tenant can add one.

unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** | GOLD, SILVER, PLATINUM |
| `name` | text | **yes** |  |
| `default_display_unit` | text | auto | one of: gram, tola, kilo, carat · default 'gram' |
| `hsn_code` | text | no |  |
| `is_active` | boolean | auto | default true |
| `sort_order` | integer | auto | default 0 |

**Must supply on insert:** `code`, `name`

---

### `metal_rate`

Historic rates are never edited — a new rate is a new row, so old invoices stay explainable.


| Column | Type | Required | Notes |
|---|---|---|---|
| `metal_id` | → metal | **yes** |  |
| `purity_id` | → purity | no | Null means the rate is for 100% pure metal. |
| `effective_from` | timestamp | auto |  |
| `rate_per_gram` | money | **yes** |  |
| `buying_rate_per_gram` | money | no | What the shop pays for old gold — normally lower. |
| `source` | text | auto | one of: manual, feed · default 'manual' |
| `branch_id` | → branch | no | Null means the rate applies to every branch. |
| `retired_at` | timestamp | no | Removed from the rate list. Kept for history; never used for pricing. |

**Must supply on insert:** `metal_id`, `rate_per_gram`

---

### `party`

Customers and suppliers. The same firm is often both, so one row serves both.

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `is_customer` | boolean | auto | default false |
| `is_supplier` | boolean | auto | default false |
| `party_type` | text | auto | one of: individual, business · default 'individual' |
| `phone` | text | no |  |
| `email` | text | no |  |
| `gstin` | text | no |  |
| `pan` | text | no |  |
| `state_code` | text | no | Decides CGST+SGST versus IGST against the branch. |
| `address_line1` | text | no |  |
| `address_line2` | text | no |  |
| `city` | text | no |  |
| `state` | text | no |  |
| `pincode` | text | no |  |
| `credit_limit` | money | no |  |
| `credit_days` | integer | no |  |
| `kyc_status` | text | auto | one of: none, pending, verified, rejected · default 'none' |
| `date_of_birth` | date | no |  |
| `anniversary` | date | no |  |
| `notes` | text | no |  |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`

---

### `payment_method`

The tenders a branch accepts. `kind` tells the system how to settle it; everything else is the tenant's choice.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** | What staff see, e.g. "HDFC Card Machine", "PhonePe QR". |
| `kind` | text | **yes** | one of: cash, card, upi, bank_transfer, cheque, credit, old_gold, scheme, advance, emi, wallet |
| `account_id` | → account | no | Ledger the money lands in — Cash in Hand, HDFC Current A/c... |
| `requires_reference` | boolean | auto | default false · Ask for UTR / card slip / cheque no. |
| `charges_percent` | rate | no | Card or wallet fee the shop pays, if tracked. |
| `max_amount` | money | no | Per-transaction limit — e.g. the cash limit. Configurable, never hardcoded. |
| `is_active` | boolean | auto | default true |
| `sort_order` | integer | auto | default 0 |

**Must supply on insert:** `code`, `name`, `kind`

---

### `payment_method_branch`

Branches where a payment method is offered. No rows = offered at every branch.

unique: payment_method_id + branch_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `payment_method_id` | → payment_method | **yes** |  |
| `branch_id` | → branch | **yes** |  |

**Must supply on insert:** `payment_method_id`, `branch_id`

---

### `price_rule`

Making, wastage, stone, hallmark and discount rules. The most specific matching rule wins.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `applies_to` | text | **yes** | one of: making, wastage, stone, hallmark, discount |
| `basis` | text | **yes** | one of: per_gram, percent, flat, slab, hybrid |
| `rate` | rate | no | per_gram: ₹/g · percent: % of metal value · flat: ₹ · hybrid: the % part. |
| `flat_amount` | money | no | hybrid only: the fixed ₹ added to the % part. |
| `slabs` | json | auto | default '[]' · basis = slab: [{"fromG":0,"toG":10,"rate":450},{"fromG":10,"toG":null,"rate":400}]. toG exclusive; null = no upper limit. |
| `slab_mode` | text | auto | one of: whole, tiered · default 'whole' · whole: the matched slab rate applies to all the weight. tiered: each slab portion at its own rate, like tax brackets. |
| `minimum_amount` | money | no | Charge at least this much per piece. |
| `metal_id` | → metal | no |  |
| `purity_id` | → purity | no |  |
| `item_category_id` | → item_category | no |  |
| `item_id` | → item | no |  |
| `branch_id` | → branch | no |  |
| `priority` | integer | auto | default 0 · Tie-breaker between equally specific rules. Higher wins. |
| `effective_from` | date | auto | default current_date |
| `effective_to` | date | no |  |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`, `applies_to`, `basis`

---

### `purity`

Module 10.1 — 22K gold is one row: fineness 91.600, karat 22.

unique: metal_id + code

| Column | Type | Required | Notes |
|---|---|---|---|
| `metal_id` | → metal | **yes** |  |
| `code` | text | **yes** | e.g. 22K, 18K, 916, 995 |
| `name` | text | **yes** |  |
| `fineness_percent` | purity % | **yes** |  |
| `karat` | number(5,2) | no | Null for silver and platinum. |
| `is_hallmarkable` | boolean | auto | default true |
| `notation` | text | auto | one of: karat, fineness, percentage · default 'karat' |
| `default_unit` | text | auto | one of: g, kg, tola, oz · default 'g' |
| `is_default` | boolean | auto | default false |
| `description` | text | no |  |
| `is_active` | boolean | auto | default true |
| `sort_order` | integer | auto | default 0 |

**Must supply on insert:** `metal_id`, `code`, `name`, `fineness_percent`

---

### `stock_location`



soft delete · unique: branch_id + code

| Column | Type | Required | Notes |
|---|---|---|---|
| `branch_id` | → branch | **yes** |  |
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `kind` | text | auto | one of: counter, vault, window, floor, transit, karigar · default 'counter' |
| `is_default` | boolean | auto | default false |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `branch_id`, `code`, `name`


## Document numbering

### `numbering_gap`




| Column | Type | Required | Notes |
|---|---|---|---|
| `series_id` | → numbering_series | **yes** |  |
| `doc_number` | text | **yes** |  |
| `reason` | text | **yes** |  |

**Must supply on insert:** `series_id`, `doc_number`, `reason`

---

### `numbering_series`

One row per document type per branch, e.g. sales invoices at the Andheri showroom.

unique: doc_type + branch_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_type` | text | **yes** | purchase_order, sales_invoice, grn, tag... |
| `branch_id` | → branch | no | Null means one shared series across all branches. |
| `name` | text | **yes** |  |
| `prefix` | text | auto | default '' · Supports {FY}, {YY}, {MM}, {BRANCH}. |
| `suffix` | text | auto | default '' |
| `padding` | integer | auto | default 5 |
| `next_number` | bigint | auto | default 1 |
| `reset_period` | text | auto | one of: never, yearly, financial_yearly, monthly · default 'financial_yearly' |
| `current_period` | text | no |  |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `doc_type`, `name`


## Old Gold Exchange & Melt

### `melt_batch`

Old gold melted in-house or sent to a refiner, and the metal that came back.

unique: batch_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `batch_number` | text | **yes** |  |
| `batch_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `metal_id` | → metal | **yes** |  |
| `kind` | text | auto | one of: melt, refine · default 'melt' |
| `status` | text | auto | one of: melted, sent, received, cancelled · default 'melted' |
| `input_gross_weight` | weight (g) | auto | default 0 |
| `input_net_weight` | weight (g) | auto | default 0 |
| `input_fine_weight` | weight (g) | auto | default 0 |
| `input_value` | money | auto | default 0 |
| `output_item_id` | → item | no |  |
| `output_purity_id` | → purity | no |  |
| `output_weight` | weight (g) | auto | default 0 |
| `output_purity_percent` | purity % | no | The assay, when it differs from the purity’s fineness. |
| `output_fine_weight` | weight (g) | auto | default 0 |
| `loss_fine_weight` | weight (g) | auto | default 0 |
| `refiner_id` | → party | no | The refinery, when sent out. |
| `refining_charge` | money | auto | default 0 |
| `sent_at` | timestamp | no |  |
| `received_at` | timestamp | no |  |
| `assay_certificate_number` | text | no |  |
| `received_into_location_id` | → stock_location | no |  |
| `voucher_id` | → voucher | no |  |
| `receive_voucher_id` | → voucher | no |  |
| `notes` | text | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |

**Must supply on insert:** `batch_number`, `batch_date`, `branch_id`, `metal_id`

---

### `old_gold_intake`

The intake voucher. One per customer visit; posts on saving.

unique: voucher_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `voucher_number` | text | **yes** |  |
| `voucher_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `location_id` | → stock_location | **yes** |  |
| `status` | text | auto | one of: posted, cancelled · default 'posted' |
| `settlement_type` | text | auto | one of: exchange, buyback · default 'exchange' |
| `channel` | text | auto | one of: desk, counter · default 'desk' |
| `tested_by` | → app_user | no |  |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_deduction_weight` | weight (g) | auto | default 0 · Stones and dirt. |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_loss_weight` | weight (g) | auto | default 0 · Fine metal kept back as melting loss. |
| `total_fine_weight` | weight (g) | auto | default 0 · Fine metal bought, after melting loss. |
| `gross_value` | money | auto | default 0 |
| `deduction_amount` | money | auto | default 0 |
| `net_value` | money | auto | default 0 |
| `paid_out_amount` | money | auto | default 0 |
| `payout_method_id` | → payment_method | no |  |
| `payout_reference` | text | no |  |
| `applied_to_invoice_id` | → sales_invoice | no |  |
| `id_proof_type` | text | no | one of: aadhaar, pan, voter_id, driving_licence, passport, other |
| `id_proof_number` | text | no |  |
| `voucher_id` | → voucher | no |  |
| `notes` | text | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |

**Must supply on insert:** `voucher_number`, `voucher_date`, `branch_id`, `customer_id`, `location_id`

---

### `old_gold_item`

One row per article brought in, weighed, tested and valued on its own.

unique: old_gold_intake_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `old_gold_intake_id` | → old_gold_intake | **yes** |  |
| `line_number` | integer | **yes** |  |
| `description` | text | **yes** |  |
| `item_category_id` | → item_category | no |  |
| `metal_id` | → metal | **yes** |  |
| `gross_weight` | weight (g) | **yes** |  |
| `stone_weight` | weight (g) | auto | default 0 |
| `dirt_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | **yes** |  |
| `test_method` | text | auto | one of: xrf, touchstone, hallmark, estimate · default 'xrf' |
| `tested_purity_percent` | purity % | **yes** |  |
| `declared_purity_percent` | purity % | no |  |
| `test_instrument` | text | no |  |
| `huid` | text | no |  |
| `own_piece_id` | → stock_piece | no |  |
| `loss_percent` | purity % | auto | default 0 · Melting loss deducted from the fine metal. |
| `loss_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | **yes** | net × tested purity, less melting loss. |
| `rate_basis` | text | auto | one of: fine, purity · default 'fine' |
| `rate_per_gram` | money | auto | default 0 |
| `value` | money | auto | default 0 |
| `melt_batch_id` | → melt_batch | no |  |
| `notes` | text | no |  |

**Must supply on insert:** `old_gold_intake_id`, `line_number`, `description`, `metal_id`, `gross_weight`, `net_weight`, `tested_purity_percent`, `fine_weight`

---

### `old_gold_payout`

Money paid to the customer for old gold: at intake (buyback) or later from the credit.


| Column | Type | Required | Notes |
|---|---|---|---|
| `old_gold_intake_id` | → old_gold_intake | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `doc_date` | date | **yes** |  |
| `payment_method_id` | → payment_method | **yes** |  |
| `amount` | money | **yes** |  |
| `reference` | text | no |  |
| `voucher_id` | → voucher | no |  |

**Must supply on insert:** `old_gold_intake_id`, `customer_id`, `doc_date`, `payment_method_id`, `amount`


## Custom Orders & Karigar

### `karigar_job`

Metal and work with a karigar: issued, received back, ghat and wages settled.

unique: job_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `job_number` | text | **yes** |  |
| `karigar_id` | → karigar | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `retail_order_id` | → retail_order | no | Null for stock work with no customer order behind it. |
| `kind` | text | auto | one of: making, repair · default 'making' |
| `status` | text | auto | one of: issued, received, cancelled · default 'issued' |
| `metal_source` | text | auto | one of: shop, customer · default 'shop' |
| `issued_on` | date | **yes** |  |
| `due_date` | date | no |  |
| `received_on` | date | no |  |
| `metal_id` | → metal | **yes** |  |
| `purity_id` | → purity | no |  |
| `item_id` | → item | no | The lot the metal left, when it came from stock. |
| `issued_from_location_id` | → stock_location | no |  |
| `issued_gross_weight` | weight (g) | auto | default 0 |
| `issued_net_weight` | weight (g) | auto | default 0 |
| `issued_fine_weight` | weight (g) | auto | default 0 |
| `issued_stone_weight` | weight (g) | auto | default 0 |
| `issued_value` | money | auto | default 0 · Cost of shop metal issued; 0 for the customer’s own. |
| `ghat_percent` | rate | auto | default 0 |
| `labour_basis` | text | auto | one of: per_gram, flat, percent · default 'per_gram' |
| `labour_rate` | rate | auto | default 0 |
| `received_gross_weight` | weight (g) | auto | default 0 |
| `received_net_weight` | weight (g) | auto | default 0 |
| `received_fine_weight` | weight (g) | auto | default 0 |
| `received_stone_weight` | weight (g) | auto | default 0 |
| `ghat_allowed_fine` | weight (g) | auto | default 0 |
| `ghat_actual_fine` | weight (g) | auto | default 0 |
| `ghat_excess_fine` | weight (g) | auto | default 0 · Lost above the allowance. |
| `excess_ghat_handling` | text | no | one of: recover, absorb |
| `excess_ghat_value` | money | auto | default 0 |
| `labour_amount` | money | auto | default 0 |
| `received_into_location_id` | → stock_location | no |  |
| `piece_id` | → stock_piece | no | Set once what came back is tagged into stock. |
| `issue_voucher_id` | → voucher | no |  |
| `receive_voucher_id` | → voucher | no |  |
| `notes` | text | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |

**Must supply on insert:** `job_number`, `karigar_id`, `branch_id`, `issued_on`, `metal_id`

---

### `order_acknowledgement`



unique: retail_order_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `method` | text | **yes** | one of: signature, otp |
| `signature_storage_key` | text | no |  |
| `otp_reference` | text | no | The reference returned by the OTP provider, not the code. |
| `acknowledged_at` | timestamp | auto |  |
| `acknowledged_by_name` | text | no |  |

**Must supply on insert:** `retail_order_id`, `method`

---

### `order_attachment`

Reference images for custom work, condition photos for repairs.


| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `kind` | text | auto | one of: reference, intake_photo, design, cad, delivery_proof, document · default 'reference' |
| `file_name` | text | **yes** |  |
| `storage_key` | text | **yes** |  |
| `content_type` | text | no |  |
| `size_bytes` | bigint | no |  |
| `caption` | text | no |  |
| `sort_order` | integer | auto | default 0 |

**Must supply on insert:** `retail_order_id`, `file_name`, `storage_key`

---

### `order_communication`




| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `channel` | text | auto | one of: sms, whatsapp, email, call, in_person · default 'whatsapp' |
| `direction` | text | auto | one of: outbound, inbound · default 'outbound' |
| `message` | text | **yes** |  |
| `sent_at` | timestamp | auto |  |
| `delivery_status` | text | auto | one of: queued, sent, delivered, read, failed · default 'queued' |
| `actor_user_id` | → app_user | no |  |

**Must supply on insert:** `retail_order_id`, `message`

---

### `order_custody_item`

Customer goods held by the shop. Tracked, never valued as stock.

unique: retail_order_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `line_number` | integer | **yes** |  |
| `token_number` | text | **yes** |  |
| `description` | text | **yes** |  |
| `metal_id` | → metal | no |  |
| `purity_id` | → purity | no |  |
| `tested_purity_percent` | purity % | no | When it was tested at intake. |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `declared_value` | money | no |  |
| `condition_notes` | text | no |  |
| `where_kept` | text | no | Safe, drawer, counter — wherever the shop keeps it. |
| `status` | text | auto | one of: received, with_karigar, ready, returned, written_off · default 'received' |
| `karigar_job_id` | → karigar_job | no |  |
| `received_on` | date | **yes** |  |
| `returned_on` | date | no |  |
| `returned_to_name` | text | no |  |
| `notes` | text | no |  |

**Must supply on insert:** `retail_order_id`, `line_number`, `token_number`, `description`, `received_on`

---

### `order_line`

A wedding order mixes ready-stock bookings and made-to-order pieces line by line.

unique: retail_order_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `line_number` | integer | **yes** |  |
| `line_mode` | text | auto | one of: booking, custom · default 'booking' |
| `title` | text | **yes** |  |
| `design_specification` | text | no |  |
| `item_id` | → item | no |  |
| `piece_id` | → stock_piece | no | Set when a specific tagged piece is reserved. |
| `purity_id` | → purity | no |  |
| `category_id` | → item_category | no |  |
| `quantity` | number(14,3) | auto | default 1 |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `metal_amount` | money | auto | default 0 |
| `making_basis` | text | auto | one of: per_gram, percent, flat · default 'per_gram' |
| `making_rate` | rate | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `wastage_percent` | rate | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `gst_rate` | rate | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `line_total` | money | auto | default 0 |
| `hsn_code` | text | no |  |
| `special_instructions` | text | no |  |
| `is_estimate` | boolean | auto | default false |

**Must supply on insert:** `retail_order_id`, `line_number`, `title`

---

### `order_payment`

Advances taken against an order. Posted when saved: the money in, the customer credited.

unique: receipt_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `payment_method_id` | → payment_method | **yes** |  |
| `amount` | money | **yes** |  |
| `reference` | text | no |  |
| `doc_date` | date | **yes** |  |
| `received_at` | timestamp | auto |  |
| `receipt_number` | text | **yes** |  |
| `status` | text | auto | one of: posted, cancelled · default 'posted' |
| `voucher_id` | → voucher | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |
| `notes` | text | no |  |

**Must supply on insert:** `retail_order_id`, `payment_method_id`, `amount`, `doc_date`, `receipt_number`

---

### `order_pipeline`

Config-driven Kanban stages. Absent rows fall back to the built-in defaults.

unique: order_type

| Column | Type | Required | Notes |
|---|---|---|---|
| `order_type` | text | **yes** | one of: booking, custom, repair, wedding, corporate |
| `stages` | json | auto | default '[]' |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `order_type`

---

### `order_stage_event`




| Column | Type | Required | Notes |
|---|---|---|---|
| `retail_order_id` | → retail_order | **yes** |  |
| `at` | timestamp | auto |  |
| `from_stage` | text | no |  |
| `to_stage` | text | **yes** |  |
| `direction` | text | auto | one of: forward, backward, same · default 'forward' |
| `reason` | text | no |  |
| `note` | text | no |  |
| `actor_user_id` | → app_user | no |  |
| `karigar_id` | → karigar | no |  |

**Must supply on insert:** `retail_order_id`, `to_stage`

---

### `retail_order`

All five order types. Type-specific fields are null for the others.

unique: order_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `order_number` | text | **yes** |  |
| `order_type` | text | **yes** | one of: booking, custom, repair, wedding, corporate |
| `status` | text | auto | one of: draft, active, completed, cancelled · default 'draft' |
| `stage` | text | **yes** | one of: booked, compliance, confirmed, crafting, delivered, design, finishing, intake, planning, production, quality, ready, received, repair, sourcing |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `salesperson_id` | → app_user | no |  |
| `karigar_id` | → karigar | no |  |
| `order_date` | date | **yes** |  |
| `expected_delivery_date` | date | **yes** |  |
| `delivered_at` | timestamp | no |  |
| `is_sla_breached` | boolean | auto | default false |
| `rate_lock_type` | text | auto | one of: booking, delivery, fixed · default 'booking' |
| `locked_rate_per_gram` | money | no | The gold rate held for this order (booking and fixed locks). |
| `rate_locked_at` | timestamp | no |  |
| `rate_lock_expires_at` | timestamp | no | From orders.rate_lock.days. Null = held until delivered. |
| `rate_source_used` | text | no | one of: booking, delivery, fixed |
| `rate_override_by` | → app_user | no | Who switched the rate at delivery, if anyone did. |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `advance_amount` | money | auto | default 0 |
| `old_gold_credit` | money | auto | default 0 |
| `scheme_credit` | money | auto | default 0 |
| `balance_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `requirement_description` | text | no |  |
| `size_specifications` | text | no |  |
| `budget_min` | money | no |  |
| `budget_max` | money | no |  |
| `design_approval` | text | no | one of: pending, approved, revision_requested |
| `manufacturing_route` | text | no | one of: in_house, external |
| `external_manufacturer_id` | → party | no |  |
| `production_status` | text | no | one of: not_started, sent_to_manufacturer, quote_received, in_production, completed |
| `repair_item_description` | text | no |  |
| `repair_issue_description` | text | no |  |
| `repair_issue_types` | json | auto | default '[]' |
| `under_warranty` | boolean | auto | default false |
| `original_invoice_number` | text | no | Links a warranty repair back to the sale. |
| `repair_invoice_type` | text | no | one of: service, goods |
| `repair_service_charge` | money | auto | default 0 |
| `estimate_approved_at` | timestamp | no |  |
| `estimate_approved_by_name` | text | no |  |
| `event_date` | date | no |  |
| `event_type` | text | no |  |
| `company_name` | text | no |  |
| `company_gstin` | text | no |  |
| `po_reference` | text | no |  |
| `credit_terms` | text | no | one of: net_15, net_30, custom |
| `credit_terms_note` | text | no |  |
| `branding_notes` | text | no |  |
| `notes` | text | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |
| `sales_invoice_id` | → sales_invoice | no |  |
| `external_reference` | text | no | Order number from the previous software, for imported orders. |

**Must supply on insert:** `order_number`, `order_type`, `stage`, `branch_id`, `customer_id`, `order_date`, `expected_delivery_date`


## Platform Operator & SaaS Admin

### `import_batch`

One file brought in from a previous system as one kind of record.


| Column | Type | Required | Notes |
|---|---|---|---|
| `entity` | text | **yes** | What the rows become: customers, opening_pieces, party_balances… |
| `title` | text | **yes** |  |
| `status` | text | auto | one of: draft, validating, validated, importing, imported, partial, undoing, undone · default 'draft' |
| `source_name` | text | no | The file name as uploaded. |
| `source_format` | text | no | xlsx, csv, xml, json, dbf… |
| `source_system` | text | no | The software it came from, as the operator named it. |
| `sheet_name` | text | no |  |
| `columns` | json | auto | default '[]' |
| `mapping` | json | auto | default '{}' |
| `value_map` | json | auto | default '{}' |
| `options` | json | auto | default '{}' |
| `row_count` | integer | auto | default 0 |
| `valid_count` | integer | auto | default 0 |
| `invalid_count` | integer | auto | default 0 |
| `warning_count` | integer | auto | default 0 |
| `skipped_count` | integer | auto | default 0 |
| `imported_count` | integer | auto | default 0 |
| `failed_count` | integer | auto | default 0 |
| `undone_count` | integer | auto | default 0 |
| `progress` | integer | auto | default 0 |
| `validation` | json | no |  |
| `result` | json | no |  |
| `error` | text | no | Why the last job stopped, when it stopped on an error. |
| `validated_at` | timestamp | no |  |
| `started_at` | timestamp | no |  |
| `finished_at` | timestamp | no |  |
| `undone_at` | timestamp | no |  |
| `operator_id` | uuid | **yes** |  |
| `operator_name` | text | no |  |

**Must supply on insert:** `entity`, `title`, `operator_id`

---

### `import_row`

One row of an imported file, as it arrived, with what became of it.

unique: batch_id + row_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `batch_id` | → import_batch | **yes** |  |
| `row_number` | integer | **yes** | The row in the file, so messages point at something the shop can find. |
| `data` | json | **yes** |  |
| `status` | text | auto | one of: pending, valid, invalid, skipped, imported, failed, undone · default 'pending' |
| `action` | text | no | one of: insert, update, skip |
| `messages` | json | auto | default '[]' |
| `label` | text | no |  |
| `target_table` | text | no |  |
| `target_id` | uuid | no |  |
| `before` | json | no |  |
| `after` | json | no |  |
| `skip_requested` | boolean | auto | default false · The operator chose to leave this row out. |
| `imported_at` | timestamp | no |  |

**Must supply on insert:** `batch_id`, `row_number`, `data`

---

### `platform_audit_log`



**platform-level** (not tenant-scoped)

| Column | Type | Required | Notes |
|---|---|---|---|
| `at` | timestamp | auto |  |
| `platform_user_id` | → platform_user | no |  |
| `action` | text | **yes** | e.g. "tenant.create", "tenant.suspend", "user.create" |
| `target_tenant_id` | → tenant | no |  |
| `target_type` | text | no |  |
| `target_id` | uuid | no |  |
| `changes` | json | no |  |
| `ip_address` | text | no |  |
| `request_id` | text | no |  |

**Must supply on insert:** `action`

---

### `platform_refresh_token`



**platform-level** (not tenant-scoped)

| Column | Type | Required | Notes |
|---|---|---|---|
| `platform_user_id` | → platform_user | **yes** |  |
| `token_hash` | text | **yes** |  |
| `expires_at` | timestamp | **yes** |  |
| `revoked_at` | timestamp | no |  |
| `user_agent` | text | no |  |
| `ip_address` | text | no |  |

**Must supply on insert:** `platform_user_id`, `token_hash`, `expires_at`

---

### `platform_user`

Platform operators. One row today — the super admin, seeded from the CLI, never created through the API.

**platform-level** (not tenant-scoped) · soft delete · unique: email

| Column | Type | Required | Notes |
|---|---|---|---|
| `email` | text | **yes** | unique |
| `full_name` | text | **yes** |  |
| `password_hash` | text | **yes** |  |
| `role` | text | auto | one of: super_admin · default 'super_admin' |
| `phone` | text | no |  |
| `is_active` | boolean | auto | default true |
| `last_login_at` | timestamp | no |  |
| `failed_login_count` | integer | auto | default 0 |
| `locked_until` | timestamp | no |  |
| `created_by_platform_user_id` | → platform_user | no |  |

**Must supply on insert:** `email`, `full_name`, `password_hash`

---

### `support_session`



**platform-level** (not tenant-scoped)

| Column | Type | Required | Notes |
|---|---|---|---|
| `operator_user_id` | → platform_user | **yes** |  |
| `reason` | text | **yes** |  |
| `started_at` | timestamp | auto |  |
| `ends_at` | timestamp | **yes** |  |
| `ended_at` | timestamp | no |  |
| `can_write` | boolean | auto | default false |
| `token_hash` | text | no |  |
| `ip_address` | text | no |  |

**Must supply on insert:** `operator_user_id`, `reason`, `ends_at`

---

### `tenant_module`

Which modules a tenant holds, and on what terms. Drives the module dock.

unique: module_key

| Column | Type | Required | Notes |
|---|---|---|---|
| `module_key` | text | **yes** | orders, stock, tagging, pos, oldgold, schemes, girvi, accounts, master, reports, settings, platform |
| `enabled` | boolean | auto | default true |
| `licence` | text | auto | one of: included, purchased, trial, expired · default 'included' |
| `trial_ends_at` | timestamp | no |  |
| `expires_at` | timestamp | no |  |
| `purchased_at` | timestamp | no |  |
| `disabled_submodules` | json | auto | default '[]' |
| `settings` | json | auto | default '{}' |

**Must supply on insert:** `module_key`


## Purchase

### `goods_receipt`

Goods Inward: what arrived and on what terms. Posting raises stock and what we owe the supplier.

unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `supplier_id` | → party | **yes** |  |
| `status` | text | auto | one of: draft, confirmed, posted, cancelled, closed · default 'draft' |
| `reference_number` | text | no | The other side's document number. |
| `reference_date` | date | no |  |
| `notes` | text | no |  |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `other_charges` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `round_off` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `posted_at` | timestamp | no |  |
| `posted_by` | uuid | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancelled_by` | uuid | no |  |
| `cancel_reason` | text | no |  |
| `voucher_id` | → voucher | no | The accounting entry created at posting. |
| `purchase_order_id` | → purchase_order | no |  |
| `location_id` | → stock_location | **yes** |  |
| `purchase_invoice_id` | → purchase_invoice | no |  |
| `is_direct` | boolean | auto | default false |
| `fine_owed` | json | auto | default '[]' |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `supplier_id`, `location_id`

---

### `goods_receipt_line`



unique: goods_receipt_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `goods_receipt_id` | → goods_receipt | **yes** |  |
| `line_number` | integer | **yes** |  |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `piece_id` | → stock_piece | no | Set when a specific tagged piece is involved. |
| `description` | text | no |  |
| `hsn_code` | text | no |  |
| `quantity` | number(14,3) | auto | default 1 |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `metal_amount` | money | auto | default 0 |
| `making_basis` | text | auto | one of: per_gram, percent, flat · default 'per_gram' |
| `making_rate` | rate | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `wastage_percent` | rate | auto | default 0 |
| `wastage_weight` | weight (g) | auto | default 0 |
| `wastage_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `gst_rate` | rate | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `line_total` | money | auto | default 0 |
| `location_id` | → stock_location | no |  |
| `notes` | text | no |  |
| `purchase_order_line_id` | → purchase_order_line | no |  |
| `other_weight` | weight (g) | auto | default 0 |
| `declared_weight` | weight (g) | no |  |
| `metal_basis` | text | auto | one of: rupee, fine · default 'rupee' |
| `touch_percent` | purity % | no |  |
| `fine_owed` | weight (g) | auto | default 0 |
| `cost_value` | money | auto | default 0 |

**Must supply on insert:** `goods_receipt_id`, `line_number`, `item_id`

---

### `purchase_invoice`

Supplier Bill: the supplier's GST invoice for one or more inwards.

unique: doc_number; supplier_id + supplier_invoice_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `supplier_id` | → party | **yes** |  |
| `status` | text | auto | one of: draft, confirmed, posted, cancelled, closed · default 'draft' |
| `reference_number` | text | no | The other side's document number. |
| `reference_date` | date | no |  |
| `notes` | text | no |  |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `other_charges` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `round_off` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `posted_at` | timestamp | no |  |
| `posted_by` | uuid | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancelled_by` | uuid | no |  |
| `cancel_reason` | text | no |  |
| `voucher_id` | → voucher | no | The accounting entry created at posting. |
| `supplier_invoice_number` | text | **yes** |  |
| `supplier_invoice_date` | date | **yes** |  |
| `due_date` | date | no |  |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `supplier_id`, `supplier_invoice_number`, `supplier_invoice_date`

---

### `purchase_order`

What we asked the supplier for. Affects nothing until goods arrive.

unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `supplier_id` | → party | **yes** |  |
| `status` | text | auto | one of: draft, confirmed, posted, cancelled, closed · default 'draft' |
| `reference_number` | text | no | The other side's document number. |
| `reference_date` | date | no |  |
| `notes` | text | no |  |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `other_charges` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `round_off` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `posted_at` | timestamp | no |  |
| `posted_by` | uuid | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancelled_by` | uuid | no |  |
| `cancel_reason` | text | no |  |
| `voucher_id` | → voucher | no | The accounting entry created at posting. |
| `expected_date` | date | no |  |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `supplier_id`

---

### `purchase_order_line`



unique: purchase_order_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `purchase_order_id` | → purchase_order | **yes** |  |
| `line_number` | integer | **yes** |  |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `piece_id` | → stock_piece | no | Set when a specific tagged piece is involved. |
| `description` | text | no |  |
| `hsn_code` | text | no |  |
| `quantity` | number(14,3) | auto | default 1 |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `metal_amount` | money | auto | default 0 |
| `making_basis` | text | auto | one of: per_gram, percent, flat · default 'per_gram' |
| `making_rate` | rate | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `wastage_percent` | rate | auto | default 0 |
| `wastage_weight` | weight (g) | auto | default 0 |
| `wastage_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `gst_rate` | rate | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `line_total` | money | auto | default 0 |
| `location_id` | → stock_location | no |  |
| `notes` | text | no |  |
| `received_quantity` | number(14,3) | auto | default 0 |
| `received_weight` | weight (g) | auto | default 0 |

**Must supply on insert:** `purchase_order_id`, `line_number`, `item_id`

---

### `purchase_return`

Goods sent back to the supplier. Reduces what we owe them, in rupees or fine metal as they were bought.

unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `supplier_id` | → party | **yes** |  |
| `status` | text | auto | one of: draft, confirmed, posted, cancelled, closed · default 'draft' |
| `reference_number` | text | no | The other side's document number. |
| `reference_date` | date | no |  |
| `notes` | text | no |  |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `other_charges` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `round_off` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `posted_at` | timestamp | no |  |
| `posted_by` | uuid | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancelled_by` | uuid | no |  |
| `cancel_reason` | text | no |  |
| `voucher_id` | → voucher | no | The accounting entry created at posting. |
| `goods_receipt_id` | → goods_receipt | no |  |
| `reason` | text | auto | one of: quality, wrong_item, excess, damaged, on_approval, other · default 'other' |
| `fine_owed` | json | auto | default '[]' |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `supplier_id`

---

### `purchase_return_line`



unique: purchase_return_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `purchase_return_id` | → purchase_return | **yes** |  |
| `line_number` | integer | **yes** |  |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `piece_id` | → stock_piece | no | Set when a specific tagged piece is involved. |
| `description` | text | no |  |
| `hsn_code` | text | no |  |
| `quantity` | number(14,3) | auto | default 1 |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `metal_amount` | money | auto | default 0 |
| `making_basis` | text | auto | one of: per_gram, percent, flat · default 'per_gram' |
| `making_rate` | rate | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `wastage_percent` | rate | auto | default 0 |
| `wastage_weight` | weight (g) | auto | default 0 |
| `wastage_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `gst_rate` | rate | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `line_total` | money | auto | default 0 |
| `location_id` | → stock_location | no |  |
| `notes` | text | no |  |
| `goods_receipt_line_id` | → goods_receipt_line | no |  |
| `metal_basis` | text | auto | one of: rupee, fine · default 'rupee' |
| `fine_owed` | weight (g) | auto | default 0 |
| `cost_value` | money | auto | default 0 |

**Must supply on insert:** `purchase_return_id`, `line_number`, `item_id`

---

### `supplier_settlement`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `supplier_id` | → party | **yes** |  |
| `kind` | text | **yes** | one of: payment, metal, rate_fix |
| `payment_method_id` | → payment_method | no |  |
| `amount` | money | auto | default 0 |
| `reference` | text | no |  |
| `metal_id` | → metal | no |  |
| `item_id` | → item | no |  |
| `purity_id` | → purity | no |  |
| `location_id` | → stock_location | no |  |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | no | rate_fix: rupees per fine gram agreed. |
| `notes` | text | no |  |
| `voucher_id` | → voucher | no |  |
| `status` | text | auto | one of: posted, cancelled · default 'posted' |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `supplier_id`, `kind`


## Executive & Owner BI

### `report_alert`

A figure watched against a limit: sales below target, ghat above tolerance, cash above the insured amount.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | text | **yes** |  |
| `spec` | json | **yes** |  |
| `measure_key` | text | **yes** |  |
| `op` | text | **yes** | one of: gt, gte, lt, lte |
| `threshold` | money | **yes** |  |
| `frequency` | text | auto | one of: hourly, daily · default 'daily' |
| `recipient_ids` | json | auto | default '[]' |
| `is_active` | boolean | auto | default true |
| `last_checked_at` | timestamp | no |  |
| `last_value` | money | no |  |
| `last_state` | text | no | one of: ok, triggered |
| `last_triggered_at` | timestamp | no |  |
| `owner_id` | → app_user | **yes** |  |

**Must supply on insert:** `name`, `spec`, `measure_key`, `op`, `threshold`, `owner_id`

---

### `report_inbox`

What schedules and alerts delivered to a person, with the figures as they were at that moment.


| Column | Type | Required | Notes |
|---|---|---|---|
| `user_id` | → app_user | **yes** |  |
| `kind` | text | **yes** | one of: schedule, alert |
| `title` | text | **yes** |  |
| `body` | text | no |  |
| `source_id` | uuid | no |  |
| `ref` | text | no |  |
| `spec` | json | no |  |
| `snapshot` | json | no |  |
| `read_at` | timestamp | no |  |

**Must supply on insert:** `user_id`, `kind`, `title`

---

### `report_pin`

Reports a person keeps at hand, in their own order. Shown on the Dashboard too.

unique: user_id + ref

| Column | Type | Required | Notes |
|---|---|---|---|
| `user_id` | → app_user | **yes** |  |
| `ref` | text | **yes** |  |
| `position` | integer | auto | default 0 |

**Must supply on insert:** `user_id`, `ref`

---

### `report_run`

Who ran which report, when, and how long it took. Feeds Recent runs.


| Column | Type | Required | Notes |
|---|---|---|---|
| `user_id` | → app_user | **yes** |  |
| `ref` | text | no |  |
| `name` | text | **yes** |  |
| `dataset` | text | **yes** |  |
| `spec` | json | **yes** |  |
| `row_count` | integer | auto | default 0 |
| `ms` | integer | auto | default 0 |

**Must supply on insert:** `user_id`, `name`, `dataset`, `spec`

---

### `report_schedule`

A report run on a timetable and delivered to people’s Reports inbox.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | text | **yes** |  |
| `ref` | text | no |  |
| `spec` | json | **yes** |  |
| `frequency` | text | **yes** | one of: daily, weekly, monthly |
| `day` | integer | no |  |
| `at_time` | text | auto | default '20:00' |
| `recipient_ids` | json | auto | default '[]' |
| `is_active` | boolean | auto | default true |
| `next_run_at` | timestamp | **yes** |  |
| `last_run_at` | timestamp | no |  |
| `owner_id` | → app_user | **yes** |  |

**Must supply on insert:** `name`, `spec`, `frequency`, `next_run_at`, `owner_id`

---

### `report_view`

A report someone designed or customised and saved.

soft delete

| Column | Type | Required | Notes |
|---|---|---|---|
| `name` | text | **yes** |  |
| `description` | text | no |  |
| `category` | text | **yes** |  |
| `base_key` | text | no |  |
| `spec` | json | **yes** |  |
| `owner_id` | → app_user | **yes** |  |
| `is_shared` | boolean | auto | default false |
| `last_run_at` | timestamp | no |  |

**Must supply on insert:** `name`, `category`, `spec`, `owner_id`


## Sales / POS

### `approval_memo`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `due_date` | date | **yes** |  |
| `notes` | text | no |  |
| `status` | text | auto | one of: open, closed · default 'open' |
| `piece_count` | integer | auto | default 0 |
| `gross_weight` | weight (g) | auto | default 0 |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `customer_id`, `due_date`

---

### `approval_memo_line`



unique: approval_memo_id + piece_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `approval_memo_id` | → approval_memo | **yes** |  |
| `piece_id` | → stock_piece | **yes** |  |
| `returned_at` | timestamp | no |  |
| `sales_invoice_id` | → sales_invoice | no |  |

**Must supply on insert:** `approval_memo_id`, `piece_id`

---

### `customer_receipt`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `payment_method_id` | → payment_method | **yes** |  |
| `amount` | money | **yes** |  |
| `reference` | text | no |  |
| `allocations` | json | auto | default '[]' |
| `advance_amount` | money | auto | default 0 |
| `notes` | text | no |  |
| `status` | text | auto | one of: posted, cancelled · default 'posted' |
| `voucher_id` | → voucher | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `customer_id`, `payment_method_id`, `amount`

---

### `sales_invoice`

Module 5.2 — counter, wholesale and export billing share this table.

unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `status` | text | auto | one of: draft, confirmed, posted, cancelled, closed · default 'draft' |
| `reference_number` | text | no | The other side's document number. |
| `reference_date` | date | no |  |
| `notes` | text | no |  |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `other_charges` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `round_off` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `posted_at` | timestamp | no |  |
| `posted_by` | uuid | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancelled_by` | uuid | no |  |
| `cancel_reason` | text | no |  |
| `voucher_id` | → voucher | no | The accounting entry created at posting. |
| `channel` | text | auto | one of: counter, wholesale, export, online · default 'counter' |
| `salesperson_id` | → app_user | no | Drives staff-wise sales reports (Module 11.4). |
| `discount_approved_by` | → app_user | no |  |
| `place_of_supply_code` | text | no |  |
| `is_export` | boolean | auto | default false |
| `export_currency` | text | no |  |
| `export_rate` | rate | no |  |
| `irn` | text | no |  |
| `irn_status` | text | auto | one of: not_required, pending, generated, cancelled, failed · default 'not_required' |
| `irn_generated_at` | timestamp | no |  |
| `ack_number` | text | no |  |
| `qr_code_data` | text | no |  |
| `paid_amount` | money | auto | default 0 |
| `old_gold_amount` | money | auto | default 0 · Credit applied from Module 6. |
| `scheme_amount` | money | auto | default 0 · Credit applied from Module 7. |
| `balance_amount` | money | auto | default 0 |
| `order_id` | uuid | no | Links back to Module 1 once orders are built. |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `customer_id`

---

### `sales_invoice_line`



unique: sales_invoice_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `sales_invoice_id` | → sales_invoice | **yes** |  |
| `line_number` | integer | **yes** |  |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `piece_id` | → stock_piece | no | Set when a specific tagged piece is involved. |
| `description` | text | no |  |
| `hsn_code` | text | no |  |
| `quantity` | number(14,3) | auto | default 1 |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `metal_amount` | money | auto | default 0 |
| `making_basis` | text | auto | one of: per_gram, percent, flat · default 'per_gram' |
| `making_rate` | rate | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `wastage_percent` | rate | auto | default 0 |
| `wastage_weight` | weight (g) | auto | default 0 |
| `wastage_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `gst_rate` | rate | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `line_total` | money | auto | default 0 |
| `location_id` | → stock_location | no |  |
| `notes` | text | no |  |
| `other_weight` | weight (g) | auto | default 0 |
| `cost_value` | money | auto | default 0 |
| `hallmark_charge` | money | auto | default 0 |
| `certificate_number` | text | no |  |
| `pricing_snapshot` | json | auto | default '{}' |
| `returned_net_weight` | weight (g) | auto | default 0 |

**Must supply on insert:** `sales_invoice_id`, `line_number`, `item_id`

---

### `sales_payment`

One row per tender. A single sale usually has several.


| Column | Type | Required | Notes |
|---|---|---|---|
| `sales_invoice_id` | → sales_invoice | **yes** |  |
| `payment_method_id` | → payment_method | no |  |
| `mode` | text | **yes** | one of: cash, card, upi, bank_transfer, cheque, credit, old_gold, scheme, advance, emi, wallet |
| `amount` | money | **yes** |  |
| `reference` | text | no | Cheque number, UPI reference, card approval code. |
| `account_id` | → account | no | Which cash or bank account this landed in. |
| `received_at` | timestamp | auto |  |
| `old_gold_intake_id` | uuid | no |  |
| `notes` | text | no |  |

**Must supply on insert:** `sales_invoice_id`, `mode`, `amount`

---

### `sales_return`



unique: doc_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `doc_number` | text | **yes** |  |
| `doc_date` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `status` | text | auto | one of: draft, confirmed, posted, cancelled, closed · default 'draft' |
| `reference_number` | text | no | The other side's document number. |
| `reference_date` | date | no |  |
| `notes` | text | no |  |
| `metal_amount` | money | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `other_charges` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `round_off` | money | auto | default 0 |
| `total_amount` | money | auto | default 0 |
| `total_gross_weight` | weight (g) | auto | default 0 |
| `total_net_weight` | weight (g) | auto | default 0 |
| `total_fine_weight` | weight (g) | auto | default 0 |
| `posted_at` | timestamp | no |  |
| `posted_by` | uuid | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancelled_by` | uuid | no |  |
| `cancel_reason` | text | no |  |
| `voucher_id` | → voucher | no | The accounting entry created at posting. |
| `sales_invoice_id` | → sales_invoice | **yes** |  |
| `settlement` | text | auto | one of: refund, credit_note · default 'credit_note' |
| `reason` | text | auto | one of: defect, size, dislike, wrong_item, exchange, other · default 'other' |
| `refund_payment_method_id` | → payment_method | no |  |
| `deduction_amount` | money | auto | default 0 |
| `refund_amount` | money | auto | default 0 |
| `adjusted_amount` | money | auto | default 0 |

**Must supply on insert:** `doc_number`, `doc_date`, `branch_id`, `customer_id`, `sales_invoice_id`

---

### `sales_return_line`



unique: sales_return_id + line_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `sales_return_id` | → sales_return | **yes** |  |
| `line_number` | integer | **yes** |  |
| `item_id` | → item | **yes** |  |
| `purity_id` | → purity | no |  |
| `piece_id` | → stock_piece | no | Set when a specific tagged piece is involved. |
| `description` | text | no |  |
| `hsn_code` | text | no |  |
| `quantity` | number(14,3) | auto | default 1 |
| `gross_weight` | weight (g) | auto | default 0 |
| `stone_weight` | weight (g) | auto | default 0 |
| `net_weight` | weight (g) | auto | default 0 |
| `fine_weight` | weight (g) | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `metal_amount` | money | auto | default 0 |
| `making_basis` | text | auto | one of: per_gram, percent, flat · default 'per_gram' |
| `making_rate` | rate | auto | default 0 |
| `making_amount` | money | auto | default 0 |
| `wastage_percent` | rate | auto | default 0 |
| `wastage_weight` | weight (g) | auto | default 0 |
| `wastage_amount` | money | auto | default 0 |
| `stone_amount` | money | auto | default 0 |
| `discount_amount` | money | auto | default 0 |
| `taxable_amount` | money | auto | default 0 |
| `gst_rate` | rate | auto | default 0 |
| `cgst_amount` | money | auto | default 0 |
| `sgst_amount` | money | auto | default 0 |
| `igst_amount` | money | auto | default 0 |
| `line_total` | money | auto | default 0 |
| `location_id` | → stock_location | no |  |
| `notes` | text | no |  |
| `sales_invoice_line_id` | → sales_invoice_line | **yes** |  |
| `cost_value` | money | auto | default 0 |

**Must supply on insert:** `sales_return_id`, `line_number`, `item_id`, `sales_invoice_line_id`


## Swarna Nidhi (Chit Schemes)

### `scheme_account`

One customer enrolled in one scheme.

unique: account_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `account_number` | text | **yes** |  |
| `scheme_plan_id` | → scheme_plan | **yes** |  |
| `customer_id` | → party | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `status` | text | auto | one of: active, matured, redeemed, defaulted, cancelled, closed · default 'active' |
| `enrolled_on` | date | **yes** |  |
| `maturity_date` | date | **yes** |  |
| `due_day` | integer | auto | default 1 |
| `installment_amount` | money | **yes** |  |
| `accrual_basis` | text | auto | one of: rupee, weight · default 'rupee' |
| `purity_id` | → purity | no |  |
| `bonus_installments` | number(6,3) | auto | default 0 |
| `bonus_percent` | rate | auto | default 0 |
| `making_charge_discount_percent` | rate | auto | default 0 |
| `max_missed_installments` | integer | auto | default 2 |
| `grace_period_days` | integer | auto | default 7 |
| `is_flexible_amount` | boolean | auto | default false |
| `minimum_installment` | money | no |  |
| `installments_missed` | integer | auto | default 0 |
| `installments_paid` | integer | auto | default 0 |
| `installments_due` | integer | auto | default 0 |
| `total_paid` | money | auto | default 0 |
| `total_weight_accrued` | weight (g) | auto | default 0 |
| `bonus_amount` | money | auto | default 0 |
| `bonus_weight` | weight (g) | auto | default 0 |
| `redeemable_amount` | money | auto | default 0 |
| `redeemable_weight` | weight (g) | auto | default 0 |
| `is_bonus_forfeited` | boolean | auto | default false |
| `nominee_name` | text | no |  |
| `nominee_relationship` | text | no |  |
| `nominee_phone` | text | no |  |
| `matured_at` | timestamp | no |  |
| `closed_at` | timestamp | no |  |
| `close_reason` | text | no |  |

**Must supply on insert:** `account_number`, `scheme_plan_id`, `customer_id`, `branch_id`, `enrolled_on`, `maturity_date`, `installment_amount`

---

### `scheme_installment`

The full schedule, generated at enrollment. Each row is later paid or missed.

unique: scheme_account_id + installment_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `scheme_account_id` | → scheme_account | **yes** |  |
| `installment_number` | integer | **yes** |  |
| `due_date` | date | **yes** |  |
| `status` | text | auto | one of: due, paid, missed, waived, advance · default 'due' |
| `amount_due` | money | **yes** |  |
| `amount_paid` | money | auto | default 0 |
| `paid_on` | date | no |  |
| `rate_per_gram` | money | no |  |
| `weight_accrued` | weight (g) | auto | default 0 |
| `payment_method_id` | → payment_method | no |  |
| `payment_reference` | text | no |  |
| `receipt_number` | text | no |  |
| `collected_by` | → app_user | no |  |
| `voucher_id` | → voucher | no |  |
| `purity_id` | → purity | no |  |
| `cancelled_at` | timestamp | no |  |
| `cancel_reason` | text | no |  |
| `waived_reason` | text | no |  |
| `last_reminder_at` | timestamp | no |  |
| `reminder_count` | integer | auto | default 0 |
| `notes` | text | no |  |

**Must supply on insert:** `scheme_account_id`, `installment_number`, `due_date`, `amount_due`

---

### `scheme_plan`

The scheme product: tenure, installment, bonus rules.

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `description` | text | no |  |
| `metal_id` | → metal | **yes** |  |
| `purity_id` | → purity | no |  |
| `accrual_basis` | text | auto | one of: rupee, weight · default 'rupee' |
| `tenure_months` | integer | **yes** |  |
| `installment_amount` | money | no | Null for flexible-amount schemes. |
| `minimum_installment` | money | no |  |
| `is_flexible_amount` | boolean | auto | default false |
| `bonus_installments` | number(6,3) | auto | default 0 |
| `bonus_percent` | rate | auto | default 0 |
| `max_missed_installments` | integer | auto | default 2 |
| `making_charge_discount_percent` | rate | auto | default 0 |
| `allow_partial_redemption` | boolean | auto | default false |
| `allow_cash_redemption` | boolean | auto | default false |
| `grace_period_days` | integer | auto | default 7 |
| `terms_and_conditions` | text | no |  |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`, `metal_id`, `tenure_months`

---

### `scheme_redemption`

Turning a matured account into jewellery. Partial redemption leaves the account open.

unique: redemption_number

| Column | Type | Required | Notes |
|---|---|---|---|
| `scheme_account_id` | → scheme_account | **yes** |  |
| `redemption_number` | text | **yes** |  |
| `redeemed_on` | date | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `is_partial` | boolean | auto | default false |
| `amount_redeemed` | money | auto | default 0 |
| `weight_redeemed` | weight (g) | auto | default 0 |
| `bonus_applied` | money | auto | default 0 |
| `rate_per_gram` | money | auto | default 0 |
| `sales_invoice_id` | → sales_invoice | no |  |
| `retail_order_id` | → retail_order | no |  |
| `cash_paid_out` | money | auto | default 0 |
| `bonus_weight_applied` | weight (g) | auto | default 0 |
| `making_discount_percent` | rate | auto | default 0 |
| `deduction_amount` | money | auto | default 0 |
| `kind` | text | auto | one of: redemption, early_closure · default 'redemption' |
| `status` | text | auto | one of: posted, cancelled · default 'posted' |
| `voucher_id` | → voucher | no |  |
| `notes` | text | no |  |

**Must supply on insert:** `scheme_account_id`, `redemption_number`, `redeemed_on`, `branch_id`


## Security vault & private entry

### `private_gateway`

The hidden admin entry on the 404 page: a private path and three ordered points on the artwork. One row per tenant, written only by the super admin.

unique: 

| Column | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | auto | default false |
| `path` | text | auto | default '' · Exact, case-sensitive pathname. Never listed anywhere a business user can read it. |
| `points` | json | auto | default '[]' · [{x,y}] ×3, normalised 0–1 over the 640×440 artwork. |
| `revision` | integer | auto | default 0 · Bumped on every save. Grants issued under an older revision stop working. |
| `updated_by_platform_user_id` | → platform_user | no |  |

_Nothing is required beyond the automatic columns._

---

### `security_grant`

Short-lived proof that someone unlocked the vault or passed the private entry. Only the sha256 of each token is kept.


| Column | Type | Required | Notes |
|---|---|---|---|
| `kind` | text | **yes** | one of: vault_unlock, gateway_grant, gateway_access · vault_unlock: private figures visible. gateway_grant: one-use, 60 s, swapped for gateway_access. gateway_access: the welcome view, 5 min. |
| `user_id` | → app_user | **yes** |  |
| `branch_id` | → branch | no |  |
| `token_hash` | text | **yes** | sha256 of the token. The token itself is never stored. |
| `token_version` | integer | **yes** | The user’s token_version when issued. A password or role change bumps it and the grant dies. |
| `revision` | integer | **yes** | The vault or gateway revision when issued. |
| `expires_at` | timestamp | **yes** |  |
| `consumed_at` | timestamp | no | One-use grants: set the moment it is used. |
| `revoked_at` | timestamp | no |  |
| `ip_address` | text | no |  |

**Must supply on insert:** `kind`, `user_id`, `token_hash`, `token_version`, `revision`, `expires_at`

---

### `security_lockout`

Wrong vault passcodes and wrong private-entry patterns, per person. Five in a row locks that person out for a while.

unique: kind + user_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `kind` | text | **yes** | one of: vault, gateway |
| `user_id` | → app_user | **yes** |  |
| `failed_count` | integer | auto | default 0 |
| `locked_until` | timestamp | no |  |
| `last_failed_at` | timestamp | no |  |

**Must supply on insert:** `kind`, `user_id`

---

### `security_vault`

The private-figures vault of one business: on/off, its passcode and who may unlock it. One row per tenant, written only by the super admin.

unique: 

| Column | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | auto | default false · Off = nobody can unlock; private figures stay hidden. |
| `passcode_hash` | text | no | scrypt salt:hash. Never returned by any endpoint. |
| `passcode_changed_at` | timestamp | no |  |
| `unlock_minutes` | integer | auto | default 15 · How long one unlock lasts before it locks again by itself. |
| `allowed_role_types` | json | auto | default '["owner"]' · Role types that may unlock: owner, admin, staff. |
| `revision` | integer | auto | default 0 · Bumped on every save. Unlocks granted under an older revision stop working. |
| `updated_by_platform_user_id` | → platform_user | no |  |

_Nothing is required beyond the automatic columns._


## Settings & Theme Studio

### `tenant_theme`

Theme Studio. preset_key matches the frontend theme ids.

unique: branch_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `preset_key` | text | auto | one of: deep-forest, royal-ruby, sapphire-platinum, obsidian-luxury, rose-gold, custom · default 'deep-forest' |
| `css_variables` | json | auto | default '{}' |
| `logo_url` | text | no |  |
| `logo_dark_url` | text | no |  |
| `favicon_url` | text | no |  |
| `branch_id` | → branch | no |  |
| `is_active` | boolean | auto | default true |

_Nothing is required beyond the automatic columns._


## Tagging & Barcoding

### `huid_assignment`




| Column | Type | Required | Notes |
|---|---|---|---|
| `piece_id` | → stock_piece | **yes** |  |
| `huid` | text | **yes** | The BIS 6-character alphanumeric identifier. |
| `hallmark_centre_code` | text | no |  |
| `hallmark_centre_name` | text | no |  |
| `hallmarked_on` | date | no |  |
| `certified_purity_percent` | purity % | no |  |
| `certificate_number` | text | no |  |
| `superseded_at` | timestamp | no |  |
| `supersede_reason` | text | no |  |
| `assigned_by` | → app_user | no |  |

**Must supply on insert:** `piece_id`, `huid`

---

### `tag_print_job`

The thermal printer queue the tagging screen shows.


| Column | Type | Required | Notes |
|---|---|---|---|
| `tag_template_id` | → tag_template | **yes** |  |
| `branch_id` | → branch | **yes** |  |
| `status` | text | auto | one of: queued, printing, printed, failed, cancelled · default 'queued' |
| `piece_count` | integer | auto | default 0 |
| `queued_by` | → app_user | no |  |
| `queued_at` | timestamp | auto |  |
| `printed_at` | timestamp | no |  |
| `printer_name` | text | no |  |
| `error_message` | text | no |  |

**Must supply on insert:** `tag_template_id`, `branch_id`

---

### `tag_print_job_item`



unique: tag_print_job_id + piece_id

| Column | Type | Required | Notes |
|---|---|---|---|
| `tag_print_job_id` | → tag_print_job | **yes** |  |
| `piece_id` | → stock_piece | **yes** |  |
| `copies` | integer | auto | default 1 |
| `rendered_payload` | json | auto | default '{}' |
| `printed` | boolean | auto | default false |

**Must supply on insert:** `tag_print_job_id`, `piece_id`

---

### `tag_template`

Tag designs from Settings → Format & Print Designer. page holds the size in mm.

soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** |  |
| `name` | text | **yes** |  |
| `page` | json | auto | default '{}' |
| `canvas_json` | text | auto | default '' |
| `bindings` | json | auto | default '[]' |
| `is_default` | boolean | auto | default false |
| `is_active` | boolean | auto | default true |

**Must supply on insert:** `code`, `name`


## Tenancy

### `tenant`

One row per customer business. Everything else in the database points here.

**platform-level** (not tenant-scoped) · soft delete · unique: code

| Column | Type | Required | Notes |
|---|---|---|---|
| `code` | text | **yes** | unique · Short slug used in URLs and logs. |
| `legal_name` | text | **yes** |  |
| `display_name` | text | **yes** |  |
| `kind` | text | auto | one of: manufacturer, retailer, both · default 'retailer' |
| `status` | text | auto | one of: trial, active, suspended, closed · default 'trial' |
| `country` | text | auto | default 'IN' |
| `base_currency` | text | auto | default 'INR' |
| `timezone` | text | auto | default 'Asia/Kolkata' |
| `gstin` | text | no |  |
| `pan` | text | no |  |
| `metadata` | json | auto | default '{}' |
| `max_branches` | integer | no |  |
| `is_demo` | boolean | auto | default false |
| `activated_at` | timestamp | no |  |

**Must supply on insert:** `code`, `legal_name`, `display_name`

