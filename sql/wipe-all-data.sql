-- =====================================================================
-- Swarnay / Swarnay - wipe ALL data from ALL tables
--
-- Schema : swarnay_schema (the only schema the app uses; see CLAUDE.md)
-- Target : Supabase Postgres
-- Effect : deletes every row in all 86 application tables.
--          The schema itself (tables, columns, indexes, FKs, RLS policies)
--          is left intact, so the app boots normally afterwards.
--
-- Run it in the Supabase SQL editor, or:
--   psql "$DATABASE_URL" -f sql/wipe-all-data.sql
--
-- Why TRUNCATE and not DELETE:
--   Every tenant-scoped table has RLS "enable" AND "force", so a plain
--   DELETE only sees the rows of the tenant set on the connection - that
--   applies to the table owner too. TRUNCATE is not subject to RLS at all,
--   so it clears everything in one pass. Run as the owner of the application tables
--   (the postgres role in the Supabase editor, or ratnagrid_app).
--
-- All primary keys are uuid, so there are no sequences to reset.
-- THIS CANNOT BE UNDONE. Take a Supabase backup first if unsure.
-- =====================================================================

begin;

set local search_path to swarnay_schema, extensions;

-- One statement for all 86 tables, so foreign-key order does not matter and
-- CASCADE can only reach tables already in the list.
truncate table
  account,
  app_user,
  approval_memo,
  approval_memo_line,
  audit_log,
  branch,
  config_value,
  customer_receipt,
  dashboard_layout,
  document_format,
  feature_flag,
  girvi_accrual,
  girvi_collateral,
  girvi_loan,
  girvi_repayment,
  goods_receipt,
  goods_receipt_line,
  hsn_gst_rate,
  huid_assignment,
  item,
  item_category,
  karigar,
  karigar_ledger,
  ledger_entry,
  melt_batch,
  metal,
  metal_ledger_entry,
  metal_rate,
  numbering_gap,
  numbering_series,
  old_gold_intake,
  old_gold_item,
  old_gold_payout,
  order_acknowledgement,
  order_attachment,
  order_communication,
  order_line,
  order_payment,
  order_pipeline,
  order_stage_event,
  party,
  payment_method,
  payment_method_branch,
  platform_audit_log,
  platform_refresh_token,
  platform_user,
  price_rule,
  purchase_invoice,
  purchase_order,
  purchase_order_line,
  purchase_return,
  purchase_return_line,
  purity,
  refresh_token,
  retail_order,
  role,
  role_permission,
  sales_invoice,
  sales_invoice_line,
  sales_payment,
  sales_return,
  sales_return_line,
  scheme_account,
  scheme_installment,
  scheme_plan,
  scheme_redemption,
  stock_adjustment,
  stock_balance,
  stock_count,
  stock_count_line,
  stock_location,
  stock_movement,
  stock_piece,
  stock_transfer,
  stock_transfer_line,
  supplier_settlement,
  support_session,
  tag_print_job,
  tag_print_job_item,
  tag_template,
  tagging_lot,
  tenant,
  tenant_module,
  tenant_theme,
  user_role,
  voucher
  restart identity cascade;

commit;

-- Verification: every row count below should be 0.
select relname as table_name, n_live_tup as approx_rows
from pg_stat_user_tables
where schemaname = 'swarnay_schema'
order by n_live_tup desc, relname;
