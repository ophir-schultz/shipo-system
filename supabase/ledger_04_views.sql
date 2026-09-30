-- Complete the ledger, migration 4 of 4: the rollup.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.8
-- Requires migrations 1-3. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- pick_days: what was picked, per client per day per SKU.
-- A view, not a table, so it cannot drift from the lines it summarises.
-- ---------------------------------------------------------------------------
create or replace view pick_days as
with usable as (          -- only lines carrying real pick evidence
  select oi.*
  from order_items oi
  where oi.pick_date is not null
    and oi.quantity_picked > 0
),
preferred as (            -- one source per order: Zenventory wins
  -- The trailing `u.source` makes the ordering TOTAL, and that matters more
  -- than it looks. The case expression ranks only Zenventory against
  -- everything else, so two different non-Zenventory sources tie at 1 and
  -- `distinct on` takes whichever row the plan happens to emit first. Because
  -- the outer query joins back on `p.source = u.source`, the arbitrary winner
  -- does not merely pick a label -- it decides which lines are counted, so
  -- `units_picked` and `orders` change with it, and can change between two
  -- runs of the same query on unchanged data. Today `source` only ever holds
  -- 'zenventory' or 'shipstation', so the tie is never exercised; it goes live
  -- the first time a third source is added, and the symptom then is not an
  -- error but pick quantities that quietly drift.
  select distinct on (u.order_id) u.order_id, u.source
  from usable u
  order by u.order_id, case u.source when 'zenventory' then 0 else 1 end, u.source
)
select o.client_id, u.pick_date, u.sku,
  max(u.description)      as description,
  bool_or(u.is_component) as is_component,
  count(distinct o.id)    as orders,
  sum(u.quantity_picked)  as units_picked,
  bool_or(u.is_estimate)  as has_estimates,
  min(case u.pick_date_source        -- 1 = least confident
        when 'pickprintdate' then 3
        when 'watermark'     then 2
        when 'modified_date' then 1
        else 0                       -- null/unknown: trust nothing
      end)                as confidence
from usable    u
join orders    o on o.id = u.order_id
join preferred p on p.order_id = u.order_id and p.source = u.source
where not o.cancelled
group by o.client_id, u.pick_date, u.sku;

-- ---------------------------------------------------------------------------
-- leaks_monthly: the six measured leaks. This is the direct answer to
-- "check where the leaks of money are", and it depends on no cost rate being
-- right. Deliberately NOT netted into pnl_monthly: see the migration header.
--
-- THE ROWS ARE A LIST OF SYMPTOMS, NOT A LIST OF ADDENDS. The same dollar can
-- be symptomatic of two problems and is reported under both: a shipment with a
-- null client_id and a carrier cost satisfies leak 1 (no client) AND leak 3 (a
-- cost with no charge), and its cost is summed into `amount` in each. Leak 5
-- and leak 6 are adjustments that may also already sit inside leak 4's cost
-- figures. So `select sum(amount) from leaks_monthly` -- the single most
-- obvious query to run against a view called "leaks" -- produces a headline
-- "total leaked" that is inflated by an unknown amount. Read one leak at a
-- time; there is no correct total here.
-- ---------------------------------------------------------------------------
create or replace view leaks_monthly as

-- 1. Label spend attributable to no order or no client.
--
--    TIMEZONE, and the asymmetry below is deliberate -- do not "fix" it into
--    consistency. `shipments.ship_date` and `rate_adjustments.adjustment_date`
--    are `timestamptz`, and `date_trunc('month', <timestamptz>)` resolves the
--    instant against the SESSION TimeZone, which is UTC on a Supabase session.
--    A label bought at 21:00 ET on the last day of a month would therefore be
--    reported in the next month, while pnl_monthly -- which groups on
--    `charge_date`, already resolved in ET by Task 14 (`warehouseDate`,
--    WAREHOUSE_TZ = 'America/New_York' in src/lib/ledger/pick-date.ts) --
--    reports it in the correct one. The two views would disagree at every
--    month boundary by an amount small enough to look like rounding. So the
--    four timestamptz truncations in this view (leaks 1, 3, 5, 6) rotate into
--    wall-clock ET first.
--    Leak 2's `pick_date` and leak 4's `charge_date` get NO such treatment:
--    both are plain `date` columns, and `at time zone` on a date is wrong --
--    it would coerce the date to a timestamp at local midnight and shift it.
select date_trunc('month', s.ship_date at time zone 'America/New_York')::date
                                              as period_month,
       null::uuid                             as client_id,
       'unattributed_label_spend'             as leak,
       'Labels with no order number or no client' as detail,
       count(*)                               as records,
       coalesce(sum(s.actual_cost), 0)        as amount
from shipments s
where nullif(trim(s.order_number), '') is null
   or s.client_id is null
group by 1

union all

-- 2. Picked, not cancelled, and no charge was ever raised. This is an ABSENCE:
--    revenue that does not exist, not money that left. `amount` is null
--    because we cannot know what it would have been worth without a rate.
select date_trunc('month', oi.pick_date)::date, o.client_id,
       'picked_never_billed',
       'Orders picked and not cancelled with no pick charge',
       count(distinct o.id),
       null::numeric
from order_items oi
join orders o on o.id = oi.order_id
where oi.pick_date is not null
  and oi.quantity_picked > 0
  and not o.cancelled
  and not exists (
    select 1 from order_charges c
    where c.order_id = o.id and c.charge_type = 'pick')
group by 1, 2

union all

-- 3. Shipments with a cost but no charge: we paid and did not bill.
--
--    `c.charge_type = 'shipping'` is load-bearing. chargeKey() returns the same
--    `shipment:<id>` key for chargeType 'shipping' AND for 'return'
--    (src/lib/ledger/charge-key.ts:40-42), so without the type test a shipment
--    carrying only a RETURN charge satisfies the key match, drops out of this
--    leak, and is treated as billed -- while the detail string above claims we
--    checked for a shipping charge.
--
--    NO DATE FLOOR, deliberately. This leak includes every shipment predating
--    the first charge-calculator run, because those shipments genuinely carry a
--    cost this ledger never billed. On day one that is the whole historical
--    back-catalogue in one row per month. Filter by `period_month` when
--    reading; the truthful set is the unfloored one.
--
--    BLIND SPOT: `shipments.ship_date` is nullable, and
--    `date_trunc('month', null)` is null, so an undated shipment with a cost
--    and no charge lands in a `period_month is null` bucket. `null >= anything`
--    is null, so EVERY date-filtered query -- including the handover query in
--    the brief -- drops it without trace. It can never leave that bucket
--    either: Task 14 skips undated shipments outright
--    (src/lib/ledger/calculate-charges.ts:188), so no charge can ever be keyed
--    for it. Undated shipments need separate triage; query
--    `where period_month is null` to see them.
select date_trunc('month', s.ship_date at time zone 'America/New_York')::date,
       s.client_id,
       'unpriced_shipments',
       'Shipments with a carrier cost and no shipping charge',
       count(*), coalesce(sum(s.actual_cost), 0)
from shipments s
where s.actual_cost is not null
  and not exists (
    select 1 from order_charges c
    where c.charge_key = 'shipment:' || s.shipstation_shipment_id::text
      and c.charge_type = 'shipping')
group by 1, 2

union all

-- 4. Charges where what we billed is below what it cost us.
--    `c.cost is not null` is load-bearing: a null cost is UNKNOWN, and an
--    unknown cost is not evidence of a negative margin. Without this test
--    every un-costed charge would be reported as a leak.
--    `charge_date` is a plain `date` -- no timezone rotation here, see leak 1.
select date_trunc('month', c.charge_date)::date, c.client_id,
       'negative_margin_lines',
       'Charges billed below cost',
       count(*), coalesce(sum(c.cost - c.amount), 0)
from order_charges c
where c.cost is not null and c.cost > c.amount
group by 1, 2

union all

-- 5. Carrier re-bills: the cost went up after the label was bought.
select date_trunc('month', a.adjustment_date at time zone 'America/New_York')::date,
       a.client_id,
       'carrier_rebills',
       'Carrier raised the cost after purchase',
       count(*), coalesce(sum(a.adjustment_amount), 0)
from rate_adjustments a
where a.adjustment_amount > 0
group by 1, 2

union all

-- 6. Voided labels: bought then voided. Refund exposure until piece 2
--    reconciles against the actual statements. A negative adjustment_amount
--    is what a void or refund looks like, and it was structurally
--    unrecordable before Task 10 changed `diff > 0.01` to `abs(diff) > 0.01`.
select date_trunc('month', a.adjustment_date at time zone 'America/New_York')::date,
       a.client_id,
       'voided_labels',
       'Labels purchased then voided or refunded',
       count(*), coalesce(sum(abs(a.adjustment_amount)), 0)
from rate_adjustments a
where a.adjustment_amount < 0
group by 1, 2;

-- ---------------------------------------------------------------------------
-- pnl_client_monthly: revenue and direct cost per client per month.
-- GROSS margin only. Overheads are not allocated across clients.
-- ---------------------------------------------------------------------------
create or replace view pnl_client_monthly as
select date_trunc('month', c.charge_date)::date as period_month,
       c.client_id,
       cl.name                                  as client_name,
       c.charge_type,
       count(*)                                 as charges,
       sum(c.amount)                            as revenue,
       -- The mirror image of cost_unknown_charges, and needed for the same
       -- reason. `order_charges.amount` is nullable BY DESIGN: an at-cost
       -- freight line is billed at whatever the carrier charged, so until the
       -- carrier reports, the REVENUE is unknown too -- not zero
       -- (ledger_03_charges.sql:66-71, calculate-charges.ts:205-215).
       -- `sum()` skips those nulls silently, so revenue reads confidently low
       -- with nothing beside it to say so. An at-cost-heavy client whose
       -- carrier costs lag would show a systematically understated margin
       -- while `cost_unknown_charges: 0` actively asserted nothing was
       -- missing. Task 16 must display this wherever it displays revenue.
       count(*) filter (where c.amount is null) as revenue_unknown_charges,
       -- sum() already skips nulls, so unknown costs do not become zeros.
       sum(c.cost)                              as cost_known,
       count(*) filter (where c.cost is null)   as cost_unknown_charges,
       sum(c.amount) - coalesce(sum(c.cost), 0) as gross_margin,
       bool_or(c.is_estimate)                   as has_estimates
from order_charges c
left join clients cl on cl.id = c.client_id
group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------------
-- pnl_monthly: the business total, with overheads subtracted at the top.
-- ---------------------------------------------------------------------------
create or replace view pnl_monthly as
with revenue as (
  select date_trunc('month', charge_date)::date as period_month,
         sum(amount)                            as revenue,
         sum(cost)                              as direct_cost,
         -- See pnl_client_monthly: a null amount is unknown revenue, not zero.
         count(*) filter (where amount is null) as revenue_unknown_charges,
         count(*) filter (where cost is null)   as cost_unknown_charges,
         bool_or(is_estimate)                   as has_estimates
  from order_charges group by 1
),
overhead as (
  -- `date_trunc` on operating_costs.period_month, not the raw column, and this
  -- is not cosmetic. `ledger_02_cost.sql:44` declares `period_month date not
  -- null` with NO constraint that it is the first of the month, and the unique
  -- index is on (period_month, category, coalesce(vendor,'')) -- so 2026-09-15
  -- and 2026-09-01 are different rows, not a conflict. The revenue side of the
  -- join is always `date_trunc('month', charge_date)::date`, i.e. always the
  -- 1st. September rent entered as 2026-09-15 would therefore (a) never join
  -- to September's revenue, surfacing instead as a PHANTOM row dated
  -- 2026-09-15 with null revenue, and (b) leave the real September row short
  -- that overhead, so its net_profit is either null or OVERSTATED by the
  -- entire mis-dated amount. Nobody files a bug about a number that flatters
  -- them. Truncating here makes the join correct by construction whatever was
  -- typed. Note this migration deliberately does not reach backwards to add a
  -- check constraint to ledger_02_cost.sql, which may already be applied.
  select date_trunc('month', period_month)::date as period_month,
         sum(amount) filter (where allocation = 'overhead')       as overhead,
         sum(amount) filter (where allocation = 'direct_labor')   as direct_labor,
         sum(amount) filter (where allocation = 'direct_storage') as direct_storage,
         -- Which categories were actually entered. See the net_profit comment
         -- below: without these, a permanently null net_profit is
         -- indistinguishable from the system working as intended, and there is
         -- no way to tell a reader WHICH row they still owe us.
         count(*) filter (where allocation = 'overhead')       as overhead_rows,
         count(*) filter (where allocation = 'direct_labor')   as direct_labor_rows,
         count(*) filter (where allocation = 'direct_storage') as direct_storage_rows
  from operating_costs group by 1
)
select coalesce(r.period_month, o.period_month) as period_month,
       r.revenue,
       r.direct_cost,
       r.revenue_unknown_charges,
       r.cost_unknown_charges,
       r.revenue - coalesce(r.direct_cost, 0)   as gross_margin,
       o.overhead, o.direct_labor, o.direct_storage,
       o.overhead_rows, o.direct_labor_rows, o.direct_storage_rows,
       -- Null propagates deliberately, and the precise condition is stricter
       -- than "operating_costs has a row for the month". Each of o.overhead,
       -- o.direct_labor and o.direct_storage is a `sum(...) filter (...)`,
       -- which is NULL -- not 0 -- when no row matches ITS filter, and one NULL
       -- poisons the whole subtraction. So net_profit is a number only in
       -- months where ALL THREE allocation categories have at least one
       -- operating_costs row. A business that never books a separate
       -- direct_storage line -- entirely plausible if storage sits inside the
       -- lease -- gets a permanently blank headline figure.
       --
       -- That null is still the right answer: coalesce-ing a missing category
       -- to 0 would claim a cost we have not recorded was zero, which is the
       -- exact unknown-as-zero error this whole migration exists to prevent.
       -- The fix is not to hide the null, it is to make it legible -- which is
       -- what overhead_rows / direct_labor_rows / direct_storage_rows above are
       -- for. Task 16 should say "net profit unavailable: no direct_storage
       -- cost recorded for September", not render an empty cell.
       r.revenue - coalesce(r.direct_cost, 0)
                 - o.overhead - o.direct_labor - o.direct_storage as net_profit,
       r.has_estimates
from revenue r
full outer join overhead o on o.period_month = r.period_month;

-- ---------------------------------------------------------------------------
-- Lock the four views to the service role.
--
-- Without this block, applying this file PUBLISHES every client's name,
-- monthly label spend, cost and gross margin to anyone who opens devtools on
-- the deployed site. Three facts combine:
--
--   1. `schema.sql:141-145` enables row level security on clients, shipments,
--      rate_adjustments and client_warehouse_rates, and there is not one
--      `create policy` statement anywhere in supabase/. RLS on with zero
--      policies is deny-all, which is why nobody has noticed: those tables are
--      genuinely locked today.
--   2. A view created WITHOUT security_invoker executes with the privileges and
--      RLS context of its OWNER. In the Supabase SQL editor that owner is
--      `postgres`, which owns those tables, and a table owner is exempt from
--      its own RLS unless FORCE ROW LEVEL SECURITY is set -- it is not, here or
--      anywhere. So these four views would read the base tables with RLS
--      switched off and hand the result to whoever asked.
--   3. Supabase's bootstrap runs ALTER DEFAULT PRIVILEGES IN SCHEMA public
--      GRANT ALL ON TABLES TO anon, authenticated, service_role, and that
--      covers views. PostgREST auto-exposes every relation in `public`. The
--      anon key is a NEXT_PUBLIC_ variable (src/lib/supabase.ts:3-6), so Next
--      inlines it into the browser bundle -- it is a public string, not a
--      secret.
--
-- Nothing is lost by locking them down. Every reader of these views is a
-- server-side route holding the service-role key: all dashboard data reads go
-- through `supabaseAdmin` (src/lib/supabase.ts:8-11), never the anon client.
-- If a screen ever comes back empty after this, the fix is to move that read
-- onto the service-role path -- NOT to grant anon back.
--
-- Both halves are needed. security_invoker closes the RLS-protected tables
-- (clients, shipments, rate_adjustments); the revoke is what closes the ledger
-- tables from migrations 1-3 (orders, order_items, order_charges, cost_rates,
-- operating_costs), which have no RLS of their own, so under security_invoker
-- the anon role would read them as itself and still see everything.
--
-- The security_invoker setting is guarded by a `do` block with an exception
-- handler rather than a `current_setting('server_version_num')` test. The
-- option does not exist before Postgres 15, and an unguarded `alter view` on
-- an older server aborts the whole paste -- taking the revoke, the part that
-- actually guarantees closure, with it. The exception-handler form is the
-- idiom this migration set already uses twice for exactly this kind of "the
-- object may not accept this yet" guard (ledger_03_charges.sql:95-100 and
-- :220-225), and unlike a version test it also survives any other reason the
-- setting cannot be applied. Every statement below is idempotent.
-- ---------------------------------------------------------------------------
do $$
begin
  alter view pick_days          set (security_invoker = true);
  alter view leaks_monthly      set (security_invoker = true);
  alter view pnl_client_monthly set (security_invoker = true);
  alter view pnl_monthly        set (security_invoker = true);
exception when others then
  raise notice 'security_invoker could not be set (%); Postgres 15+ is required. '
               'The revoke below still applies and is what closes the exposure.', sqlerrm;
end $$;

revoke all on pick_days          from anon, authenticated;
revoke all on leaks_monthly      from anon, authenticated;
revoke all on pnl_client_monthly from anon, authenticated;
revoke all on pnl_monthly        from anon, authenticated;

grant select on pick_days          to service_role;
grant select on leaks_monthly      to service_role;
grant select on pnl_client_monthly to service_role;
grant select on pnl_monthly        to service_role;
