-- =====================================================================
-- Swarnay / Swarnay - wipe all data BUT keep the super-admin login
--
-- Identical to wipe-all-data.sql except that `platform_user` is left alone,
-- so you can still sign in to the super-admin app afterwards. Everything
-- else goes, including every tenant, user, master and transaction.
--
-- platform_user only ever references itself, so CASCADE on the other tables
-- cannot reach it. platform_refresh_token IS cleared, so every existing
-- session is logged out and you sign in fresh.
--
-- If you would rather wipe it too: use wipe-all-data.sql, then
--   npm run seed:superadmin -- --password='...'
--
-- THIS CANNOT BE UNDONE.
-- =====================================================================

begin;

set local search_path to swarnay_schema, extensions;

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

-- The one row that should survive.
select email, role, is_active from swarnay_schema.platform_user;
