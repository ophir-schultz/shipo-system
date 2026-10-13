-- Clear the US zones that were inferred for parcels that did not go to the US.
--
-- READ THIS FIRST. Only PART 5 writes, and it is commented out. PART 3 must be
-- SAVED before PART 5 runs -- it is the only undo, and unlike the Crisp Power
-- file this one cannot reconstruct it afterwards.
--
-- THE SUPABASE EDITOR SHOWS ONLY THE LAST STATEMENT'S RESULT when you paste a
-- batch. Paste one PART at a time.
--
-- WHY THIS EXISTS. 4690fc5 stopped resolveZone deriving a US zone from a
-- foreign postcode: zone_chart maps a US ZIP PREFIX to a zone, and stripping
-- non-digits from 'B2Y 1M9' gives '219', which is a real row. That fix is
-- sound for shipments resolved from now on, and it does not reach a single
-- shipment already carrying a wrong zone. Both halves of that are in the code:
--
--   src/lib/billing/zones.ts:145 -- step 0 returns shipment.zone before the
--     country guard at step 2 is reached. A stored zone is never re-examined.
--   src/lib/billing/recalculate.ts:230 -- the zone key is OMITTED from the
--     update when the resolved zone is null, so recalculate can only ever
--     WRITE a zone, never clear one.
--
-- Together those make a wrong stored zone permanent. It cannot age out, and no
-- number of recalculate runs will revisit it. A manual clear is the only thing
-- that lets 4690fc5's guard take effect on the rows that need it.
--
-- WHY CLEARING IS SAFE, which is not obvious for a column going to null.
-- recalculate.ts:230 is the ONLY writer of shipments.zone in the codebase --
-- the other `zone` columns belong to zone_chart and client_zone_rates, which
-- this file does not touch. So the value being cleared was put there by the
-- inference now known to be wrong, and not by a human or a carrier. Where a
-- carrier DID assert a zone, it is in raw_data, and resolveZone step 1 reads
-- it back on the next run: clearing the column loses nothing that raw_data
-- still holds.
--
-- WHAT IT SETS IN MOTION, and this is the part to be sure about before
-- running it. recalculate writes `client_rate: clientRate` unconditionally. So
-- on the next pass a cleared shipment resolves no zone, skips the matrix, and
-- falls to the legacy card -- and if no legacy row covers it, client_rate is
-- written NULL and the shipment becomes visibly UNPRICED. That is the intended
-- correction: a parcel to Nova Scotia priced on the Maryland lane should not
-- hold a price at all until someone agrees an international one. But it means
-- this file does not merely clear a column, it un-prices shipments. PART 4 is
-- there to find out whether any of them have already been invoiced.
--
-- US TERRITORIES ARE DELIBERATELY EXCLUDED. Puerto Rico, the USVI, Guam,
-- American Samoa and the Northern Marianas use US ZIP codes and are real rows
-- in zone_chart, so their stored zones are CORRECT and clearing them would
-- un-price shipments that are priced properly today.
--
-- That exclusion also exposes a gap in 4690fc5 that this file cannot fix.
-- The guard allows only 'US' and 'USA', so a NEW shipment to one of these
-- territories is now refused a zone it should have been given. Existing ones
-- still price only because step 0 hands back their stored zone -- the same
-- staleness this file is otherwise correcting is what is currently protecting
-- them. If PART 2 shows any territory rows, the code needs them allowlisted
-- beside 'US' before that protection is relied on any further.


-- ---------------------------------------------------------------------------
-- PART 1 -- the census. How big is this, and is it territories or foreign?
-- ---------------------------------------------------------------------------
-- Read-only. `with_stored_zone` is the column this whole file is about: it is
-- the count of shipments 4690fc5 cannot reach. If it is 0 everywhere, the fix
-- is already complete and PART 5 must not run.
with f as (
  select
    s.*,
    nullif(trim(upper(coalesce(
      s.raw_data -> 'shipTo' ->> 'country',
      s.raw_data ->> 'country'
    ))), '') as country
  from shipments s
)
select
  coalesce(f.country, '<not recorded>')   as country,
  case
    when f.country is null
      then 'treated as domestic'
    when f.country in ('US', 'USA')
      then 'domestic'
    when f.country in ('PR', 'VI', 'GU', 'AS', 'MP')
      then 'US TERRITORY -- do not clear'
    else 'FOREIGN -- in scope'
  end                                     as kind,
  count(*)                                as shipments,
  count(f.zone)                           as with_stored_zone,
  count(f.client_rate)                    as billed,
  sum(f.client_rate)                      as billed_total,
  min(f.ship_date)::date                  as oldest,
  max(f.ship_date)::date                  as newest
from f
group by 1, 2
order by 2, 4 desc, 3 desc;


-- ---------------------------------------------------------------------------
-- PART 2 -- the rows themselves, so each one can be looked at.
-- ---------------------------------------------------------------------------
-- Read-only. One line per shipment PART 5 would touch. The zone column is the
-- wrong answer; recipient_zip is where it came from.
--
-- raw_zone is the separate question: if the carrier supplied a zone in
-- raw_data, resolveZone step 1 will hand it straight back after the clear, and
-- nothing about that shipment actually changes. Those rows are not worth
-- clearing and are not evidence of anything.
with f as (
  select
    s.*,
    nullif(trim(upper(coalesce(
      s.raw_data -> 'shipTo' ->> 'country',
      s.raw_data ->> 'country'
    ))), '') as country,
    coalesce(
      s.raw_data ->> 'zone',
      s.raw_data -> 'advancedOptions' ->> 'zone',
      s.raw_data -> 'shipTo' ->> 'zone'
    ) as raw_zone
  from shipments s
)
select
  cl.name                                 as client,
  f.country,
  f.order_number,
  f.tracking_number,
  f.ship_date::date                       as ship_date,
  f.recipient_zip,
  f.zone                                  as stored_zone,
  coalesce(f.raw_zone, '-')               as raw_zone,
  concat_ws(' / ', f.carrier, f.service)  as service,
  f.client_rate,
  f.actual_cost
from f
join clients cl on cl.id = f.client_id
where f.country is not null
  and f.country not in ('US', 'USA', 'PR', 'VI', 'GU', 'AS', 'MP')
  and f.zone is not null
order by f.client_rate desc nulls last, f.ship_date desc;


-- ---------------------------------------------------------------------------
-- PART 3 -- THE UNDO. Save this output before PART 5 runs.
-- ---------------------------------------------------------------------------
-- Read-only, and the reason it exists: the Crisp Power file could reconstruct
-- its own undo because every cell it touched held the same value. These rows
-- hold DIFFERENT zones -- 2 here, 3 there -- and once they are null there is
-- nothing left to derive them from. The old zone came from an inference that
-- 4690fc5 has since removed, so re-running the code cannot reproduce it.
--
-- Copy the single text cell this returns into the ticket, the commit, or
-- anywhere that is not this editor's scrollback, BEFORE running PART 5.
with f as (
  select
    s.id, s.zone,
    nullif(trim(upper(coalesce(
      s.raw_data -> 'shipTo' ->> 'country',
      s.raw_data ->> 'country'
    ))), '') as country
  from shipments s
)
select coalesce(
  string_agg(
    format('update shipments set zone = %s where id = %L;', f.zone, f.id),
    chr(10) order by f.id
  ),
  '-- nothing to undo: PART 5 would touch no rows'
) as undo_statements
from f
where f.country is not null
  and f.country not in ('US', 'USA', 'PR', 'VI', 'GU', 'AS', 'MP')
  and f.zone is not null;


-- ---------------------------------------------------------------------------
-- PART 4 -- has any of this already been invoiced?
-- ---------------------------------------------------------------------------
-- Read-only, and the question PART 5 cannot answer for itself. Clearing a zone
-- lets recalculate null the client_rate, which is right for a shipment nobody
-- has billed and is a DIVERGENCE for one that is already on an issued invoice:
-- the invoice says one number and the shipment row then says none.
--
-- The bills schema is read here rather than assumed, because guessing a column
-- name in a file about money is how the wrong rows get matched. Run this
-- first, then write the join it tells you is possible.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'bills'
order by ordinal_position;

-- If PART 1 showed `billed` as 0 for every FOREIGN row, this is moot and
-- PART 5 is unconditionally safe -- there is no price to diverge from. If it
-- showed a non-zero `billed_total`, stop and establish whether those shipments
-- are on an invoice that has been sent before clearing anything. Un-pricing a
-- shipment a client has already paid for is a worse state than a wrong zone.


-- ---------------------------------------------------------------------------
-- PART 5 -- THE WRITE. The only statement here that changes a row.
-- ---------------------------------------------------------------------------
-- Run only after PART 3 is saved somewhere durable and PART 4 is settled.
--
-- `and zone is not null` is load-bearing: it makes the statement re-runnable,
-- because a second run finds nothing left to clear. The territory list is
-- load-bearing for a different reason -- those zones are correct, and this is
-- the one statement in the file that would silently un-price them.
--
-- update shipments s
--    set zone = null
--  where s.zone is not null
--    and nullif(trim(upper(coalesce(
--          s.raw_data -> 'shipTo' ->> 'country',
--          s.raw_data ->> 'country'
--        ))), '') not in ('US', 'USA', 'PR', 'VI', 'GU', 'AS', 'MP')
--    and nullif(trim(upper(coalesce(
--          s.raw_data -> 'shipTo' ->> 'country',
--          s.raw_data ->> 'country'
--        ))), '') is not null;
--
-- The row count MUST equal the number of rows PART 2 listed. More means
-- something changed between reading and writing, and PART 6 before anything
-- else.
--
-- `is not null` is stated separately and on purpose: `not in` against a NULL
-- yields NULL, not true, so a shipment with no recorded country would be
-- excluded anyway. It is written out because that behaviour is the difference
-- between clearing 4 rows and clearing the entire book, and it should not rest
-- on the reader remembering SQL's three-valued logic.


-- ---------------------------------------------------------------------------
-- PART 6 -- after, and the proof that the guard actually holds.
-- ---------------------------------------------------------------------------
-- Read-only. Run it immediately after PART 5, and then AGAIN after the next
-- recalculate has run.
--
-- Immediately after PART 5: with_stored_zone is 0 for every FOREIGN row.
--
-- After a recalculate: it is STILL 0. That is the real test, and it is a test
-- of 4690fc5 rather than of this file. If a zone has come back, the country
-- guard did not fire -- the payload shape is not what destinationCountry()
-- reads, or the country is spelled in a way the check does not catch -- and
-- the fix needs revisiting before these rows are cleared a second time.
--
-- Also watch `billed` fall on the FOREIGN row. Those shipments becoming
-- unpriced is the correction working, not a regression: the price they held
-- was computed from a zone chart that does not describe where they went.
with f as (
  select
    s.*,
    nullif(trim(upper(coalesce(
      s.raw_data -> 'shipTo' ->> 'country',
      s.raw_data ->> 'country'
    ))), '') as country
  from shipments s
)
select
  case
    when f.country is null                            then 'not recorded'
    when f.country in ('US', 'USA')                   then 'domestic'
    when f.country in ('PR', 'VI', 'GU', 'AS', 'MP')  then 'US territory'
    else 'FOREIGN'
  end                                     as kind,
  count(*)                                as shipments,
  count(f.zone)                           as with_stored_zone,
  count(f.client_rate)                    as billed,
  sum(f.client_rate)                      as billed_total
from f
group by 1
order by 1;
