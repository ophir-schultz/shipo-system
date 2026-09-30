-- Nayax rate card, transcribed from the quote. Labels are the quote's own words.
-- Spec: docs/superpowers/specs/2026-09-29-complete-the-ledger-design.md §6
--
-- Requires: supabase/ledger_03_charges.sql applied first.
--   ledger_03 drops the NOT NULL constraints on service_type and rate, and adds
--   effective_from / effective_to. Without it this insert fails.
--
-- Safe to run more than once: it deletes this client's seeded rows first.
-- The delete keyed on effective_from = '2026-01-01' cannot touch legacy rows
-- because ledger_03 added effective_from with no backfill — all pre-existing
-- rows have effective_from = null and the predicate never matches them.
--
-- RATES ARE CHANGED BY EDITING THIS FILE, NEVER THE TABLE. The delete
-- identifies seeded rows by effective_from = '2026-01-01'. Any row whose
-- effective_from is hand-edited in the database escapes that delete, and a
-- re-run of this file inserts a duplicate beside it — two rows for the same
-- (charge_type, variant), which is the self-overlapping card the dated lookup
-- exists to prevent (calculate-charges.ts:91-98 calls it a data error and
-- resolves it by sort order). "Safe to run more than once" holds only while
-- this file is the single source of these eighteen rows.
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

  delete from client_warehouse_rates
   where client_id = cid and effective_from = '2026-01-01';

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
    -- the delete above identifies seeded rows by effective_from = '2026-01-01',
    -- so a hand-edited row escapes it and the next re-run inserts a second peak
    -- line beside it. See the header.
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
