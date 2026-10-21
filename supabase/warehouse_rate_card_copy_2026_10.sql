-- Give Crisp Power, Kivema, Orcam and Suteka a warehouse rate card by COPYING
-- an existing client's card.
--
-- Measured 2026-10-14 (supabase/verify/warehouse_log_gap_by_client.sql): those
-- four hold ZERO rows in client_warehouse_rates, so the daily log shows them
-- the no-card banner and no boxes. They do have shipping cards in
-- client_zone_rates -- a different table and a different problem; see
-- docs/rate-card-worklist.md.
--
-- ===========================================================================
-- READ THIS BEFORE RUNNING SECTION 2
--
-- These rates were NOT agreed with these four clients. They are another
-- client's numbers. The cards already on file disagree with each other --
-- additional_item is 0.20 / 0.30 / 0.50 and inbound_pallet_handling is 7.00 on
-- two cards and 20.00 on a third -- so there is no "standard" to fall back on
-- and the choice of source IS the pricing decision.
--
-- The rates are copied by SELECT rather than typed into this file on purpose:
-- the numbers come out of the database, so nothing here can be a transcription
-- error or an invented price. What it cannot do is make them correct.
--
-- Run section 1. Read every row. Then run section 2.
--
-- SET THE SOURCE CLIENT IN BOTH SECTION 1 AND SECTION 2. The plan is spelled
-- out twice rather than held in a temp view because the SQL editor pools
-- connections: a temp view created by section 1 may not exist by the time
-- section 2 runs, and an insert that silently read a different plan than the
-- one reviewed is the whole thing this file is trying to avoid.
--
-- Candidates as of 2026-10-14, loggable actions each:
--   'Creative Pea'          12
--   'Time Systems (UK) Ltd' 12
--   'SitnStand'             15   (a different service set, not just different
--                                 numbers -- three services the others lack)
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- SECTION 1 -- DRY RUN. Writes nothing. Read the rate column.
-- ---------------------------------------------------------------------------
with source as (
  select id from clients
  where name = 'Creative Pea'   -- <<<<<< SET THE SOURCE CLIENT HERE (1 of 2)
    and active = true
),
target as (
  select id, name from clients
  where active = true
    and name in ('Crisp Power', 'Kivema', 'Orcam', 'Suteka')
),
plan as (
  select t.id as target_id, t.name as target_client,
         r.service_type, r.rate, r.unit
  from client_warehouse_rates r
  join source s on s.id = r.client_id
  cross join target t
  where
    -- Only lines this screen can price. A null rate or a blank name copied
    -- over would land as a row that exists and still cannot be logged -- the
    -- `none-priced` state, which is a worse place to be than `no-card`
    -- because it reads as though someone had already dealt with it.
    r.service_type is not null
    and btrim(r.service_type) <> ''
    and r.rate is not null
    -- Only lines live today. Copying an expired line forward with a fresh
    -- effective_from would resurrect a rate that was deliberately ended.
    and coalesce(r.effective_from, date '-infinity') <= current_date
    and coalesce(r.effective_to,   date 'infinity')  >  current_date
    -- Idempotent, and this guard is load-bearing. client_warehouse_rates_no_overlap
    -- is keyed `charge_type with =`, and NULL never conflicts in an exclusion
    -- constraint -- so these legacy rows are exactly the rows the constraint
    -- does NOT protect. Running section 2 twice without this would insert a
    -- second live line per service, and priceServiceLine REFUSES a service
    -- with two live lines rather than picking one. A double-run would
    -- therefore un-price every client it just priced.
    and not exists (
      select 1 from client_warehouse_rates x
      where x.client_id = t.id
        and x.service_type = r.service_type
        and coalesce(x.effective_from, date '-infinity') <= current_date
        and coalesce(x.effective_to,   date 'infinity')  >  current_date
    )
)
select target_client, service_type, rate, unit, current_date as effective_from
from plan
order by target_client, service_type;


-- ---------------------------------------------------------------------------
-- SECTION 2 -- THE WRITE. Only after reading section 1's output.
--
-- effective_from is current_date, not null. A null would read as "this rate
-- was always in force", which would make it apply to warehouse work already
-- logged in the past -- retroactively pricing history at a rate invented
-- today.
-- ---------------------------------------------------------------------------
with source as (
  select id from clients
  where name = 'Creative Pea'   -- <<<<<< SET THE SOURCE CLIENT HERE (2 of 2)
    and active = true
),
target as (
  select id, name from clients
  where active = true
    and name in ('Crisp Power', 'Kivema', 'Orcam', 'Suteka')
),
plan as (
  select t.id as target_id, r.service_type, r.rate, r.unit
  from client_warehouse_rates r
  join source s on s.id = r.client_id
  cross join target t
  where r.service_type is not null
    and btrim(r.service_type) <> ''
    and r.rate is not null
    and coalesce(r.effective_from, date '-infinity') <= current_date
    and coalesce(r.effective_to,   date 'infinity')  >  current_date
    and not exists (
      select 1 from client_warehouse_rates x
      where x.client_id = t.id
        and x.service_type = r.service_type
        and coalesce(x.effective_from, date '-infinity') <= current_date
        and coalesce(x.effective_to,   date 'infinity')  >  current_date
    )
)
insert into client_warehouse_rates (client_id, service_type, rate, unit, effective_from)
select target_id, service_type, rate, unit, current_date
from plan
returning client_id, service_type, rate, unit;


-- ---------------------------------------------------------------------------
-- SECTION 3 -- VERIFY. Not "Success": the count of loggable actions per
-- client, which is the thing that was 0 and the thing the screen reads.
--
-- Expect the four targets to match the source's line count. Any still at 0 did
-- not get a card. Any LOWER than the source hit the not-exists guard, meaning
-- that client already had a live line for that service.
--
-- For the fuller picture -- including whether any service now has TWO live
-- lines and has therefore gone unpriceable -- re-run
-- supabase/verify/warehouse_log_gap_by_client.sql, which reports duplicates
-- in its blocked_lines column.
-- ---------------------------------------------------------------------------
select
  c.name,
  count(*) filter (
    where r.service_type is not null
      and r.rate is not null
      and coalesce(r.effective_from, date '-infinity') <= current_date
      and coalesce(r.effective_to,   date 'infinity')  >  current_date
  ) as live_rated_lines
from clients c
left join client_warehouse_rates r on r.client_id = c.id
where c.active = true
group by c.id, c.name
order by live_rated_lines, c.name;


-- ---------------------------------------------------------------------------
-- UNDO, if section 1 was read too quickly.
--
-- Scoped by effective_from = current_date AND the four names, so it cannot
-- touch a line that was on file before today. Run it the same day; after
-- midnight, change current_date to the day the insert ran.
-- ---------------------------------------------------------------------------
-- delete from client_warehouse_rates r
-- using clients c
-- where c.id = r.client_id
--   and c.name in ('Crisp Power', 'Kivema', 'Orcam', 'Suteka')
--   and r.effective_from = current_date;
