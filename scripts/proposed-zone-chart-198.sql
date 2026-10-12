-- =====================================================================
-- PROPOSED zone_chart changes for origin_prefix '198'  (Wilmington, DE)
-- Generated 2026-09-29. NOTHING HAS BEEN EXECUTED. Review before running.
--
-- !!! CORRECTION 2026-09-29 — READ BEFORE RUNNING SECTION B !!!
--   The premise below ("all traffic is USPS") is FALSE. It was inferred from
--   the shipments table, but src/lib/sync/shipstation.ts hardcodes
--   carrierCode:'stamps_com', so the DB only ever contained USPS. Measured
--   against ShipStation directly over the last 30 days: 776 of 1,095
--   shipments (71%) are UPS.
--
--   Consequence: zone_chart holding a UPS chart is CORRECT for the majority
--   of real traffic. SECTION B WOULD MAKE PRICING WORSE — do not run it.
--   Section A remains valid and safe: those 14 prefixes are territories and
--   offshore states absent from the table entirely, and UPS and USPS agree
--   on them.
--
-- WHY THIS EXISTS (original, partly superseded — see correction above)
--   The 223 shipments then in the system were all STAMPS_COM (USPS). But
--   zone_chart holds a UPS ground chart: no zone 1 anywhere, and 198->198
--   is zone 2 (UPS minimum) where USPS rates that lane as zone 1.
--   The table has no carrier column, so it can only hold one carrier's chart
--   — which is a real limitation now that both carriers are in play.
--
-- SOURCE
--   USPS postcalc.usps.com DomesticZoneChart, origin 198,
--   effective September 1, 2026. Retrieved 2026-09-29.
--   5-digit overrides applied where they apply to all mail services.
--
-- MEASURED IMPACT OF SECTION B
--   169 of 190 then-priced shipments already agree with the USPS chart.
--   21 shift zone. Net billing change: +$1.34 total.
--   But see the correction: that sample was USPS-only by construction.
-- =====================================================================


-- ---------------------------------------------------------------------
-- SECTION A — ADDITIONS (14 rows the DB is missing entirely)
-- This is the section that fixes the unpriced shipments. It is purely
-- additive and cannot change the price of anything already priced.
-- Simulated effect: prices 5 of the 33 unpriced shipments.
-- ---------------------------------------------------------------------
INSERT INTO zone_chart (origin_prefix, dest_prefix, zone) VALUES
  ('198', '006', 7),
  ('198', '007', 7),
  ('198', '008', 7),
  ('198', '009', 7),
  ('198', '340', 6),
  ('198', '876', 8),
  ('198', '967', 8),
  ('198', '968', 8),
  ('198', '969', 8),   -- from USPS 5-digit table (all services)
  ('198', '995', 8),
  ('198', '996', 8),
  ('198', '997', 8),
  ('198', '998', 8),
  ('198', '999', 8)
ON CONFLICT DO NOTHING;


-- ---------------------------------------------------------------------
-- SECTION A-EXCLUDED — 15 prefixes deliberately NOT inserted
-- USPS gives these a different zone depending on the mail SERVICE, and
-- zone_chart has no service column. Inserting either value would be wrong
-- for the other half of the services. No shipment has ever gone to one of
-- these, so leaving them absent keeps the failure loud instead of silent.
-- ---------------------------------------------------------------------
--   090: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   091: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   092: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   093: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   094: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   095: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   096: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   097: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   098: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   099: 3-digit table says zone 2; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   962: 3-digit table says zone 8; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   963: 3-digit table says zone 8; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   964: 3-digit table says zone 8; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   965: 3-digit table says zone 8; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5
--   966: 3-digit table says zone 8; Priority Mail service -> zone 5; USPS Ground Advantage (< 16 oz.) -> zone 5


-- ---------------------------------------------------------------------
-- SECTION B — ZONE CORRECTIONS (83 rows where DB disagrees with USPS)
-- OPTIONAL and SEPARATE. These change prices on already-billed shipments
-- (net +$1.34). Do not run this in the same breath as Section A.
-- ---------------------------------------------------------------------
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='019';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='026';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='031';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='032';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='033';  -- was 3
-- UPDATE zone_chart SET zone = 3 WHERE origin_prefix='198' AND dest_prefix='066';  -- was 2
-- UPDATE zone_chart SET zone = 3 WHERE origin_prefix='198' AND dest_prefix='068';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='080';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='081';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='083';  -- was 2
-- UPDATE zone_chart SET zone = 3 WHERE origin_prefix='198' AND dest_prefix='169';  -- was 2
-- UPDATE zone_chart SET zone = 2 WHERE origin_prefix='198' AND dest_prefix='170';  -- was 3
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='175';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='176';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='189';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='190';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='191';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='192';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='193';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='194';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='195';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='196';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='197';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='198';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='210';  -- was 2
-- UPDATE zone_chart SET zone = 1 WHERE origin_prefix='198' AND dest_prefix='219';  -- was 2
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='273';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='275';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='276';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='277';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='284';  -- was 5
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='303';  -- was 6
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='304';  -- was 4
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='307';  -- was 4
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='313';  -- was 4
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='314';  -- was 4
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='332';  -- was 5
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='334';  -- was 6
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='341';  -- was 5
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='374';  -- was 4
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='396';  -- was 5
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='405';  -- was 5
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='421';  -- was 4
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='422';  -- was 4
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='442';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='446';  -- was 3
-- UPDATE zone_chart SET zone = 4 WHERE origin_prefix='198' AND dest_prefix='447';  -- was 3
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='478';  -- was 4
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='479';  -- was 4
-- UPDATE zone_chart SET zone = 5 WHERE origin_prefix='198' AND dest_prefix='494';  -- was 4
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='500';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='505';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='508';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='514';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='553';  -- was 5
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='587';  -- was 6
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='641';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='644';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='645';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='647';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='649';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='660';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='661';  -- was 5
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='662';  -- was 5
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='679';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='693';  -- was 6
-- UPDATE zone_chart SET zone = 6 WHERE origin_prefix='198' AND dest_prefix='728';  -- was 5
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='733';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='739';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='768';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='779';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='786';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='787';  -- was 6
-- UPDATE zone_chart SET zone = 7 WHERE origin_prefix='198' AND dest_prefix='792';  -- was 6
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='799';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='821';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='830';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='865';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='873';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='878';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='879';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='880';  -- was 7
-- UPDATE zone_chart SET zone = 8 WHERE origin_prefix='198' AND dest_prefix='885';  -- was 7


-- ---------------------------------------------------------------------
-- SECTION C — PRESENT IN DB, NOT IN USPS CHART (1)
-- ---------------------------------------------------------------------
--   198 -> 569 (zone 6) is not a USPS destination prefix


-- ---------------------------------------------------------------------
-- SECTION D — STILL UNPRICEABLE AFTER ALL OF THE ABOVE
-- ---------------------------------------------------------------------
--   Zone > 8 in Section A: none — 969 resolves to zone 8 via the 5-digit table
--
--   International destinations have no ZIP prefix and can never be priced
--   by this table. Observed: 1 shipment to UK postcode W9 3BA
--   (Suteka, usps_first_class_mail_international).
