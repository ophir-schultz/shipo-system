-- Partner statements from the ledger.
-- Spec: docs/superpowers/specs/2026-10-11-partner-ledger-statements-design.md
-- Requires ledger migrations 1-4 and supabase/referral_program.sql.
-- Safe to run more than once.
--
-- Two views, both read-only, no new tables.
--
-- partner_client_monthly answers "what do we owe this partner, and is that
-- figure safe to pay yet". partner_order_transactions is the transaction list
-- behind it. Both come from the same order_charges rows /pnl reads, so the
-- partner statement and the P&L cannot disagree. Today they can: the statement
-- reads fba_invoices, which is typed by hand on /referrals, and nothing
-- reconciles the two.
--
-- The design doc named only the monthly view. The second one is an amendment
-- made during implementation and recorded in the doc: aggregating orders in the
-- app meant pulling every charge row to render every order line, and putting
-- the aggregation in SQL also puts the disclosure rule in SQL -- see the
-- comment on that view.
--
-- WHAT THIS VIEW DELIBERATELY DOES NOT DO: decide the payout. The terms live in
-- src/lib/referrals.ts (REFERRAL_TERMS, computeOwed) and stay there. This view
-- reports the inputs. Processing fees are not here at all -- the ledger has no
-- such charge type -- so final net profit is reached in the app by subtracting
-- fba_invoices.cost_processing.

-- ---------------------------------------------------------------------------
-- Drop first, for the reason documented at the top of ledger_04_views.sql:
-- `create or replace view` may only APPEND columns, and Postgres compares by
-- ordinal, so inserting a column mid-list raises 42P16 against a database that
-- already has the earlier definition -- which reads like "already applied" and
-- is not. The drop makes the re-run promise true, and its deliberate side
-- effect is that the ACLs go with it. That is why the revoke/grant block below
-- is unconditional and must stay in this file.
-- ---------------------------------------------------------------------------
drop view if exists public.partner_client_monthly;

create view public.partner_client_monthly as
with b as (
  select date_trunc('month', oc.charge_date)::date as period_month,
         oc.client_id,

         -- Null-propagating on purpose. `sum` skips nulls, so this reads LOW
         -- when a charge is billed at cost and the carrier has not reported
         -- yet. revenue_unknown_charges below is what says so, and a non-zero
         -- count makes the month unpayable rather than underpaid.
         sum(oc.amount) as revenue,

         -- The agreement's deducted buckets. surcharge and return sit with
         -- freight because they are carrier money (confirmed by Ophir
         -- 2026-10-11); they are not separately named in the terms.
         sum(oc.cost) filter (
           where oc.charge_type in ('shipping', 'surcharge', 'return')
         ) as cost_freight,
         sum(oc.cost) filter (where oc.charge_type = 'material') as cost_materials,
         sum(oc.cost) filter (where oc.charge_type = 'storage')  as cost_storage,

         -- REPORTED, NEVER DEDUCTED. The agreement deducts freight, materials,
         -- storage and processing -- not warehouse labour. So partner net
         -- profit is structurally HIGHER than our real gross margin, by exactly
         -- this number. That is the signed deal, not a bug, and must not be
         -- "corrected" here. It is surfaced as its own column so /pnl can show
         -- our margin beside the partner's and nobody misreads one for the
         -- other.
         sum(oc.cost) filter (
           where oc.charge_type in ('pick', 'pack', 'receiving')
         ) as cost_labour_not_deducted,

         count(*) filter (where oc.amount is null) as revenue_unknown_charges,

         -- DEDUCTED BUCKETS ONLY, and the filter list is the point. An unknown
         -- `pick` cost cannot move what we owe, because pick is never
         -- deducted -- counting it would block payable months for no reason and
         -- train everyone to override the block. Keep this list in sync with
         -- the three bucket sums above.
         count(*) filter (
           where oc.cost is null
             and oc.charge_type in ('shipping', 'surcharge', 'return',
                                    'material', 'storage')
         ) as cost_unknown_charges,

         bool_or(oc.is_estimate) as has_estimates
  from order_charges oc
  group by 1, 2
)
select b.period_month,
       b.client_id,
       cl.name                as client_name,
       cl.referral_partner_id,
       b.revenue,

       -- READ THE coalesce, then read why it is safe here -- it is the exact
       -- move ledger_04_views.sql warns about, and the only thing separating
       -- the two cases is the counter sitting beside it.
       --
       -- `sum(x) filter (...)` returns NULL when NO row matches, which is a
       -- different fact from "a matching row had a null cost". No material
       -- charges at all genuinely means zero materials cost that month, and
       -- zero is the honest figure. Material charges whose cost is unknown is
       -- the dangerous case, and that one is caught by cost_unknown_charges,
       -- NOT by this coalesce.
       --
       -- So: never remove the counter and keep the coalesce. Alone, these three
       -- columns understate cost, which overstates net profit, which overpays a
       -- partner 5% of margin we never earned.
       coalesce(b.cost_freight, 0)             as cost_freight,
       coalesce(b.cost_materials, 0)           as cost_materials,
       coalesce(b.cost_storage, 0)             as cost_storage,
       coalesce(b.cost_labour_not_deducted, 0) as cost_labour_not_deducted,

       -- NULL only when EVERY amount in the month is unknown, because `sum`
       -- skips nulls. The partial case -- some revenue known, some not -- comes
       -- out as a number that is too LOW, which makes net profit too low, which
       -- UNDERpays. That is the mirror of the cost risk and it is not fixed
       -- here: revenue_unknown_charges makes the month unpayable, and an
       -- unpayable month is never the basis of a cheque.
       b.revenue
         - coalesce(b.cost_freight, 0)
         - coalesce(b.cost_materials, 0)
         - coalesce(b.cost_storage, 0) as net_profit_before_processing,

       b.revenue_unknown_charges,
       b.cost_unknown_charges,

       -- The money rule. A month with any unknown in a deducted bucket, or any
       -- unknown revenue, is PROVISIONAL and not payable. Stricter than /pnl on
       -- purpose: /pnl showing a high margin is a bad read, paying 5% of a high
       -- margin is cash out the door that does not come back.
       (b.revenue_unknown_charges = 0 and b.cost_unknown_charges = 0) as payable,

       b.has_estimates
from b
join clients cl on cl.id = b.client_id
where cl.referral_partner_id is not null;

-- ---------------------------------------------------------------------------
-- The transaction list behind a statement. One row per order per month.
--
-- WHY THIS IS A VIEW AND NOT A JOIN IN THE APP: the app would have to pull
-- every charge row to add them up -- six rows per order, so a client doing
-- 2,000 orders in a month is 12,000 rows crossing the wire to render 2,000
-- lines. Postgres does the aggregation; the row count that reaches Node is the
-- row count the partner actually sees.
--
-- WHAT IS DELIBERATELY ABSENT: cost. Any cost, in any form. The approved
-- disclosure scope says a partner may see date, order number and amount
-- billed, and nothing else, because `amount / quantity` on a line item IS the
-- rate card and a partner who is also an agency can read it straight off.
-- Keeping cost out of the VIEW rather than out of the RENDER is the point: a
-- future component cannot leak a column that does not exist. Do not add one
-- "for the internal screen" -- /pnl reads order_charges directly and already
-- has every cost it needs.
--
-- period_month is here, matching partner_client_monthly, so a transaction can
-- be attributed to the month whose figures it explains. A charge is attributed
-- by charge_date, not by the order's own date: the month-level view groups the
-- same way, and the two must agree or the lines will not add up to the total.
--
-- order_id IS NULLABLE in order_charges -- storage and other account-level
-- charges belong to a client and a month but to no order. Grouping by a null
-- order_id collapses all of them into one row per month, which is the honest
-- shape: there is no order number to show. Label that row for what it is
-- rather than printing a blank.
-- ---------------------------------------------------------------------------
drop view if exists public.partner_order_transactions;

create view public.partner_order_transactions as
select date_trunc('month', oc.charge_date)::date as period_month,
       oc.client_id,
       cl.referral_partner_id,
       oc.order_id,
       o.order_number,
       min(oc.charge_date) as first_charge_date,
       max(oc.charge_date) as last_charge_date,

       -- Reads LOW, exactly like revenue in the month view, and for the same
       -- reason: `sum` SKIPS nulls rather than propagating them, so an order
       -- with one unreported at-cost freight line totals the lines we do know.
       -- It is NULL only when every line is unknown. amount_unknown_charges
       -- below is the only thing that distinguishes a complete total from a
       -- partial one -- never render this column without it.
       sum(oc.amount) as amount_billed,
       count(*) filter (where oc.amount is null) as amount_unknown_charges,
       count(*) as charge_rows
from order_charges oc
join clients cl on cl.id = oc.client_id
left join orders o on o.id = oc.order_id
where cl.referral_partner_id is not null
group by 1, 2, 3, 4, 5;

-- ---------------------------------------------------------------------------
-- THE REVOKE RUNS FIRST, ahead of the guards, for the reason spelled out in
-- ledger_04_views.sql: a guard that can abort the paste must not sit above the
-- one statement that actually closes the exposure.
--
-- These two views are a worse leak than the five in that file if left open.
-- partner_client_monthly joins client revenue and margin to the identity of
-- the partner who referred them, so a single anon read is every client's
-- economics AND the commercial relationships behind them.
-- partner_order_transactions is every referred client's order numbers and
-- billed amounts, which is a customer list and a revenue curve together.
-- order_charges has no RLS of its own, so security_invoker alone does not
-- close either -- the revoke does.
--
-- `authenticated` is named for a reason that is live in this app: the partner
-- portal signs in people who are emphatically not staff. A partner who could
-- read these would see every OTHER partner's clients.
--
-- PUBLIC is named because a grant to PUBLIC reaches every role there is,
-- including ones nobody has created yet.
--
-- Nothing is lost by locking them down. Every reader is a server-side route
-- holding the service-role key (src/lib/supabase.ts supabaseAdmin). If a screen
-- comes back empty after this, move that read onto the service-role path --
-- do NOT grant anon back.
-- ---------------------------------------------------------------------------
revoke all on public.partner_client_monthly,
              public.partner_order_transactions
  from anon, authenticated, public;

grant select on public.partner_client_monthly,
                public.partner_order_transactions
  to service_role;

do $$
begin
  alter view public.partner_client_monthly     set (security_invoker = true);
  alter view public.partner_order_transactions set (security_invoker = true);
  raise notice 'security_invoker set on partner_client_monthly and '
               'partner_order_transactions.';
exception when others then
  -- Version test inside the handler, matching ledger_04_views.sql:683-699. An
  -- unguarded `alter view` on a pre-15 server aborts the paste and takes the
  -- revoke with it, so the handler must exist; but pre-15 is the one cause that
  -- is a fact about the server rather than a mistake in this file, so only that
  -- one degrades to a notice. Everything else -- a mistyped name (42P01), an
  -- ownership failure (42501) -- is a broken paste and must not finish green.
  if current_setting('server_version_num')::int < 150000 then
    raise notice 'security_invoker could NOT be set. SQLSTATE %: %. This server '
                 'most likely predates Postgres 15. The revoke above has already '
                 'applied and is what closes the exposure.', sqlstate, sqlerrm;
  else
    raise exception 'security_invoker could not be set. SQLSTATE %: %. This is '
                    'not a version problem -- check both views were created and '
                    'are owned by this role.', sqlstate, sqlerrm;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Verify the result, not the statement. `alter default privileges` or a grant
-- elsewhere can re-open this view without anyone editing this file.
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
    -- Every role against every view. Checking only one of the two would let a
    -- stray grant on the other read as "closed", and the transaction view is
    -- the one a future migration is most likely to touch.
    select string_agg(r.role || ' on ' || v.rel, ', ' order by v.rel, r.role)
      into still_open
    from unnest(array['anon', 'authenticated']) as r(role)
    cross join unnest(array['public.partner_client_monthly',
                            'public.partner_order_transactions']) as v(rel)
    where has_table_privilege(r.role, v.rel, 'SELECT');
  exception when others then
    readable := false;
    raise notice 'Could not verify anon/authenticated privilege (SQLSTATE %: %). '
                 'One of those roles may not exist on this server. Confirm '
                 'manually that neither can select from partner_client_monthly '
                 'or partner_order_transactions before treating this file as '
                 'applied.', sqlstate, sqlerrm;
  end;

  if not readable then
    null;  -- already reported
  elsif still_open is not null then
    raise exception 'WARNING: these are still readable: %. That is every referred '
                    'client''s revenue and margin, their order numbers, and the '
                    'partner behind each one. Do not treat this file as applied '
                    'until the revoke above has taken effect.', still_open;
  else
    raise notice 'Both views are closed to anon and authenticated.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Post-apply checks. Run as their own submission -- the Supabase SQL editor
-- shows only the last statement's result, so a live select here would bury the
-- notices raised above.
--
-- 1. `payable = false` rows are EXPECTED and are not a bug. They are months we
--    have not finished pricing. What would be a bug is every row payable while
--    cost_unknown_charges is non-zero somewhere in order_charges -- that means
--    the filter list drifted from the bucket sums.
-- 2. cost_labour_not_deducted MUST be non-zero for any month with pick/pack
--    activity. If it reads 0.00 across the board, either the costs are unpriced
--    or the charge_type names drifted, and the number standing in for "our real
--    margin" on /pnl is then indistinguishable from the partner's.
-- 3. A client with referral_partner_id set but no rows here has no charges yet.
--    A client with charges but NOT appearing means referral_partner_id is null
--    -- that is a linking gap on /referrals, not a view problem.
-- 4. THE TWO VIEWS MUST ADD UP. For any (client, month), the sum of
--    partner_order_transactions.amount_billed must equal
--    partner_client_monthly.revenue. They are grouped the same way from the
--    same rows, so a difference means one of the two WHERE or GROUP BY clauses
--    was edited without the other -- and the visible symptom is a partner
--    seeing a transaction list that does not add up to their own total. The
--    second query below is the check; it should return no rows.
-- ---------------------------------------------------------------------------
-- select period_month, client_name, revenue, cost_freight, cost_materials,
--        cost_storage, cost_labour_not_deducted, net_profit_before_processing,
--        revenue_unknown_charges, cost_unknown_charges, payable
-- from partner_client_monthly
-- order by period_month desc, client_name;

-- The reconciliation in check 4. `is distinct from` and not `<>`, because a
-- month whose revenue is unknown is NULL on both sides and `null <> null` is
-- null, not false -- which would hide exactly the months most likely to be
-- wrong.
-- select m.period_month, m.client_name, m.revenue as month_view,
--        t.total as txn_view
-- from partner_client_monthly m
-- left join (
--   select period_month, client_id, sum(amount_billed) as total
--   from partner_order_transactions
--   group by 1, 2
-- ) t on t.period_month = m.period_month and t.client_id = m.client_id
-- where m.revenue is distinct from t.total;
