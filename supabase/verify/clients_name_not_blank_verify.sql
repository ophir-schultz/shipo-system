-- Verifies clients_name_not_blank.sql. Run AFTER applying it. Rolls itself back.
begin;

-- 1. The constraint exists, is a CHECK, and says what it is supposed to say.
--
-- Read out of pg_constraint rather than reported by the migration, because a
-- notice printed by the migration proves only that the migration's own SELECT
-- ran. This reads the state itself: conname, contype, and the predicate
-- Postgres actually stored.
--
-- convalidated is reported and NOT required, because the migration adds the
-- constraint NOT VALID on purpose so that a table with a pre-existing blank
-- row still gets it. NOT VALID still refuses every new INSERT and UPDATE --
-- which is what step 2 proves -- so a false here is a note about the old rows,
-- not a failure of the protection.
do $$
declare
  kind      "char";
  predicate text;
  validated boolean;
begin
  select contype, pg_get_constraintdef(oid), convalidated
    into kind, predicate, validated
  from   pg_constraint
  where  conname = 'clients_name_not_blank'
  and    conrelid = 'clients'::regclass;

  if kind is null then
    raise exception 'FAIL: clients_name_not_blank does not exist on clients. '
                    'supabase/clients_name_not_blank.sql has not been applied.';
  end if;
  if kind <> 'c' then
    raise exception 'FAIL: clients_name_not_blank exists but is contype %, not a CHECK', kind;
  end if;

  -- The predicate is asserted because the WEAKER candidate is the likely one.
  -- `length(btrim(name)) > 0` looks equivalent and is not: btrim's default
  -- trim set is a space, so a tab-only or newline-only name passes it while
  -- JavaScript's .trim() refuses it -- the constraint would then be quietly
  -- weaker than the rule in src/lib/clients/editable-fields.ts that it exists
  -- to back up.
  if predicate not like '%[^[:space:]]%' then
    raise exception 'FAIL: clients_name_not_blank is defined as %, which is not the '
                    'non-whitespace test. A btrim-based predicate admits a tab-only '
                    'name.', predicate;
  end if;

  if validated then
    raise notice 'PASS: clients_name_not_blank exists, is a CHECK, tests for a '
                 'non-whitespace character, and is VALIDATED against every existing row';
  else
    raise notice 'PASS (with a note): clients_name_not_blank exists, is a CHECK and '
                 'tests for a non-whitespace character, but is NOT VALIDATED -- so at '
                 'least one pre-existing row has a blank name. New writes are already '
                 'refused. Run step 4 to list the offending rows.';
  end if;
end $$;

-- 2. Positive control: the constraint actually bites, on all four shapes.
--
-- Step 1 alone is not evidence that a blank name is refused -- it is evidence
-- that a row in a catalog table says so. These four inserts are the thing
-- being claimed. The tab and newline cases are the whole reason the predicate
-- is a regex and not btrim; if this file is ever run against a btrim-based
-- constraint, those two are what fails.
do $$
declare
  label   text;
  attempt text;
begin
  foreach attempt in array array['', ' ', E'\t', E'\n  \t']
  loop
    label := case attempt
               when ''      then 'the empty string'
               when ' '     then 'a single space'
               when E'\t'   then 'a tab'
               else              'mixed whitespace'
             end;
    begin
      insert into clients (name) values (attempt);
      raise exception 'FAIL: a client named % was ACCEPTED. clients_name_not_blank '
                      'is not constraining this shape.', label;
    exception when check_violation then
      raise notice 'PASS: a client named % is refused', label;
    end;
  end loop;
end $$;

-- 3. Negative control: a real name is still accepted.
--
-- Without this, every assertion in step 2 would also pass on a constraint of
-- `check (false)`, which refuses blank names by refusing everything -- and
-- would stop Ophir adding a client at all.
do $$
declare new_id uuid;
begin
  insert into clients (name) values ('Verify Co') returning id into new_id;
  if new_id is null then
    raise exception 'FAIL: inserting a normal client name returned no row';
  end if;
  raise notice 'PASS: a normal client name is still accepted';
exception when check_violation then
  raise exception 'FAIL: clients_name_not_blank refused the normal name ''Verify Co''. '
                  'The predicate is too strong and no client can be created.';
end $$;

-- 4. What is actually in the table right now.
--
-- The count is the answer to "can step 1's convalidated become true", and the
-- ids are what to go and fix. Reported rather than asserted: a blank row that
-- predates the constraint is a data problem to work through, not a reason for
-- this file to fail.
do $$
declare
  bad int;
  ids text;
begin
  select count(*), string_agg(id::text, ', ')
    into bad, ids
  from   clients
  where  name !~ '[^[:space:]]';

  if bad > 0 then
    raise notice 'NOTE: % pre-existing client row(s) still have a blank name: %. '
                 'Give them real names, then re-run clients_name_not_blank.sql to '
                 'validate the constraint.', bad, ids;
  else
    raise notice 'PASS: zero client rows have a blank name';
  end if;
end $$;

rollback;
