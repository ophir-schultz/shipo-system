-- Nayax rate card, transcribed from the quote. Labels are the quote's own words.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §6
--
-- Requires: supabase/ledger_03_charges.sql applied first.
--   ledger_03 drops the NOT NULL constraints on service_type and rate, and adds
--   effective_from / effective_to. Without it this insert fails.
--
-- Safe to run more than once: it deletes this client's seeded rows first.
-- The delete is keyed on `charge_type is not null` and so cannot touch legacy
-- rows, which are written by the rate-upload flow and carry no charge_type
-- (src/components/billing/WarehouseRatesUpload.tsx:74-78).
--
-- It was keyed on `effective_from = '2026-01-01'` until the peak-surcharge note
-- further down was followed to its conclusion: that note tells you to edit that
-- exact literal to switch the line on, which took the row out of the delete's
-- reach and made the next re-run insert a second copy of it. See the long
-- comment on the delete itself.
--
-- RATES ARE CHANGED BY EDITING THIS FILE, NEVER THE TABLE. Editing a row in the
-- database is not caught by anything here — this file simply overwrites it on
-- the next run, so the change silently reverts, and in the meantime the card on
-- record disagrees with the card in this repository. What IS caught now is the
-- outcome that used to follow from it: ledger_03_charges.sql carries
-- client_warehouse_rates_no_overlap, so two rows for the same (client,
-- charge_type, variant) covering the same day fail at the insert instead of
-- being billed from by sort order (calculate-charges.ts:91-98 calls that a data
-- error and resolves it by sort order — it does not refuse).
--
-- Warning: POST /api/clients/[id]/warehouse-rates deletes ALL of a client's
-- rates before inserting, and the UI that calls it is on the client detail
-- page. If anyone uses the rate-upload flow for Nayax, all eighteen rows below
-- are gone and the replacements carry no charge_type — the loader drops them
-- and the client silently stops being billed. Re-apply this file.
--
-- Note: `unit` is omitted from the insert, so all eighteen rows take the column
-- default 'per_unit' (schema.sql:32) regardless of what they actually measure.
-- That is harmless: `rate_type` is the truth column and nothing in the ledger
-- path reads `unit`. It is legacy display metadata only.
--
-- Note: description stays null throughout. The brief's Step 3 asks for
-- verbatim qualifying conditions from the quote text; that text is not in this
-- repository. Null is visible and harmless; a paraphrase would not be.

do $$
declare
  cid uuid;
  n   int;
begin
  -- ilike '%nayax%' is a substring match: "Nayax", "Nayax EU" and an archived
  -- "Nayax (old)" all qualify. A bare `limit 1` with no order by takes whichever
  -- row the planner returns first — not stable between runs — so the whole
  -- eighteen-line card could attach to the wrong client_id and report success.
  -- Count first and refuse to guess.
  select count(*) into n from clients where name ilike '%nayax%';
  if n = 0 then
    raise exception 'No client matching "nayax" found. Check the client name first.';
  elsif n > 1 then
    raise exception '% clients match "nayax". Narrow the predicate before seeding '
                    'a rate card onto one of them.', n;
  end if;
  select id into cid from clients where name ilike '%nayax%';

  -- Keyed on `charge_type is not null`, NOT on a date.
  --
  -- It used to read `effective_from = '2026-01-01'`, which is the same literal
  -- the peak-surcharge note below tells you to edit in order to activate that
  -- line. Follow those instructions — set the peak row's effective_from to
  -- '2026-11-01', re-run — and the delete no longer matches the peak row it
  -- wrote last time: the other seventeen are replaced and a SECOND peak row is
  -- inserted beside the first. Two rows, same client, same (surcharge, peak),
  -- same window, and `get diagnostics row_count` below still reads 18 and
  -- reports success. The one documented way to change this card armed a
  -- duplicate of the one line on it that multiplies every other line.
  --
  -- charge_type is the right key because it is what makes a row one of OURS,
  -- and no instruction anywhere asks you to change it. The legacy rows this
  -- file must not touch are now safe for a better reason than before:
  -- POST /api/clients/[id]/warehouse-rates writes only service_type, rate and
  -- unit (src/components/billing/WarehouseRatesUpload.tsx:74-78), so every row
  -- not written by a seed file has charge_type null. The old predicate rested
  -- on ledger_03 having added effective_from with no backfill — a fact about
  -- one migration's history, which stops being true the first time anyone
  -- backfills it. This one rests on a column that means "structured rate card"
  -- and that nothing outside these seed files writes.
  --
  -- ledger_03_charges.sql now also carries client_warehouse_rates_no_overlap,
  -- so if this predicate is ever narrowed again the duplicate fails at the
  -- insert rather than being billed from.
  delete from client_warehouse_rates
   where client_id = cid and charge_type is not null;

  insert into client_warehouse_rates
    (client_id, category, label, rate, rate_type,
     charge_type, variant, effective_from, effective_to)
  values
    -- ---- inbound -----------------------------------------------------------
    -- receiving x4: not yet billable. No sync currently fetches inbound
    -- receipts. Seeding the lines now puts the agreed price on record; the gap
    -- appears as unbilled inbound work rather than silence.
    (cid, 'inbound',  'Pallet receiving',                  20.00, 'per_pallet',
     'receiving', 'pallet',             '2026-01-01', null),
    (cid, 'inbound',  'Carton receiving',                   0.85, 'per_carton',
     'receiving', 'carton',             '2026-01-01', null),
    (cid, 'inbound',  'Container devanning 20ft',         450.00, 'flat',
     'receiving', 'devan_20ft',         '2026-01-01', null),
    (cid, 'inbound',  'Container devanning 40ft',         650.00, 'flat',
     'receiving', 'devan_40ft',         '2026-01-01', null),

    -- ---- storage -----------------------------------------------------------
    -- storage x2: not yet billable. Storage billing is built in Task 18, which
    -- walks a separate inventory snapshot table that does not yet exist.
    (cid, 'storage',  'Pallet position',                   25.00, 'per_pallet',
     'storage',   'pallet',             '2026-01-01', null),
    (cid, 'storage',  'Shelf',                             12.00, 'per_shelf',
     'storage',   'shelf',              '2026-01-01', null),

    -- ---- outbound ----------------------------------------------------------
    -- pick/device and pick/component: BILLABLE TODAY.
    -- These two variants are the exact strings the calculator uses:
    --   calculate-charges.ts:117  →  item.isComponent ? 'component' : 'device'
    -- If the variant strings drift here, every pick silently loses its rate and
    -- the order lands in leaks_monthly.picked_never_billed instead of billing.
    (cid, 'outbound', 'Device pick + serial number scan',   0.32, 'per_unit',
     'pick',      'device',             '2026-01-01', null),
    (cid, 'outbound', 'Component / accessory pick',         0.20, 'per_unit',
     'pick',      'component',          '2026-01-01', null),

    -- pick/carton, pick/pallet_scan, pick/pallet x3: not yet billable.
    -- The calculator's pick variant is binary (device | component) at
    -- calculate-charges.ts:117 — nothing in the system describes or records a
    -- carton pick or a pallet pick, so these rates can never be looked up.
    (cid, 'outbound', 'Full carton pick',                   1.50, 'per_carton',
     'pick',      'carton',             '2026-01-01', null),
    (cid, 'outbound', 'Full pallet scan',                  12.50, 'per_pallet',
     'pick',      'pallet_scan',        '2026-01-01', null),
    (cid, 'outbound', 'Full pallet pick',                  20.00, 'per_pallet',
     'pick',      'pallet',             '2026-01-01', null),

    -- pack/pallet_shrink_wrap x1: not yet billable.
    -- Pack is looked up by device | component only (calculate-charges.ts:154).
    -- Nayax includes packing in the pick rate and has no per-unit pack line —
    -- the 'pallet_shrink_wrap' variant is never matched. The rate is on record
    -- so that the agreed price is visible; it raises no charge today.
    (cid, 'outbound', 'Pallet + shrink wrap',              15.00, 'per_pallet',
     'pack',      'pallet_shrink_wrap', '2026-01-01', null),

    -- shipping: BILLABLE TODAY.
    -- at_cost: rate is null by design. The client pays exactly what the carrier
    -- charged. A null amount here is "we have not received the carrier bill yet"
    -- and is correctly different from zero.
    -- variant is null: there is one freight line, not one per carrier.
    (cid, 'outbound', 'Carrier freight',                    null, 'at_cost',
     'shipping',  null,                 '2026-01-01', null),

    -- IMPORTANT — peak surcharge: NOT IN EFFECT. Both dates are the same.
    -- This is deliberate, not a typo. The range '[2026-01-01, 2026-01-01)' is
    -- empty: the condition effective_from <= d AND d < effective_to is false for
    -- every date d, so this rate is on record but raises zero charges.
    --
    -- The peak window from the Nayax quote is not yet known. To activate this
    -- line, edit the two date literals in THIS FILE's peak tuple below — set
    -- effective_from to the real start of the peak window and effective_to to
    -- its real end — and re-run the file. Do NOT edit the row in the table:
    -- this file overwrites it on the next run, so the change reverts silently.
    --
    -- Those instructions used to arm a duplicate when followed exactly. The
    -- delete above was keyed on effective_from = '2026-01-01', so the moment
    -- you changed this tuple's effective_from the previously-inserted peak row
    -- stopped matching it, survived the delete, and sat beside the new one.
    -- The delete is now keyed on charge_type, and ledger_03 carries an
    -- exclusion constraint, so a re-run replaces this row whatever date it
    -- holds and a second overlapping copy cannot be written at all.
    --
    -- Leaving effective_to = null (open-ended) would bill 8% on every
    -- pick-and-pack total all year round — that is an overbilling error the
    -- ledger cannot detect, because leaks_monthly has no overbilling branch.
    --
    -- The line must NOT simply be deleted instead. load-charge-inputs.ts:392
    -- finds this line with a bare .find() that ignores dates and passes the 8%
    -- through as peakSurchargePct. The calculator at calculate-charges.ts:271-272
    -- checks hasPeakLine — whether a ('surcharge','peak') row EXISTS on the
    -- card at all — before deciding whether to honour the dated lookup or fall
    -- back to that undated percentage. Deleting the row removes hasPeakLine,
    -- and the same 8% re-enters through the fallback path on every order.
    --
    -- percentage: 8.00 means 8 percent, not 800 percent and not 0.08.
    (cid, 'outbound', 'Peak season surcharge',              8.00, 'percentage',
     'surcharge', 'peak',               '2026-01-01', '2026-01-01'),

    -- ---- returns -----------------------------------------------------------
    -- return x3: not yet billable. No returns-received feed exists. A return
    -- LABEL being bought is already billed as shipping and is a different event
    -- from a return being received and processed; these three lines cover the
    -- latter, which has no data source yet.
    (cid, 'returns',  'Return processing',                  3.00, 'per_box',
     'return',    'box',                '2026-01-01', null),
    (cid, 'returns',  'Additional returned item',           0.35, 'per_unit',
     'return',    'unit',               '2026-01-01', null),
    (cid, 'returns',  'Special labour',                    48.00, 'per_hour',
     'return',    'labour_hour',        '2026-01-01', null),

    -- material/packing x1: not yet billable.
    -- Nothing records which box size an order shipped in, and the card bills
    -- materials at cost + 15%. Without packaging purchase records per shipment,
    -- the cost basis does not exist and this rate cannot be applied.
    -- cost_plus: 15.00 means cost + 15 percent.
    (cid, 'returns',  'Packing materials',                 15.00, 'cost_plus',
     'material',  'packing',            '2026-01-01', null);

  -- Report the MEASURED number, not the expected one. A hard-coded
  -- 'Seeded 18 rate lines' fires identically if a values tuple was dropped by
  -- an edit or a partial paste, and a missing rate line is otherwise invisible
  -- at apply time — the comment block below teaches the reader to expect
  -- unbilled services, so a silent omission has been pre-explained away.
  get diagnostics n = row_count;
  if n is distinct from 18 then
    raise exception 'Expected to seed 18 Nayax rate lines, wrote %', n;
  end if;
  raise notice 'Seeded % Nayax rate lines', n;

  -- The two pick variants are the only lines that carry meaningful billable
  -- volume, and they must read exactly 'device' and 'component'
  -- (calculate-charges.ts:117). Assert them here, scoped to THIS client and
  -- THIS effective_from: a trailing query grouped by variant across the whole
  -- table returns two rows as soon as any client has one of each, so from the
  -- second rate card onward a mistyped Nayax 'device' hides behind another
  -- client's correct one. Also assert effective_to is null, because an empty
  -- date range is a deliberate off-switch in this very file (see the peak line)
  -- and a mistyped effective_to would disable the largest revenue line silently.
  --
  -- `is distinct from` rather than `<>`: count(*) cannot be null here, but
  -- `<>` against anything nullable yields NULL, and PL/pgSQL falls straight
  -- through a NULL `if` — printing success for exactly the case the assertion
  -- exists to catch. That trap has bitten this branch four times.
  select count(*) into n from client_warehouse_rates
   where client_id = cid and effective_from = '2026-01-01'
     and charge_type = 'pick' and variant = 'device'
     and effective_to is null;
  if n is distinct from 1 then
    raise exception 'Expected exactly one open-ended pick/device line, found %', n;
  end if;

  select count(*) into n from client_warehouse_rates
   where client_id = cid and effective_from = '2026-01-01'
     and charge_type = 'pick' and variant = 'component'
     and effective_to is null;
  if n is distinct from 1 then
    raise exception 'Expected exactly one open-ended pick/component line, found %', n;
  end if;

  -- The card as a WHOLE, counted in the table rather than at the insert.
  --
  -- `get diagnostics row_count` above says how many rows this statement wrote.
  -- It cannot say how many are now there, which is the question that matters:
  -- 18 inserted on top of 1 that escaped the delete is 19, and it reported
  -- success. That is precisely how an activated peak line used to end up
  -- duplicated (see the delete above), and it is the only assertion here that
  -- would have caught it.
  --
  -- Not scoped to a date, deliberately. Every per-line assertion above is
  -- scoped to effective_from = '2026-01-01', which is exactly the scoping that
  -- made the duplicate invisible: a second peak row dated '2026-11-01' falls
  -- outside every one of them.
  select count(*) into n from client_warehouse_rates
   where client_id = cid and charge_type is not null;
  if n is distinct from 18 then
    -- Plain % only. RAISE is not format(): its sole placeholder is %, so a %L
    -- here would be read as "% then a literal L" and would paste the uuid in
    -- unquoted with an L stuck to it. quote_literal does the quoting instead.
    raise exception 'Nayax should hold 18 structured rate lines, holds %. More '
                    'than 18 means a row escaped the delete and is now '
                    'duplicated; fewer means something outside this file '
                    'removed one. List them with: select charge_type, variant, '
                    'effective_from, effective_to from client_warehouse_rates '
                    'where client_id = % and charge_type is not null '
                    'order by charge_type, variant, effective_from;',
                    n, quote_literal(cid);
  end if;

  -- The peak line by name, because it is the one whose dates are MEANT to
  -- change and therefore the one a date-scoped check cannot protect. Two of
  -- these multiply every pick-and-pack total on the invoice.
  select count(*) into n from client_warehouse_rates
   where client_id = cid and charge_type = 'surcharge' and variant = 'peak';
  if n is distinct from 1 then
    raise exception 'Expected exactly one surcharge/peak line for Nayax, found %. '
                    'Two of them bill the surcharge twice over, or once from '
                    'whichever row sorts first; zero removes hasPeakLine and '
                    'lets the undated 8%% back in through the fallback at '
                    'load-charge-inputs.ts:392.', n;
  end if;
end $$;

-- =============================================================================
-- Which of the eighteen are billable today, and why fourteen are not
-- =============================================================================
--
-- Billable today (3 of 18):
--   pick/device      — calculator:117 picks the rate when isComponent = false
--   pick/component   — calculator:117 picks the rate when isComponent = true
--   shipping         — calculator:190 uses rateFor('shipping', null, shipDate)
--
-- Becomes billable once the peak window is known (1 more):
--   surcharge/peak   — see the comment above; disabled by the empty date range
--
-- Not yet billable (14 of 18) — this is deliberate, not an oversight.
-- Seeding an unbillable line puts the agreed price on record and makes the gap
-- visible as an unbilled service rather than as silence. A missing charge
-- surfaces in leaks_monthly as picked-but-never-billed and is recoverable; a
-- fabricated one is not.
--
--   receiving x4     no sync fetches inbound receipts
--   storage x2       built in Task 18 (needs an inventory snapshot table)
--   pick/carton      calculator's pick variant is binary: device | component only
--   pick/pallet_scan same — carton and pallet picks are not recorded
--   pick/pallet      same
--   pack/pallet_shrink_wrap  pack is looked up by device|component only;
--                    Nayax includes packing in the pick rate (spec §5.7)
--   return/box       no returns-received data feed exists
--   return/unit      same
--   return/labour_hour same
--   material/packing no per-shipment box-size data; billing at cost+15% needs
--                    packaging purchase records per shipment
--
-- =============================================================================

-- Every line must be either priced or explicitly at_cost. This returns rows
-- only if something was typed wrong.
--
-- Deliberately UNSCOPED: this is a whole-table invariant, not a check on this
-- paste. A hit may therefore belong to another client — for instance a row
-- created through the rate-upload endpoint with a null rate — so read
-- client_id before concluding that this file is at fault.
select client_id, label, rate_type, rate
from client_warehouse_rates
where rate is null
  -- NULL IS DISTINCT FROM 'at_cost' is true when rate_type is null, unlike
  -- NULL <> 'at_cost' which evaluates to NULL (not TRUE) and silently passes
  -- the worst-case typo — a row with both a null rate and a null rate_type.
  -- This trap has bitten this branch three times in three different SQL dialects.
  and rate_type is distinct from 'at_cost';

-- The calculator finds rates by (charge_type, variant), so a null charge_type
-- is a line that exists on the quote and can never be billed. This must also
-- return nothing.
select label from client_warehouse_rates
where effective_from = '2026-01-01' and charge_type is null;

-- The check on the two billable pick variants used to live here as a third
-- trailing query grouped by variant across the whole table. It now lives inside
-- the DO block above, scoped to this client and this effective_from, because
-- the unscoped form returns a clean-looking two rows as soon as a second client
-- is seeded with correct variants — on the lines that carry the revenue.
