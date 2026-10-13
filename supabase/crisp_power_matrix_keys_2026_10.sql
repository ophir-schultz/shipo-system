-- Crisp Power's zone matrix is keyed on carrier alone. Decide whether that is
-- the agreement, and narrow it if it is not.
--
-- READ THIS FIRST. Only PART 3 writes, and it is commented out. Everything
-- else is a select.
--
-- THE SUPABASE EDITOR SHOWS ONLY THE LAST STATEMENT'S RESULT when you paste a
-- batch. Paste one PART at a time.
--
-- NOTHING IS MISPRICED TODAY, and that is the reason to look now rather than
-- later. Crisp Power has one shipment in the whole table -- a Stamps.com
-- parcel on 2026-07-01 -- so no UPS shipment has ever met these cells. The
-- defect is latent, and the first UPS label they buy is what exposes it.
--
-- WHAT IS ACTUALLY WRONG. All 216 cells are keyed carrier='UPS', service=''.
-- A cell is BLANKET only when BOTH keys are empty (see isBlanket in
-- src/lib/billing/zones.ts), so these are tier-1 cells with a service key that
-- means "any". Since 2026-10-13 the matrix is matched with cardRowCovers
-- rather than `.eq()`, and an empty service key passes that test
-- unconditionally. Every UPS service therefore draws the SAME cell for a given
-- weight and zone: Ground, Next Day Air and Standard International would all
-- bill at one price. If these 216 rates are a ground table, a next-day-air
-- parcel bills at the ground rate -- a real number, on an invoice, with
-- nothing to distinguish it from a correct one.
--
-- Before 2026-10-13 the same rows were simply unreachable: the old `.eq()`
-- read needed service='' to equal the shipment's service, which never happens,
-- and Crisp Power has no blanket cell to fall back to. The cells are not newly
-- wrong. They are newly LIVE.
--
-- THE DECISION THIS FILE CANNOT MAKE. Whether to narrow the key depends on
-- what Crisp Power agreed, and that is not in the database:
--
--   A. The 216 rates are a UPS GROUND table. Then service='' is wrong, PART 3
--      narrows it, and a next-day-air parcel goes unpriced instead of being
--      billed at the ground rate. Unpriced is the safe failure -- it is
--      visible in the unpriced reports, and a wrong price is not visible
--      anywhere.
--
--   B. The 216 rates are a single all-UPS-services price. Then service='' is
--      CORRECT and PART 3 must not run. Leave the data alone.
--
-- There is no evidence here that separates A from B. One shipment, and not a
-- UPS one. PART 1 and PART 2 gather what the database does hold so the
-- agreement can be recognised; the agreement itself decides.
--
-- WHY THIS IS NOT LIKE THE ATTRIBUTION BACKFILL. That file could not be
-- undone, because the values it overwrote were the only record of a hand
-- decision. This one can: every one of the 216 cells holds the same service
-- value today, '', so setting them to 'Ground' destroys no information and
-- PART 4 names the statement that puts them back. Reversible is not the same
-- as harmless -- a wrong narrowing leaves UPS shipments unpriced until someone
-- notices -- but it does mean the risk here is a delay, not a loss.


-- ---------------------------------------------------------------------------
-- PART 1 -- the shape of the 216 cells.
-- ---------------------------------------------------------------------------
-- Read-only. Weight and zone span, and the rate range, because a table that
-- runs to 150 LB is a ground table and one that stops at a few pounds is not.
-- This is recognition evidence, not proof.
select
  z.carrier,
  z.service,
  count(*)                        as cells,
  count(distinct z.weight_lb)     as weights,
  min(z.weight_lb)                as min_weight_lb,
  max(z.weight_lb)                as max_weight_lb,
  count(distinct z.zone)          as zones,
  min(z.zone)                     as min_zone,
  max(z.zone)                     as max_zone,
  min(z.rate::numeric)            as min_rate,
  max(z.rate::numeric)            as max_rate
from client_zone_rates z
join clients c on c.id = z.client_id
where c.name = 'Crisp Power'
group by 1, 2
order by 3 desc;

-- HOW TO READ IT. One row is expected: UPS / '' / 216. A SECOND row would
-- change the problem -- two key pairs on one client is the arrangement that
-- makes pickZoneCell's ambiguity refusal reachable, and PART 3 as written
-- would then be too broad.


-- ---------------------------------------------------------------------------
-- PART 2 -- what else the database knows about Crisp Power.
-- ---------------------------------------------------------------------------
-- Read-only. The legacy card is the best available witness: if it names
-- services, whoever wrote it had a view about which services are priced, and
-- the matrix was probably loaded under the same understanding.
select
  'legacy card'                   as source,
  coalesce(r.carrier, '<null>')   as carrier,
  coalesce(r.service, '<null>')   as service,
  r.weight_min::text              as detail_a,
  r.weight_max::text              as detail_b,
  r.rate::text                    as rate
from client_shipping_rates r
join clients c on c.id = r.client_id
where c.name = 'Crisp Power'

union all

-- Every shipment they have. Expected: exactly one, Stamps.com, 2026-07-01.
-- If a UPS shipment appears here, the matrix is already pricing and PART 3
-- stops being a precaution.
select
  'shipment',
  coalesce(s.carrier, '<null>'),
  coalesce(s.service, '<null>'),
  s.ship_date::date::text,
  coalesce(s.client_rate::text, 'UNPRICED'),
  s.actual_cost::text
from shipments s
join clients c on c.id = s.client_id
where c.name = 'Crisp Power'

order by 1, 2, 3;


-- ---------------------------------------------------------------------------
-- PART 3 -- THE WRITE. Run this ONLY under interpretation A.
-- ---------------------------------------------------------------------------
-- Commented out on purpose. Do not uncomment it to see what it would do --
-- PART 1 and PART 2 are what show that.
--
-- 'Ground' rather than a ShipStation code, because the matrix is matched with
-- cardRowCovers and the short display name is what covers the codes. 'Ground'
-- covers 'ups_ground_saver' and 'ups_ground'; 'ups_ground_saver' would NOT
-- cover a plain 'ups_ground' shipment. This is the same convention Orcam's
-- matrix uses, and Orcam's 34 shipments are what demonstrate it matching.
--
-- 'Ground' on its own would be dangerous -- it also appears in
-- 'usps_ground_advantage'. It is safe here only because cardRowCovers requires
-- the CARRIER to pass as well, and neither 'stamps_com' nor 'ups' contains the
-- other. Do not narrow the service key while widening or removing the carrier
-- key; the carrier key is what makes this one sound.
--
-- `and coalesce(service, '') = ''` is load-bearing: it is what makes the
-- statement re-runnable (a second run matches nothing, because the rows now
-- say 'Ground') and what stops it touching a cell someone has already keyed.
--
-- update client_zone_rates
--    set service = 'Ground'
--  where client_id = (select id from clients where name = 'Crisp Power')
--    and carrier = 'UPS'
--    and coalesce(service, '') = '';
--
-- The row count MUST be 216, matching PART 1. Fewer means some cells were
-- already keyed and PART 1 should have shown two rows. More means the cell
-- count changed between reading and writing, and PART 4 before anything else.


-- ---------------------------------------------------------------------------
-- PART 4 -- after, and the undo.
-- ---------------------------------------------------------------------------
-- Read-only. Run it before PART 3 as the baseline and after as the result.
-- The service column should move from '' to 'Ground' on all 216 rows, and
-- `cells` must not change -- this statement renames a key, it does not add or
-- remove a rate.
select
  coalesce(z.carrier, '<null>')   as carrier,
  coalesce(z.service, '<null>')   as service,
  count(*)                        as cells,
  sum(z.rate::numeric)            as rate_total
from client_zone_rates z
join clients c on c.id = z.client_id
where c.name = 'Crisp Power'
group by 1, 2
order by 3 desc;

-- rate_total is there to be compared across the two runs. It must be
-- IDENTICAL. If it moved, PART 3 did something other than what it says, and
-- the rates themselves are in question rather than the keys.
--
-- THE UNDO, if interpretation A turns out to be wrong. No information is lost
-- by PART 3 -- every affected cell held the same value, '' -- so this restores
-- the previous state exactly:
--
-- update client_zone_rates
--    set service = ''
--  where client_id = (select id from clients where name = 'Crisp Power')
--    and carrier = 'UPS'
--    and service = 'Ground';
--
-- What the undo does NOT restore is anything invoiced in between. Under
-- interpretation A a non-ground UPS shipment goes unpriced rather than wrongly
-- priced, so the exposure while this is wrong is a missing charge and not a
-- false one -- recoverable by pricing it later.
