-- Verifies ledger_03b_rate_adjustments_cleanup.sql. Run AFTER applying it. Rolls itself back.
begin;

-- 1. Every rate_adjustments row whose order_number maps to exactly one shipment
--    must now have a non-null shipment_id. Any rows that still have
--    shipment_id = null and only one matching shipment means the backfill
--    missed something.
do $$
declare n int;
begin
  select count(*) into n
  from   rate_adjustments ra
  where  ra.shipment_id is null
    and  (
           select count(*)
           from   shipments s
           where  s.order_number = ra.order_number
         ) = 1;
  if n > 0 then
    raise exception 'FAIL: % rate_adjustments row(s) still have shipment_id = null '
                    'but their order_number resolves to exactly one shipment', n;
  end if;
  raise notice 'PASS: all unambiguously-derivable shipment_ids have been backfilled (0 remaining)';
end $$;

-- 2. The new dedup key must be clean: no (shipment_id, adjustment_amount) pair
--    appears more than once among rows where shipment_id is non-null.
--    A duplicate here means a pre-existing row and a newly inserted row both
--    landed for the same shipment change — the symptom the backfill prevents.
do $$
declare n int;
begin
  select count(*) into n
  from (
    select shipment_id, adjustment_amount, count(*) as cnt
    from   rate_adjustments
    where  shipment_id is not null
    group  by shipment_id, adjustment_amount
    having count(*) > 1
  ) dups;
  if n > 0 then
    raise exception 'FAIL: % duplicate (shipment_id, adjustment_amount) pair(s) found '
                    'in rate_adjustments — the backfill did not eliminate all dupes', n;
  end if;
  raise notice 'PASS: no duplicate (shipment_id, adjustment_amount) pairs among backfilled rows';
end $$;

-- Informational: how many rows remain un-backfilled, and why.
select
  count(*) filter (where shipment_id is null)              as still_null,
  count(*) filter (where shipment_id is null
                     and (select count(*) from shipments s
                          where s.order_number = ra.order_number) > 1)
                                                           as ambiguous_multi_shipment,
  count(*) filter (where shipment_id is null
                     and (select count(*) from shipments s
                          where s.order_number = ra.order_number) = 0)
                                                           as orphaned_no_shipment
from rate_adjustments ra;

rollback;
