#!/bin/sh
# Disposable proof that scan_serial_claims.sql leaves production objects
# alone and that record_scan_claimed enforces the new rules.
# Drops its database at the end. No hosted database is used.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MAIN_SQL=${MAIN_SQL:-/tmp/serialization_scans_main.sql}
DB="scan_claims_$$"
psql -d postgres -v ON_ERROR_STOP=1 -c "drop database if exists $DB" >/dev/null
psql -d postgres -v ON_ERROR_STOP=1 -c "create database $DB" >/dev/null
cleanup() { psql -d postgres -c "drop database if exists $DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
create extension if not exists "uuid-ossp";
create table clients (id uuid primary key default uuid_generate_v4(), name text);
create table client_warehouse_rates (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  service_type text,
  rate numeric(10,2),
  unit text
);
create table warehouse_daily_log (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid,
  log_date date,
  service_type text,
  quantity numeric,
  rate numeric,
  total numeric,
  notes text,
  logged_by uuid
);
SQL
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$MAIN_SQL" >/dev/null

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
insert into clients (id, name) values
  ('00000000-0000-4000-8000-000000000001', 'Fixture Client'),
  ('00000000-0000-4000-8000-000000000002', 'Other Fixture');
insert into client_warehouse_rates (client_id, service_type, rate, unit) values
  ('00000000-0000-4000-8000-000000000001', 'serialization_box', 1.50, 'flat');
insert into scan_events (id, client_id, scan_type, order_ref, sku, serial_count) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'box', 'OLD-1', 'SIM-SKU', 1),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'box', 'OLD-2', 'SIM-SKU', 1);
insert into scanned_serials (scan_event_id, serial, position) values
  ('10000000-0000-4000-8000-000000000001', 'HIST-1', 1),
  ('10000000-0000-4000-8000-000000000002', 'HIST-1', 1);
SQL

if ! psql -d "$DB" -v ON_ERROR_STOP=1 -tA -c "select has_function_privilege('public', 'record_scan(uuid,text,text[],text,text,text,integer,text,uuid,date)', 'execute')" >/dev/null 2>&1; then
  echo "note: privilege lookup uses the catalog oid instead of a typed signature"
fi

psql -d "$DB" -v ON_ERROR_STOP=1 -tA -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['OLD-A'], 'SO-OLD', 'SIM-SKU') ->> 'scan_event_id'" > /tmp/scan-old-first.txt

psql -d "$DB" -v ON_ERROR_STOP=1 -tA > /tmp/scan-before.txt <<'SQL'
select 'fn|' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_scan';
select 'view|' || md5(pg_get_viewdef('public.duplicate_serials'::regclass, true));
select 'acl|' || coalesce(p.proacl::text, 'null') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_scan';
select 'hist|' || count(*) from scanned_serials where serial = 'HIST-1';
select 'olda|' || count(*) from scanned_serials where serial = 'OLD-A';
SQL

psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/scan_serial_claims.sql" >/dev/null

psql -d "$DB" -v ON_ERROR_STOP=1 -tA > /tmp/scan-after.txt <<'SQL'
select 'fn|' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_scan';
select 'view|' || md5(pg_get_viewdef('public.duplicate_serials'::regclass, true));
select 'acl|' || coalesce(p.proacl::text, 'null') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_scan';
select 'hist|' || count(*) from scanned_serials where serial = 'HIST-1';
select 'olda|' || count(*) from scanned_serials where serial = 'OLD-A';
SQL

echo "---- schema compare (before vs after migration, before any new call) ----"
diff -u /tmp/scan-before.txt /tmp/scan-after.txt && echo "SCHEMA_UNCHANGED=yes" || echo "SCHEMA_UNCHANGED=no"

# Production caller after the migration: a new serial still stores,
# and the same serial stores AGAIN. That is the old path, without the claim.
psql -d "$DB" -v ON_ERROR_STOP=1 -tA -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['OLD-B'], 'SO-OLD-B', 'SIM-SKU') ->> 'scan_event_id'" > /tmp/scan-old-second.txt
psql -d "$DB" -v ON_ERROR_STOP=1 -tA -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['OLD-A'], 'SO-OLD-AGAIN', 'SIM-SKU') ->> 'scan_event_id'" > /tmp/scan-old-dup.txt

psql -d "$DB" -v ON_ERROR_STOP=1 -tA -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['AAA','BBB'], 'SO-1', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU') ->> 'scan_event_id'" > /tmp/scan-new-first.txt
psql -d "$DB" -v ON_ERROR_STOP=1 -tA -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['bbb','AAA'], 'SO-1', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU')" > /tmp/scan-new-retry.txt

set +e
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['AAA','CCC'], 'SO-2', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU')" >/tmp/scan-new-conflict.txt 2>&1
conflict=$?
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['HIST-1'], 'SO-3', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU')" >/tmp/scan-new-hist.txt 2>&1
hist=$?
set -e

psql -d "$DB" -v ON_ERROR_STOP=1 >/tmp/scan-hold.txt 2>&1 <<'SQL' &
begin;
insert into scan_events (id, client_id, scan_type, order_ref, sku, serial_count)
values ('20000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'box', 'HOLD', 'ROLL-SKU', 1);
insert into scan_serial_claims (client_id, sku_key, serial_key, scan_event_id)
values ('00000000-0000-4000-8000-000000000001', 'roll-sku', 'roll-1', '20000000-0000-4000-8000-000000000001');
select pg_sleep(2);
commit;
SQL
hold=$!
sleep 0.4
set +e
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['ROLL-1'], 'SO-ROLL', 'ROLL-SKU', null, null, null, null, null, 'ROLL-SKU')" >/tmp/scan-rollback.txt 2>&1
roll=$?
set -e
wait "$hold"

psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['RACE-1'], 'SO-R', 'RACE-SKU', null, null, null, null, null, 'RACE-SKU')" >/tmp/scan-race-a.txt 2>&1 &
pid_a=$!
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan_claimed('00000000-0000-4000-8000-000000000001', 'box', array['RACE-1','RACE-2'], 'SO-R2', 'RACE-SKU', null, null, null, null, null, 'RACE-SKU')" >/tmp/scan-race-b.txt 2>&1 &
pid_b=$!
set +e
wait "$pid_a"; race_a=$?
wait "$pid_b"; race_b=$?
set -e

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/tmp/scan-role-setup.txt
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'scan_nobody') then
    create role scan_nobody nologin;
  end if;
end $$;
grant usage on schema public to scan_nobody;
SQL

psql -d "$DB" -v ON_ERROR_STOP=1 -tA > /tmp/scan-ready.txt <<'SQL'
select scan_claim_ready();
select 'old_exec|' || has_function_privilege('scan_nobody', p.oid, 'execute')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_scan';
select 'new_exec|' || has_function_privilege('scan_nobody', p.oid, 'execute')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'record_scan_claimed';
select 'old_dup_events|' || count(*) from scan_events where order_ref in ('SO-OLD', 'SO-OLD-AGAIN');
select 'olda_rows|' || count(*) from scanned_serials where serial = 'OLD-A';
select 'hist_still|' || count(*) from scanned_serials where serial = 'HIST-1';
select 'new_events|' || count(*) from scan_events where order_ref = 'SO-1';
select 'conflict_events|' || count(*) from scan_events where order_ref = 'SO-2';
select 'roll_events|' || count(*) from scan_events where order_ref = 'SO-ROLL';
select 'race_events|' || count(*) from scan_events where sku = 'RACE-SKU';
select 'fns|' || string_agg(proname || ':' || pronargs::text, ',' order by proname)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in ('record_scan', 'record_scan_claimed', 'scan_claim_ready');
SQL

set +e
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/tmp/scan-denied.txt 2>&1
set role scan_nobody;
select count(*) from scan_serial_claims;
SQL
denied=$?
set -e

echo "conflict_exit=$conflict historical_exit=$hist rollback_exit=$roll race_a=$race_a race_b=$race_b denied_exit=$denied"
echo "---- ready and counts ----"
cat /tmp/scan-ready.txt
echo "---- old first / dup ----"
echo "first=$(cat /tmp/scan-old-first.txt)"
echo "dup=$(cat /tmp/scan-old-dup.txt)"
echo "---- retry ----"
cat /tmp/scan-new-retry.txt
echo "---- conflict ----"
cat /tmp/scan-new-conflict.txt
echo "---- historical ----"
cat /tmp/scan-new-hist.txt
echo "---- rollback ----"
cat /tmp/scan-rollback.txt
echo "---- denied ----"
cat /tmp/scan-denied.txt
