-- Verifies ledger_03d_sync_runs_mutex.sql. Run AFTER applying it. Rolls itself back.
--
-- Reading note: every assertion below is the OPPOSITE of the corresponding one
-- in ledger_03c_verify.sql on the partial/non-partial question, and that is
-- deliberate, not a copy-paste slip. There the predicate had to be ABSENT
-- because the only writer upserts and PostgREST cannot infer a partial index.
-- Here the predicate has to be PRESENT, because it is what releases the lock:
-- a row leaves the index the moment close() moves it off 'running'. The two
-- files disagreeing is the system working.
begin;

-- ---------------------------------------------------------------------------
-- 1. Both indexes exist, are UNIQUE, and ARE partial.
--
-- Three separate ways this regresses, all of which leave a plausible-looking
-- index behind:
--
--   missing      -> no mutex at all, and nothing anywhere errors. The syncs go
--                   back to the check-then-act race they had before, which is
--                   invisible until the ledger oscillates.
--   not unique   -> same thing. An index on (source) that is not unique is a
--                   perfectly good query index and constrains nothing.
--   not partial  -> the catastrophic one. Without `where status = 'running'`
--                   the FIRST completed run of a source occupies the index for
--                   ever, and every subsequent run is refused with 23505 --
--                   which openSyncRun reads as "someone else holds the lock"
--                   and skips QUIETLY. Three syncs a day, all skipping, no
--                   errors, no alarm.
do $$
declare
  r          record;
  checked    int := 0;
begin
  for r in
    select unnest(array['sync_runs_running_source_key',
                        'sync_runs_running_source_client_key']) as want
  loop
    declare
      is_unique  boolean;
      is_partial boolean;
    begin
      select i.indisunique, i.indpred is not null
        into is_unique, is_partial
      from   pg_index i
      join   pg_class c on c.oid = i.indexrelid
      where  c.relname = r.want;

      if is_unique is null then
        raise exception 'FAIL: % does not exist. ledger_03d_sync_runs_mutex.sql '
                        'has not been applied, so two syncs of the same source can '
                        'still overlap.', r.want;
      end if;
      if not is_unique then
        raise exception 'FAIL: % exists but is not UNIQUE, so it constrains nothing '
                        'and the mutex is decorative.', r.want;
      end if;
      if not is_partial then
        raise exception 'FAIL: % is NOT partial. The predicate is what releases the '
                        'lock -- without it the first finished run holds the source '
                        'for ever and every later run skips silently with 23505. '
                        'Recreate it with `where status = ''running'' and ...`.', r.want;
      end if;
      checked := checked + 1;
    end;
  end loop;

  raise notice 'PASS: % mutex index(es) unique and partial', checked;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Positive control, source-wide rows (client_id null).
--
-- Query 1 read the catalogue, which proves the indexes are SHAPED right and
-- nothing about whether Postgres enforces them where it matters. The two rows
-- that actually corrupt data -- charges and shipstation -- both write
-- client_id null, and NULLs are distinct in SQL, so a single combined index on
-- (source, client_id) would pass query 1 and ignore exactly these rows. This
-- block is what distinguishes the two designs.
--
-- Both directions are asserted. A second row for the SAME source must be
-- rejected; a row for a DIFFERENT source must be accepted, because the sources
-- do not conflict with each other and an index that serialised all of them
-- would make shipstation wait on charges for no reason.
do $$
declare blocked boolean := false;
begin
  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03d-a', null, 'live', 'running');

  -- Different source: must be ACCEPTED.
  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03d-b', null, 'live', 'running');

  -- Same source, still running: must be REJECTED. This is the overlapping pair.
  begin
    insert into sync_runs (source, client_id, mode, status)
      values ('verify-03d-a', null, 'live', 'running');
  exception when unique_violation then
    blocked := true;
  end;

  if not blocked then
    raise exception 'FAIL: a second running row for the same source with client_id '
                    'null was accepted. The charges and shipstation locks do not '
                    'exist -- most likely the index is a single (source, client_id) '
                    'one, where SQL NULL-distinctness exempts every row these two '
                    'sources write.';
  end if;
  raise notice 'PASS: second running row for the same source rejected, other source accepted';
end $$;

-- ---------------------------------------------------------------------------
-- 3. Positive control, per-client rows, and the release.
--
-- zenventory opens a row PER CLIENT and loops over the clients, so two running
-- rows for the same source and DIFFERENT clients are not a conflict -- that is
-- just the loop. An index that rejected them would stop the sync after its
-- first client and report a lock conflict for every client after it.
--
-- The last third of this block asserts the UNLOCK, which nothing else here
-- covers: after close() moves the row off 'running' the predicate stops
-- matching, the row leaves the index, and the next run of that client can take
-- the lock. If this failed, the lock would be permanent -- which is the same
-- end state as a non-partial index, reached by a different route.
do $$
declare
  c1      uuid;
  c2      uuid;
  blocked boolean := false;
begin
  select id into c1 from clients order by id limit 1;
  select id into c2 from clients order by id offset 1 limit 1;

  if c1 is null or c2 is null then
    -- Not a pass. client_id is a real FK, so without two clients this block
    -- would silently skip the only per-client assertion in the file.
    raise exception 'INCONCLUSIVE: fewer than two clients exist, so the per-client '
                    'half of the mutex could not be exercised.';
  end if;

  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03d-c', c1, 'live', 'running');

  -- Same source, DIFFERENT client: must be ACCEPTED.
  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03d-c', c2, 'live', 'running');

  -- Same source, SAME client: must be REJECTED.
  begin
    insert into sync_runs (source, client_id, mode, status)
      values ('verify-03d-c', c1, 'live', 'running');
  exception when unique_violation then
    blocked := true;
  end;

  if not blocked then
    raise exception 'FAIL: a second running row for the same (source, client_id) was '
                    'accepted, so zenventory has no per-client lock.';
  end if;

  -- The release. Close the first client's row the way close() does, then take
  -- the lock again: it must now succeed.
  update sync_runs
     set status = 'ok', finished_at = now()
   where source = 'verify-03d-c' and client_id = c1 and status = 'running';

  insert into sync_runs (source, client_id, mode, status)
    values ('verify-03d-c', c1, 'live', 'running');

  raise notice 'PASS: per-client locks are independent, and closing a run releases its lock';
end $$;

-- ---------------------------------------------------------------------------
-- 4. No abandoned runs survive.
--
-- PART 1 of the migration reaped everything older than STALE_RUN_MINUTES, and
-- openSyncRun() reaps the same set on every open from here on. So a row that is
-- still 'running' and older than 30 minutes means one of the two stopped
-- working, and the consequence is specific: that row holds its source's lock,
-- so every later run of it is refused with 23505 and skips quietly. The sync
-- stops, the table looks healthy, and nothing raises.
--
-- 30 minutes matches STALE_RUN_MINUTES in src/lib/ledger/run-lock.ts. All three
-- places that know this number have to agree.
do $$
declare n int;
begin
  select count(*) into n
  from   sync_runs
  where  status = 'running'
    and  started_at < now() - interval '30 minutes';

  if n > 0 then
    raise exception 'FAIL: % abandoned run(s) still hold a lock. Each one blocks its '
                    'source permanently and the skip is silent. Find them with: '
                    'select id, source, client_id, started_at from sync_runs where '
                    'status = ''running'' and started_at < now() - interval ''30 '
                    'minutes'';', n;
  end if;
  raise notice 'PASS: no abandoned running rows';
end $$;

-- ---------------------------------------------------------------------------
-- 5. The watermark index exists.
--
-- Not part of the mutex, so this is a notice and not a failure: a missing index
-- here costs a sequential scan per client per sync, which is slow rather than
-- wrong. Asserted anyway because the cost grows with a table that is never
-- pruned, and because a silent omission is how it would go unnoticed.
do $$
begin
  if to_regclass('public.sync_runs_watermark_idx') is null then
    raise warning 'SLOW: sync_runs_watermark_idx is missing. The zenventory watermark '
                  'read falls back to a sequential scan plus a sort, once per client '
                  'per sync, against an append-only table.';
  else
    raise notice 'PASS: sync_runs_watermark_idx present';
  end if;
end $$;

rollback;
