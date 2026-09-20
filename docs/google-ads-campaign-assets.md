# Shipo — Google Ads Campaign Assets (upload-ready)

_Prepared 2026-08-11. Owner: Ophir. Budget: $1,200/mo (~$40/day). Pairs with `google-ads-strategy.md` + `google-ads-landing-page.md`._

> **Nothing here spends money until Ophir creates the account and adds billing.** This is the drop-in build sheet.
> 🚩 = claim to verify before it runs. `[[brackets]]` = value Ophir must supply.

---

## 0. Global settings (set once, at campaign level)

| Setting | Value |
|---|---|
| Networks | **Search only.** Display OFF. Search Partners OFF. |
| Locations | United States (target: *presence* — "people in", not "interested in") |
| Language | English |
| Devices | All. Review mobile vs desktop after 2 weeks. |
| Budget | C1 $18/day · C2 $16/day · C3 $6/day (≈ $40/day total = ~$1,200/mo) |
| Bidding | **Maximize Clicks + max CPC ceiling ~$20** for weeks 1–2 → Max Conversions after 15–30 conv → tCPA later |
| Ad rotation | Optimize (let Google serve best RSA combos) |
| Match types | **Phrase + Exact only.** No broad at launch. |
| Schedule | All days at launch; add weekday day-parting after 2 weeks of data |

---

## 1. Keywords — upload-ready

Format below: `[exact]` and `"phrase"`. Paste into Google Ads Editor with the matching ad group.

### Campaign 1 — FBA Prep & Forwarding

**Ad Group 1a — FBA Prep Center**
```
[fba prep center]
"fba prep center"
[amazon fba prep service]
"amazon fba prep service"
[fba prep and forwarding]
"fba prep and forwarding"
[amazon prep center]
"amazon prep center"
[fba prep company]
"fba prep company"
[third party fba prep]
"third party fba prep"
```

**Ad Group 1b — Amazon Receiving / Forwarding**
```
[amazon fba forwarding]
"amazon fba forwarding"
[us receiving for amazon sellers]
"us receiving for amazon sellers"
[amazon prep and ship]
"amazon prep and ship"
[fba freight forwarding]
"fba freight forwarding"
[amazon inventory forwarding]
"amazon inventory forwarding"
```

### Campaign 2 — 3PL / DTC Fulfillment

**Ad Group 2a — 3PL Fulfillment**
```
[3pl fulfillment company]
"3pl fulfillment company"
[3pl fulfillment services]
"3pl fulfillment services"
[third party logistics fulfillment]
"third party logistics fulfillment"
[3pl provider usa]
"3pl provider usa"
[outsourced fulfillment company]
"outsourced fulfillment company"
```

**Ad Group 2b — Ecommerce / DTC Fulfillment**
```
[ecommerce fulfillment services]
"ecommerce fulfillment services"
[dtc fulfillment]
"dtc fulfillment"
[shopify fulfillment service]
"shopify fulfillment service"
[order fulfillment company]
"order fulfillment company"
[d2c fulfillment services]
"d2c fulfillment services"
```

### Campaign 3 — Delaware / No-Sales-Tax

**Ad Group 3a — Delaware Fulfillment**
```
[delaware fulfillment center]
"delaware fulfillment center"
[delaware 3pl]
"delaware 3pl"
[fulfillment center delaware]
"fulfillment center delaware"
[no sales tax fulfillment center]
"no sales tax fulfillment center"
[tax free state warehouse]
"tax free state warehouse"
```

---

## 2. Negative keywords — ACCOUNT-LEVEL list (add day one)

Create a shared negative list named **"Shipo — Global Negatives"** and apply to all 3 campaigns.
```
jobs
job
career
careers
salary
hiring
free
diy
how to
software
wms
platform
login
seller central
for rent
for lease
for sale
warehouse space
real estate
lease
car
vehicle
moving
personal
cheapest
template
course
certification
internship
```
> Then check the **Search Terms report weekly** and keep adding negatives. This is where most wasted spend gets cut.

---

## 3. Responsive Search Ads (RSA)

Rules: headlines ≤ 30 chars, descriptions ≤ 90 chars. Provide all headlines below so Google mixes combos. **Pin 1 intent headline to position 1** per ad group. Build **1 RSA per ad group** at launch (add a 2nd variant in week 2).

Final URL: the matching landing-page variant. Display path: `/fba-prep`, `/fulfillment`, `/delaware`.

---

### Campaign 1 (FBA Prep) — RSA

**Headlines** (pin "Amazon FBA Prep & Forwarding" to pos 1):
```
Amazon FBA Prep & Forwarding
Delaware FBA Prep Center
FBA Prep — No Sales Tax
US Receiving for FBA Sellers
Prep, Label, Forward to FBA
Compliant FBA Prep Service
Your Amazon Prep Partner
Skip FBA Prep Headaches
Real-Time Inventory Tracking      🚩verify
Save on Amazon Prep Fees          🚩verify
Get an FBA Prep Quote
Talk to a Prep Specialist
```

**Descriptions:**
```
Amazon FBA prep, labeling & forwarding from our Delaware center. No sales tax. Get a quote.
Ship inventory to us — we prep and forward to Amazon FBA. Compliant, tracked, reliable.
Book a call with a Shipo prep specialist for a custom quote based on your volume.
Growing Amazon seller? Offload prep to a US 3PL built for FBA. Request pricing today.
```

---

### Campaign 2 (3PL / DTC) — RSA

**Headlines** (pin "3PL Fulfillment for Brands" to pos 1):
```
3PL Fulfillment for Brands
Ecommerce Order Fulfillment
Shopify & DTC Fulfillment
Delaware-Based 3PL
Fulfillment That Scales
Fast, Accurate Order Ship        🚩verify
Real-Time Order Tracking         🚩verify
Outsource Your Fulfillment
Get a Fulfillment Quote
Talk to a Fulfillment Expert
Pick, Pack & Ship for DTC
No Sales Tax — Delaware 3PL
```

**Descriptions:**
```
Pick, pack & ship for DTC brands from our Delaware 3PL. Integrations + real-time tracking.
Outgrowing your garage? Shipo handles fulfillment so you can scale. Get a custom quote.
Shopify, WooCommerce & more — connect your store and we ship your orders. Book a call.
Delaware 3PL with no sales tax advantage. Reliable fulfillment for growing brands.
```

---

### Campaign 3 (Delaware) — RSA

**Headlines** (pin "Delaware Fulfillment Center" to pos 1):
```
Delaware Fulfillment Center
Ship From No-Sales-Tax State
Delaware 3PL & Prep
East Coast Fulfillment Hub
Fulfillment, Delaware-Based
Get a Delaware 3PL Quote
FBA Prep & DTC in Delaware
No State Sales Tax
Talk to a Fulfillment Expert
```

**Descriptions:**
```
Fulfillment & FBA prep from Delaware — no state sales tax. Fast East Coast shipping reach.
Base your inventory in Delaware. Prep, storage & fulfillment under one roof. Get a quote.
Delaware 3PL for Amazon sellers & DTC brands. Custom pricing for your volume — get a quote.
Ship from a 0% state sales tax location. Reliable Delaware fulfillment. Book a call.
```

---

## 4. Ad assets / extensions (add all applicable)

**Sitelinks** (final URLs → matching page anchors):
```
FBA Prep            → /get-quote#fba
DTC Fulfillment     → /get-quote#dtc
How It Works        → /get-quote#how
Get a Quote         → /get-quote#form
```

**Callouts:**
```
Delaware — No Sales Tax
Real-Time Tracking        🚩verify
Dedicated Support
FBA-Compliant
Store Integrations         🚩verify
```

**Structured snippet** (header: Services):
```
FBA Prep, Kitting, Storage, Forwarding, Pick & Pack
```

**Call asset:** `[[business phone]]` with Google call reporting ON.
**Lead form asset:** optional backup to the landing page.
**Location asset:** add only if you want the Delaware address publicly shown.

---

## 5. Conversion tracking checklist (MUST be live BEFORE spend)

Hand this to whoever installs the tag. **No tracking = don't launch.**

- [ ] Install **Google tag (gtag)** on shipousa.com — via Site Kit, GTM, or direct in `<head>`.
- [ ] Create conversion action: **Quote form submit** (primary) — fires on `/thank-you` page load.
- [ ] Create conversion action: **Phone call from ad** (Google forwarding number).
- [ ] (Optional) **Call ≥60s from website** conversion.
- [ ] Link **GA4** ↔ **Google Ads**.
- [ ] Redirect form success → `/thank-you`, confirm tag fires there.
- [ ] QA every conversion with **Google Tag Assistant** before enabling campaigns.
- [ ] Set primary conversion = form submit; secondary = calls.

---

## 6. Launch-day checklist (order matters)

1. [ ] Landing page + `/thank-you` live and fast (< 2.5s mobile LCP).
2. [ ] Conversion tracking QA'd green (§5).
3. [ ] All flagged 🚩 claims verified or removed.
4. [ ] Account: Search-only, Display + Search Partners OFF, US/English.
5. [ ] Global negatives list applied to all 3 campaigns.
6. [ ] Keywords loaded (phrase + exact only).
7. [ ] 1 RSA per ad group, intent headline pinned to pos 1.
8. [ ] Extensions attached.
9. [ ] Budgets set ($18 / $16 / $6 day), Max Clicks + $20 CPC ceiling.
10. [ ] `[[business phone]]` + call reporting on.
11. [ ] Ophir has added billing. → **Enable.**

---

## 7. Values Ophir still owes (blocks launch)

- `[[business phone]]` — for the call asset + call conversion.
- 🚩 Verify: real-time tracking, turnaround/"fast", any %/guarantee, integrations list, "save on prep fees."
- `[[booking link]]` — if using "Book a Call."
- Final call: WordPress vs Next.js page (affects tag install path).
- Create the Google Ads account + add payment (**I never enter payment details**).
