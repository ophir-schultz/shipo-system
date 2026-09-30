-- Complete the ledger, migration 4 of 4: the rollup.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §5.8
-- Requires migrations 1-3. Safe to run more than once.

-- ---------------------------------------------------------------------------
-- Drop first. This is what makes "safe to run more than once" true, and it is
-- not defensive habit -- this file has already broken that promise once.
--
-- `create or replace view` may only APPEND columns. Renaming, reordering or
-- removing an existing output column raises 42P16 ("cannot change name of view
-- column"), and Postgres compares by ORDINAL, so inserting a column mid-list
-- renames every column after it as far as that check is concerned. This
-- migration did exactly that: `revenue_unknown_charges` went in between
-- `revenue` and `cost_known` in pnl_client_monthly, and `revenue_unknown_charges`
-- plus the three `*_rows` counts went into the middle of pnl_monthly. Against a
-- database already carrying the first version of this file, a re-paste got
-- through pick_days and leaks_monthly and then died at pnl_client_monthly --
-- leaving both P&L views on their old, buggy definitions while the operator saw
-- an error easy to wave off as "already applied".
--
-- DELIBERATE SIDE EFFECT, and the two blocks must stay together in this file
-- forever: dropping a view discards its ACLs, so every recreated view comes back
-- at the schema defaults -- which on Supabase means granted to anon (see the
-- long comment above the revoke/grant block at the bottom). That block is
-- therefore not merely idempotent, it is REQUIRED on every single run. Never
-- move it to a separate file, never make it conditional, and never add a view
-- here without adding it there.
--
-- No `cascade`, on purpose. Nothing in supabase/ or src/ selects from these five
-- today (verified: the only references are this file, the verify script, and
-- comments), so a plain drop is sufficient. Should something come to depend on
-- one of them later, a plain drop fails loudly and the next reader gets to
-- decide; `cascade` would silently delete their object instead.
--
-- PASTE CONTRACT. Run this file as ONE batch — paste it whole into the Supabase
-- SQL editor and execute in a single submission. The editor wraps a whole paste
-- in one implicit transaction, so a failure anywhere rolls the drops back and
-- leaves the old views intact rather than none. If you must run it in pieces
-- (e.g. to debug a single statement), run it to the end: between a `create` and
-- the `revoke` block at the bottom, the newly recreated view is readable by the
-- `anon` role at the Supabase schema default. The revoke is not a tidying step —
-- it is the other half of the create.
-- ---------------------------------------------------------------------------
drop view if exists public.pnl_monthly;
drop view if exists public.pnl_client_monthly;
drop view if exists public.leaks_monthly;
drop view if exists public.pick_days;
drop view if exists public.labour_variance_inputs;

-- ---------------------------------------------------------------------------
-- pick_days: what was picked, per client per day per SKU.
-- A view, not a table, so it cannot drift from the lines it summarises.
-- ---------------------------------------------------------------------------
create or replace view public.pick_days as
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
-- `is not true`, NOT `not o.cancelled`. orders.cancelled is
-- `boolean default false` and NULLABLE (ledger_01_orders.sql:29), so any row
-- written before the column was populated carries null -- and `not null` is
-- null, which a WHERE clause drops. The calculator reads the same column the
-- opposite way deliberately: load-charge-inputs.ts:402 does
-- `cancelled: o.cancelled === true`, i.e. null means "not cancelled".
-- `is not true` is that same rule expressed in SQL, so the two stay in step.
where o.cancelled is not true
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
create or replace view public.leaks_monthly as

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
       -- `amount` is the KNOWN spend, not the spend. `shipments.actual_cost` is
       -- nullable, sum() skips those, and the coalesce turns an all-null group
       -- into 0 -- so a month of unattributed labels whose carrier costs have
       -- not been reported yet renders as "$0 leaked" when the true figure is
       -- simply not in yet. `records` beside it is the honest count and does not
       -- move, so read the two together: records high with amount low or zero
       -- means unreported carrier cost, not an absence of leakage.
       --
       -- The coalesce stays. Every branch of the union all must agree on column
       -- types, and a null here would be indistinguishable from leak 2's null
       -- `amount`, which deliberately means "this leak has no dollar figure by
       -- construction". Leak 3's identical coalesce is a genuine no-op, guarded
       -- by its own `actual_cost is not null` predicate.
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
  -- `is not true`, NOT `not o.cancelled`. orders.cancelled is nullable
  -- (ledger_01_orders.sql:29) and `not null` is null, so the plain form drops
  -- null-cancelled rows -- and this is a LEAK DETECTOR, so dropping them blinds
  -- it in the silent direction: the calculator bills those orders
  -- (load-charge-inputs.ts:402 treats null as not-cancelled) while this branch
  -- refuses to see them, so unbilled picks go unreported. `is not true` is the
  -- calculator's rule, in SQL.
  and o.cancelled is not true
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
create or replace view public.pnl_client_monthly as
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
       -- THIS COLUMN ONLY: sum() skips nulls, so an unknown cost does not
       -- become a zero here -- which is why it is named cost_known and not
       -- cost. The guarantee stops at this line; gross_margin below does NOT
       -- have it.
       sum(c.cost)                              as cost_known,
       count(*) filter (where c.cost is null)   as cost_unknown_charges,
       -- READ THE coalesce. It treats every unpriced charge as FREE, so this is
       -- the margin over the priced subset only, and it reads HIGH by whatever
       -- the unknown costs turn out to be -- by the full billed amount of those
       -- charges in the worst case, and by everything when no cost in the group
       -- is known at all (the coalesce then returns 0 and the figure equals
       -- revenue). It is not "gross margin"; it is "gross margin so far".
       --
       -- That is a deliberate ruling, not an oversight. Null-propagating this
       -- the way net_profit does would blank the column in essentially every
       -- real month -- one unpriced charge anywhere in a client-month is enough
       -- -- which destroys the view's purpose. The caveat is carried by
       -- cost_unknown_charges sitting immediately beside it instead.
       --
       -- SO: Task 16 must never render gross_margin without
       -- cost_unknown_charges beside it. Alone, this number is an
       -- overstatement presented as a fact.
       sum(c.amount) - coalesce(sum(c.cost), 0) as gross_margin,
       bool_or(c.is_estimate)                   as has_estimates
from order_charges c
left join clients cl on cl.id = c.client_id
group by 1, 2, 3, 4;

-- ---------------------------------------------------------------------------
-- pnl_monthly: the business total, with overheads subtracted at the top.
-- ---------------------------------------------------------------------------
create or replace view public.pnl_monthly as
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
         -- NULL and 0 differ, and the difference is the useful part. These read
         -- 0 only when the month HAS operating_costs rows and none of them
         -- carry this allocation -- "we have September's book and there is no
         -- direct_storage line in it". They read NULL when the month has no
         -- operating_costs rows at all, because the full outer join below has
         -- no right-hand row to count -- "September's costs have not been
         -- entered". Neither can be misread as "checked and zero dollars":
         -- net_profit is null in both cases.
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
       -- Same coalesce, same caveat as pnl_client_monthly.gross_margin: an
       -- unpriced charge is treated as FREE, so this is the margin over the
       -- priced subset and it reads HIGH by however much the unknown costs turn
       -- out to be -- equal to revenue outright in a month where no cost is
       -- known. Deliberate: the alternative is a permanently blank column,
       -- since one unpriced charge anywhere in the business-month would null it.
       -- cost_unknown_charges above carries the caveat, and Task 16 must never
       -- render gross_margin without it -- alone this is an overstatement
       -- presented as a fact. Contrast net_profit below, which DOES propagate
       -- null, because there the missing input is a whole category of cost
       -- rather than a countable handful of charges.
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
-- labour_variance_inputs: the measured numbers §5.3.2 needs, and nothing
-- derived from them. The subtraction lives in src/lib/ledger/variance.ts so
-- there is exactly one implementation of it -- computing
-- `payroll - units * standard_rate` here as well would give two, one tested and
-- one not, and the first time either changed they would disagree in silence.
--
-- standard_rate is read from cost_rates as it stood ON the month being
-- reported, not as it stands today. Using today's rate would silently rewrite
-- every past month's variance the moment anyone re-baselines -- which is the
-- circularity §5.3.2 exists to prevent, arriving by a different route.
--
-- THE RATE IS PER-VARIANT AND THIS VIEW MUST NOT BLEND IT BY ACCIDENT.
-- ledger_06_seed_cost_rates.sql seeds ('pick','device') at 0.2300 and
-- ('pick','component') at 0.2000, both with effective_from = '2026-01-01'.
-- Filtering on cost_type = 'pick' alone and taking `order by effective_from
-- desc limit 1` is therefore a coin toss the planner may call differently
-- between two runs of the same query on unchanged data, and it would be applied
-- to a units total that mixes both variants -- absorbed cost wrong by up to 13%
-- in an unpredictable direction. So the view aggregates per (period_month,
-- variant) internally and exposes a UNITS-WEIGHTED rate per month:
--
--     standard_rate = sum(units_v * rate_v) / sum(units_v)
--
-- which is algebraically exact: multiplying it by total units in TypeScript
-- reproduces sum(units_v * rate_v). (Numeric division can be non-terminating --
-- 1.00 over 3 units -- so the reconstruction can differ in the far tail of the
-- fraction. That is a rounding artefact of order 1e-15 dollars, not a blend.)
-- variant_breakdown beside it carries the per-variant detail, because §5.3.2
-- asks for the components to be shown "so the cause is visible rather than
-- inferred from one number".
--
-- HOW THE VARIANT IS RECOVERED: order_charges.rate_id -> client_warehouse_rates
-- .variant. rate_id is never null on a charge the calculator wrote, because
-- calculate-charges.ts:122-123 does `if (!rate || rate.rate === null) continue`
-- -- the charge exists only because the rate card line did. The two rejected
-- alternatives: cost_rate_id is null whenever the COST lookup failed
-- (calculate-charges.ts:142), which is precisely the months this view has to
-- keep reporting; and `label` is a display string ('Pick — device') containing
-- an em-dash, which is fragile to match on.
-- ---------------------------------------------------------------------------
create or replace view public.labour_variance_inputs as
with pick_charges as (
  -- One row per pick charge, carrying the variant its rate-card line names.
  -- LEFT join, not inner: a pick charge whose rate_id is null (or dangling)
  -- must be COUNTED, never dropped. Dropping it would shrink units_picked and
  -- report a fictitious unfavourable variance; it arrives here with a null
  -- variant instead, and a null variant nulls the month's standard rate below.
  select date_trunc('month', c.charge_date)::date as period_month,
         w.variant                                as variant,
         c.quantity                               as quantity
  from order_charges c
  left join client_warehouse_rates w on w.id = c.rate_id
  where c.charge_type = 'pick'
),
per_variant as (
  -- `sum(quantity)` skips null quantities. No writer in this codebase produces
  -- one (calculate-charges.ts:115 skips null and zero outright), and the error
  -- direction if one ever appears is the safe one: units read LOW, so absorbed
  -- reads LOW and the variance reads UNFAVOURABLE. It does not flatter.
  select period_month, variant,
         sum(quantity) as units,
         count(*)      as charges
  from pick_charges
  group by 1, 2
),
priced as (
  -- The held cost rate for THIS variant, as it stood on the 1st of this month.
  -- `cr.variant = v.variant` is an exact match, mirroring findCostRate
  -- (cost-rate.ts:42). A null v.variant therefore matches nothing -- NULL =
  -- NULL is NULL -- which is what makes an unattributable pick charge null the
  -- month's rate rather than quietly borrowing the null-variant cost row.
  --
  -- The `order by ... limit 1` is belt and braces: cost_rates_no_overlap
  -- (ledger_02_cost.sql:30-38) already guarantees at most one row per
  -- (cost_type, variant) covers any given day, so unlike the cross-variant form
  -- this tie-break is never actually exercised and the result is deterministic.
  select v.period_month, v.variant, v.units, v.charges, cr.rate, cr.basis
  from per_variant v
  left join lateral (
    select cr.rate, cr.basis
    from cost_rates cr
    where cr.cost_type = 'pick'
      and cr.variant = v.variant
      and cr.effective_from <= v.period_month
      and (cr.effective_to is null or v.period_month < cr.effective_to)
    order by cr.effective_from desc
    limit 1
  ) cr on true
),
picked as (
  select period_month,
         sum(units)                                  as units_picked,
         sum(charges) filter (where variant is null) as unattributable_pick_charges,
         -- ALL-OR-NOTHING, and this is the point of the column. If device has a
         -- rate in effect and component does not, a weighted average over only
         -- the covered subset understates absorbed and reports a leak that is
         -- not there -- sending someone to hunt an overspend that never
         -- happened. One uncovered variant nulls the whole month's rate.
         bool_or(rate is null)                       as any_rate_missing,
         sum(units * rate)                           as standard_cost,
         -- The WEAKEST basis among the contributing rates. Every pick rate is
         -- 'estimated' today (ledger_06_seed_cost_rates.sql), and that file's
         -- header forbids presenting a placeholder as measured -- so the screen
         -- needs this column to caveat the figure. It cannot use
         -- VarianceResult.basis for the purpose: variance.ts:39 returns
         -- 'measured' whenever both inputs are present, because it has no way
         -- to know the rate it was handed is a placeholder.
         -- cost_rates_basis_valid (ledger_02_cost.sql:55) limits the domain to
         -- these three, so the chain is total.
         case when bool_or(basis = 'estimated') then 'estimated'
              when bool_or(basis = 'derived')   then 'derived'
              when bool_or(basis = 'measured')  then 'measured'
         end                                         as standard_rate_basis,
         jsonb_agg(jsonb_build_object(
                     'variant',       variant,
                     'units',         units,
                     'standard_rate', rate,
                     'basis',         basis)
                   order by variant nulls last)      as variant_breakdown
  from priced
  group by 1
),
payroll as (
  -- date_trunc, NOT the raw column. ledger_02_cost.sql:81 declares
  -- `period_month date not null` with no first-of-month constraint, and the
  -- unique index is on (period_month, category, coalesce(vendor,'')) -- so
  -- September payroll entered as 2026-09-15 is a perfectly legal row. Grouped
  -- raw it would become a phantom month that joins to nothing, and September
  -- would read "payroll not entered" while the payroll sat in the table. Same
  -- reasoning, at length, at the `overhead` CTE in pnl_monthly above.
  select date_trunc('month', period_month)::date as period_month,
         sum(amount)                             as direct_labor
  from operating_costs
  where allocation = 'direct_labor'
  group by 1
),
months as (
  -- UNION, not "pick months left-joined to payroll". A month with payroll and
  -- no picks -- a shutdown month, or simply any month where payroll is entered
  -- before the charge calculator has run -- is 100%-unabsorbed labour, the
  -- largest unfavourable variance there is. Drawn from the pick side alone it
  -- would produce no row at all and be invisible.
  select period_month from picked
  union
  select period_month from payroll
)
select m.period_month,
       -- 0, not null: `picked` has no row for this month because order_charges
       -- holds no pick charge in it, which is a measured zero, not an unknown.
       coalesce(p.units_picked, 0)                as units_picked,
       coalesce(p.unattributable_pick_charges, 0) as unattributable_pick_charges,
       -- null, not 0: payroll for a month nobody has entered is UNKNOWN, and a
       -- 0 here would report the entire standard cost as a favourable variance
       -- -- a large fictitious saving. Nobody files a bug about a number that
       -- flatters them.
       r.direct_labor,
       case when coalesce(p.any_rate_missing, false) then null
            when p.units_picked > 0 then p.standard_cost / p.units_picked
       end                                        as standard_rate,
       case when coalesce(p.any_rate_missing, false) then null
            else p.standard_rate_basis
       end                                        as standard_rate_basis,
       case when p.units_picked > 0 and r.direct_labor is not null
            then r.direct_labor / p.units_picked
       end                                        as implied_actual_rate,
       p.variant_breakdown
from months m
left join picked  p on p.period_month = m.period_month
left join payroll r on r.period_month = m.period_month
order by m.period_month desc;

-- ---------------------------------------------------------------------------
-- Lock the five views to the service role.
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
--      anywhere. So these five views would read the base tables with RLS
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
-- (clients, shipments, rate_adjustments, client_warehouse_rates); the revoke
-- is what closes the ledger
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
--
-- AND IT IS NOT OPTIONAL ON A RE-RUN. The drop block at the top of this file
-- destroys these views' ACLs along with the views, so each run recreates them
-- at the Supabase schema defaults -- i.e. granted to anon. This block is what
-- takes them back. It must stay in this file, below those creates, and it must
-- stay unconditional.
-- ---------------------------------------------------------------------------
-- THE REVOKE RUNS FIRST, AHEAD OF EVERY GUARD BELOW. The guards now `raise
-- exception` rather than `raise notice` (a guard that cannot fail the paste is
-- not a guard -- a failed alter or a failed revoke used to finish as a green
-- paste), and an exception ends the paste at that statement. Sequenced the old
-- way, the one statement that actually closes the exposure sat BELOW two blocks
-- that can now abort, so a loud guard could leave the views created and still
-- granted to anon -- trading a silent hole for a louder one. Revoking first
-- costs nothing: it depends on nothing above it, and the verifications that
-- follow read the result rather than the statement.
revoke all on public.pick_days              from anon, authenticated;
revoke all on public.leaks_monthly          from anon, authenticated;
revoke all on public.pnl_client_monthly     from anon, authenticated;
revoke all on public.pnl_monthly            from anon, authenticated;
revoke all on public.labour_variance_inputs from anon, authenticated;

grant select on public.pick_days              to service_role;
grant select on public.leaks_monthly          to service_role;
grant select on public.pnl_client_monthly     to service_role;
grant select on public.pnl_monthly            to service_role;
grant select on public.labour_variance_inputs to service_role;

-- The handler reports WHAT failed, not why. `when others` catches a mistyped
-- view name (42P01) and an ownership failure (42501) just as readily as an
-- unrecognized parameter, and the previous wording announced "Postgres 15+ is
-- required" for all of them -- on a Postgres 17 server, that is a notice nobody
-- investigates. The SQLSTATE is printed so the actual cause is one lookup away,
-- and the version explanation is offered as the likely case rather than
-- asserted. The block is not narrowed to specific SQLSTATEs because the code
-- Postgres raises for an unrecognized relation option is not something to guess
-- at; the verification block below closes that gap from the other end instead.
do $$
begin
  alter view public.pick_days              set (security_invoker = true);
  alter view public.leaks_monthly          set (security_invoker = true);
  alter view public.pnl_client_monthly     set (security_invoker = true);
  alter view public.pnl_monthly            set (security_invoker = true);
  alter view public.labour_variance_inputs set (security_invoker = true);
  raise notice 'security_invoker set on all five views.';
exception when others then
  -- The version test lives INSIDE the handler, which is the distinction the
  -- comment above is about. An unguarded `alter view` on a pre-15 server aborts
  -- the paste, so the handler has to exist; but once we are in the handler the
  -- `alter` has already been rolled back to the block's savepoint and asking
  -- the server its version is free. Pre-15 is the one cause that is a fact
  -- about the server rather than a mistake in this file, so it stays a notice
  -- and degrades gracefully -- the revoke above has already closed the
  -- exposure, which is the whole reason that degradation was acceptable.
  --
  -- Every OTHER cause -- a mistyped view name (42P01), an ownership failure
  -- (42501), a create that silently did not happen -- is a broken paste, and a
  -- broken paste must not finish green. Those now stop the file.
  if current_setting('server_version_num')::int < 150000 then
    raise notice 'security_invoker could NOT be set. SQLSTATE %: %. '
                 'Most likely this server predates Postgres 15, which is where the '
                 'option was introduced -- but check the SQLSTATE before assuming '
                 'that. The revoke above has already applied and is what closes the '
                 'exposure. See the verification notice that follows.',
                 sqlstate, sqlerrm;
  else
    raise exception 'security_invoker could NOT be set. SQLSTATE %: %. '
                 'Most likely this server predates Postgres 15, which is where the '
                 'option was introduced -- but check the SQLSTATE before assuming '
                 'that. The revoke above has already applied and is what closes the '
                 'exposure. See the verification notice that follows.',
                 sqlstate, sqlerrm;
  end if;
end $$;

-- Second guard: confirm the setting actually TOOK. Without this, the only
-- evidence that a view runs as its invoker is that an `alter` did not throw --
-- and the handler above still swallows the one case it must (a pre-Postgres-15
-- server, where the option does not exist), so a silent failure there would
-- otherwise be indistinguishable from success. This reads the stored
-- reloptions back and names the views that are missing the setting, whatever
-- SQLSTATE the server chose. A view absent from pg_class entirely is also
-- reported, since the left join leaves it with no options at all.
--
-- NOTE: `c.relnamespace = 'public'::regnamespace` hard-codes the `public`
-- schema. The DDL above uses the same schema (`public.pick_days` etc.), so the
-- two agree. If the views were ever moved to a different schema the check would
-- report all five missing while the `alter`s had in fact succeeded -- a false
-- alarm. Keep the DDL and this check in the same schema.
--
-- THE LOOKUP IS WRAPPED IN ITS OWN INNER BLOCK, and that nesting is load-bearing
-- now that the verdict below is a `raise exception`. `exception when others`
-- catches ANY exception raised inside its block -- including one this block
-- raises on purpose -- so with a single flat block the new hard failure would be
-- caught by its own handler and demoted straight back to the notice this fix
-- exists to remove. The inner block covers only the catalog read; the verdict
-- sits outside it, where nothing can swallow it.
do $$
declare
  missing    text;
  readable   boolean := true;
begin
  begin
    select string_agg(v.name || ' (reloptions=' ||
                      coalesce(c.reloptions::text, 'NULL') || ')',
                      ', ' order by v.name) into missing
    from unnest(array['pick_days', 'leaks_monthly',
                      'pnl_client_monthly', 'pnl_monthly',
                      'labour_variance_inputs']) as v(name)
    left join pg_class c on c.relname = v.name
                        and c.relnamespace = 'public'::regnamespace
    where coalesce((select o.option_value::boolean
                      from pg_options_to_table(c.reloptions) o
                     where o.option_name = 'security_invoker'), false) is not true;
  exception when others then
    readable := false;
    raise notice 'Could not verify security_invoker (SQLSTATE %: %). Treat the '
                 'setting as UNCONFIRMED and do not grant these views to anon or '
                 'authenticated.', sqlstate, sqlerrm;
  end;

  if not readable then
    null;  -- already reported; the revoke above is what closes the exposure
  elsif missing is not null then
    raise exception 'WARNING: security_invoker is NOT set on: %. These views still '
                 'run with their OWNER''s privileges, which on Supabase means '
                 'they read the RLS-protected base tables (clients, shipments, '
                 'rate_adjustments, client_warehouse_rates) with row level '
                 'security bypassed. The revoke '
                 'above keeps them closed to anon and authenticated, so nothing '
                 'is exposed TODAY -- but they are not RLS-safe, and granting '
                 'select on them back to any role would publish every client''s '
                 'data to that role. Do not grant them back on this server. '
                 '(reloptions=NULL means the option is absent; reloptions showing '
                 'security_invoker=false means it was explicitly disabled; a view '
                 'not appearing in pg_class at all means the create failed.)',
                 missing;
  else
    raise notice 'Verified: security_invoker is set on all five views.';
  end if;
end $$;

-- Third guard: confirm the revoke actually closed the exposure. `security_invoker`
-- is the RLS guard; `revoke` is the guard that closes the ledger tables that have
-- no RLS of their own (orders, order_items, order_charges, cost_rates,
-- operating_costs). The `alter view` failure is still swallowed on a pre-15
-- server, which is why it needs a read-back; the `revoke` above is unconditional and aborts the paste on
-- failure, so a silent miss is less likely -- but `alter default privileges` or a
-- `grant` elsewhere can re-open a view without touching this file. This block
-- checks the result rather than the statement. Guarded the same way as the
-- `reloptions` block: if the `anon` role does not exist (non-Supabase server) the
-- function raises and we fall through to a notice rather than aborting the paste.
--
-- Same inner-block nesting as the reloptions guard, for the same reason: the
-- verdict is now a `raise exception`, and a flat `exception when others` would
-- catch that deliberate exception and demote it back to a notice. Only the
-- `has_table_privilege` call -- the part that legitimately throws when the
-- `anon` role does not exist -- sits inside the handler's reach.
do $$
declare
  still_open text;
  readable   boolean := true;
begin
  begin
    select string_agg(v.name, ', ' order by v.name) into still_open
    from unnest(array['public.pick_days', 'public.leaks_monthly',
                      'public.pnl_client_monthly', 'public.pnl_monthly',
                      'public.labour_variance_inputs']) as v(name)
    where has_table_privilege('anon', v.name, 'SELECT');
  exception when others then
    readable := false;
    raise notice 'Could not verify anon privilege (SQLSTATE %: %). The `anon` '
                 'role may not exist on this server. Confirm manually that anon '
                 'cannot select from the five views before treating the file as '
                 'applied.', sqlstate, sqlerrm;
  end;

  if not readable then
    null;  -- already reported above
  elsif still_open is not null then
    raise exception 'WARNING: anon can still SELECT from: %. The revoke did not '
                 'close the exposure. Check whether `alter default privileges` '
                 'or an explicit grant elsewhere re-opened these views. Until '
                 'this is resolved every client''s margin is readable via the '
                 'public anon key.',
                 still_open;
  else
    raise notice 'Verified: anon cannot SELECT from any of the five views.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- OPERATOR CHECK for labour_variance_inputs. Run this after the paste and read
-- the result; it cannot be run from the test suite, which has no database.
--
-- 1. `direct_labor` MUST be null on every row until operating_costs carries a
--    direct_labor line. If it comes back 0.00, something is substituting zero
--    for unknown, and the screen will report the entire standard cost as a
--    favourable variance -- a large fictitious saving. Find it before shipping.
-- 2. `standard_rate` is the units-weighted blend of the per-variant rates. Sanity
--    check it against variant_breakdown: it must fall between the smallest and
--    largest rate in that array, and equal one of them when only one variant was
--    picked. A rate outside that interval means the weighting is wrong.
-- 3. `standard_rate_basis` reads 'estimated' while ledger_06_seed_cost_rates.sql
--    is the only source of pick rates. Anything else means someone re-baselined;
--    confirm that was intended before the screen drops the estimate caveat.
-- 4. `unattributable_pick_charges` MUST be 0. A non-zero count is pick charges
--    whose rate_id does not resolve to a rate-card variant; the view correctly
--    nulls that month's standard_rate rather than guessing, but the charges
--    themselves need repairing at the source.
-- 5. A month appearing with units_picked = 0 and a direct_labor figure is real
--    and important: payroll was paid and nothing was picked, so none of it was
--    absorbed. It is not a bug in this query.
--
-- Left COMMENTED OUT deliberately. The Supabase SQL editor shows the result of
-- the last statement in a paste, so a live select here would replace the
-- security notices raised by the three verification blocks above with a result
-- grid -- burying the one output of this file nobody may skip. Run it as its own
-- submission after the paste.
-- ---------------------------------------------------------------------------
-- select period_month, units_picked, unattributable_pick_charges, direct_labor,
--        standard_rate, standard_rate_basis, implied_actual_rate,
--        variant_breakdown
-- from labour_variance_inputs
-- order by period_month desc;
