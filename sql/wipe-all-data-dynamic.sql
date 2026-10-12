-- =====================================================================
-- Swarnay / Swarnay - wipe ALL data, table list discovered at runtime
--
-- Same result as wipe-all-data.sql, but it reads the table list out of the
-- catalog instead of hard-coding it. Use this one if you have added modules
-- since the fixed list was generated - it can never go stale.
--
-- It truncates every ordinary table in the `swarnay_schema` schema in a single
-- statement. Nothing in `public`, `auth` or `storage` is touched, so
-- Supabase's own tables are safe.
--
-- THIS CANNOT BE UNDONE.
-- =====================================================================

do $$
declare
  table_list text;
begin
  select string_agg(format('%I.%I', schemaname, tablename), ', ' order by tablename)
    into table_list
  from pg_tables
  where schemaname = 'swarnay_schema';

  if table_list is null then
    raise notice 'No tables found in schema "swarnay_schema" - nothing to do.';
    return;
  end if;

  raise notice 'Truncating: %', table_list;
  execute 'truncate table ' || table_list || ' restart identity cascade';
end $$;

-- Verification: every row count below should be 0.
select relname as table_name, n_live_tup as approx_rows
from pg_stat_user_tables
where schemaname = 'swarnay_schema'
order by n_live_tup desc, relname;
