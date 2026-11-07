#!/bin/sh
# Disposable local proof for supabase/scan_serial_claims.sql.
# Creates a temporary database, applies a minimal schema and that file,
# then drops the database. It does not read or write any hosted database.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
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
create table scan_events (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null references clients(id),
  scan_type text not null,
  order_ref text,
  sku text,
  box_ref text,
  serial_count integer not null,
  expected_count integer,
  warehouse_log_id uuid,
  scanned_at timestamptz default now(),
  scanned_by uuid,
  notes text,
  push_job_id uuid
);
create table scanned_serials (
  id uuid primary key default uuid_generate_v4(),
  scan_event_id uuid not null references scan_events(id) on delete cascade,
  serial text not null,
  position integer
);
create table zenventory_push_queue (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid not null,
  order_ref text not null,
  sku text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  idempotency_key text not null unique,
  request_payload jsonb,
  response_status integer,
  response_body text,
  last_error text,
  created_at timestamptz default now(),
  pushed_at timestamptz,
  unique (client_id, order_ref, sku)
);
SQL
psql -d "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/scan_serial_claims.sql" >/dev/null

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL'
insert into clients (id, name) values
  ('00000000-0000-4000-8000-000000000001', 'Fixture Client'),
  ('00000000-0000-4000-8000-000000000002', 'Other Fixture');
insert into client_warehouse_rates (client_id, service_type, rate, unit) values
  ('00000000-0000-4000-8000-000000000001', 'serialization_box', 1.50, 'flat');

-- Historical pair, written without the claim table's help.
insert into scan_events (id, client_id, scan_type, order_ref, sku, serial_count) values
  ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'box', 'OLD-1', 'SIM-SKU', 1),
  ('10000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', 'box', 'OLD-2', 'SIM-SKU', 1);
insert into scanned_serials (scan_event_id, serial, position) values
  ('10000000-0000-4000-8000-000000000001', 'HIST-1', 1),
  ('10000000-0000-4000-8000-000000000002', 'HIST-1', 1);
SQL

# Same-event retry, then a conflicting second event.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['AAA','BBB'], 'SO-1', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU') as first" -tA > /tmp/scan-claims-first.txt
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['bbb','AAA'], 'SO-1', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU') as retry" -tA > /tmp/scan-claims-retry.txt

set +e
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['AAA','CCC'], 'SO-2', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU')" >/tmp/scan-claims-conflict.txt 2>&1
conflict=$?
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['HIST-1'], 'SO-3', 'SIM-SKU', null, null, null, null, null, 'SIM-SKU')" >/tmp/scan-claims-hist.txt 2>&1
hist=$?
set -e

# Hold the claim row open so the other session passes the read, inserts,
# then hits the unique index and has to roll that insert back.
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/tmp/scan-claims-hold.txt 2>&1 &
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
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['ROLL-1'], 'SO-ROLL', 'ROLL-SKU', null, null, null, null, null, 'ROLL-SKU')" >/tmp/scan-claims-rollback.txt 2>&1
roll=$?
set -e
wait "$hold"

# Two overlapping submissions at once. Each would be its own event.
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['RACE-1'], 'SO-R', 'RACE-SKU', null, null, null, null, null, 'RACE-SKU')" >/tmp/scan-claims-race-a.txt 2>&1 &
pid_a=$!
psql -d "$DB" -v ON_ERROR_STOP=1 -c "select record_scan('00000000-0000-4000-8000-000000000001', 'box', array['RACE-1','RACE-2'], 'SO-R2', 'RACE-SKU', null, null, null, null, null, 'RACE-SKU')" >/tmp/scan-claims-race-b.txt 2>&1 &
pid_b=$!
set +e
wait "$pid_a"; race_a=$?
wait "$pid_b"; race_b=$?
set -e

psql -d "$DB" -v ON_ERROR_STOP=1 -tA <<'SQL' > /tmp/scan-claims-counts.txt
select 'ready|' || scan_claim_ready()::text;
select 'definer|' || prosecdef::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_scan';
select 'search_path|' || coalesce(array_to_string(proconfig, ','), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'record_scan';
select 'logs|' || count(*) from warehouse_daily_log;
select 'events_sim|' || count(*) from scan_events where sku = 'SIM-SKU' and order_ref = 'SO-1';
select 'hist_events|' || count(*) from scan_events where order_ref in ('OLD-1','OLD-2');
select 'hist_claims|' || count(*) from scan_serial_claims where serial_key = 'hist-1';
select 'race_events|' || count(*) from scan_events where sku = 'RACE-SKU';
select 'race_logs|' || count(*) from warehouse_daily_log w where exists (select 1 from scan_events e where e.warehouse_log_id = w.id and e.sku = 'RACE-SKU');
select 'conflict_events|' || count(*) from scan_events where order_ref = 'SO-2';
select 'conflict_serials|' || count(*) from scanned_serials where serial = 'CCC';
select 'rls|' || c.relrowsecurity::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'scan_serial_claims';
select 'invoker|' || (select option_value from pg_options_to_table((select reloptions from pg_class where relname = 'duplicate_serials')) where option_name = 'security_invoker');
select 'roll_events|' || count(*) from scan_events where order_ref = 'SO-ROLL';
select 'roll_logs|' || count(*) from warehouse_daily_log w where exists (select 1 from scan_events e where e.warehouse_log_id = w.id and e.order_ref = 'SO-ROLL');
SQL

psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/tmp/scan-claims-grant.txt 2>&1 || true
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'scan_nobody') then
    create role scan_nobody nologin;
  end if;
end $$;
grant usage on schema public to scan_nobody;
SQL
set +e
psql -d "$DB" -v ON_ERROR_STOP=1 <<'SQL' >/tmp/scan-claims-rls.txt 2>&1
set role scan_nobody;
select count(*) from scan_serial_claims;
SQL
rls=$?
set -e

echo "conflict_exit=$conflict"
echo "historical_exit=$hist"
echo "race_a_exit=$race_a"
echo "race_b_exit=$race_b"
echo "rollback_exit=$roll"
echo "grant_denied_exit=$rls"
echo "---- counts ----"
cat /tmp/scan-claims-counts.txt
echo "---- first ----"
cat /tmp/scan-claims-first.txt
echo "---- retry ----"
cat /tmp/scan-claims-retry.txt
echo "---- conflict ----"
cat /tmp/scan-claims-conflict.txt
echo "---- historical ----"
cat /tmp/scan-claims-hist.txt
echo "---- race a ----"
cat /tmp/scan-claims-race-a.txt
echo "---- race b ----"
cat /tmp/scan-claims-race-b.txt
echo "---- rollback ----"
cat /tmp/scan-claims-rollback.txt
echo "---- role ----"
cat /tmp/scan-claims-rls.txt
