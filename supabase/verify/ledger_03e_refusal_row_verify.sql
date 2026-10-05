-- Verifies that the refusal row openSyncRun() writes can actually be written.
-- Run any time after deploying the commit that added LOCK_REFUSED_STATUS.
-- Rolls itself back; no migration accompanies it, because none is needed.
--
-- ---------------------------------------------------------------------------
-- Why this file exists, given that sync-run-mutex.test.ts already covers the
-- refusal row in eight tests.
--
-- Those tests run against a hand-rolled fake that DOES NOT ENFORCE UNIQUE
-- INDEXES. They prove openSyncRun builds the right row and throws the right
-- error; they cannot prove Postgres will accept that row, because in the fake
-- every insert is accepted. The single claim the whole repair rests on is an
-- index-predicate claim:
--
--     a 'skipped' row is outside `where status = 'running'`, so inserting one
--     while the winner still holds the lock does not collide.
--
-- If that is wrong, the refusal insert gets its own 23505, the error is logged
-- and discarded by design, and NOTHING IS WRITTEN. The system silently reverts
-- to the invisible-refusal behaviour this change exists to end -- while every
-- unit test still passes and the deploy looks healthy. The failure mode is a
-- repair that quietly does not repair anything.
--
-- Reasoning about these predicates is also precisely what went wrong twice
-- already on this branch: once assuming a partial index would serve a
-- PostgREST on_conflict (42P10), once assuming a single (source, client_id)
-- index would constrain the client_id-null rows (it cannot; NULLs are
-- distinct). Both looked obviously correct on paper. This file asks the
-- database instead.
-- ---------------------------------------------------------------------------
begin;

-- ---------------------------------------------------------------------------
-- 1. A refusal row can be written while the winner holds the lock.
--
-- The exact production sequence, in order: run A takes the lock, run B is
-- refused, run B records the refusal. If the third step raises, the repair is
-- a no-op in production and nothing anywhere says so.
do $$
declare
  refused boolean := false;
begin
  -- Run A takes the lock.
  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03e-a', null, 'live', 'running');

  -- Run B asks for it and is refused. Asserted rather than assumed: if this
  -- did NOT raise, the mutex is gone and the rest of the block would be
  -- testing a refusal that never happened.
  begin
    insert into sync_runs (source, client_id, mode, status)
      values ('verify-03e-a', null, 'live', 'running');
  exception when unique_violation then
    refused := true;
  end;

  if not refused then
    raise exception 'INCONCLUSIVE: the second running row was ACCEPTED, so the '
                    'mutex is not in force here and this file cannot test the '
                    'refusal row. Run ledger_03d_verify.sql first.';
  end if;

  -- Run B records the refusal. THE ASSERTION OF THIS FILE.
  insert into sync_runs (source, client_id, mode, status, finished_at, errors)
    values ('verify-03e-a', null, 'live', 'skipped', now(),
            '[{"kind":"warning","context":"lock refused","message":"verify"}]'::jsonb);

  raise notice 'PASS: a refusal row is accepted while the winner holds the lock';
exception when unique_violation then
  raise exception 'FAIL: the REFUSAL row was rejected (%). One of the two unique '
                  'indexes is matching it, which means it is not partial on '
                  'status = ''running'' as ledger_03d_sync_runs_mutex.sql '
                  'intends. In production this is SILENT: openSyncRun logs the '
                  'error and discards it, so every refusal goes unrecorded '
                  'exactly as before the repair, with all tests still green. '
                  'Check the predicates with: select indexrelid::regclass, '
                  'pg_get_expr(indpred, indrelid) from pg_index where indrelid = '
                  '''sync_runs''::regclass;', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Refusals do not serialise against each other.
--
-- Four schedulers racing must leave one winner and THREE refusal rows. If the
-- refusal rows collided with one another, only the first would survive and
-- the count would under-report contention by exactly the amount that makes it
-- interesting -- PART B would read "1 ran, 1 refused" for any level of
-- contention from two callers to twenty.
do $$
declare n int;
begin
  insert into sync_runs (source, client_id, mode, status, finished_at)
    values ('verify-03e-b', null, 'live', 'running',  null),
           ('verify-03e-b', null, 'live', 'skipped', now()),
           ('verify-03e-b', null, 'live', 'skipped', now()),
           ('verify-03e-b', null, 'live', 'skipped', now());

  select count(*) into n
  from   sync_runs
  where  source = 'verify-03e-b' and status = 'skipped';

  if n <> 3 then
    raise exception 'FAIL: expected 3 refusal rows, found %. Refusals are '
                    'serialising against each other, so PART B under-reports '
                    'contention.', n;
  end if;
  raise notice 'PASS: three refusals coexist with one winner';
end $$;

-- ---------------------------------------------------------------------------
-- 3. A refusal row does not hold the lock after the winner releases it.
--
-- The nightmare case, and the reason LOCK_REFUSED_STATUS may never be
-- 'running'. A refusal row that occupied the index would outlive the winner's
-- close() and lock the source out until the 30-minute reaper happened to
-- clear it -- turning the mechanism that makes a wedged source VISIBLE into
-- one that makes a source wedged.
do $$
begin
  -- Winner finishes, the way close() does.
  update sync_runs set status = 'ok', finished_at = now()
   where source = 'verify-03e-b' and status = 'running';

  -- The next run must be able to take the lock, with three refusal rows and
  -- one completed run already sitting in the table for this source.
  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03e-b', null, 'live', 'running');

  raise notice 'PASS: refusal rows do not hold the lock';
exception when unique_violation then
  raise exception 'FAIL: a later run could NOT take the lock although the winner '
                  'had closed (%). A refusal row is occupying the index, so this '
                  'source is now locked out until the stale reaper clears it -- '
                  'and every run in between skips silently.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The predicates say 'running' specifically, and not merely "something".
--
-- ledger_03d_verify.sql block 1 asserts `indpred is not null` -- that each
-- index IS partial. It does not assert WHAT the predicate is, and the
-- difference matters here: an index partial on, say, `status <> 'ok'` would
-- satisfy that check completely while rejecting every refusal row. Block 1
-- above catches that behaviourally; this one names the cause, so the failure
-- arrives with its diagnosis attached instead of as a bare 23505.
--
-- Deliberately NOT an assertion that 'skipped' differs from 'ok'. That would
-- be a fact about string comparison rather than about this system, and a
-- verify file that asserts tautologies reports coverage it does not have.
do $$
declare r record;
begin
  for r in
    select c.relname                            as idx,
           pg_get_expr(i.indpred, i.indrelid)   as predicate
    from   pg_index i
    join   pg_class c on c.oid = i.indexrelid
    where  i.indrelid = 'sync_runs'::regclass
      and  i.indisunique
      and  i.indpred is not null
  loop
    if position('status' in r.predicate) = 0
       or position('running' in r.predicate) = 0 then
      raise exception 'FAIL: unique partial index % is predicated on "%", which '
                      'does not restrict to the running rows. Any row this '
                      'predicate matches holds the lock, and any row it rejects '
                      'cannot be written -- refusal rows are one or the other.',
                      r.idx, r.predicate;
    end if;
    raise notice 'PASS: % predicated on %', r.idx, r.predicate;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Nothing in the real table already uses this status for anything else.
--
-- A notice, not a failure, and it is about reading PART B rather than about
-- correctness. Any pre-existing 'skipped' row would be counted as a refusal by
-- the clusters CTE in ledger_08_post_deploy_check.sql. There should be none
-- before the deploy, and only genuine refusals after it.
do $$
declare n int;
begin
  select count(*) into n
  from   sync_runs
  where  status = 'skipped' and source not like 'verify-03e-%';

  raise notice 'INFO: % pre-existing ''skipped'' row(s) in sync_runs. Before the '
               'refusal-row deploy this should be 0; after it, each one is a real '
               'lock refusal.', n;
end $$;

rollback;
