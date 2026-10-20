# Partner dashboard v2: bulk client intake, activity detail, reports, and the brand

**Status:** approved by Ophir 2026-10-20
**Supersedes nothing.** Extends `2026-10-13-partner-portal-disclaimer-claims-data-design.md`,
which is built and green. Read that one first; this spec assumes it.

Origin — Ophir's four bullets, verbatim:

1. Auto sign in per each partner
2. Auto sending the Docu sign to the client of the agreement and W9
3. Dashboard view — adding client (some partners have close to 100), partner sees
   his amount owed and the orders list with number of units and whether FBA or DTC,
   and a downloadable report
4. Design — Shipo colors and logo, same as the website

---

## 0. Decisions taken, 2026-10-20

Each was put to Ophir as a choice with the trade-offs stated, and each is the
answer he gave. They are the premises of everything below; a task that
contradicts one of them is wrong, not creative.

| # | Question | Decision |
|---|----------|----------|
| D1 | What is a partner in this product? | **A referrer who gets paid.** Not an account manager. Shipo owns the client relationship. |
| D2 | How does a ~100-client backlog arrive? | **A batch is a first-class object.** One paste or upload, cap applied per batch, staff triage the batch. |
| D3 | FBA vs DTC in the activity view? | **DTC per-order, FBA per-month.** Two labelled sections, honest to how each line is sold. |
| D4 | What fires when staff create a partner row? | **Sign-in link automatically. Agreement on a staff click. W-9 automatically after the agreement is signed.** |
| D5 | How far does the re-theme reach? | **Partner screens only.** Light, real brand palette. Staff screens untouched. |

D1 has a consequence Ophir was shown and accepted: **per-order amounts come off
the partner's order list.** See §4.1.

---

## 1. What already exists — do not rebuild it

Grounded by reading the tree on 2026-10-20, not from memory.

- **Partner auth, complete.** `POST /api/partner/request-code` → emailed 6-digit
  code, SHA-256 hashed, 10-minute TTL → `POST /api/partner/verify-code` →
  `shipo_partner_session` cookie, 30-day TTL. `getPartnerFromSession()`
  (`src/lib/partner-auth.ts`) re-runs `portalAccessBlock` on **every** request, so
  a partner deactivated since login loses access immediately.
  `src/proxy.ts` excludes `partner$|partner/`, so every `api/` handler
  authenticates itself.
- **Tables:** `partner_login_codes`, `partner_sessions`,
  `partner_terms_acceptances`, `partner_client_claims`, `referral_partners`
  (incl. `agreement_status`, `agreement_signed_at`, `w9_received_at`,
  `tax_status`), `referral_payouts`, `fba_invoices`.
- **Claims, complete.** `POST /api/partner/claims` files one claim. Staff decide at
  `POST /api/referrals/claims`, and approval — setting
  `clients.referral_partner_id` — is the only write that creates money.
- **Statement, complete.** Roster, 12-month window, per-client bonus state,
  monthly summary from `partner_client_monthly`, transaction list from
  `partner_order_transactions`, claims panel.
- **DocuSign, complete and repaired.** `buildPartnerAgreementEnvelope` requires
  `webhookUrl`; the `eventNotification` omission that left every signed partner
  stuck at `pending` was fixed in `0c0680b` on main.
- **Brand assets exist:** `public/shipo-logo.svg`, `public/shipo-logo.jpg`.

### 1a. Four findings from grounding this spec

These were discovered while checking the premises of Ophir's bullets. Three
change the design; one corrects an error of mine.

**Finding 1 — `CLAIM_STORE_CEILING`'s stated premise is now false.**
`src/lib/partner-claims.ts` sets `CLAIM_DAILY_CAP = 5` and
`CLAIM_STORE_CEILING = 25`. Claims 6–24 in a rolling day are stored and flagged;
claim 25 and beyond is **discarded while the partner reads
`CLAIM_RECEIVED`** — "Received. We will review this and come back to you." The
ceiling's own docstring justifies this with: *"Set well above anything a person
does by hand so that the discard is never what a real partner meets."*

Bullet 3 says some partners have close to 100 clients. That makes the discard
exactly what a real partner meets, and each lost claim is worth $300 plus twelve
months of 5%. This is the same harm the file's own comments call the route's
worst bug, reintroduced by a business fact rather than by code.

**Requirement, binding on §3: no path a real partner can reach may end in a
discard.**

**Finding 2 — units beside amounts hands over the rate card by division.**
`partner_order_transactions` already shows per-order *amount billed*. Putting
unit counts on the same row lets any partner compute `amount ÷ units` — the
effective per-unit rate. Agreement §3.8 states the partner has no right "to any
rate card, to per-unit prices, or to the cost of any individual order", and
per-unit price is on Shipo's never-show list. Resolved by D1: amounts off,
units on. See §4.1.

**Finding 3 — my claim that FBA/DTC does not exist was wrong.** It does, at the
month level. `FbaInvoice` (`src/lib/referrals.ts`) carries `units_shipped` (FBA
prep) and `orders_shipped` (DTC), both nullable on purpose because *"null means
not recorded, 0 means recorded and it was genuinely zero"*. What does **not**
exist is a per-order channel flag, and that is structural rather than an
oversight: `referrals.ts:30` — *"Shipo sells FBA prep (billed per unit) and DTC
fulfillment (not)."* FBA prep is not order-shaped; there are no FBA rows in
`orders`. Per-order DTC units do exist, in `order_items.quantity_picked`, and
have simply never been surfaced to a partner. `partner_client_monthly` carries
revenue and the three deducted cost buckets and **no units and no order counts
at all**.

**Finding 4 — the portal's "Shipo colors" are not Shipo's colors.**
`src/app/globals.css` declares `--color-shipo: #00AAFF`, `--color-shipo-dark:
#0090DD`, `--color-shipo-light: #33BBFF` on a `#0a0f1a` background. All 415 KB of
`https://shipousa.com/` was grepped on 2026-10-20: those three hex values appear
**zero times**. The live site is white-background with `#0b3361` (35 hits),
`#1a73e8` (30), `#e0ee47` (15), and surfaces `#f4f8fd` / `#f6f8fb`. So bullet 4
is literally true — the portal does not have the brand colors, and it is dark
where the site is light.

---

## 2. Sign-in and the onboarding chain (bullets 1 and 2)

### 2.1 "Auto sign in" is a one-click link, and it must not be a GET login

A link that logs someone in when fetched is consumed by email scanners, security
proxies and link prefetchers before the human clicks it. The partner then meets
a dead token on his first contact with the portal.

So: the emailed link carries a single-use token and lands on a page that renders
a **Continue** button, which POSTs the token. One click for the partner, immune
to prefetch.

- Token: 32 bytes of CSPRNG, base64url, stored **hashed** (SHA-256) exactly as
  `partner_login_codes.code_hash` already is. Never stored in plaintext.
- TTL: 7 days. Longer than the 6-digit code's 10 minutes because this one is
  delivered on row creation and the partner may not read mail that day. Single
  use: `consumed_at` set in the same statement that reads it.
- The 6-digit code flow is **unchanged and remains available** as the fallback
  for a partner whose link expired or who lost the email.
- Delivery: the same email carries the link and the code.

Implementation: add `link_token_hash` and `link_expires_at` to
`partner_login_codes` rather than a new table — it is the same object (a
one-time credential issued to one partner) and sharing the table shares the
`consumed_at` / `attempts` discipline already tested there.

New route `POST /api/partner/verify-link`, which mirrors `verify-code`: hash,
look up, check expiry and `consumed_at`, run `canAccessPortal()`, mint the
session. It must **not** be reachable by GET.

### 2.2 What fires on partner-row creation

Staff create a `referral_partners` row on `/referrals`. That one action sends the
sign-in email (link + code). Nothing else.

**The agreement stays a deliberate staff click.** Clause 1's Party name comes
from `partyName()` → `partner.company || partner.name`, and that string must be a
verified legal name — the 2026-10-20 Jimi Maciel envelope established the rule as
"legal name + d/b/a brand" ("Jimi P Maciel, an individual doing business as
MileMogul"), checked against his EIN notice, because the agreement's Party, W-9
line 1 and the 1099-NEC payee must be the same legal person or the 1099
mismatches IRS records. An envelope fired automatically on row creation ships
whatever was typed into a form, to whatever address was typed, and DocuSign
void/correct is the only remedy.

### 2.3 The W-9 fires automatically once the agreement is signed

By then a human has verified the name, so the objection in §2.2 is spent. The
trigger is the existing `POST /api/partner/agreement-webhook` — the handler whose
`eventNotification` was missing until `0c0680b`.

**One precondition, and it must fail loudly to staff and silently to the
partner.** `buildPartnerW9Envelope` refuses any `tax_status` other than
`us_person`. If `tax_status` is null or non-US when the agreement-signed event
arrives, the auto-fire is **skipped**, a staff-visible flag is set, and the
partner is shown the existing W-9 call-to-action rather than an error. A 503
landing in a partner's lap because of a column staff never filled in is a Shipo
failure presented as the partner's problem.

Also blocking: `ACCOUNTANT_W9_EMAIL` and `ACCOUNTANT_W9_NAME` are still unset
(task #41). With them unset the W-9 route answers 503 and routes the partner to
`Support@shipousa.com` — correct, fail-closed behaviour, and it means the
automatic half of this section does nothing until Ophir supplies a named human.
DocuSign shows that name to the partner, so a shared inbox is not acceptable.

---

## 3. Batch client intake (bullet 3, "adding client")

### 3.1 What a batch is

A partner onboarding an existing book submits one list. That list is an object in
its own right: it has a submission time, a row count, a partner, and a staff
decision history. Modelling it as N independent claims loses the grouping that
makes 100 rows triageable, and routes straight into the discard path of
Finding 1.

New table `partner_claim_batches`:

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `referral_partner_id` | uuid not null → `referral_partners(id)` | |
| `row_count` | int not null | as accepted, after in-batch dedupe |
| `submitted_raw_count` | int not null | as pasted, before dedupe — the honest count to echo back |
| `submitted_ip` | text | via `clientIp()`, as claims already do |
| `created_at` | timestamptz default now() | |

And `partner_client_claims` gains `batch_id uuid null → partner_claim_batches(id)`.
Null means "filed one at a time through the existing form" — the existing route
is untouched and keeps working.

### 3.2 How it refuses, which is the whole point

`BATCH_MAX_ROWS = 150`. Covers "close to 100" with headroom.

**Over the limit refuses the entire batch and stores nothing**, with an honest
count: "We can take 150 companies at a time. You pasted 203 — please split it."

This is permitted and does not breach the concealment rule of the 2026-10-13
spec's §3.2 (never confirm or deny whether a company is known to Shipo). The
existing route already draws the line: *"This response MAY differ from the others, because it is about the
request's shape and not about Shipo's client list. A partner who submitted an
empty form learns nothing about any company from being told the form was
empty."* A partner learns nothing about any company from being told his paste
was too long.

**What must never happen is a partial accept.** Taking the first 150 of 203 and
answering "Received" is Finding 1 wearing a different hat — he believes 203 are
filed and 53 are gone.

**The batch path must not consult `CLAIM_DAILY_CAP` or `CLAIM_STORE_CEILING`
per row.** Those bound how many single-form submissions a partner can make in a
day; a batch is one submission. Rate-limiting is per batch: `BATCH_MAX_PER_DAY
= 3` in a rolling 24 hours, refused with the same shape-honest message. The
rolling window and the fail-closed count discipline of the existing route are
copied exactly — a count that errors refuses with a 500, because a write we
could not verify must never be reported as received.

### 3.3 Dedupe is case-folded, and it has bitten before

Within the batch, and against the partner's existing claims, companies are
compared on a folded key: NFKC-normalised, lowercased, whitespace collapsed,
and a trailing legal suffix (`inc`, `llc`, `ltd`, `corp`, `co`) ignored.

The intake dedupe was case-sensitive once before and was **minting two partner
rows per human**. A paste of 100 hand-typed company names is precisely where
`Acme LLC` / `acme llc` / `ACME, LLC.` arrive together.

Deduped rows are not errors. The response reports both numbers: "203 pasted,
187 after removing duplicates" — a shape fact about his own submission, not a
fact about Shipo's clients.

### 3.4 Everything else is unchanged

Each row becomes an ordinary `partner_client_claims` row built by `claimRow`'s
allow-list, `status: 'submitted'`, **no `client_id`**. Staff approve or reject
per row at the existing `POST /api/referrals/claims`; approval remains the only
write that creates money. The partner sees per-claim state collapsed to
`under_review | approved | not_approved`, never the reason — `partner-claims.ts:118`
folds `rejected` and `duplicate` together because *"duplicate IS the reason — it
says this company is already attributed to somebody"*, and a reason on that
screen is the enumeration leak arriving through a different door.

Route: `POST /api/partner/claims/batch`. Accepts a pasted newline/CSV body or an
uploaded CSV. Authenticates with `getPartnerFromSession()` first, before the body
is read, for the reason the existing route documents: every step below needs a
partner id.

### 3.5 Staff side

The claims queue groups by batch: one collapsible header per batch showing
partner, submitted-at and row count, rows beneath it. Bulk approve is **not** in
scope — approval is the write that creates money and it stays one considered
decision per client.

---

## 4. Activity: orders, units, FBA vs DTC (bullet 3)

### 4.1 DTC — one row per order, units, and no amount

New view `partner_order_units`. One row per order:

`period_month`, `client_id`, `client_name`, `referral_partner_id`, `order_date`,
`order_number`, `units`, `units_estimated`. That is the complete column list.

- `units` = `sum(order_items.quantity_picked)`, falling back to
  `quantity_ordered` for lines where `quantity_picked` is null, with a boolean
  `units_estimated` saying which rows used the fallback. Picked is what shipped;
  ordered is what was asked for, and conflating them silently misreports volume.
- `where orders.cancelled is not true`.
- `where clients.referral_partner_id is not null`, and the partner filter is
  applied **in SQL**, exactly as `partner_client_monthly` does it. The existing
  view's header gives the reason: putting the aggregation in SQL also puts the
  disclosure rule in SQL, where an app-side refactor cannot drop it.
- **No `amount` column at all.** Not hidden in the UI — absent from the view, so
  it cannot be selected by a later caller. This is Finding 2's resolution.

`partner_order_transactions` (which carries per-order amounts) stops being read
by the partner statement. It is **not dropped** — `/pnl` and staff screens may
use it, and dropping a view to change a partner screen is blast radius for
nothing.

This is a visible reduction for any partner already using the statement. Ophir
was shown it and accepted it. In practice the affected population today is the
`ZZ PORTAL TEST` fixture and Dr. Halloon.

### 4.2 FBA — one row per client per month

From `fba_invoices.units_shipped`: `period`, `client_name`, `units_shipped`.

Rendered as its own labelled section with a plain sentence explaining why the
granularity differs: FBA prep is billed per unit and is not order-shaped, so
there is nothing per-order to show.

`units_shipped` is **hand-typed on `/referrals`** and
`partner_client_monthly` does not carry it. So a partner's FBA activity is only
as current as staff data entry, and a null reads as "not recorded" rather than
zero — the screen must say "not recorded yet" for null and "0" for zero, because
`FbaInvoice` keeps those distinct on purpose and collapsing them tells a partner
his month was empty when nobody has typed it.

### 4.3 Money stays monthly

Unchanged from the shipped statement: `partner_client_monthly` gives revenue, the
three deducted buckets, net profit before processing, the `payable` flag; the app
subtracts `fba_invoices.cost_processing` and applies
`REFERRAL_TERMS.COMMISSION_RATE`. Provisional months owe nothing, per the
2026-10-13 spec's §3.6.
`cost_labour_not_deducted` is never rendered and never exported.

---

## 5. Reports (bullet 3)

`GET /api/partner/report?format=csv`. Authenticated by
`getPartnerFromSession()`; the partner's id is applied in the SQL predicate, not
by filtering in the app.

Four sections, each a CSV (a zip of four files, or one file per request —
implementer's choice, tests pin the contents):

1. **Monthly** — period, client, revenue, `cost_freight`, `cost_materials`,
   `cost_storage`, `cost_processing`, net profit, 5% share, payable
2. **DTC orders** — order date, client, order number, units, units_estimated
3. **FBA** — period, client, units prepped
4. **Bonus and payouts** — client, $300 state, signup date, first-payment date

Every figure here is already on his screen, so the export adds no disclosure.

Two exclusions with tests that assert absence by name:
`cost_labour_not_deducted`, and any per-order amount.

PDF is out of scope. CSV is what reconciles against a P&L.

---

## 6. Brand (bullet 4)

Partner screens only (D5).

Tokens, scoped to the partner layout so staff screens do not shift:

```
--brand-ink:      #0b3361   /* headings, navy */
--brand-action:   #1a73e8   /* buttons, links */
--brand-accent:   #e0ee47   /* lime, sparing */
--brand-surface:  #f4f8fd   /* cards, table stripes */
--brand-surface-2:#f6f8fb
--brand-page:     #ffffff
```

- Light theme on every `/partner` route including `/partner/login`.
- `public/shipo-logo.svg` in the header, linking to `https://shipousa.com/`.
- `--color-shipo*` is **left in place** for staff screens. It is the wrong cyan
  and removing it app-wide is the separate job Ophir declined for now; this spec
  stops using it on partner screens.
- Contrast, computed 2026-10-20 against white: `--brand-ink` `#0b3361` is
  **12.65:1**, `--brand-action` `#1a73e8` is **4.51:1**, `--brand-accent`
  `#e0ee47` is **1.27:1**.
- Therefore **body text is `--brand-ink`, not `--brand-action`.** 4.51:1 clears
  AA for normal text by 0.01 — fine for link and button labels, no margin at all
  for paragraphs, and any darkening of the page background puts it under.
- `#e0ee47` at 1.27:1 is invisible on white. It **must never carry text or
  meaning** — accent rules, underlines and highlight fills only. A status
  communicated by that colour alone is unreadable.

---

## 7. Build order

Each step ends in something testable. 2 and 3 are the long ones.

1. **Brand layer.** Tokens, partner layout, logo, the six existing partner
   screens re-themed. Pure presentation, lands first so everything after it is
   built in the final skin.
2. **Batch intake.** Migration (`partner_claim_batches`, `claims.batch_id`),
   fold/dedupe helper, `claimBatchAdmission`, route, partner UI, staff grouping.
3. **Activity.** `partner_order_units` view, FBA monthly read, the two sections.
4. **Reports.** The four CSV sections and the two absence tests.
5. **Sign-in link.** Migration (`link_token_hash`, `link_expires_at`), issuance
   on row creation, `verify-link` route, the Continue page.
6. **W-9 auto-fire.** Webhook branch, the `tax_status` precondition and its
   staff flag.

Step 6 cannot be verified end-to-end until #41 (accountant identity) and #42
(DocuSign production vars) land. Steps 1–5 are independent of both.

---

## 8. Testing

TDD throughout. The tests that earn their keep:

- A batch of exactly 150 stores 150 rows; 151 stores **zero** and answers with
  the honest count.
- A batch is never partially accepted — assert row count is 0 or N, never
  between.
- The batch path never reaches `CLAIM_STORE_CEILING`'s discard. Assert by
  submitting a 150-row batch and a 150-row batch again, and checking nothing was
  dropped.
- `Acme LLC`, `acme llc`, `ACME, LLC.` in one paste collapse to one row.
- A count query that errors refuses with 500, never with `CLAIM_RECEIVED`.
- `partner_order_units` has no column whose name contains `amount`, `rate`,
  `cost` or `price`.
- The CSV never contains `cost_labour_not_deducted` and never a per-order amount.
- A report request returns only the requesting partner's rows when two partners
  with clients exist.
- A sign-in link works once; the second POST is refused.
- `GET` on the verify-link route is not a login.
- An expired link falls back to the 6-digit code without a dead end.
- The agreement-signed webhook with `tax_status` null does not fire a W-9, sets
  the staff flag, and returns 200 to DocuSign.
- Null `units_shipped` renders "not recorded", 0 renders "0".
- An order whose every line has null `quantity_picked` reports estimated units,
  not zero units.

Run the whole suite, not the touched file. Last green state was 2198/2198.

---

## 9. Review focus — what the happy path will not exercise

1. A batch at exactly the limit, and one row over.
2. The same company twice in one paste with different capitalisation and a legal
   suffix.
3. A sign-in link fetched by an email scanner before the partner clicks.
4. The agreement-signed webhook arriving with `tax_status` null or non-US.
5. An order with no picked quantities, and a client with orders but no charges.
6. A partner with zero clients opening Activity and Reports.
7. A partner whose only claims were deduped out of his own batch.

---

## 10. Risks

- **A reduction ships.** Per-order amounts leave the partner statement. Accepted
  by Ophir; stated here so nobody later "restores" it and reopens Finding 2.
- **FBA activity is as good as staff data entry.** `units_shipped` is typed by
  hand. A partner may read an FBA month as empty when it is merely untyped. The
  null/zero distinction in §4.2 is the mitigation, not a fix.
- **Batch intake widens the claim surface.** 150 rows in one request against 5 a
  day. The compensations are that nothing is attributed by submitting, approval
  is still one human decision per client, and the response still reveals nothing
  about any company.
- **A 7-day sign-in token is a longer-lived credential** than a 10-minute code.
  Hashed at rest, single use, and `canAccessPortal()` is re-checked on
  redemption and on every subsequent request.
- **Two themes to maintain** until the staff re-theme happens. Deliberate.
- **None of this reaches a real partner while the branch is unpushed.** 10
  commits ahead of main, three migrations unapplied, and tasks #41–#43 open.

---

## 11. Deliberately not in scope

- A staff "record as signed" / "record W-9 received" manual override. Declined
  previously and still declined: it is a way to mark a legal obligation met
  without the artifact.
- Bulk approve in the staff claims queue (§3.5).
- PDF reports (§5).
- The staff-screen re-theme (D5).
- Any per-order money, rate card, per-unit price, or `cost_labour_not_deducted`
  on a partner-facing surface or in an export. Not a scope decision — a standing
  rule.
- Making FBA prep order-shaped. Considered and declined as part of D3: it models
  per-unit prep work as something it is not.
