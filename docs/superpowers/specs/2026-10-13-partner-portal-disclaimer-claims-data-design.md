# Partner portal: disclaimer, partner-added clients, and what a partner may see

> Status: DESIGN, awaiting Ophir's review. Date: 2026-10-13.
>
> **Exception — §1a and §1b are BUILT, not proposed.** They were live bugs found
> while grounding this design in the code, and Ophir said "fix the bug". The rest
> of this document is design and no code has been written for it.
>
> Covers Ophir's four requirements of 2026-10-13, in his words:
>
> 1. *"it should be the first think you enter it should pop up like diclaimer and than signing."*
> 2. *"How can i add a partner i dont see the option to add more of my clients lets say i have a client with 10K of orders i need to see his orders and every client that the other is uploading"*
> 3. *"i Dont see a diclaimer we need to add one to protect us"*
> 4. *"we need him to see more data"*
>
> Partner commission in Shipo's own P&L is a SEPARATE, already-planned piece of
> work: `2026-10-13-partner-commission-in-pnl-plan.md`. Nothing here depends on
> it and nothing there depends on this.

---

## 0. Decisions already taken

| Question | Ophir's answer |
|---|---|
| Disclaimer before signing, or after login? | **Keep the DocuSign gate. Add the disclaimer after login.** (#1 and his earlier *"DocuSign should be before they have access"* are opposite orders; he chose to keep the built one.) |
| Who adds clients? | **Partner-side — the partner adds clients**, with staff approval. |
| How much data? | He first chose commission math **and** order-level detail, then agreed with the concern and asked for a recommendation. This design answers that: **every input to his payment, nothing that is not an input.** |
| Disclaimer scope | **"EVERYTHING AGAINST LAW SUIT"** — all four risk areas below. |
| W-9: in the dashboard, before he starts, auto-forwarded to the accountant | **Required** (2026-10-13). Designed in §2a. |
| Split the W-9 into its own envelope? | **Yes** — agreement envelope becomes agreement-only; the W-9 is signed in the dashboard. Accepted the cost of a second signing round trip. |
| What does the accountant receive? | **The W-9 only**, as a DocuSign carbon-copy recipient. Not the agreement — Section 6 keeps the commission terms confidential. |
| W-9 or W-8? | **W-9 only — "all our partners are US only for now."** The W-8BEN / W-8BEN-E paths are deferred, but a guard refuses a non-US partner rather than silently sending them a W-9. §2a.7. |
| The accountant's email address | **STILL OPEN — blocks the builder.** Will not be guessed. |

**Not a lawyer.** I can make this evidentially strong — versioned, timestamped,
per-partner, provable. I cannot make it lawsuit-proof, and the text in §2 must
go to the attorney who has the agreement before it is shown to anyone.

---

## 1. What already exists — do not rebuild it

Read before building. `src/components/partner/Statement.tsx` is 399 lines and
already renders, per client per month:

- units shipped **or** orders shipped (never both — a zero would read as "your client shipped nothing")
- total billed
- the four deducted cost categories: freight & carrier, packaging & materials, storage, payment processing
- net profit
- "Your share (5%)"
- a collapsible **per-order transaction list**: date, order number, amount billed
- carry-forward and the $50 minimum, in and out
- a "How this is calculated" section
- a truncation notice when the 1,000-row transaction cap bites

So "I need to see his orders" is **already built** and already bounded by
Decision 1 of `2026-10-11-partner-ledger-statements-design.md`: date, order
number, amount billed, and no cost column anywhere — enforced in SQL, because
`amount / quantity` on a line item *is* the rate card.

`loadPartnerLedger()` already returns `clients` carrying `referral_signup_date`,
`referral_first_payment_date` and `founding_bonus_seq`. **Everything §4 adds is
derivable from data already loaded.** No new reads, no new views, no migration
for §4.

### 1a. A live drift bug found while grounding this — FIXED

`Statement.tsx:258-261` tells every partner:

> You earn **$300** once per referred client, after that client has been active
> **60 days**, has billed **$500 or more in a single calendar month**, and has
> paid its first invoice.

Both of those gates were **removed on 2026-10-12** on Ophir's instruction.
`REFERRAL_TERMS.QUALIFY_MIN_DAYS_ACTIVE` is `0` (`referrals.ts:95`), the revenue
bar is gone, the agreement was repurposed to state their absence positively
(`referral-agreement-TEMPLATE.md:382`), and the attorney cover note records the
change. The partner-facing screen is the only artifact that did not get the
memo.

It understates what a partner earns, so it is not a payout exposure — it is a
dispute exposure in the other direction ("your portal said 60 days").

**FIXED 2026-10-13.** Not by retyping the sentence, which is how it drifted in
the first place, but by deriving it: `src/lib/partner-bonus-copy.ts` builds the
whole sentence from the partner's own admitted terms and `REFERRAL_TERMS`, so
there is no second place to forget. 32 tests, including a `vi.mock` reversion
control (`partner-bonus-copy.reversion.test.ts`) that restores
`QUALIFY_MIN_DAYS_ACTIVE: 60` and asserts the sentence changes — because the
"no days are mentioned" guard would also pass if the function were *incapable*
of mentioning days, and a guard that cannot fail is decoration. That is the
exact condition that let this live on a partner-facing screen for a day short of
a year.

String assembly moved out of the JSX for the same reason. The component was
joining the conditions with a `.map()` and an index-dependent separator, which
renders the two-condition standing programme as "A, **and** B", and `fmt(300)`
as "$300.00" in prose. Untested string building in this specific paragraph is
the bug the module exists to prevent.

### 1b. A worse bug found underneath it — also fixed

Chasing the above surfaced a **payout** exposure, in the dangerous direction.

`getPartnerFromSession()` selected only `id, name, company, email, status,
agreement_status`, and `Statement.tsx` cast that straight to `ReferralPartner` —
where all five bespoke-terms fields are declared optional (`referrals.ts:141-145`).
So the cast compiled, nothing warned, and `qualifyBars()` saw `undefined` on all
three bars, concluded there was no contracted row, and priced the partner on the
**standing** programme.

The result was two screens disagreeing about one person's money: `/referrals`
priced a contracted partner on their contracted figures, while that same
partner's own statement showed $300 with no bar. **Nobody queries a number that
looks normal.**

Fixed on both sides, so neither alone can regress it:

1. The session select now carries all five columns — verified present in the live
   table first, because a column that is not there would 42703 the select and
   lock **every** partner out of the portal.
2. `StatementPartner extends ReferralPartner` and re-declares those fields as
   **required**, which let the cast be deleted. A partner object missing them can
   no longer reach `computeOwed()`.

The select is one long single-line string literal with `// prettier-ignore`, and
must stay that way: supabase-js parses it at the *type* level, so a concatenated
expression is not a literal type and the row degrades to `GenericStringError` —
which surfaces as three unrelated type errors further down rather than as "your
select is not a literal."

---

## 2. The disclaimer (#1 and #3)

### 2.1 Where it sits

```
/partner/login → code → session cookie → [ DISCLAIMER ] → [ W-9 ] → /partner statement
                              ↑
                   portalAccessBlock() already enforced
                   agreement must be 'signed' to get this far
```

Two gates, in that order, and the order is deliberate: the disclaimer is what
limits what we are liable for if the next screen goes wrong, so it comes before
anything that collects a taxpayer identification number. §2a covers the W-9.

The DocuSign agreement stays where it is: a partner cannot obtain a session at
all until `agreement_status === 'signed'`, enforced in `partner-access.ts:79`
and re-asked on every request by `getPartnerFromSession()`. The disclaimer is
the first thing *inside* the portal.

**The gate must render without reading any ledger data.** `src/app/partner/page.tsx`
is 18 lines today and calls `loadPartnerLedger` only inside `<Statement>`. The
check goes in `page.tsx` **before** `<Statement>` is constructed, so an
unaccepted partner's request never touches `partner_client_monthly`. A gate
that fetches the data it is gating is not a gate.

### 2.2 How acceptance is recorded

New table, **not** columns on `referral_partners`:

```sql
create table if not exists public.partner_terms_acceptances (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,
  terms_version text not null,
  accepted_at   timestamptz not null default now(),
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now()
);
create index on public.partner_terms_acceptances (referral_partner_id, terms_version);
alter table public.partner_terms_acceptances enable row level security;
```

Append-only, by design. Two columns on `referral_partners` would be overwritten
when the text changes, destroying the record that this partner accepted *that*
wording on *that* day — which is the only thing the row is for. A row per
(partner, version) answers "what did he agree to, and when" forever.

`ip` and `user_agent` are evidence, not telemetry. IP comes from
`x-forwarded-for` on Vercel; record it as read and never infer a location from it.

### 2.3 Versioning

`src/lib/partner-terms.ts`:

```ts
export const PARTNER_TERMS_VERSION = '2026-10-13'
export const PARTNER_TERMS_SECTIONS: ReadonlyArray<{ heading: string; body: string }> = [...]
export function needsAcceptance(
  acceptances: ReadonlyArray<{ terms_version: string }>,
): boolean
```

`needsAcceptance` returns true unless an acceptance exists for the *current*
version. Bumping the constant therefore re-prompts everyone, which is the
desired behaviour and must be stated out loud: **changing the text makes every
partner accept again.** That is the point — silent re-wording of terms someone
already agreed to is the failure mode.

`needsAcceptance` lives in a `.ts` file, not the component, because
`vitest.config.ts` has `include: ['src/**/*.test.ts']` — nothing in a `.tsx`
can be covered.

### 2.4 What the disclaimer says — four risk areas

Drafted for the attorney to redline, not to ship as-is. Each area exists
because a specific thing on the screen behind it could otherwise be turned
against Shipo.

**(a) Confidentiality.** The figures are Shipo's confidential business
information under Section 6 of the agreement: revenue, cost categories and
margin on named accounts. Not to be disclosed, republished, or used
competitively. This is the clause that matters most, because the statement
discloses Shipo's own margin on a per-client basis.

**(b) The figures are good-faith estimates, not an account stated.** Lines
marked "not final" / "not priced yet" are not owed. Figures may be restated when
charges are priced. Disputes in writing within 30 days of receiving the
statement (already the standing term, already on the screen). Clawback is
**offset-only**, never a demand for a refund, per agreement 3.9.

**(c) No client solicitation and no use of client data.** Client names, order
counts and billing figures are shown for one purpose — so the partner can check
his own commission. Not to approach the client, not to broker them elsewhere,
not to build a list. **This clause is the price of §4 and §1's order detail.**
Without it, the portal is a feed of Shipo's client roster with volumes attached.

**(d) Independent contractor, own taxes, W-9 first.** No employment,
partnership or agency. Partner is responsible for his own taxes; Shipo files
information returns and cannot pay until it holds a completed W-9 or W-8. Not
tax or financial advice.

**Plus, in plain words:** if this screen and the signed agreement disagree, the
agreement governs. Nothing on this screen varies it.

### 2.5 Open legal item, carried forward and still open

Showing a partner a **client's** order-level detail probably needs a clause in
the **client** agreement, not only the partner one. The client never agreed to
have their volumes shown to the person who referred them. §2.4(c) binds the
partner; it does not obtain the client's consent. Raise with the attorney in the
same pass.

### 2.6 Acceptance route

`POST /api/partner/accept-terms` — session cookie only, no body except the
version being accepted; reject if it does not match the server's current
constant (so a stale tab cannot accept last week's text). Idempotent: a second
POST for a version already accepted is a no-op `200`, not a duplicate row.

---

## 2a. The W-9 gate, and forwarding it to the accountant

> *"Before he starts he needs trough his dashboard to sign the W9 than he can
> start but we need to forward it automatecly to our accountent"* — 2026-10-13

### 2a.1 What is already true, so this is not built twice

A W-9 is **already collected before a partner can start** — just not in the
dashboard. Today:

1. Staff send **one** DocuSign envelope: the agreement (server template) plus
   page 1 of IRS Form W-9 as a second composite template
   (`docusign-envelope.ts:411`, two composite templates, shared recipient ids).
2. The partner completes both in DocuSign's email ceremony.
3. The webhook stamps `agreement_status='signed'` **and** `w9_received_at`
   (`agreement-webhook/route.ts:216-240`).
4. Only a `signed` partner can obtain a session at all.

The W-9 tabs are sent `required: true` on purpose, and that is what makes step 3
sound: DocuSign will not complete an envelope with a required tab empty, so
"completed, and it carried a W-9" is evidence the form came back filled in
(`docusign-w9.ts:68-75`). Nothing in that chain needs replacing.

### 2a.2 The circularity — why a dashboard W-9 gate is unreachable as things stand

Portal access requires a signed agreement. The W-9 is page 2 of the agreement
envelope. **So everyone who can load the dashboard has already signed the W-9,
and a gate placed there would show to nobody.**

It is not useless, though, because `w9_received_at` *can* be null for someone who
can log in, and the code already knows all three ways:

- envelopes that **predate** the W-9 — including the one already sent
  (`agreement-webhook/route.ts:207`);
- a signed-but-no-W-9 envelope, which the webhook currently only **logs**
  (`route.ts:218-223`) and then leaves as a silent payout block;
- later, a changed TIN or entity — an LLC election, a new EIN.

Today the fallback for all three is the staff-voice sentence in
`payoutBlockedReason()`: *"re-sending the agreement collects it."* That is an
instruction only Shipo can act on, and the partner never sees it.

### 2a.3 SETTLED — split the W-9 into its own envelope, signed in the dashboard

**Decided 2026-10-13: split it, and CC the accountant on the W-9 only.**

The agreement envelope becomes **agreement-only**. The W-9 becomes its own small
envelope, created by the dashboard, signed in the dashboard via a DocuSign
embedded recipient view, and carbon-copied to the accountant.

This is the only option that satisfies all three of the requirement's parts at
once, and the deciding reason is confidentiality, not tidiness — see §2a.5.

| | Keep W-9 in the agreement envelope | Split it out (**recommended**) |
|---|---|---|
| Signed in the dashboard | No — in DocuSign email, before the dashboard exists | **Yes** |
| Gate is reachable | Only for the three §2a.2 exceptions | **Yes, for every new partner** |
| Accountant CC sees | the W-9 **and the commission terms** | **the W-9 only** |
| Round trips for the partner | one | two (the second is in-dashboard) |
| Cost to built, tested code | none | agreement builder drops a composite template; its tests change |

The cost is honest and worth stating plainly: the current `emailBlurb` advertises
the bundle as saving "a second round trip", and splitting gives that round trip
back. It buys a gate that is actually enforced where he asked for it, and an
accountant who does not receive the commission terms.

### 2a.4 Who the W-9 is actually for — NOT the IRS

Verified against `docs/irs-fw9.pdf` itself, which prints in the box at the top of
page 1:

> **"Give form to the requester. Do not send to the IRS."**

So **nothing in this system ever transmits a W-9 to the IRS**, and no future
version of it should try. The chain is:

| Document | Who holds it | Who it goes to | When |
|---|---|---|---|
| **W-9** | Shipo (the requester), in DocuSign's vault | the requester and their accountant. **Never the IRS.** | once, before payment |
| **1099-NEC** | prepared *from* the W-9 | **the IRS**, and the partner | annually |

This is the whole reason the W-9 is collected before we pay anybody: without a
taxpayer identification number we cannot file the 1099-NEC, and
`partner-w9.ts:5-8` already states the consequence — *"pay first, and we are left
owing the IRS a 1099-NEC we have no taxpayer identification number to file it
with."*

The accountant is CC'd because **the accountant is who files the 1099-NEC.** That
is the entire purpose of the forwarding; it is not a step on the way to the IRS.

> **Unverified, and for the accountant to confirm — not for me to assert:** the
> dollar threshold at which a 1099-NEC becomes required for 2026. It has
> historically been $600 of nonemployee compensation per year, and recent
> legislation changed it. I am not confident of the current figure and have not
> verified one, so no threshold is hardcoded anywhere in this design. The W-9 is
> collected from every partner regardless, which is the safe side: holding a form
> we did not strictly need costs nothing, and needing one we do not hold is the
> failure in `partner-w9.ts`.

### 2a.5 Forwarding — it must NOT pass through our servers

**This is the part with real risk.** A completed W-9 contains an SSN or EIN.

`docusign-redact.ts` exists to keep that number out of our database, and it is
emphatic about why: *"'Include Documents' attaches the signed PDF as base64 — the
W-9 image, TIN and all… ticked once by anyone with DocuSign admin, silently turns
our event log into a store of social security numbers."* So the refusal lives at
the write, "where no checkbox can reach it."

The obvious implementation of "forward it automatically" defeats that from a
direction the redactor cannot defend — it guards the write to
`partner_agreement_events`, not an outbound email. Fetching the signed PDF and
emailing it would put an SSN into our server memory, our logs, and Resend's
outbound mail. **Do not build that.**

Use DocuSign's own **carbon-copy recipient** instead: the accountant goes on the
envelope as a `carbonCopies` recipient, and DocuSign delivers the completed W-9
from its own vault the moment the envelope completes.

- It is genuinely automatic — no cron, no queue, no retry logic of ours.
- We never hold the bytes, so the TIN never enters our systems. Nothing to redact,
  nothing to leak, nothing to back up.
- It is one recipient block in the builder, with a `routingOrder` after the signer.
- The accountant's address is **configuration, not a literal** —
  `ACCOUNTANT_W9_EMAIL`, read once and asserted non-empty at build time, so a
  missing value is a refused envelope rather than a W-9 quietly delivered to
  nobody. Same failure class as the renamed custom field in `partner-w9.ts:19-23`.

**Blocked on one input I will not guess: the accountant's email address.** And one
decision: whether they should also be CC'd on the *agreement* (Section 6 makes the
commission terms confidential, which is the argument for the split in §2a.3).

### 2a.6 What the gate checks, and what it must not say

`holdsW9(partner)` already exists and is already evidence-only — *"Absent means
absent, never 'probably fine'"* (`partner-w9.ts:34`). Reuse it; do not write a
second predicate.

The gate blocks the **statement**, not the portal, and that distinction is already
load-bearing in the codebase: *"Signing the agreement opens the PORTAL; the W-9
opens PAYMENT… collapsing the two would either lock them out of their own numbers
or pay them without a TIN"* (`partner-w9.ts:41-46`).

Ophir's instruction tightens that — the W-9 now gates *starting*, so it does block
the statement. But the existing reasoning still constrains the copy: the partner
must be able to resolve it themselves, in the dashboard, which is exactly what
they cannot do today. So a **second message map** is needed, partner-voice, for the
same reason `partner-access.ts` carries two:
`payoutBlockedReason()` is staff-voice and says *"re-sending the agreement collects
it"* — a partner cannot re-send anything. It must never reach the gate.

### 2a.7 W-9 **or** W-8 — which form, and the gap this design has today

Raised by Ophir 2026-10-13: *"do we need W9 or W8 to sign a partner?"*

**Neither, universally. It depends on the partner, and we do not currently ask.**

| Partner | Form |
|---|---|
| US citizen, US resident alien, or an entity formed in the US (LLC, corp, partnership) | **W-9** |
| Foreign **individual** | **W-8BEN** |
| Foreign **entity** | **W-8BEN-E** |

A foreign person **must not** sign a W-9. The certification on it says the signer
is a U.S. person; a foreign partner ticking it is a false certification on a form
we are the custodian of. So the form cannot be chosen until the status is known,
which means **one question has to come before the envelope is built.**

#### The gap, stated plainly

The system already *promises* both. Four places say "W-9 **or W-8**" —
`Statement.tsx:335`, `partner-w9.ts:4`, `partner-auth.ts:41`,
`partner_w9.sql:5`. But:

1. **Only `docs/irs-fw9.pdf` exists.** There is no W-8BEN or W-8BEN-E anywhere in
   the repo.
2. **`buildPartnerAgreementEnvelope()` hardcodes the W-9** and throws without
   `w9DocumentBase64` (`docusign-envelope.ts:358`). There is no branch.
3. **We capture no country and no US-person status.** `partner_type` is the
   business category (`ecommerce_agency`, …), not a tax status. The intake route
   has no country field.
4. **`w9_received_at` is one bare timestamp** and cannot say *which* form we hold —
   nor when it expires (below).

So a foreign partner today is sent a W-9 they cannot lawfully complete. **This is
not yet live damage: there are zero partner rows** (verified 2026-10-13), so it is
a cheap fix now and an expensive one after the first international signing.

It is also not hypothetical. The Global Shoplink UK approach (2026-09-09) is a
foreign counterparty, and the FBA prep ICP explicitly covers international
importers.

#### Two differences that affect the design, not just the paperwork

- **A W-8 expires; a W-9 does not.** A W-8BEN is generally valid from signing
  through the end of the third following calendar year, absent a change in
  circumstances. A single `w9_received_at` timestamp cannot express that, so a
  lapsed W-8 would read as permanently satisfied. **Confirm the exact rule with
  the accountant before implementing an expiry.**
- **Foreign payees are reported differently.** A 1099-NEC is for US persons;
  foreign payees fall under a different regime (1042-S), and a payment with no
  valid W-8 on file carries a default withholding exposure.

> **For the accountant, and NOT for me to rule on:** whether referral commission
> paid to a foreign partner is US-source income at all. The general principle is
> that compensation for services is sourced where the services are *performed*, so
> a UK agency referring UK clients from the UK may be foreign-source and outside
> US withholding and reporting entirely. That would change the answer completely,
> and it is a question for a tax professional, not an inference from this
> document.

#### SETTLED — W-9 only, with a guard

> *"all our partners are US only for now"* — Ophir, 2026-10-13

**The W-8 paths are not built.** No W-8BEN or W-8BEN-E PDF, no second set of
measured coordinates, no expiry concept. All of that is deferred until a foreign
partner is actually in prospect, which is the right call: it is two IRS forms'
worth of measured tab placement and tests for a case that does not exist yet.

**But "US only for now" gets enforced, not remembered.** That is the whole of the
remaining work here, and it is small:

1. **A tax-status field on the partner row**, staff-set at partner creation, not
   partner-facing. Staff already know whether they are signing a US company. No
   change to the intake form, no new question for the partner. Default it to
   nothing — *unset*, not *US person*, because a default that happens to be the
   safe answer today is not a guard.
2. **The envelope builder refuses on anything but a US person.** `throw`, with a
   message naming the W-8 that would be needed. It must **never** fall back to
   attaching the W-9.

That is one column, one field, one guard, one test. What it buys: today "US only"
is a policy living in Ophir's head with nothing in the system holding it. The
moment someone signs the Global Shoplink UK counterparty — a real, named, foreign
prospect — they would be sent a W-9, and **a W-9 coming back filled in looks
exactly like success.** No error, no warning, nobody notices.

That is the same failure class as §1a: a commercial fact known to a human, not
derived by the code, with a failure that has no symptom. The guard is cheaper than
the W-8 implementation *and* cheaper than discovering a foreign partner certified
themselves a US person on a form we hold.

**The test that matters** is the refusal, not the happy path: a builder called with
a foreign status, or with the status unset, must throw rather than produce a
sendable envelope. A test that only exercises the US-person path stays green on a
builder that silently W-9s everybody.

### 2a.8 Table

No new table for the W-9 itself. `referral_partners.w9_received_at` is already the
single source (`supabase/partner_w9.sql`), already present live (verified
2026-10-13), and its own migration note says one column "deliberately". The W-9
envelope id belongs in `partner_agreement_events` alongside the agreement's, which
already stores envelope ids with the payload redacted.

§2a.7 adds **one** column to `referral_partners`: the tax status. The form-type and
W-8-expiry columns are deferred with the W-8 paths themselves. **Verify it is
absent before adding it** — the same check that `partner-auth.ts` warns about,
since a column that is not there would 42703 the session select and lock every
partner out of the portal.

### 2a.9 Risks specific to this section

1. **Embedded signing needs a recipient view URL** (`createRecipientView`), with a
   `clientUserId` set on the signer. A signer with a `clientUserId` receives **no
   email** — which is correct here and is also the thing that makes it untestable
   by inbox. If the view URL fails the partner must get a plain "email me the form
   instead" fallback, or the gate becomes a lockout.
2. **A W-9-only envelope must still set the `w9` custom field**, or the webhook
   records a received W-9 as never received (`partner-w9.ts:19-23`).
3. **Splitting the envelope changes code that is already tested and already sent
   once.** The one draft envelope that exists becomes a different shape.
4. **The accountant CC is a disclosure.** It should be a named recipient we have an
   engagement with, not a shared inbox — the same objection already raised against
   `support@sterlingaudithealth.com` as a signer.

## 3. Partner-added clients (#2)

### 3.1 The attribution-fraud problem this must not create

The deal is **$300 + 5% of net profit for 12 months**. A form that lets a
partner type a client name and have it attributed to him is a form that lets
him claim clients he never referred — including Shipo's existing clients, and
including clients another partner brought. So:

**A partner submits a CLAIM. Staff approve it. Nothing is attributed by the
act of submitting.**

### 3.2 The claim must never answer a question

The submission endpoint returns the **same** response every time:

> Received. We will review this and come back to you.

Never "this client is already with Shipo", never "already attributed", never
"not found". Any one of those turns the form into a lookup against Shipo's
client list, and a partner could enumerate the customer base one guess at a
time. This is the same reasoning that makes `/api/partner/request-code` refuse
to say whether an address is a partner.

Rate-limit by partner: a small cap per day, counted server-side. The cap
**fails closed** — if the count query errors, refuse the submission. (Note for
whoever builds it: `/api/referrals/intake`'s ceiling fails *open* on a failed
COUNT. Do not copy that.)

### 3.3 Table

```sql
create table if not exists public.partner_client_claims (
  id            uuid primary key default uuid_generate_v4(),
  referral_partner_id uuid not null references public.referral_partners(id) on delete cascade,

  -- As typed by the partner. Never trusted, never matched automatically.
  company_name  text not null,
  website       text,
  contact_name  text,
  contact_email text,
  note          text,          -- "what did you do for this referral"

  status        text not null default 'submitted',
                -- submitted | approved | rejected | duplicate
  -- Set by staff on approval. The ONLY thing that attributes money.
  client_id     uuid references public.clients(id),
  decided_by    text,
  decided_at    timestamptz,
  decision_note text,          -- staff-facing; never rendered to the partner

  submitted_ip  text,
  created_at    timestamptz not null default now()
);
create index on public.partner_client_claims (status, created_at desc);
create index on public.partner_client_claims (referral_partner_id, created_at desc);
alter table public.partner_client_claims enable row level security;
```

`decision_note` is staff-facing and must never reach the partner surface —
"already claimed by Partner B" is exactly the information §3.2 refuses to leak.
Keep it out of every partner-side select by naming columns explicitly.

### 3.4 Staff side

A queue on `/referrals`. For each claim, staff see what the partner typed, and
— because staff may see it — whether the named company resembles an existing
client and whether that client already carries a `referral_partner_id`.
Three actions:

- **Approve** → set `client_id`, set `clients.referral_partner_id`, status `approved`. This is the single write that creates money, and it is a human act with a name attached.
- **Reject** → status `rejected`, reason recorded staff-side. The partner sees "not approved" and is told to contact us. Not the reason, by default — a reason like "already attributed" is the leak again.
- **Mark duplicate** → status `duplicate`, no attribution.

Approving a claim for a client already attributed to another partner must
**raise a conflict, not silently re-point the row**. Re-pointing moves a live
12-month revenue share from one person to another with no record.

### 3.5 Partner side

A "Clients you have referred" section (see §4) with the partner's own claims
listed by state: *under review* / *approved* / *not approved*. Plus a short
form. Dates and his own typed text only.

---

## 4. More data (#4) — every input, nothing that is not an input

**The principle:** show the partner every input to his own payment, and nothing
that is not an input. Each item below is something he cannot currently see and
that changes what he is owed. Measured against §1, four things are missing.

### 4.1 The client roster — the actual complaint

Today, a client linked to a partner but not yet earning renders **nothing**.
`s.months.length === 0` produces "No statement yet", so a partner with a live
client sees an empty page. That is almost certainly what "I don't see the option
to add more of my clients … I need to see his orders" is really about.

Add a roster section listing **every** client in `ledger.clients`, earning or
not:

| Client | Referred | First paid | Commission window | This month |
|---|---|---|---|---|

Derived entirely from `referral_signup_date` and `referral_first_payment_date`,
both already loaded. A client with no first payment reads "awaiting first
payment", not a zero.

### 4.2 The 12-month commission window

`computeOwed` already computes `inWindow` and already writes the note
*"Outside the 12-month window — not owed"* (`referrals.ts:647,657`) — and the
statement renders neither. A partner cannot currently tell whether he is in
month 2 or month 11 of a client's window, which is the single biggest
determinant of his future income.

Show: **month N of 12**, and the month the window closes. Nothing for a client
with no first paid invoice yet — that is unknown, not month zero.

### 4.3 Bonus state per client

`computeOwed` already generates a per-client note for the $300
(`referrals.ts:605-619`): *"Qualified — set the first-payment date to release"*,
*"Owed — qualified on …"*, or the unqualified note. The statement drops all of
it, and a partner only sees a bonus once it is released.

Render a partner-safe version per client: **paid / approved / in review /
awaiting first payment**. "Set the first-payment date" is an instruction to
Shipo staff and must be re-voiced before a partner sees it — the same
staff-voice-vs-partner-voice rule `partner-access.ts` already enforces with two
message maps. Do it the same way: one decision, two phrasings, a
`Record<State, string>` so a missing phrasing is a compile error.

### 4.4 His own account state — "why am I not being paid"

The statement already says payment requires a W-9 (`Statement.tsx:277`) and the
partner has **no way to see whether Shipo holds one** — nor any way to provide
one (no `/w9` route exists; that is the separate open task). Show:

- agreement signed, with the date
- W-9 / W-8 **held or not held** (`referral_partners.w9_received_at`, verified present in the live DB)
- payout method on file, or not

Three columns do not exist yet and would need a migration if this is wanted:
`payout_method`, `payout_details`, `referral_code`. Confirmed absent. **Not
proposed here** — flagged so the W-9 and payout-method work is costed as its
own piece rather than discovered mid-build.

### 4.5 What is deliberately NOT added

- rate cards, per-unit prices, per-order **cost** — `amount / quantity` is the rate card
- warehouse labour (`cost_labour_not_deducted`) — reported to staff on `/pnl`, never to a partner; it makes partner net profit structurally higher than Shipo's real margin and showing it invites an argument about a deduction the agreement does not make
- anything about another partner, or any client not his
- any confirmation of whether a company is a Shipo client (§3.2)

**On his original "1,2" (commission math AND order detail):** order-level detail
is already there and already bounded, so there is nothing further to grant.
Individual orders are not an input to "5% of net profit" — the inputs are
billed, the four cost categories, net profit, and the rate. Going further than
date/order/billed would be disclosure with no verification benefit. If he wants
more than that, §2.5 should be settled with the attorney first.

---

## 5. Build order

1. **Fix the stale 60-day/$500 prose** (§1a). ✅ **DONE 2026-10-13** — derived into `partner-bonus-copy.ts`, 32 tests including a `vi.mock` reversion control proving the guards can fail. It also surfaced a worse bug underneath: `getPartnerFromSession` was not selecting the five bespoke-terms columns, so a contracted partner's own statement priced them on the standing programme while `/referrals` showed staff the contracted figures. Both fixed.
2. **Disclaimer** (§2). One migration, one lib + tests, one gate, one route. Text to the attorney in parallel — build the mechanism, hold the wording.
3. **W-9 gate** (§2a). Needs the accountant's address before the envelope builder can be written (the split and the CC scope are settled); the *gate* and its partner-voice message map can be built first against `holdsW9()`, which already exists. Goes after the disclaimer because the disclaimer must precede collecting a TIN.
4. **More data** (§4.1–4.4, minus the migration-dependent parts of 4.4). No migration, no new reads, pure render over data already loaded.
5. **Claims** (§3). One migration, one partner route, one partner form, one staff queue. Largest piece and the only one that can create a payment obligation, so it goes last and gets the most review.

## 6. Testing

Decision logic in `.ts`, tests as `src/**/*.test.ts` (vitest `include` covers
nothing else). Following `partner-access.test.ts` (310 lines) and
`partner-ledger.test.ts` (777 lines):

- `partner-terms.test.ts` — `needsAcceptance`: no acceptances; current version; only an *older* version (**must re-prompt**); multiple rows; unknown future version.
- `partner-claims.test.ts` — the response is byte-identical for a new company, an existing Shipo client, and a company already claimed by another partner. This is the test that protects §3.2, and it is the one that will be tempting to weaken.
- rate-limit **fails closed** on a count error.
- approving a claim for an already-attributed client raises a conflict and writes nothing.
- `partner-ledger` / statement: a client with no first payment shows "awaiting first payment" and **not** month 0 of 12, and **not** $0.
- every `AccessBlock`-style state map is total (compile-time), and the partner phrasing contains no staff instruction — assert no partner-facing string matches `/reactivate|set the first-payment|send a new one/i`.
- **W-9 (§2a):** the gate blocks on `w9_received_at` null and opens on any timestamp; the partner-facing string does **not** match `/re-send|re-sending the agreement/i`, which is what `payoutBlockedReason()` says and what a partner cannot act on; the W-9-only envelope sets the `w9` custom field taken from the shared constant, asserted **by name** so a rename fails the build; the accountant appears exactly once as a `carbonCopies` recipient with a routing order after the signer; and — the control that matters — **a builder called with no `ACCOUNTANT_W9_EMAIL` throws rather than producing a sendable envelope.** A test that only checks the happy path would stay green on an envelope silently CC'd to nobody.

## 7. Risks

1. **§2.5 is unresolved.** Client order detail is already live on the partner statement today, before any client agreement covers it. §2.4(c) reduces but does not remove that.
2. **The claims form is the only new path to money.** Everything else here is read-only or a consent record.
3. **Bumping `PARTNER_TERMS_VERSION` re-prompts every partner.** Correct, but it must be a deliberate act, not a typo fix.
4. **Attorney review gates §2 going live**, not the build.
5. **The W-9 forwarding is the highest-consequence item in this document.** Everything else here leaks, at worst, commercial detail. This one carries a social security number, and the existing redactor cannot defend an outbound email. §2a.5's carbon-copy mechanism is not a convenience — it is the reason we never hold the bytes. If anyone later "simplifies" it into fetch-and-email, that is a regression with no symptom.
6. **One blocking input, Ophir's:** the accountant's email address. The CC-scope question is settled (W-9 only) and so is the split.
