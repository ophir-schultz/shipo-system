-- ===========================================================================
-- partner_order_units -- per-order ACTIVITY for the partner statement
--
-- Spec: docs/superpowers/specs/2026-10-20-partner-dashboard-v2-design.md §4.1
--
-- WHAT IS DELIBERATELY ABSENT: money. No amount, no rate, no cost, no price,
-- in any form, under any name. Not a billed total, not a per-line figure, not
-- a quantity paired with a value that a division would turn back into a rate.
--
-- This view exists because the shipped partner statement read
-- partner_order_transactions, which carries amount_billed per order -- and
-- `amount / quantity` on a single order IS the rate card. Several referral
-- partners are agencies who also resell fulfilment, so that screen handed a
-- competitor our pricing one order at a time. The fix is not to stop RENDERING
-- the figure. The fix is that the figure is not in the view the partner path
-- reads, so no future component can leak a column that does not exist here.
--
-- partner_order_transactions is NOT dropped by this file. /pnl and staff
-- screens may use it, and tearing down a view to change a partner screen is
-- blast radius for nothing. It simply stops being read by the partner
-- statement, which is enforced in src/lib/partner-activity.test.ts.
--
-- Month-level money is unaffected. It lives in partner_client_monthly and the
-- statement still shows it. What goes away is money PER ORDER.
--
-- HOW UNITS ARE COUNTED, and the three things that make it not obvious:
--
-- 1. quantity_picked FIRST, quantity_ordered as the fallback, and
--    units_estimated says which happened. An order picked yesterday and an
--    order placed this morning both have a real unit count -- one is what left
--    the building, the other is what was asked for -- and reporting the second
--    as zero would tell a partner his client went quiet in the exact week they
--    got busy. The flag is what keeps the two honest.
--
-- 2. `sum` SKIPS NULLS. A line with neither a picked nor an ordered quantity
--    contributes nothing instead of making the order's total null, so this
--    column READS LOW on an order with one unquantified line. units is null
--    only when every line is unquantified. The app layer counts those orders
--    separately (ActivityClientMonth.unitsUnknownOrders) and the renderer must
--    never print a month total without it.
--
-- 3. ONE SOURCE PER ORDER. order_items is keyed (order_id, source,
--    line_ordinal) -- one order can legitimately hold lines written by two
--    different integrations, and summing across both double-counts every unit.
--    Only sync/zenventory.ts writes the table today, so this is latent rather
--    than live, but ledger_04_views.sql:54-80 already carries the same
--    `preferred` CTE for pick_days for exactly this reason, and a view that
--    disagreed with pick_days about which source counts would report a
--    different volume than the ops screens. Zenventory wins, same as there.
--
--    pick_days' own CTE cannot be reused: it filters to
--    `pick_date is not null and quantity_picked > 0`, which throws away every
--    unpicked order -- and the unpicked orders are precisely the ones this view
--    has to report via the ordered-quantity fallback.
--
-- is_component is NOT filtered. It is a billing-RATE class from classifySku(),
-- not a kit hierarchy: order lines are flat -- whatever the integration listed
-- -- so summing every line does not double-count a kit's components. Filtering
-- on it would silently drop real units.
-- ===========================================================================

-- Drop first, do not `create or replace`. A replace may only APPEND columns and
-- Postgres compares the select list by ordinal, so inserting a column in the
-- middle raises 42P16 against any database that already holds an earlier
-- definition. The drop takes the view's ACLs with it, which is why the
-- revoke/grant block below is unconditional rather than guarded.
drop view if exists public.partner_order_units;

create view public.partner_order_units as
with preferred as (
  -- One source per order. See note 3 in the header.
  select distinct on (oi.order_id) oi.order_id, oi.source
  from order_items oi
  order by oi.order_id,
           case oi.source when 'zenventory' then 0 else 1 end,
           oi.source
)
select date_trunc('month', coalesce(o.order_date, o.created_at::date))::date as period_month,
       o.client_id,
       cl.name as client_name,
       cl.referral_partner_id as referral_partner_id,
       o.order_date,
       o.order_number,
       sum(coalesce(oi.quantity_picked, oi.quantity_ordered)) as units,
       bool_or(oi.quantity_picked is null and oi.quantity_ordered is not null) as units_estimated
from orders o
join clients cl on cl.id = o.client_id
-- LEFT, both of them. An order with no item rows at all still belongs on the
-- statement -- the partner's client placed it -- and it reports an unknown unit
-- count rather than vanishing. An inner join to preferred would delete it.
-- `is not distinct from` and not `=` so that an order with no preferred source
-- matches no lines instead of matching all of them.
left join preferred p on p.order_id = o.id
left join order_items oi
       on oi.order_id = o.id
      and oi.source is not distinct from p.source
where cl.referral_partner_id is not null
  -- `is not true`, NOT `not o.cancelled`. orders.cancelled is
  -- `boolean default false` and NULLABLE, so any row written before the column
  -- was populated carries null -- and `not null` is null, which a WHERE clause
  -- drops. That would hide every legacy order from the partner. pick_days gets
  -- this right and load-charge-inputs.ts reads it as `o.cancelled === true`,
  -- so all three agree.
  and o.cancelled is not true
-- GROUPED BY THE TWO PRIMARY KEYS, not by the printed columns. orders.order_number
-- is `not null` but is NOT unique -- it is whatever the source system called the
-- order, and two integrations can hand us the same number. Grouping by the
-- printed number would merge two real orders into one row, under-count the
-- month, and add one client's units to another order's total. Grouping by o.id
-- makes every row exactly one order, and Postgres allows the other columns of
-- orders and clients in the select list because each is functionally dependent
-- on its own table's primary key.
group by o.id, cl.id;

-- ---------------------------------------------------------------------------
-- period_month falls back to created_at when order_date is null, so an undated
-- order lands in a real month instead of a null one that renders as a mystery
-- group. order_date itself stays null on the row, and the app sorts those last.
-- date_trunc here matches partner_client_monthly's shape but NOT its source:
-- that view groups by charge_date and this one by order date. The two are
-- deliberately separate sections on screen for that reason -- an order shipped
-- in September and billed in October belongs to different months in each, and
-- nesting the activity list inside the money months would mis-attribute it.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- THE REVOKE RUNS FIRST, ahead of the guards, for the reason spelled out in
-- ledger_04_views.sql: a guard that can abort the paste must never sit above
-- the one statement that actually closes the exposure.
--
-- This view carries no money, which makes it less bad than its two siblings
-- and nowhere near harmless: left open it is every referred client's NAME,
-- every order NUMBER, every order's volume, and the identity of the partner
-- who referred them. That is a customer list with a demand curve attached.
--
-- `authenticated` is named for a reason that is live in this app: the partner
-- portal signs in people who are emphatically not staff. A partner who could
-- read this view directly would see every OTHER partner's clients and volumes.
--
-- PUBLIC is named because a grant to PUBLIC reaches every role there is,
-- including ones nobody has created yet.
--
-- Nothing is lost by locking it down. The only reader is a server-side route
-- holding the service-role key (src/lib/supabase.ts supabaseAdmin). If a screen
-- comes back empty after this, move that read onto the service-role path -- do
-- NOT grant anon back.
-- ---------------------------------------------------------------------------
revoke all on public.partner_order_units from anon, authenticated, public;

grant select on public.partner_order_units to service_role;

do $$
begin
  alter view public.partner_order_units set (security_invoker = true);
  raise notice 'security_invoker set on partner_order_units.';
exception when others then
  -- Version test INSIDE the handler, matching partner_ledger.sql and
  -- ledger_04_views.sql. An unguarded `alter view` on a pre-15 server aborts
  -- the paste and takes the revoke with it, so the handler must exist. But
  -- pre-15 is the one cause that is a fact about the server rather than a
  -- mistake in this file, so only that one degrades to a notice. Everything
  -- else -- a mistyped name (42P01), an ownership failure (42501) -- is a
  -- broken paste and must not finish green.
  if current_setting('server_version_num')::int < 150000 then
    raise notice 'security_invoker could NOT be set. SQLSTATE %: %. This server '
                 'most likely predates Postgres 15. The revoke above has already '
                 'applied and is what closes the exposure.', sqlstate, sqlerrm;
  else
    raise exception 'security_invoker could not be set. SQLSTATE %: %. This is '
                    'not a version problem -- check the view was created and is '
                    'owned by this role.', sqlstate, sqlerrm;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verify the RESULT, not the statement. `alter default privileges` or a grant
-- elsewhere can re-open this view without anyone editing this file, so the
-- check asks the database what is true rather than trusting the revoke above.
--
-- Nested blocks: only has_table_privilege sits inside the handler's reach,
-- because a flat `exception when others` would catch the deliberate
-- `raise exception` below and demote the verdict to a notice.
-- ---------------------------------------------------------------------------
do $$
declare
  still_open text;
  readable   boolean := true;
begin
  begin
    select string_agg(r.role, ', ' order by r.role)
      into still_open
    from unnest(array['anon', 'authenticated']) as r(role)
    where has_table_privilege(r.role, 'public.partner_order_units', 'SELECT');
  exception when others then
    readable := false;
    raise notice 'Could not verify anon/authenticated privilege (SQLSTATE %: %). '
                 'One of those roles may not exist on this server. Confirm '
                 'manually that neither can select from partner_order_units '
                 'before treating this file as applied.', sqlstate, sqlerrm;
  end;

  if not readable then
    null;  -- already reported
  elsif still_open is not null then
    raise exception 'WARNING: partner_order_units is still readable by %. That is '
                    'every referred client''s name, their order numbers and '
                    'volumes, and the partner behind each one. Do not treat this '
                    'file as applied until the revoke above has taken effect.',
                    still_open;
  else
    raise notice 'partner_order_units is closed to anon and authenticated.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Post-apply checks. Run as their own submission -- the Supabase SQL editor
-- shows only the last statement's result, so a live select here would bury the
-- notices raised above.
--
-- 1. units_estimated true on recent orders is EXPECTED and is not a bug: those
--    are orders not yet picked. units_estimated true on orders MONTHS old is a
--    pick-date ingestion gap, not a view problem -- check sync/zenventory.ts.
-- 2. A null units with a non-null order_number means every line on that order
--    is unquantified. Expect a handful. A whole month of them means order_items
--    stopped being written, and the statement will say so on screen rather than
--    report zeroes.
-- 3. The volume here will NOT equal partner_client_monthly's order count: that
--    view counts charged orders by charge month, this one counts placed orders
--    by order month. They are not meant to tie out, which is why they are two
--    separate sections rather than one table.
-- ---------------------------------------------------------------------------
-- select period_month, client_name, count(*) as orders,
--        sum(units) as units, count(*) filter (where units is null) as unknown,
--        bool_or(units_estimated) as any_estimated
-- from partner_order_units
-- group by 1, 2
-- order by 1 desc, 2;
