-- RETRACTION: September 2026 direct_labor was understated.
--
-- operating_costs_2026_09_labor.sql wrote one direct_labor row of $1,807.80 on
-- the strength of four Cash App debits on the Sept 2026 BoA statement for
-- SHIPOLLC ...6109, with a note recording that the owner had confirmed it was
-- the complete month.
--
-- THAT CONFIRMATION WAS WRONG. Contractors are also paid by Zelle from a second
-- account, and none of those payments appear on the ...6109 statement -- grep
-- for "zelle" across all 8 pages returns nothing. So $1,807.80 is a FLOOR, not
-- a total, understated by an amount nobody has measured yet.
--
-- The file that wrote it actually said so before it said otherwise: "$1,807.80
-- across two people is roughly $904 each for a month, which is low enough for a
-- 3PL warehouse that the obvious reading is 'some labour is paid from another
-- account and this is only a floor'." That reading was correct. It was set
-- aside on the basis of a confirmation, and the confirmation did not hold.
--
-- WHY A DELETE AND NOT A CORRECTED NOTE. pnl_monthly aggregates `amount`
-- (sum(...) filter (where allocation = 'direct_labor')); it never reads `note`.
-- Fixing the wording would leave the VIEW reporting $1,807.80 as September's
-- labour, which is the false claim. A note cannot retract a number that a view
-- is still summing.
--
-- WHY NOT LEAVE IT, SINCE net_profit IS NULL ANYWAY. Two reasons. direct_labor
-- is itself a published column -- it reads $1,807.80 today, to anyone looking.
-- And net_profit is NULL only because direct_storage is missing; the moment a
-- storage split is decided, net_profit renders and is overstated by the
-- unmeasured Zelle labour. The error is latent, not absent.
--
-- After this runs, September has NO direct_labor row and pnl_monthly reports
-- direct_labor = NULL, i.e. UNKNOWN. That is accurate. An unknown that
-- announces itself gets fixed; an understated total that looks plausible does
-- not.


-- ---------------------------------------------------------------------------
-- PART 1 -- what is there now. Reads only. Run this first.
-- ---------------------------------------------------------------------------
select id, period_month, category, vendor, amount, allocation, note
from operating_costs
where period_month = '2026-09-01'
  and allocation = 'direct_labor'
order by category;

-- Expect exactly one row: category 'contract_labor', amount 1807.80, vendor
-- NULL, note ending "...this is the complete month for September."
--
-- NO ROWS -> the labour insert never landed, or someone has already removed it.
-- Nothing to retract; skip PART 2 and go to PART 3 to confirm the view agrees.
--
-- MORE THAN ONE ROW -> September labour is recorded in several places. Read all
-- of them before deleting anything; PART 2 removes only 'contract_labor' and
-- would leave the others in place.


-- ---------------------------------------------------------------------------
-- PART 2 -- choose ONE of 2A or 2B. Do not run both.
-- ---------------------------------------------------------------------------

-- 2A -- THE DEFAULT. Use this unless you have the Zelle figures in front of
-- you right now. Removes the understated row so direct_labor reads UNKNOWN.
delete from operating_costs
where period_month = '2026-09-01'
  and category = 'contract_labor'
  and allocation = 'direct_labor'
returning id, category, amount, allocation;

-- Expect 1 row returned, amount 1807.80. Nothing is lost that cannot be
-- rebuilt: the four Cash App debits are itemised in
-- operating_costs_2026_09_labor.sql and on the statement itself.
--
-- `allocation = 'direct_labor'` is in the WHERE clause as a guard, not a
-- filter -- it is already implied by the category. If it ever stops matching,
-- something other than this file wrote that row and the delete should miss
-- rather than guess.


-- 2B -- ONLY if the true September total is known. Replaces the amount in
-- place. YOU MUST SUBSTITUTE BOTH PLACEHOLDERS -- this statement is written to
-- FAIL if you paste it unedited, rather than to write a plausible wrong number.
--
--   update operating_costs
--      set amount = <<<TOTAL_INCLUDING_ZELLE>>>,
--          note   = 'Contractor pay, September 2026. Cash App 1807.80 from BoA '
--                || 'SHIPOLLC ...6109 (09/02 451.50 + 447.32, 09/25 429.45 + '
--                || '479.53) PLUS Zelle <<<ZELLE_AMOUNT>>> from <<<ACCOUNT>>>. '
--                || 'Supersedes the 2026-10-05 entry of 1807.80, which was a '
--                || 'floor mistaken for a total.'
--    where period_month = '2026-09-01'
--      and category = 'contract_labor'
--   returning id, amount, note;
--
-- The angle brackets are deliberate: `<<<TOTAL_INCLUDING_ZELLE>>>` is a syntax
-- error, so a careless paste stops instead of committing a guess. Do not
-- replace it with a round number or an estimate -- if the Zelle total is not
-- known to the cent, run 2A and come back.


-- ---------------------------------------------------------------------------
-- PART 3 -- confirm the view agrees. Run after PART 2.
-- ---------------------------------------------------------------------------
select
  period_month,
  revenue,
  direct_cost,
  overhead,
  direct_labor,
  direct_storage,
  overhead_rows,
  direct_labor_rows,
  direct_storage_rows,
  net_profit,
  case
    when net_profit is not null then 'net_profit is a number'
    when direct_labor is null and direct_storage is null
      then 'net_profit NULL: no direct_labor and no direct_storage row for this month'
    when direct_labor is null
      then 'net_profit NULL: no direct_labor row for this month'
    when direct_storage is null
      then 'net_profit NULL: no direct_storage row for this month'
    when revenue is null
      then 'net_profit NULL: no order_charges revenue for this month'
    else 'net_profit NULL: see the null column above'
  end as why
from pnl_monthly
where period_month = '2026-09-01';

-- AFTER 2A, EXPECT: direct_labor = NULL, direct_labor_rows = 0, and `why` back
-- to 'net_profit NULL: no direct_labor and no direct_storage row for this
-- month'. The `why` string widening from one missing category to two is the
-- derived proof that the delete took effect -- it is computed from the view,
-- not reported by the delete.
--
-- overhead should be UNCHANGED at 12892.58 with overhead_rows = 4. This
-- retraction touches direct_labor only; rent, software, telecom and bank fees
-- are all still measured and still correct.
--
-- AFTER 2B, EXPECT: direct_labor = your substituted total, direct_labor_rows
-- = 1, and `why` = 'net_profit NULL: no direct_storage row for this month'.
--
-- WHAT IS NEEDED TO CLOSE THIS PROPERLY: the September statement for the
-- account the Zelle payments leave from. Note that ...6109 names CHK 7029 as
-- the source of its three incoming transfers (1,400.00 + 400.00 + 1,400.00),
-- and 7029 is the only other account it references anywhere -- so if the Zelle
-- account is 8029, that is a THIRD account and the cost base is wider than two
-- statements. Worth settling which, because it changes how much of the business
-- is still unobserved.
