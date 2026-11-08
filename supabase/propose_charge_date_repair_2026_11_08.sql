-- PROPOSAL. Do not run.
--
-- Name: propose_charge_date_repair_2026_11_08
-- This file is not supabase/repair_date_only_charge_dates.sql.
-- This file is not supabase/warehouse_freight_shipment.sql.
-- Freight columns are already applied. This proposal does not touch them.
--
-- Snapshot taken 2026-11-08 by the read in impact_78b8.sql.
-- Join: order_charges.order_id -> orders, then shipments on
-- client_id AND order_number. One shipment only.
-- 1,038 charges. Known amount 6241.29. Unknown amount 723.
-- 21 of those move September 30 to October 1, all with a null amount:
--   Kivema 2, SitnStand 9, Suteka 8, Time Systems (UK) Ltd 2.
-- 285 move across a Monday week boundary. Known amount on those weeks
-- is 1149.34. The other 14 ship_date charges match more than one
-- shipment and are excluded. Their known amount is 207.16 and 4 are
-- unknown. A charge_key to shipstation_shipment_id join is a different
-- question and is not used here.
--
-- The snapshot did not include the 1,038 ids. This file does not
-- invent them. Section 1 is the read that lists them. Section 2
-- refuses to update unless the live counts still match this snapshot,
-- and it refuses unless the session sets
--   set shipo.approve_charge_date_repair = 'propose_charge_date_repair_2026_11_08';
-- Section 2 updates charge_date only. Amounts stay. It ends in ROLLBACK.
-- Do not replace that with COMMIT until Ophir approves this exact file.

-- =====================================================================
-- 1. READ ONLY. This is the id snapshot. It does not change a row.
-- =====================================================================

with c as (
  select oc.id, oc.client_id, oc.charge_type, oc.charge_date, oc.amount,
         oc.charge_date_source, o.order_number, o.cancelled
  from public.order_charges oc
  join public.orders o on o.id = oc.order_id
  where oc.charge_date_source = 'ship_date'
),
j as (
  select c.id, c.client_id, c.charge_type, c.charge_date, c.amount,
         c.order_number, c.cancelled,
         count(s.id) as n_ship,
         min(s.raw_data->>'shipDate') as raw,
         bool_and(s.ship_date = ((s.raw_data->>'shipDate') || ' 00:00:00+00')::timestamptz)
           filter (where (s.raw_data->>'shipDate') ~ '^\d{4}-\d{2}-\d{2}$') as utc_mid_ok,
         bool_and((s.raw_data->>'shipDate') ~ '^\d{4}-\d{2}-\d{2}$') as dateonly,
         min((s.ship_date at time zone 'America/New_York')::date) as et
  from c
  left join public.shipments s
    on s.client_id = c.client_id
   and s.order_number = c.order_number
  group by c.id, c.client_id, c.charge_type, c.charge_date, c.amount,
           c.order_number, c.cancelled
)
select j.id, cl.name as client, j.order_number, j.charge_type,
       j.charge_date as stored_charge_date,
       j.raw::date as carrier_day,
       j.amount
from j
join public.clients cl on cl.id = j.client_id
where j.n_ship = 1
  and coalesce(j.cancelled, false) = false
  and coalesce(j.dateonly, false)
  and coalesce(j.utc_mid_ok, false)
  and j.charge_date = j.raw::date - 1
  and j.charge_date = j.et
order by j.id;

-- =====================================================================
-- 2. NOT APPROVED. Update proposal. Default end is ROLLBACK.
-- =====================================================================

begin;

do $gate$
begin
  if current_setting('shipo.approve_charge_date_repair', true)
     is distinct from 'propose_charge_date_repair_2026_11_08' then
    raise exception
      'charge date repair is not approved. No row was changed.';
  end if;
end
$gate$;

create temporary table charge_date_repair_eligible on commit drop as
with c as (
  select oc.id, oc.client_id, oc.charge_date, oc.amount, o.order_number, o.cancelled
  from public.order_charges oc
  join public.orders o on o.id = oc.order_id
  where oc.charge_date_source = 'ship_date'
),
j as (
  select c.id, c.client_id, c.charge_date, c.amount, c.order_number, c.cancelled,
         count(s.id) as n_ship,
         min(s.raw_data->>'shipDate') as raw,
         bool_and(s.ship_date = ((s.raw_data->>'shipDate') || ' 00:00:00+00')::timestamptz)
           filter (where (s.raw_data->>'shipDate') ~ '^\d{4}-\d{2}-\d{2}$') as utc_mid_ok,
         bool_and((s.raw_data->>'shipDate') ~ '^\d{4}-\d{2}-\d{2}$') as dateonly,
         min((s.ship_date at time zone 'America/New_York')::date) as et
  from c
  left join public.shipments s
    on s.client_id = c.client_id
   and s.order_number = c.order_number
  group by c.id, c.client_id, c.charge_date, c.amount, c.order_number, c.cancelled
)
select j.id, cl.name as client, j.charge_date as old_charge_date,
       j.raw::date as new_charge_date, j.amount
from j
join public.clients cl on cl.id = j.client_id
where j.n_ship = 1
  and coalesce(j.cancelled, false) = false
  and coalesce(j.dateonly, false)
  and coalesce(j.utc_mid_ok, false)
  and j.charge_date = j.raw::date - 1
  and j.charge_date = j.et;

do $check$
declare
  n integer;
  known numeric;
  unknown integer;
  month_cross integer;
  month_known numeric;
  week_cross integer;
  week_known numeric;
  kivema integer;
  sitnstand integer;
  suteka integer;
  timesystems integer;
  other_month integer;
begin
  select count(*),
         coalesce(sum(amount), 0),
         count(*) filter (where amount is null),
         count(*) filter (where to_char(old_charge_date, 'YYYY-MM')
                            is distinct from to_char(new_charge_date, 'YYYY-MM')),
         coalesce(sum(amount) filter (where to_char(old_charge_date, 'YYYY-MM')
                            is distinct from to_char(new_charge_date, 'YYYY-MM')), 0),
         count(*) filter (where date_trunc('week', old_charge_date)
                            is distinct from date_trunc('week', new_charge_date)),
         coalesce(sum(amount) filter (where date_trunc('week', old_charge_date)
                            is distinct from date_trunc('week', new_charge_date)), 0)
    into n, known, unknown, month_cross, month_known, week_cross, week_known
  from charge_date_repair_eligible;

  if n <> 1038 then
    raise exception 'drift: eligible count is %, expected 1038', n;
  end if;
  if known <> 6241.29 then
    raise exception 'drift: known amount is %, expected 6241.29', known;
  end if;
  if unknown <> 723 then
    raise exception 'drift: unknown count is %, expected 723', unknown;
  end if;
  if month_cross <> 21 or month_known <> 0 then
    raise exception 'drift: month moves % rows and known %', month_cross, month_known;
  end if;
  if week_cross <> 285 or week_known <> 1149.34 then
    raise exception 'drift: week moves % rows and known %', week_cross, week_known;
  end if;

  select count(*) filter (where client = 'Kivema'),
         count(*) filter (where client = 'SitnStand'),
         count(*) filter (where client = 'Suteka'),
         count(*) filter (where client = 'Time Systems (UK) Ltd'),
         count(*) filter (where client not in
           ('Kivema', 'SitnStand', 'Suteka', 'Time Systems (UK) Ltd'))
    into kivema, sitnstand, suteka, timesystems, other_month
  from charge_date_repair_eligible
  where to_char(old_charge_date, 'YYYY-MM')
        is distinct from to_char(new_charge_date, 'YYYY-MM');

  if kivema <> 2 or sitnstand <> 9 or suteka <> 8
     or timesystems <> 2 or other_month <> 0 then
    raise exception
      'drift: month clients kivema % sitnstand % suteka % timesystems % other %',
      kivema, sitnstand, suteka, timesystems, other_month;
  end if;
end
$check$;

create table if not exists public.charge_date_repair_20261108_backup (
  id uuid primary key,
  old_charge_date date not null,
  new_charge_date date not null,
  backed_up_at timestamptz not null default now()
);

insert into public.charge_date_repair_20261108_backup (id, old_charge_date, new_charge_date)
select id, old_charge_date, new_charge_date
from charge_date_repair_eligible
on conflict (id) do nothing;

update public.order_charges oc
set charge_date = e.new_charge_date
from charge_date_repair_eligible e
where oc.id = e.id
  and oc.charge_date = e.old_charge_date
  and oc.amount is not distinct from e.amount
  and oc.charge_date_source = 'ship_date';

do $after$
declare
  moved integer;
begin
  select count(*) into moved
  from public.order_charges oc
  join charge_date_repair_eligible e on e.id = oc.id
  where oc.charge_date = e.new_charge_date
    and oc.amount is not distinct from e.amount;
  if moved <> 1038 then
    raise exception 'drift after update: % rows, expected 1038', moved;
  end if;
end
$after$;

-- Restore path, after a committed run, in a later transaction:
--   update public.order_charges oc
--   set charge_date = b.old_charge_date
--   from public.charge_date_repair_20261108_backup b
--   where oc.id = b.id
--     and oc.charge_date = b.new_charge_date;
--   drop table public.charge_date_repair_20261108_backup;

rollback;
