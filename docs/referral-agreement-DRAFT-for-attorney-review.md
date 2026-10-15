# Shipo LLC — Referral Partner Agreement

> **STATUS: DRAFT — FOR DELAWARE ATTORNEY REVIEW ONLY. NOT FOR USE OR SIGNATURE.**
> Prepared by Shipo LLC (non-attorney). This document is not legal advice. It must be
> reviewed and approved by a licensed Delaware attorney before it is sent to any partner
> or executed. Bracketed items and margin notes flag points requiring counsel's decision.

---

**This Referral Partner Agreement** ("Agreement") is entered into as of the date of the last
signature below (the "Effective Date") by and between:

- **Shipo LLC**, a Delaware limited liability company with its principal place of business at
  310 Cornell Dr, Wilmington, DE 19801 ("Shipo" or "Company"); and
- **______________________________** ("Partner"), located at __________________________________.

Shipo and Partner are each a "Party" and together the "Parties."

---

## 1. Purpose

Partner wishes to refer prospective clients to Shipo for third-party logistics (3PL),
FBA prep, and fulfillment services ("Services"). Shipo wishes to compensate Partner for
qualified referrals on the terms below. This Agreement is non-exclusive; nothing here
prevents either Party from working with other partners, referral sources, or providers.

## 2. Referrals

2.1 A "Referral" is a prospective client that Partner introduces to Shipo in writing
(email or the Shipo partner form) and that has not, within the prior [12] months, been:
(a) an existing Shipo client; (b) already in Shipo's active sales pipeline; or
(c) referred by another partner first.

2.2 Shipo will confirm in writing whether a submitted Referral is accepted as a new,
non-duplicate lead. Shipo has sole discretion over whether to accept any prospective
client and over the terms of any client engagement.

## 3. Qualification & Compensation

> [ATTORNEY NOTE — READ FIRST. This section was rewritten on 2026-10-12 to state the
> terms Shipo is **already publishing** at shipousa.com/partner-program/ and **already
> computing** in its billing system (`src/lib/referrals.ts`). The previous draft of this
> section described a one-time $300 commission and nothing else: it omitted the 5%
> revenue-share entirely, which is the larger and longer-lived obligation of the two.
> Partners have been recruited against the published terms with no executed agreement in
> place. Three documents must say the same thing — the website, this agreement, and the
> code that calculates the payment — and the first and third already do.]

Shipo pays Partner **two separate amounts** for a Qualified Referral: a one-time signup
bonus (3.3) and a monthly share of net profit for twelve months (3.4). They are
**additive** — earning one does not reduce or replace the other.

3.1 **Qualified Referral.** A Referral becomes a "Qualified Referral" when the referred
client (a) signs a Shipo services agreement, and (b) pays its first invoice for Services.
Both limbs are required: an invoice that issues but is not paid does not qualify a
Referral. There is **no minimum invoice amount** and no minimum number of orders, units,
or months — an invoice of any size qualifies once it is paid.

> **ATTORNEY NOTE (3.1 / 3.2, rewritten 2026-10-12).** Until this date 3.1 required the
> referred client to be invoiced **$500 or more in a single calendar month**, and 3.2
> withheld the bonus until the client had been active for **60 days**. Both were removed
> on the client's instruction, with the commercial exposure put to him first and accepted:
> (i) a referred client billing a small amount each month may never return the $300 out of
> the 5% share, and (ii) without the 60-day wait the bonus is payable on a client that
> signs, is invoiced and paid once, and leaves. 3.9 (clawback on cancellation, chargeback
> or refund) is now the ONLY protection against that, which raises the stakes on the two
> questions 3.9 already leaves open below — the mechanism and the cure period. Please
> advise on both with that in mind, and in particular on whether an offset-only remedy is
> worth anything against a partner who refers once and never refers again, there being
> nothing further to offset against. If a minimum-term or repayment covenant is wanted, it
> belongs here.

3.2 **No waiting period.** Nothing further need elapse before the signup bonus becomes
payable. Once a Referral is a Qualified Referral under 3.1 the bonus is payable under 3.3,
and Shipo will not withhold it pending any minimum period of client activity, tenure, or
continued trading. Shipo's protection against a referred client that does not stay is 3.9
(clawback), which applies in place of any waiting period.

3.3 **Signup bonus.** For each Qualified Referral, Shipo will pay Partner a one-time
bonus of **$300 USD**, payable once the conditions in 3.1 are met. The bonus is paid once
per referred client, never per month and never per order.

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
salaries, not bad debt, and not Shipo's cost of the signup bonus itself.

> [ATTORNEY NOTE: this definition is the single most likely subject of a dispute, because
> it is the only clause with a running dollar figure attached and it is currently defined
> precisely in code and only loosely in prose. The four buckets above correspond exactly to
> the cost categories Shipo's billing system deducts. Recommend (i) keeping the list
> **closed** ("less only the following") rather than open-ended, as drafted, and (ii) adding
> an audit or statement-objection clause — see 3.8.]

3.6 **Statements and payment timing.** Shipo will make a monthly statement available to
Partner through the Shipo partner portal showing, for each referred client and each month:
the amount invoiced, the deducted cost categories in 3.5, the resulting Net Profit, and
Partner's 5% share. A month's share is calculated once that month's costs are final;
where a charge for the month has not yet been priced, the statement will mark the month
as provisional and no amount is owed on it until it is finalised. Amounts shown as payable
are paid within [30] days of the end of the month in which they became payable.

3.7 **Minimum payment and carry-forward.** If Partner's total balance for a month —
bonuses and revenue share combined — is **less than $50 USD**, no payment is made that
month and the balance **rolls forward** and is added to the following month. A balance of
$50 or more is paid. Carried balances are never forfeited.

3.8 **Statement objections.** [ATTORNEY NOTE: not yet drafted; recommended. Shipo's
statement is the only record Partner can see, and under 3.5 Partner cannot independently
verify the cost deductions. Suggest a window (e.g. 60 days) in which Partner may object
in writing to a statement, after which it is deemed accepted, together with a limited
right to have a disputed month re-examined.]

3.9 **Clawback / chargeback.** If the referred client cancels, charges back, or receives a
refund such that the qualifying month is not actually paid within [60] days, no bonus or
share is owed on that month; if already paid, Partner will [refund it / have it offset
against future amounts]. [ATTORNEY NOTE: choose mechanism and cure period.]

3.10 **No minimum thresholds.** Neither amount is subject to a minimum. The signup bonus
under 3.3 is owed on every Qualified Referral whatever the size of the referred client's
invoices, and the revenue share under 3.4 is owed on the Net Profit of every month in the
twelve-month window however small that month's figure is — subject only to 3.7, which
defers payment of a balance under $50 USD to the following month without forfeiting it.

3.11 **One set of terms.** There is no promotional, launch, or founding tier. Every
Qualified Referral earns the same bonus under 3.3 and the same revenue share under 3.4,
measured from the referred client's first paid invoice, regardless of when the referral was
made or how many referrals preceded it.

> [ATTORNEY NOTE: 3.11 is deliberately a statement that no separate promotional tier
> exists, not a promotional term. An earlier draft of this section carried a limited
> "Founding Client" offer — a raised $500 bonus for the first ten referred clients and a
> revenue-share window shifted to the client's second month. That offer was withdrawn on
> 2026-10-12 before any partner was signed and before any bonus was paid, and it was never
> published on shipousa.com. It is recorded here only so that a reader comparing drafts can
> see the clause was removed deliberately rather than lost. If Shipo later wants a
> promotional tier, it belongs in a dated addendum that expires without amending this
> document.]

## 4. Taxes & Independent Contractor Status

4.1 Partner is an independent contractor, not an employee, agent, partner, or joint
venturer of Shipo. Partner has no authority to bind Shipo or to quote prices, make
promises, or sign agreements on Shipo's behalf.

4.2 Partner is responsible for all taxes on amounts received under Section 3. Shipo will
issue an IRS Form 1099 where required; Partner will provide a completed **Form W-9** before
any amount is paid. [ATTORNEY NOTE: confirm 1099-NEC handling and W-9 gate. Note that the
W-9 gate interacts with 3.7: if a balance is withheld for a missing W-9 it should carry
forward rather than be forfeited, and the drafting should say which.]

## 5. Partner Conduct

Partner will: (a) represent Shipo's Services truthfully and only using Shipo-approved
materials; (b) not make guarantees about pricing, results, tax outcomes, or savings;
(c) comply with applicable laws including the CAN-SPAM Act and anti-spam / do-not-contact
rules in any outreach; and (d) not use Shipo's name, logo, or trademarks except as
approved in writing.

> [ATTORNEY NOTE: Delaware "0% sales tax" is a location fact only. Partner must not
> represent that using Shipo lowers a client's own sales-tax obligations. Consider an
> explicit prohibition on tax-benefit claims.]

## 6. Confidentiality

Each Party will keep the other's non-public business information (including client lists,
pricing, and commission terms) confidential and use it only to perform under this
Agreement. This survives termination for [2] years.

## 7. Term & Termination

7.1 This Agreement begins on the Effective Date and continues until terminated.

7.2 Either Party may terminate for convenience on [30] days' written notice.

7.3 **Survival of amounts already earned.** Termination does not end the twelve-month
revenue share in Section 3.4 for clients that qualified **before** termination. For each
such client, the bonus under 3.3 (if its conditions were met before termination) and the
remaining months of its 3.4 window continue to be payable, and the statement and payment
obligations in 3.6 and 3.7 continue, until that client's twelve-month window expires. No
bonus or share accrues on referrals submitted after termination.

> [ATTORNEY NOTE: this clause and 7.2 are in tension by design and counsel should confirm
> the resolution is the intended one. 7.2 lets either side terminate for convenience on 30
> days' notice; without 7.3 stated this explicitly, Shipo could be read as able to end a
> twelve-month obligation in its second month by terminating the agreement. That reading
> would be inconsistent with the published offer, which promises twelve months. If Shipo
> instead wants a right to cut the tail short — for cause, for example — that has to be
> drafted as its own exception here rather than left to inference.]

## 8. Limitation of Liability

Except for breaches of confidentiality (Section 6) or Partner's indemnification
obligations, neither Party is liable for indirect, incidental, or consequential damages,
and each Party's total liability is capped at the total amounts paid or payable to Partner
under Section 3 — bonuses and revenue share combined — in the [12] months before the claim.
[ATTORNEY NOTE: confirm cap and carve-outs. "Amounts under Section 3" rather than
"commissions", because Section 3 now creates two distinct payments and a cap worded against
only one of them would be ambiguous.]

## 9. Indemnification

Partner will indemnify Shipo against claims arising from Partner's misrepresentations,
unauthorized promises, or unlawful outreach. [ATTORNEY NOTE: confirm mutual vs. one-way.]

## 10. Governing Law & Disputes

This Agreement is governed by the laws of the State of Delaware, without regard to its
conflict-of-laws rules. The Parties consent to [venue: courts located in Delaware /
binding arbitration in Delaware]. [ATTORNEY NOTE: choose forum + arbitration vs. courts.]

## 11. General

Entire agreement; no oral modifications; assignment only with consent; notices in writing;
severability; counterparts and electronic signatures (including DocuSign) are valid.

---

## Signatures

**Shipo LLC**

Signature: \s1\

Name: Ophir Schultz  \n1\

Title: Owner / Principal

Date: \d1\

**Partner**

Signature: \s2\

Name: \n2\

Title:

Date: \d2\

> DocuSign anchor tags (\s1\ \n1\ \d1\ signer 1 = Shipo; \s2\ \n2\ \d2\ signer 2 = Partner)
> are placed for automated tab positioning and are removed/hidden at send time.
