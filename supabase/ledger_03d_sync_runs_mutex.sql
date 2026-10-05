-- Complete the ledger, migration 3d: make the sync_runs lock real.
-- Safe to run more than once.
--
-- ---------------------------------------------------------------------------
-- Why this file exists.
--
-- src/lib/ledger/run-lock.ts prevents two charge runs from overlapping, and
-- the reason it exists is concrete: recalculation deletes charges whose
-- calculated_at predates the current run, so a second run's cutoff is LATER
-- than the first run's fresh rows and deletes them. The order loses charges,
-- the next run restores them, nothing ever errors, and the ledger oscillates.
--
-- But canStart() is ADVISORY. persist-charges.ts reads the open runs at :171,
-- decides at :192, and inserts the 'running' row at :210, with no transaction
-- and no database-level mutex in between. Two callers that both read before
-- either writes both pass the gate. The check-then-act window is small and it
-- is reachable: /api/agent/monitor declares maxDuration = 300 and AutoSync
-- polls it every five minutes from EVERY open browser tab, so a pass that uses
-- its full budget has not finished when the next tick begins. The single-flight
-- guard in src/lib/monitor/single-flight.ts cannot help -- it is a React ref,
-- so it dedupes within one tab, not across tabs and not against the cron.
--
-- The other two sources had no gate at all. sync/shipstation.ts:19 and
-- sync/zenventory.ts:117 opened their rows unconditionally.
--
-- This file moves the rule to the one place that cannot be raced.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- PART 1 -- reap abandoned runs, so the indexes below can be created.
--
-- This MUST come first. A 'running' row is left behind whenever a lambda is
-- hard-killed at its maxDuration: close() runs in a finally and therefore
-- survives an ordinary throw, but nothing survives the process being killed.
-- Those rows are already sitting in the table, and a unique index cannot be
-- created over duplicates, so without this part PART 2 simply fails on any
-- database that has ever had a sync time out.
--
-- 30 minutes, because that is STALE_RUN_MINUTES in run-lock.ts and the two
-- must agree. It is six times the 300-second function budget, so a row this
-- old cannot belong to a live Vercel invocation.
--
-- Recorded as a WARNING rather than an error entry. close()'s status formula
-- and every error_count reader in the app treat warnings as non-failures, so
-- reaping does not fire the monitor's alarm -- which is correct, because an
-- abandoned run did not fail, it stopped existing. The status still has to
-- become 'failed': it is the only terminal status the rest of the codebase
-- knows, and both readers that matter -- the charge throttle (status = 'ok',
-- persist-charges.ts:142) and the zenventory watermark (status in ok/partial,
-- zenventory.ts:102) -- must not mistake an abandoned run for a completed one.
do $$
declare n int;
begin
  with reaped as (
    update sync_runs
       set status      = 'failed',
           finished_at = coalesce(finished_at, now()),
           errors      = '[{"kind":"warning","context":"run abandoned",'
                      || '"message":"Still running more than 30 minutes after it '
                      || 'started, so ledger_03d_sync_runs_mutex.sql presumed it '
                      || 'dead and closed it. The usual cause is the lambda being '
                      || 'killed at its maxDuration, which skips the finally that '
                      || 'would have closed it."}]'::jsonb
     where status     = 'running'
       and started_at < now() - interval '30 minutes'
    returning 1
  )
  select count(*) into n from reaped;
  raise notice 'reaped % abandoned run(s)', n;
end $$;

-- ---------------------------------------------------------------------------
-- PART 2 -- the mutex.
--
-- TWO indexes, not one, because the lock's granularity is not uniform.
-- zenventory opens a sync_runs row PER CLIENT (zenventory.ts:117-119 passes
-- clientId), and two zenventory passes for DIFFERENT clients are not a
-- conflict -- that is just the loop doing its job. charges and shipstation
-- write client_id null and are genuinely source-wide.
--
-- A single `unique (source, client_id) where status = 'running'` would get
-- this exactly backwards. NULLs are distinct in SQL, so every client_id-null
-- row would be UNCONSTRAINED -- charges and shipstation, the two sources whose
-- overlap actually corrupts data, would be the two the index ignored. The
-- split below is the same shape ledger_03_charges.sql already uses for its
-- order_id-null charge rows, and for the same reason.
--
-- PARTIAL, and here that is SAFE -- note the contrast with the three other
-- unique indexes on this branch. orders_client_order_key,
-- order_charges_order_key and rate_adjustments_shipment_amount_key all had to
-- be non-partial because PostgREST's on_conflict emits a bare column list,
-- Postgres cannot infer a partial index from it, and supabase-js .upsert()
-- therefore raises 42P10. That trap needs an upsert to spring it, and NOTHING
-- UPSERTS sync_runs: openSyncRun() uses a plain .insert() (sync-run.ts), and
-- the lock depends on it staying that way. A future change to .upsert() here
-- would break every sync with 42P10 -- which is loud, at least, rather than
-- silent. supabase/verify/ledger_03d_verify.sql asserts the predicate is
-- present, so dropping it would be caught too.
--
-- The predicate is what makes the lock releasable at all: a row only occupies
-- the index while status = 'running'. close() sets 'ok'/'partial'/'failed',
-- which drops it out of the index -- that IS the unlock, and it costs no extra
-- write.
do $$
begin
  create unique index if not exists sync_runs_running_source_key
    on sync_runs (source)
    where status = 'running' and client_id is null;

  create unique index if not exists sync_runs_running_source_client_key
    on sync_runs (source, client_id)
    where status = 'running' and client_id is not null;
exception when unique_violation then
  raise exception 'sync_runs still holds more than one live run for the same '
                  'source (%). PART 1 cleared everything older than 30 minutes, so '
                  'what is left started recently -- either a sync is genuinely '
                  'running right now, in which case wait for it and re-run this '
                  'file, or two overlapped and both are stuck. Nothing has changed. '
                  'Find them with: select source, client_id, count(*), '
                  'array_agg(id), min(started_at), max(started_at) from sync_runs '
                  'where status = ''running'' group by 1, 2 having count(*) > 1; '
                  'then close the surplus rows with: update sync_runs set status = '
                  '''failed'', finished_at = now() where id = ''<id>'';', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- PART 3 -- supporting index for the watermark read.
--
-- Not part of the mutex, but the same table and the same deploy. zenventory
-- runs `source = ? and client_id = ? and status in (ok,partial) and
-- finished_at is not null order by finished_at desc limit 1` once PER CLIENT
-- PER SYNC (zenventory.ts:97-106), and sync_runs is append-only and never
-- pruned. Unindexed that is a sequential scan plus a sort, N times a sync,
-- three scheduled syncs a day, against a table that only grows. The partial
-- indexes above cannot serve it -- they cover only the 'running' rows, which
-- is the one status this query excludes.
create index if not exists sync_runs_watermark_idx
  on sync_runs (source, client_id, finished_at desc)
  where status in ('ok', 'partial');
