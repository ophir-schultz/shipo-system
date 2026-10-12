# Why 33 shipments have `client_rate = $0`

**Date:** 2026-09-29
**Status:** Diagnosed. Nothing fixed, nothing written to the database.
**Trigger:** monitor alerts `33 shipments have no rate match` / `33 shipments have a client assigned but NO rate`

> ## ⚠️ CORRECTION — 2026-09-29, after publication
>
> **Sections 2, 3 and 6 below drew the wrong conclusion from a biased sample.**
> I reasoned from the `shipments` table, which showed 223 of 223 as USPS. But
> `src/lib/sync/shipstation.ts` hardcodes `carrierCode: 'stamps_com'`, so the
> table *could only ever* contain USPS. It is a selection artifact, not a fact
> about the business.
>
> Measured against ShipStation directly (last 30 days, no carrier filter):
> **776 of 1,095 shipments — 71% — are UPS.**
>
> | Store | USPS | UPS | Units | In Supabase |
> | --- | --- | --- | --- | --- |
> | Nayax | 0 | **309** | 8,069 | **1** |
> | Suteka | 4 | **190** | 1,792 | 13 |
> | SitnStand | 0 | **90** | 106 | **0** |
> | Kivema | 305 | 79 | 15 | 151 |
> | Orcam | 5 | **66** | 258 | 14 |
> | Time System | 0 | 16 | 20 | 1 |
> | Crisp Power | 0 | 5 | 54 | 1 |
>
> What this changes:
>
> - **§2 is wrong.** Orcam's 800 UPS rows and Crisp Power's 216 are **not dead
>   weight**. They are correctly keyed for traffic that is never synced. Do not
>   delete them.
> - **§3 is backwards.** A UPS `zone_chart` is *right* for the majority of
>   traffic. **Section B of the proposed SQL must not be run** — it would
>   convert a correct chart into a wrong one for 71% of shipments.
> - **§6 is not harmless.** The missing `{carrier, service:''}` attempt was
>   called unexercised because "Crisp Power has no UPS shipments." Crisp Power
>   ships 100% UPS. The gap bites the moment the carrier filter is fixed.
>
> The root cause is one line in the sync, not the rate data. §1, §4 and §5 are
> unaffected and still hold. Detail: `scripts/probe-store-client-gap.mjs`,
> `scripts/probe-carrier-spread.mjs`.

All analysis below is from read-only scripts in `scripts/diag-*.mjs`. No row was
inserted, updated, or deleted, and no code was changed.

---

## 1. The alert is one number hiding three unrelated problems

`recalculateShipments()` prices a shipment two ways: the zone matrix
(`client_zone_rates`), then the legacy card (`client_shipping_rates`). The
legacy path has an unconditional fallback — it takes the last row if nothing
else matches — so **any** legacy row at all guarantees a price.

Every one of the six affected clients has **zero** `client_shipping_rates`
rows. So the legacy safety net does not exist for them, and everything had to
come from the zone matrix. That is why a single missing ingredient produces a
`$0` rate rather than a rough one.

Splitting the 33 by what each actually needs:

| Need | Count | Clients |
| --- | --- | --- |
| Rate card only | 18 | Orcam 10, Suteka 8 |
| `zone_chart` territory rows only | 5 | Kivema 3, Nayax 1, Creative Pea 1 |
| Both | 10 | Orcam 4, Suteka 5, Crisp Power 1 |

Verified by simulation (`scripts/diag-simulate-fix.mjs`): applying the additive
`zone_chart` rows alone prices **5 of 33**, leaves 27 blocked on rate cards, and
leaves 1 structurally unpriceable.

---

## 2. Two clients are carded for a carrier they never ship with

> **SUPERSEDED — see the correction at the top.** The premise of this section
> is false. Those clients *do* ship UPS; the sync never fetches it. The cell
> detail below is still accurate; the conclusion is not.

**Every shipment in the system — 223 of 223 — is `STAMPS_COM` (USPS).** There
is not one UPS shipment. *(True of the table, because the sync only ever asks
for `stamps_com`. Not true of the business.)*

| Client | Rate card is keyed to | Their actual traffic |
| --- | --- | --- |
| Orcam | `carrier="UPS" service="Ground"`, 800 rows | 100% `STAMPS_COM` |
| Crisp Power | `carrier="UPS" service=""`, 216 rows | 100% `STAMPS_COM` |
| Suteka | *no card at all* | 100% `STAMPS_COM` |
| Kivema / Nayax / Creative Pea | blanket `carrier="" service=""` | 100% `STAMPS_COM` |

`resolveZoneRate` tries the shipment's own `{carrier, service}`, then the
blanket pair `{'', ''}`. A UPS-keyed card matches neither. Orcam's 800 rows and
Crisp Power's 216 rows are therefore **dead weight — they can never match
anything**, which is why 100% of Orcam's shipments are unpriced.

Per-client cell-level detail: `docs/rate-card-worklist.md`.

---

## 3. `zone_chart` is a UPS chart being used to zone USPS parcels

> **SUPERSEDED — see the correction at the top.** The chart *is* a UPS chart —
> that part is right, and the evidence below stands. But 71% of real traffic is
> UPS, so the chart is appropriate for the majority and the "wart" framing is
> backwards. **Do not run Section B.** The genuine defect is that `zone_chart`
> has no carrier column while two carriers are live.

This was not obvious and is worth recording.

| Evidence | Reading |
| --- | --- |
| 903 rows, **zero** with `zone = 1` | USPS charts include zone 1; UPS ground starts at 2 |
| `198 -> 198` (origin to itself) is zone **2** | USPS rates that lane zone 1 |
| Table columns are `origin_prefix, dest_prefix, zone` | **no carrier dimension** — it can only ever hold one carrier's chart |

So the single shared chart holds UPS ground zones, while 100% of traffic is
USPS.

**Measured impact is small.** Compared against the authoritative USPS chart
(postcalc.usps.com, origin 198, effective September 1 2026), 169 of 190 priced
shipments already agree. 21 shift zone. Net billing difference: **+$1.34**
total. Zone charts are distance-derived and largely converge, so this is a
correctness wart rather than a financial problem — but it should be recorded
before someone onboards a real UPS client and the two systems collide.

---

## 4. What the chart is missing

29 destination prefixes present in the USPS chart are absent from the database,
and they are exactly the ones that bit us — every US territory and offshore
state. 14 of them can be inserted safely; 15 cannot.

**Safe to insert (Section A):**

- `006`–`009` — Puerto Rico, US Virgin Islands (zone 7)
- `340` — APO/FPO Americas (zone 6)
- `876` — zone 8
- `967`, `968` — Hawaii (zone 8)
- `969` — Guam / N. Marianas (zone 8)
- `995`–`999` — Alaska (zone 8)

**Deliberately excluded (15):** `090`–`099` and `962`–`966`, the military
APO/FPO Europe and Pacific ranges. USPS assigns these a **different zone per
mail service** — zone 5 for Priority Mail and Ground Advantage under 16 oz,
but the 3-digit value (2 and 8 respectively) otherwise. `zone_chart` has no
service column, so either value would be wrong half the time. No shipment has
ever gone to one, so leaving them absent keeps the failure loud.

The remaining gaps in the 000–999 range are unassigned USPS prefixes, not
omissions. The contiguous-US chart is complete.

Proposed SQL, split into an additive Section A and an optional Section B:
`scripts/proposed-zone-chart-198.sql`. **Not executed.**

Two parsing traps worth knowing, both of which produced wrong output on the
first pass: the chart lists Hawaii's `967` as a 5-digit entry (`96700`) rather
than a 3-digit range, and the `+` marker means "consult the 5-digit override
table" rather than being decoration.

---

## 5. What cannot be fixed by data

### 5.1 Zone 9 — a false alarm, resolved

The 3-digit chart lists `969` (Guam, N. Marianas) as `9+`, which looked
unrepresentable: `resolveZone` rejects anything outside 1–8
(`src/lib/billing/zones.ts:55`) and no `client_zone_rates` row has `zone = 9`.

But the `+` means "see the 5-digit table," and there all four `969xx` ranges
are **zone 8, for all mail services**. So `969` is inserted as zone 8 and there
is no zone-9 problem. Recorded because the naive reading of the chart says
otherwise.

### 5.2 International has no zone at all

1 shipment to UK postcode `W9 3BA`. A domestic ZIP-prefix zone matrix
structurally cannot price it. This is the 1 shipment the simulation leaves as
`still NO ZONE`. Suteka ships `usps_first_class_mail_international`, so this
will recur.

---

## 6. Known code gap — recorded, not fixed

`resolveZoneRate` tries exactly two keyings:

```ts
const attempts = [
  { carrier, service },      // exact
  { carrier: '', service: '' },  // blanket
]
```
— `src/lib/billing/zones.ts:77-80`

It never tries `{ carrier, service: '' }`. So a **carrier-wide card** — one
priced per carrier but not per service — can only match a shipment whose
service is literally the empty string. Crisp Power's card is exactly this shape
(`carrier="UPS" service=""`), making all 216 rows unreachable.

~~This is not the cause of the current 33 (Crisp Power has no UPS shipments at
all, so the gap is never exercised)~~ — **wrong, see the correction at the top.**
Crisp Power ships 100% UPS; its shipments are simply never synced. This gap
will bite as soon as the carrier filter is fixed, and it should be fixed in the
same change rather than left alone.

It remains unfixed only because nothing has been implemented yet.

Adding `{ carrier, service: '' }` between the two existing attempts would make
carrier-wide cards work as an operator would reasonably expect.

---

## 7. Deploy safety

Every fix identified here is **Supabase rows, not code**. None of it requires a
build or a deploy. The one code change discussed (§6) is deferred.
