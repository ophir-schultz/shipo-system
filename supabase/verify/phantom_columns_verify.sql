-- Do the screens and the export read the SAME money out of `bills` and
-- `rate_adjustments`?
--
-- Two selects name columns that supabase/schema.sql does not declare:
--
--   src/app/billing/page.tsx:34   bills             ... manual_total ...
--   src/app/reports/page.tsx:31   rate_adjustments  ... new_cost ...
--
-- while schema.sql declares `manual_charges_total` (111) and `adjusted_cost`
-- (67) -- and those are the names everything else writes and reads:
--
--   calculator.ts:289-299               INSERTS manual_charges_total into bills
--   api/reports/download/route.ts:146   reads   manual_charges_total
--   shipstation.ts:216, :582            write   adjusted_cost
--   api/reports/download/route.ts:123   reads   adjusted_cost
--   AdjustmentsClient.tsx:90, :167      read    adjusted_cost
--
-- The original question was "is the page's name a typo?". That is now settled
-- and the answer is no: the pages render values rather than the refusal that
-- src/lib/db/read.ts:41 produces from a PostgREST 400, so `manual_total` and
-- `new_cost` are real live columns. Meanwhile bill generation inserts
-- `manual_charges_total` and would fail outright if that column were missing.
--
-- So BOTH names exist, and the question became a worse one: nothing in this
-- codebase ever WRITES `manual_total` or `new_cost`. If the screens read a
-- column that only the database ever populates, the screens and the .xlsx can
-- disagree about the same bill, silently, and the arithmetic below says by how
-- much.
--
-- Read-only throughout. No DDL, no writes.


-- 1. Shape, default and provenance of all four columns.
--
-- is_generated / generation_expression is the question that matters most here:
-- a GENERATED column would explain how a value nobody writes still shows up on
-- screen, and would mean the two names are two views of one number rather than
-- two numbers. column_default distinguishes "0 because nobody wrote it" from
-- "0 because that is the real figure".
select
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default,
  is_generated,
  generation_expression
from information_schema.columns
where table_schema = 'public'
  and (
    (table_name = 'bills'            and column_name in ('manual_total', 'manual_charges_total'))
    or (table_name = 'rate_adjustments' and column_name in ('new_cost', 'adjusted_cost'))
  )
order by table_name, column_name;


-- 2. THE DECISIVE ONE for bills. Do the two columns ever hold different money,
--    and do the four components the screen displays add up to the grand total
--    the screen displays?
--
-- calculator.ts accumulates every section into `cents` (line 268), so by
-- construction grand_total = shipping + warehouse + adjustments + manual. The
-- screen shows manual_total in that fourth slot. If manual_total is not the
-- column that was written, the row visibly fails to add up, and the shortfall
-- is exactly the manual charges the client is not being shown.
select
  count(*)                                                     as bills_total,
  count(*) filter (
    where coalesce(manual_total, 0) <> coalesce(manual_charges_total, 0)
  )                                                            as rows_where_the_two_disagree,
  count(*) filter (where manual_total is null)                 as manual_total_null,
  count(*) filter (where manual_charges_total is null)          as manual_charges_total_null,
  coalesce(sum(manual_total), 0)                               as sum_screen_reads,
  coalesce(sum(manual_charges_total), 0)                       as sum_export_reads,
  coalesce(sum(manual_charges_total), 0) - coalesce(sum(manual_total), 0)
                                                               as money_the_screen_omits,
  count(*) filter (
    where round(coalesce(shipping_total, 0) + coalesce(warehouse_total, 0)
              + coalesce(adjustments_total, 0) + coalesce(manual_total, 0), 2)
       <> round(coalesce(grand_total, 0), 2)
  )                                                            as rows_that_do_not_add_up_on_screen
from public.bills;


-- 3. Same question for rate_adjustments.
select
  count(*)                                                     as adjustments_total,
  count(*) filter (
    where coalesce(new_cost, 0) <> coalesce(adjusted_cost, 0)
  )                                                            as rows_where_the_two_disagree,
  count(*) filter (where new_cost is null)                     as new_cost_null,
  count(*) filter (where adjusted_cost is null)                as adjusted_cost_null,
  coalesce(sum(new_cost), 0)                                   as sum_screen_reads,
  coalesce(sum(adjusted_cost), 0)                              as sum_export_reads
from public.rate_adjustments;


-- 4. The worst case made concrete, if 2 or 3 found any disagreement: name the
--    rows. A total is arguable; a list of specific bills is not.
select
  id,
  client_id,
  week_start,
  week_end,
  status,
  manual_total          as screen_shows,
  manual_charges_total  as export_shows,
  grand_total,
  round(coalesce(shipping_total, 0) + coalesce(warehouse_total, 0)
      + coalesce(adjustments_total, 0) + coalesce(manual_total, 0), 2)
                        as screen_components_sum
from public.bills
where coalesce(manual_total, 0) <> coalesce(manual_charges_total, 0)
order by week_start desc
limit 50;


-- 5. Did anything ever actually populate the two unwritten columns, or are they
--    uniformly at their default? A column that is 0 in every row of a non-empty
--    table is a column nobody writes, whatever the schema says it is for.
select 'bills.manual_total'              as col,
       count(*)                          as rows_nonzero_nonnull
  from public.bills            where coalesce(manual_total, 0) <> 0
union all
select 'bills.manual_charges_total',
       count(*) from public.bills            where coalesce(manual_charges_total, 0) <> 0
union all
select 'rate_adjustments.new_cost',
       count(*) from public.rate_adjustments where coalesce(new_cost, 0) <> 0
union all
select 'rate_adjustments.adjusted_cost',
       count(*) from public.rate_adjustments where coalesce(adjusted_cost, 0) <> 0;
