-- ============================================================
-- Finish the campaigns/P&L migration — schema only, no seed
-- Reviewable file — apply manually in the Supabase SQL editor.
-- ============================================================
--
-- WHY THIS EXISTS, AND WHY IT IS NOT JUST "RUN campaigns_pnl.sql"
--
-- campaigns_pnl.sql (2026-08-09) was applied in part. Measured today with a
-- scratch probe, scripts/probe-pnl-tables.mjs — untracked, because .gitignore
-- line 61 keeps every probe-* out of the repo on purpose. The reading it
-- produced is therefore reproduced here in full rather than cited, since the
-- script it came from is not something a later reader can open:
--
--   referral_partners            exists   (from referral_program.sql)
--   referral_payouts             exists
--   clients.referral_partner_id  present
--   campaigns                    ABSENT
--   inbound_shipments            ABSENT
--   clients.acquisition_campaign_id  ABSENT
--   clients.acquisition_date         ABSENT
--
-- The consequence is worse than the yellow banner that was assumed. /pnl asks
-- per table whether a migration object is missing and excuses those three —
-- but `clients` is NEVER excused (src/app/pnl/page.tsx:87), and the page
-- selects clients.acquisition_campaign_id. So the read fails 42703, lands in
-- `unreadable`, and the whole page is refused rather than degraded. That has
-- been the state since the select was added on 2026-09-20.
--
-- THE SEED IS DELIBERATELY OMITTED.
--
-- The original file ends by inserting six campaigns at monthly_cost 0 and
-- one_time_cost 0, guarded by `where not exists (select 1 from campaigns)`.
-- Running it now would fire, because campaigns is about to be created empty.
--
-- Those zeros are not neutral. One of these channels has a measured cost:
-- Apollo.io billed $426.87 in September 2026 (BoA statement, SHIPOLLC
-- ...6109). The LinkedIn campaigns run through HeyReach (campaign id 543002,
-- see campaigns_pnl.sql) and no invoice for it has been read, so its spend is
-- UNKNOWN — which is the point. An unmeasured cost is not $0, and a campaign
-- row asserting $0 spend states something false on the one screen whose job
-- is to report where the money went. The code survives it —
-- campaignFigures() guards ROI with `spend > 0`, so ROI comes back null rather
-- than infinite — but CAC does not: `spend / clientsWon` prints $0.00 per
-- client won, a decided-looking figure assembled from a placeholder nobody
-- entered. An empty campaigns table says "no campaign has been entered",
-- which is true. Six rows of $0 say "these campaigns were free", which is not.
--
-- Campaigns should be added with their real costs, which is what the comment
-- in the original file ("edit costs later via form") assumed would happen
-- before anyone read the numbers.
--
-- Idempotent: every statement is `if not exists`. Safe to re-run.

-- campaigns must exist before clients can reference it.
create table if not exists campaigns (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  channel text not null,        -- dtc_email, fba_linkedin, partner_linkedin, seo, backlinks, spn, other
  status text default 'active', -- active, paused, ended
  start_date date,
  end_date date,
  monthly_cost numeric(10,2) default 0,   -- recurring spend
  one_time_cost numeric(10,2) default 0,  -- setup / one-off spend
  notes text,
  created_at timestamptz default now()
);

alter table campaigns enable row level security;

-- INBOUND SHIPMENTS (receiving log — the "packing list" feeding P&L)
create table if not exists inbound_shipments (
  id uuid primary key default uuid_generate_v4(),
  client_id uuid references clients(id),
  reference text,                 -- PO / container / tracking ref
  received_date date,
  units integer default 0,
  our_cost numeric(10,2) default 0,      -- what receiving/handling cost us
  billed_amount numeric(10,2) default 0, -- what we bill the client
  notes text,
  created_at timestamptz default now()
);

alter table inbound_shipments enable row level security;

-- The two columns whose absence is what actually refuses /pnl.
-- clients.referral_partner_id already exists and is left alone.
alter table clients add column if not exists acquisition_campaign_id uuid references campaigns(id);
alter table clients add column if not exists acquisition_date date;
