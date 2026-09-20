# Shipo — Google Ads Landing Page (copy + layout)

_Prepared 2026-08-11. Owner: Ophir. Status: build-ready copy. Pairs with `google-ads-strategy.md`._

---

## 0. Ground rules (read first)

- **Do NOT point ads at the homepage.** This is a dedicated, message-matched page. Ad → page headline must echo the search term.
- **Message match:** the page headline mirrors the ad. An FBA-prep click lands on FBA-prep language; a DTC click on DTC language. Simplest v1 = **one strong page** with an anchored section per intent. Later = 3 URL variants (`/fba-prep`, `/dtc-fulfillment`, `/delaware`) each with its own hero.
- **One job:** get a quote request or booked call. Every section drives to the same form / call CTA. No nav that leaks away, no blog links, no footer rabbit holes.
- **🚩 Claim flags carry over from the strategy doc.** Anything marked _(verify)_ below must be confirmed true by Ophir before it ships. Placeholders in `[[double brackets]]` need a real value.
- **Delaware "no sales tax"** is used as a **location fact only** — never phrased as tax advice.

---

## 1. Page-level spec

| Item | Spec |
|---|---|
| URL | `shipousa.com/get-quote` (or `/fba-prep`, `/dtc-fulfillment`, `/delaware` for variants) |
| Build | WordPress/Elementor on shipousa.com **or** standalone Next.js page — your call |
| Nav | **Stripped.** Logo (non-linking or → top of page), phone number, and the CTA button only. No full site menu. |
| Performance | Mobile LCP < 2.5s. Compress hero image, lazy-load below-fold, no heavy sliders. |
| Mobile | Sticky click-to-call bar + sticky "Get a Quote" button at bottom. Form reachable in one thumb-scroll. |
| Tracking | Form submit fires conversion on the **thank-you page**. Call button fires call conversion. (See strategy §10.) |
| Trust | Real logos/reviews only. **No fabricated logos, counts, or star ratings.** |

---

## 2. Above the fold (hero)

**Headline (H1) — swap per intent variant:**
- FBA variant: **Amazon FBA Prep & Forwarding — Delaware, No Sales Tax**
- DTC variant: **3PL Fulfillment for Growing Brands — Delaware-Based**
- Delaware variant: **Ship From Delaware — No State Sales Tax**
- One-page default: **FBA Prep & Ecommerce Fulfillment — Delaware, No Sales Tax**

**Subhead (one line):**
> Send us your inventory. We receive, prep, store, and ship — to Amazon FBA or straight to your customers — from our Delaware fulfillment center.

**Primary CTA button:** `Get a Quote` (anchor-scrolls to the form)
**Secondary CTA:** `Book a Call` → [[Calendly / booking link]] · or `Call [[business phone]]`

**Hero supporting bullets (3, scannable):**
- Amazon-compliant FBA prep, labeling & forwarding
- DTC pick, pack & ship with store integrations
- Delaware base — **0% state sales tax** _(location fact)_

**Form (above the fold, right side on desktop / below hero on mobile):**
Fields — keep it short:
- Name
- Email
- Monthly order / unit volume _(dropdown: <500 · 500–2k · 2k–10k · 10k+)_
- What you need _(dropdown: FBA Prep · DTC Fulfillment · Both · Not sure)_
- Store platform _(optional: Amazon · Shopify · WooCommerce · Other)_

Button: `Get My Quote` → on submit, redirect to `/thank-you` (fires conversion).
Microcopy under button: _No spam. We reply with pricing within [[X business hours — verify]]._

---

## 3. Trust bar (immediately under hero)

A thin strip of proof. **Only real items** — pull whatever is genuinely true:
- Real client logos, if you have permission _(verify + get consent)_
- Integrations you actually support: Amazon, Shopify, WooCommerce, [[others]] _(verify)_
- "Real-time inventory & order tracking" _(verify — Zenventory-backed, likely true)_
- Delaware, USA — East Coast shipping reach

> If you have zero logos/reviews today, use integration badges + the Delaware/tax fact + a plain "Founder-led, responsive support" line. **Do not invent social proof.**

---

## 4. How it works (3 steps)

**Section title:** How Shipo Works

1. **Send us your inventory** — Ship to our Delaware center. We receive and check it in. _(add: typical check-in time — verify before stating any number)_
2. **We prep & store** — FBA prep, labeling, kitting, and storage — or ready-to-ship DTC stock. Compliant and tracked.
3. **We ship** — Forward to Amazon FBA, or pick/pack/ship your DTC orders as they come in. You see status in real time _(verify)_.

CTA under section: `Get a Quote`

---

## 5. Services (two clear columns)

**Amazon FBA Sellers**
- Receiving & inspection
- FBA prep, labeling, poly-bagging, bundling
- Freight forwarding to Amazon FBA
- Buffer / overflow storage between shipments

**DTC / Ecommerce Brands**
- Store integration (Shopify, WooCommerce, Amazon, [[more]] — _verify_)
- Pick, pack & ship
- Kitting & bundles
- Returns handling _(verify you offer this)_

CTA: `Talk to a Fulfillment Specialist`

---

## 6. Why Delaware (the differentiator)

**Title:** Why Base Your Inventory in Delaware?

- **0% state sales tax** — a Delaware location fact. _(Do not phrase as tax advice. If a visitor asks what it means for them, "talk to your tax advisor.")_
- **East Coast reach** — fast ground coverage to the dense Northeast/Mid-Atlantic population.
- **One roof** — prep, storage, and fulfillment in the same facility; no handoffs between vendors.

---

## 7. Objection-handlers / FAQ (short)

- **What volume do you work with?** From [[X]] to [[Y]] orders/month — _verify your real floor/ceiling_.
- **How is pricing structured?** Custom to your volume and services. Request a quote and we'll send real numbers.
- **Do you integrate with my store?** [[List real integrations]] _(verify)_.
- **How fast do you turn around prep / orders?** [[State only a number you can hit — verify. If unsure, say "we'll confirm turnaround for your volume on your quote call."]]
- **Where are you located?** Delaware, USA.

---

## 8. Final CTA block

**Headline:** Get a Custom Quote for Your Volume
**Sub:** Tell us your monthly volume and what you need — we'll send pricing built for your business.
**Buttons:** `Get a Quote` (form) · `Book a Call` ([[booking link]]) · `Call [[phone]]`

---

## 9. Thank-you page (`/thank-you`) — REQUIRED

This page exists so the conversion can fire. Do not skip it.
- Copy: **Thanks — we've got your request.** We'll reply with pricing within [[X business hours — verify]]. Want to talk sooner? `Book a call` [[link]] or call [[phone]].
- **Conversion tag fires on load of this page** (form-submit conversion). QA with Google Tag Assistant before spend.

---

## 10. What I need from you to finalize copy

1. **Verify the flagged claims** _(verify)_: real-time tracking, turnaround/response times, integrations list, returns handling, volume floor/ceiling, reply-time promise.
2. **Real trust assets:** any client logos (with consent), reviews, or integration badges — or confirm we launch without them.
3. **Business phone** for the call button + `[[booking link]]` (Calendly or similar) if you want "Book a Call."
4. **Build target:** WordPress/Elementor on shipousa.com, or a standalone Next.js page? (Changes who builds it and how tracking is installed.)
5. **Pricing line:** confirm we keep it gated ("custom quote") — matches your existing pricing-gated stance.

Once you confirm #1–#4, I finalize exact copy (no placeholders) and hand a section-by-section build sheet to whoever builds the page.
