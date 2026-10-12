# Shipo LLC — Referral Partner Agreement

> **DOCUSIGN TEMPLATE — one copy, every partner.** Prepared 2026-10-12 from
> `docs/referral-agreement-DRAFT-for-attorney-review.md`. Every bracketed item in that
> draft has been resolved to a specific term; the resolutions are listed at the end of this
> file under "Schedule of Resolved Items" for the record. This document has **not** been
> reviewed by a licensed Delaware attorney.
>
> This file is deliberately NOT partner-specific. The first version of it was cut for a
> named counterparty, with the company name and address typed into the party block — which
> would have meant a new file in `docs/` for every partner, each one a separate copy of the
> same figures, drifting apart on its own schedule. The counterparty's details are instead
> DocuSign fill anchors (`\pname\` `\paddr\` `\pemail\`), filled by the sender at send
> time. One document, one set of figures, one thing to keep in step with
> `src/lib/referrals.ts`.
>
> Only the text between the CONTRACT-START and CONTRACT-END markers below is the contract.
> `scripts/build-agreement-pdf.mjs` renders exactly that slice and nothing else, so this
> note and the Schedule at the foot of the file never reach the counterparty. An internal
> note about open legal questions, bound into the signed document, is an admission.

---

<!-- CONTRACT-START -->

**This Referral Partner Agreement** ("Agreement") is entered into as of the date of the last
signature below (the "Effective Date") by and between:

- **Shipo LLC**, a Delaware limited liability company with its principal place of business at
  310 Cornell Dr, Wilmington, DE 19801 ("Shipo" or "Company"); and
- **\pname\**, with its address at \paddr\ ("Partner").

Notices to Partner may be given at \pemail\. Notices to Shipo may be
given at ophir@shipousa.com.

Shipo and Partner are each a "Party" and together the "Parties."

---

## 1. Purpose

Partner wishes to refer prospective clients to Shipo for third-party logistics (3PL),
FBA prep, and fulfillment services ("Services"). Shipo wishes to compensate Partner for
qualified referrals on the terms below. This Agreement is non-exclusive; nothing here
prevents either Party from working with other partners, referral sources, or providers.

## 2. Referrals

2.1 A "Referral" is a prospective client that Partner introduces to Shipo in writing
(email or the Shipo partner form) and that has not, within the prior twelve (12) months,
been: (a) an existing Shipo client; (b) already in Shipo's active sales pipeline; or
(c) referred by another partner first.

2.2 Shipo will confirm in writing whether a submitted Referral is accepted as a new,
non-duplicate lead. Shipo has sole discretion over whether to accept any prospective
client and over the terms of any client engagement.

## 3. Qualification & Compensation

Shipo pays Partner **two separate amounts** for a Qualified Referral: a one-time signup
bonus (3.3) and a monthly share of net profit for twelve months (3.4). They are
**additive** — earning one does not reduce or replace the other.

3.1 **Qualified Referral.** A Referral becomes a "Qualified Referral" when the referred
client (a) signs a Shipo services agreement, and (b) is invoiced **$500 USD or more in a
single calendar month** for Services. The test is at-or-above $500, not more than $500,
and it is measured per calendar month — not as a running total across months.

3.2 **Release condition (60 days active).** No signup bonus is payable until the referred
client has been an active, invoiced Shipo client for at least **60 days**, even if the
client cleared the $500 threshold in its first month. This exists so that a bonus is not
paid on an account that signs and immediately churns. For this purpose a client is
"active" if Shipo has invoiced it for Services and its engagement has not been terminated;
the 60 days are measured from the first day of the earliest calendar month in which Shipo
invoiced that client. A month in which no invoice issues does not by itself end the
period, but termination of the client's engagement does.

3.3 **Signup bonus.** For each Qualified Referral, Shipo will pay Partner a one-time
bonus of **$300 USD**, payable after the conditions in 3.1 and 3.2 are both met and the
referred client has paid its first qualifying invoice. The bonus is paid once per referred
client, never per month and never per order.

3.4 **Revenue share — 5% of net profit for 12 months.** In addition to the bonus, Shipo
will pay Partner **5% of the Net Profit** (as defined in 3.5) earned on the referred
client's **entire account**, each calendar month, for **twelve (12) consecutive months**
measured from the client's **first paid invoice**. The share is calculated on the whole
account, not only on the specific service the Referral was made for.

3.5 **"Net Profit", defined.** For each referred client and each calendar month, Net
Profit means the total amount **invoiced to that client for that month**, less only the
following direct costs of serving that account in that month:

  (a) **freight and carrier charges** — including shipping charges, carrier surcharges,
      and return shipping;
  (b) **packaging and prep materials**;
  (c) **storage**; and
  (d) **payment-processing fees**.

**Warehouse labor is NOT deducted.** Pick, pack, and receiving labor are excluded from
this calculation, which increases Net Profit and therefore increases Partner's share.
No other deduction of any kind is taken — not overhead, not software, not rent, not
salaries, not bad debt, and not Shipo's cost of the signup bonus itself. The list in
(a)–(d) is closed: Shipo may not add a category of deduction without a written amendment
signed by both Parties.

3.6 **Statements and payment timing.** Shipo will make a monthly statement available to
Partner through the Shipo partner portal showing, for each referred client and each month:
the amount invoiced, the deducted cost categories in 3.5, the resulting Net Profit, and
Partner's 5% share. A month's share is calculated once that month's costs are final;
where a charge for the month has not yet been priced, the statement will mark the month
as provisional and no amount is owed on it until it is finalised. Amounts shown as payable
are paid within **thirty (30) days** of the end of the month in which they became payable.

3.7 **Minimum payment and carry-forward.** If Partner's total balance for a month —
bonuses and revenue share combined — is **less than $50 USD**, no payment is made that
month and the balance **rolls forward** and is added to the following month. A balance of
$50 or more is paid. Carried balances are never forfeited.

3.8 **Statement objections and re-examination.** Partner may object in writing to any
monthly statement within **sixty (60) days** after that statement is first made available
to Partner in the partner portal. An objection must identify the month, the referred
client, and the figure disputed. A statement not objected to within that window is deemed
accepted and final as to the amounts it shows.

Where Partner objects in time, Shipo will re-examine the disputed month and, within
thirty (30) days of the objection, give Partner a written explanation of each disputed
figure, including the amount invoiced and the total of each cost category in 3.5 for that
client and month. If the re-examination shows an underpayment, Shipo will pay the
difference with the next scheduled payment; if it shows an overpayment, the difference is
offset under 3.9.

A month marked provisional under 3.6 is not subject to the sixty-day window until the
statement for that month is finalised; the window runs from the date the finalised
statement is made available.

This clause does not give Partner a right of access to Shipo's books, to any rate card, to
per-unit prices, or to the cost of any individual order.

3.9 **Clawback / chargeback.** If the referred client cancels, charges back, or receives a
refund such that the qualifying month is not actually paid within **sixty (60) days** of
the invoice date, no bonus or share is owed on that month. Where an amount has already
been paid to Partner, Shipo will recover it **by offset against amounts next becoming
payable** to Partner under this Agreement, and not by demanding a refund. Shipo will
identify any offset on the statement for the month in which it is taken.

If this Agreement terminates while an offset balance is outstanding, Shipo may continue to
offset it against amounts that remain payable under 7.3. If no such amounts remain, the
outstanding balance is written off and Partner owes Shipo nothing.

3.10 **Minimum thresholds.** No bonus is owed on a referred account that never reaches
$500 invoiced in a calendar month. The revenue share in 3.4 is not subject to that
threshold once the client has qualified.

3.11 **One set of terms.** There is no promotional, launch, or founding tier. Every
Qualified Referral earns the same bonus under 3.3 and the same revenue share under 3.4,
measured from the referred client's first paid invoice, regardless of when the referral was
made or how many referrals preceded it. Any future promotional term must be made by a
dated written addendum signed by both Parties.

## 4. Taxes & Independent Contractor Status

4.1 Partner is an independent contractor, not an employee, agent, partner, or joint
venturer of Shipo. Partner has no authority to bind Shipo or to quote prices, make
promises, or sign agreements on Shipo's behalf.

4.2 Partner is responsible for all taxes on amounts received under Section 3. Shipo will
issue an IRS Form 1099-NEC where required; Partner will provide a completed **Form W-9**
before any amount is paid. A balance that is withheld solely because Shipo has not
received Partner's W-9 **carries forward and is not forfeited**; it becomes payable with
the next scheduled payment after the W-9 is received.

## 5. Partner Conduct

Partner will: (a) represent Shipo's Services truthfully and only using Shipo-approved
materials; (b) not make guarantees about pricing, results, tax outcomes, or savings;
(c) comply with applicable laws including the CAN-SPAM Act and anti-spam / do-not-contact
rules in any outreach; and (d) not use Shipo's name, logo, or trademarks except as
approved in writing.

5.1 **No tax-benefit claims.** Shipo's Delaware location means Delaware imposes no state
sales tax on Shipo. That is a fact about where Shipo operates and nothing more. Partner
will not represent, suggest, or imply that engaging Shipo reduces, eliminates, defers, or
otherwise changes a client's own sales-tax, use-tax, nexus, or other tax obligations in
any jurisdiction, and will not describe Shipo's Services as producing a tax benefit of any
kind.

## 6. Confidentiality

Each Party will keep the other's non-public business information (including client lists,
pricing, and commission terms) confidential and use it only to perform under this
Agreement. This survives termination for **two (2) years**.

## 7. Term & Termination

7.1 This Agreement begins on the Effective Date and continues until terminated.

7.2 Either Party may terminate for convenience on **thirty (30) days'** written notice.

7.3 **Survival of amounts already earned.** Termination does not end the twelve-month
revenue share in Section 3.4 for clients that qualified **before** termination. For each
such client, the bonus under 3.3 (if its conditions were met before termination) and the
remaining months of its 3.4 window continue to be payable, and the statement and payment
obligations in 3.6, 3.7 and 3.8 continue, until that client's twelve-month window expires.
No bonus or share accrues on referrals submitted after termination.

7.4 **Exception — termination for cause.** Shipo may terminate this Agreement immediately
on written notice, and the survival in 7.3 does **not** apply, where Partner has
(a) breached Section 5 or Section 6; (b) made a material misrepresentation about Shipo's
Services, pricing, or tax treatment; or (c) obtained a Referral by unlawful outreach. In
that event no further bonus or share accrues from the date of notice, including on clients
that had already qualified. Shipo bears the burden of identifying the conduct relied on in
its notice. Termination for convenience under 7.2 is not termination for cause and does
not cut short 7.3.

## 8. Limitation of Liability

Except for breaches of confidentiality (Section 6) or Partner's indemnification
obligations, neither Party is liable for indirect, incidental, or consequential damages,
and each Party's total liability is capped at the total amounts paid or payable to Partner
under Section 3 — bonuses and revenue share combined — in the **twelve (12)** months
before the claim.

## 9. Indemnification

Indemnification under this Agreement runs **one way**. Partner will indemnify, defend and
hold harmless Shipo against third-party claims, and against losses, liabilities and
reasonable legal fees, arising from Partner's misrepresentations, unauthorized promises,
breach of Section 5, or unlawful outreach. Shipo owes Partner no indemnity under this
Agreement; Shipo's exposure to Partner is limited to the amounts in Section 3 and the cap
in Section 8.

## 10. Governing Law & Disputes

This Agreement is governed by the laws of the State of Delaware, without regard to its
conflict-of-laws rules. The Parties consent to the exclusive jurisdiction and venue of the
state and federal courts located in New Castle County, Delaware, and each Party waives any
objection to that venue on grounds of inconvenient forum. Each Party bears its own legal
fees except where Section 9 applies.

## 11. General

Entire agreement; no oral modifications; assignment only with consent; notices in writing;
severability; counterparts and electronic signatures (including DocuSign) are valid.

---

## Signatures

**Shipo LLC**

Signature: _______________________  \s1\

Name: Ophir Schultz  \n1\

Title: Owner / Principal

Date: _______________  \d1\

**Partner — \pname\**

Signature: _______________________  \s2\

Name: _______________________  \n2\

Title: _______________________

Date: _______________  \d2\

<!-- CONTRACT-END -->

---

## Schedule of Resolved Items

Recorded so that this copy can be compared against the attorney-review draft. Each line is
a decision, not a drafting preference, and each one is a point an attorney may still want
to change.

| Clause | Draft left open | Resolved to |
|---|---|---|
| 2.1 | `[12]` month duplicate lookback | twelve (12) months |
| 3.2 | definition of "active" | invoiced and not terminated, measured from the earliest invoiced month — matches what the billing system computes |
| 3.5 | list open or closed | **closed** — no new deduction category without a signed amendment |
| 3.6 | `[30]` day payment window | thirty (30) days after month end |
| 3.8 | **not drafted at all** | 60-day objection window, deemed accepted after; 30-day written re-examination with category totals; provisional months run from finalisation; expressly no books/rate-card access |
| 3.9 | refund **or** offset; `[60]` days | **offset only**, never a demand for refund; 60 days from invoice date; written off if nothing remains to offset against |
| 4.2 | 1099 handling; W-9 gate vs. 3.7 | 1099-NEC; a balance withheld for a missing W-9 carries forward and is not forfeited |
| 5 | explicit tax-benefit prohibition | added as 5.1 |
| 6 | `[2]` year confidentiality tail | two (2) years |
| 7.2 | `[30]` day notice | thirty (30) days |
| 7.3 / 7.4 | whether Shipo may cut the 12-month tail short | convenience termination does **not** cut it short; a separate for-cause right in 7.4 does, limited to Section 5/6 breach, material misrepresentation, or unlawful outreach |
| 8 | `[12]` month lookback for the cap | twelve (12) months |
| 9 | mutual or one-way | **one-way**, stated expressly |
| 10 | Delaware courts vs. arbitration | courts, exclusive venue New Castle County, Delaware |

Two items were deliberately **not** added:

- **No audit right.** 3.8 gives Partner an explanation and a re-examination, not access to
  Shipo's books. An audit right over a cost definition this granular is the clause most
  likely to be abused by a partner who is also a competitor.
- **No non-solicitation.** Partner is a referral source, not an employee or a reseller, and
  a non-solicit against someone whose business is making introductions is both hard to
  enforce and likely to kill the deal.
