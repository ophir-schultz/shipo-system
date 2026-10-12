# Rate-card worklist — what is missing, per client

Generated 2026-09-29 from the 33 shipments with `client_rate = 0`.
Read-only analysis. Nothing has been written to the database.

`resolveZoneRate` looks for a `client_zone_rates` row matching
`{client_id, carrier, service, weight_lb, zone}` exactly — first with the
shipment's own carrier/service, then with the blanket pair `carrier=''`,
`service=''`. Any other combination is never tried.

## Orcam — 14 unpriced

**Card today:** 800 rows, keyed `carrier="UPS" service="Ground"`

**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):

| weight_lb | zone | shipments |
|---|---|---|
| 1 | 2 | 1 |
| 1 | 4 | 2 |
| 1 | 5 | 2 |
| 1 | 6 | 1 |
| 1 | 8 | 1 |
| 2 | 3 | 1 |
| 2 | 4 | 1 |
| 2 | 5 | 1 |
| 5 | 7 | 4 |

**Their traffic is:** `STAMPS_COM / usps_parcel_select`, `STAMPS_COM / usps_ground_advantage`

**Fix:** the existing 800 rows are keyed to `carrier="UPS" service="Ground"`, which this client's traffic never matches. Either re-key them to the blanket pair `carrier=''`, `service=''`, or add a second card keyed to `carrier='STAMPS_COM'` with the real USPS rates.

---

## Suteka — 13 unpriced

**Card today:** *none at all*

**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):

| weight_lb | zone | shipments |
|---|---|---|
| 1 | 2 | 1 |
| 1 | 3 | 3 |
| 1 | 5 | 3 |
| 1 | 6 | 1 |
| 1 | 8 | 4 |
| 1 | NO ZONE | 1 |

**Their traffic is:** `STAMPS_COM / usps_first_class_mail_international`, `STAMPS_COM / usps_ground_advantage`

**Fix:** create a card. Simplest is a blanket grid `carrier=''`, `service=''`, weight_lb 1-20 x zone 1-8 = 160 cells.

---

## Kivema — 3 unpriced

**Card today:** 80 rows, keyed `carrier="" service=""`

**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):

| weight_lb | zone | shipments |
|---|---|---|
| 2 | 8 | 1 |
| 4 | 8 | 2 |

**Their traffic is:** `STAMPS_COM / usps_parcel_select`

**Fix:** the blanket card already exists and covers zones 1-8 — these fail only because the zone could not be resolved. Section A of the zone_chart proposal fixes them. No rate-card work needed.

---

## Nayax — 1 unpriced

**Card today:** 800 rows, keyed `carrier="" service=""`

**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):

| weight_lb | zone | shipments |
|---|---|---|
| 1 | 7 | 1 |

**Their traffic is:** `STAMPS_COM / usps_ground_advantage`

**Fix:** the blanket card already exists and covers zones 1-8 — these fail only because the zone could not be resolved. Section A of the zone_chart proposal fixes them. No rate-card work needed.

---

## Creative Pea — 1 unpriced

**Card today:** 160 rows, keyed `carrier="" service=""`

**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):

| weight_lb | zone | shipments |
|---|---|---|
| 3 | 8 | 1 |

**Their traffic is:** `STAMPS_COM / usps_ground_advantage`

**Fix:** the blanket card already exists and covers zones 1-8 — these fail only because the zone could not be resolved. Section A of the zone_chart proposal fixes them. No rate-card work needed.

---

## Crisp Power — 1 unpriced

**Card today:** 216 rows, keyed `carrier="UPS" service=""`

**Cells its real traffic needs** (weight_lb x zone, zone resolved via the USPS chart):

| weight_lb | zone | shipments |
|---|---|---|
| 7 | 8 | 1 |

**Their traffic is:** `STAMPS_COM / usps_ground_advantage`

**Fix:** the existing 216 rows are keyed to `carrier="UPS" service=""`, which this client's traffic never matches. Either re-key them to the blanket pair `carrier=''`, `service=''`, or add a second card keyed to `carrier='STAMPS_COM'` with the real USPS rates.

---

