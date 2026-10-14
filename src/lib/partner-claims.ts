// Turning a partner's claim into a storable row. Spec §3.1-§3.3.
//
// THE ONLY NEW PATH TO MONEY IN THE PORTAL. The deal is $300 plus 5% of
// net profit for twelve months, so a form that attributed a client by the
// act of typing his name is a form for claiming clients he never referred
// — Shipo's existing clients, and clients another partner brought in.
//
// A partner submits a CLAIM. Staff approve it. Nothing is attributed by
// the act of submitting, and the SHAPE OF THE INSERTED ROW is where that
// is enforced: `claimRow` emits only partner-supplied text plus the ip
// and `status: 'submitted'`. `client_id`, `decided_by`, `decided_at` and
// `decision_note` are not emitted at all — not as null, not as undefined.
// A `client_id: null` in this object would be harmless today and would be
// the line somebody later fills in from the typed company name.
//
// Separate from the route for the reason partner-terms-record.ts gives:
// `vitest.config.ts` has `include: ['src/**/*.test.ts']`, so a route
// handler cannot be covered as a module. Everything that decides anything
// lives here, where the suite can reach it; the route is sequencing.
//
// ALLOW-LIST, NEVER A SPREAD. The input is JSON off the network. Building
// the row by copying named fields means a body carrying `client_id`,
// `status: 'approved'` or `referral_partner_id` cannot reach the insert —
// `{ ...input, status: 'submitted' }` would stop only the last of those,
// and would look like it stopped all three.

import { clientIp } from './partner-terms-record'

/**
 * The ONE response body, for every outcome that is not a 4xx on shape.
 *
 * §3.2: never "this client is already with Shipo", never "already
 * attributed", never "not found". Any one of those turns the form into a
 * lookup against Shipo's client list, and a partner could enumerate the
 * customer base one guess at a time. Same reasoning that makes
 * `/api/partner/request-code` refuse to say whether an address is a
 * partner's.
 *
 * It also promises no decision and no timescale, because the next
 * sentence a partner reads about this claim is a human's.
 */
export const CLAIM_RECEIVED = 'Received. We will review this and come back to you.'

/** Claims one partner may submit per rolling 24 hours. */
export const CLAIM_DAILY_CAP = 5

/**
 * Rows one partner's claims may occupy in a rolling 24 hours before we
 * stop keeping them at all.
 *
 * NOT a second cap — a dumping-ground limit. Everything between
 * CLAIM_DAILY_CAP and here is stored and flagged, because a partner's
 * sixth claim in a day is a person with six clients, not a script. Past
 * this, keeping rows serves nobody: a human filing twenty-five claims in
 * a day is doing something the queue cannot absorb anyway, and an
 * automated submitter would fill the table unbounded.
 *
 * Set well above anything a person does by hand so that the discard is
 * never what a real partner meets.
 */
export const CLAIM_STORE_CEILING = 25

/** Cap for the short free-text fields. */
export const CLAIM_FIELD_MAX = 300

/** Cap for `note` — "what did you do for this referral". */
export const CLAIM_NOTE_MAX = 2000

/** The four states in supabase/partner_client_claims.sql's comment. */
export type ClaimStatus = 'submitted' | 'approved' | 'rejected' | 'duplicate'

/**
 * What the PARTNER is told about a claim he already filed. Spec §3.5.
 *
 * THREE states over the table's four, and the collapse is the point.
 * `rejected` and `duplicate` both read as `not_approved`, because
 * "duplicate" IS the reason — it says this company is already attributed
 * to somebody — and §3.4 tells the partner "not approved, talk to us" and
 * never the reason. A reason on this screen is the §3.2 leak arriving
 * through a different door: a partner could file claims against guessed
 * company names and read Shipo's client list off the rejections.
 */
export type ClaimPartnerState = 'under_review' | 'approved' | 'not_approved'

/**
 * `Record<ClaimPartnerState, string>` so a state added without a partner
 * phrasing is a COMPILE ERROR rather than a blank cell under a claim he
 * filed. Same construction as ROSTER_STATE_TEXT and BONUS_STATE_TEXT.
 *
 * Partner voice throughout: no staff instruction, no column name, and no
 * word about any company other than the one he typed.
 */
export const CLAIM_PARTNER_TEXT: Record<ClaimPartnerState, string> = {
  under_review: 'We have this and are looking at it. Nothing more is needed from you.',
  approved:
    'Approved. This client now counts as your referral, and the bonus and monthly share appear in the list above.',
  not_approved:
    'Not approved. Email Support@shipousa.com and we will go through it with you.',
}

/**
 * Map a stored status to the partner's three states.
 *
 * UNKNOWN FALLS TO `under_review`, deliberately. The alternatives are
 * worse in both directions: `approved` promises money on a status this
 * code has never seen, and `not_approved` refuses a claim that may be
 * perfectly live. "We are looking at it" is the only answer that is true
 * of a status we cannot interpret.
 *
 * Exact match, not case-insensitive: the column holds whatever staff
 * wrote, and 'Approved' typed by hand must not read as released money on
 * a partner's screen. The queue writes the lower-case values in
 * supabase/partner_client_claims.sql's comment; anything else is an
 * unknown and is treated as one.
 */
export function claimPartnerState(status: string | null | undefined): ClaimPartnerState {
  if (status === 'approved') return 'approved'
  if (status === 'rejected' || status === 'duplicate') return 'not_approved'
  return 'under_review'
}

/**
 * Everything is `unknown` because this is a parsed JSON body, not a form
 * the type system saw. `company_name: 123` and `company_name: null` both
 * arrive here, and `String(x)` would store '123' and 'null' as company
 * names.
 */
export interface ClaimInput {
  company_name?: unknown
  website?: unknown
  contact_name?: unknown
  contact_email?: unknown
  note?: unknown
}

/**
 * A string field, trimmed and capped, or null when it is not usable text.
 *
 * Null for a non-string too: an array or an object survives JSON.parse,
 * and coercing it would store '[object Object]'.
 */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  return trimmed.slice(0, max)
}

/**
 * Build the row to insert, or refuse it.
 *
 * `partnerId` comes from the session cookie, never from the body — it is
 * an argument precisely so there is no path by which the request can name
 * the partner it credits.
 *
 * An optional field the partner left blank is OMITTED rather than stored
 * as ''. On the staff queue an empty string reads as "he told us there is
 * no website"; absent reads as "he did not say".
 */
export function claimRow(
  partnerId: string,
  input: ClaimInput,
  forwardedFor: string | null | undefined,
  /**
   * True when this claim did not arrive inside the partner's allowance —
   * see claimAdmission. Emitted as `over_cap` so a human looks at it;
   * omitted entirely when false, because the column has a default and a
   * key written here is a key somebody later fills in from elsewhere.
   */
  overCap = false,
):
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; reason: 'no_company' } {
  const company = text(input.company_name, CLAIM_FIELD_MAX)
  // The one required field. Without it the staff queue has a row nobody
  // can act on, and the partner has a claim he believes he filed.
  if (company === null) return { ok: false, reason: 'no_company' }

  const row: Record<string, unknown> = {
    referral_partner_id: partnerId,
    company_name: company,
    status: 'submitted' satisfies ClaimStatus,
    submitted_ip: clientIp(forwardedFor),
  }

  const website = text(input.website, CLAIM_FIELD_MAX)
  if (website !== null) row.website = website

  const contactName = text(input.contact_name, CLAIM_FIELD_MAX)
  if (contactName !== null) row.contact_name = contactName

  const contactEmail = text(input.contact_email, CLAIM_FIELD_MAX)
  if (contactEmail !== null) row.contact_email = contactEmail

  const note = text(input.note, CLAIM_NOTE_MAX)
  if (note !== null) row.note = note

  // The status stays 'submitted'. A bespoke status would hide the row
  // from the staff queue's open list, which filters on 'submitted' — and
  // recording a claim nobody ever looks at is the same loss as discarding
  // it, arriving one step later.
  if (overCap) row.over_cap = true

  return { ok: true, row }
}

/**
 * Whether an approval may proceed. Null when it may; otherwise a
 * sentence saying why it must not. Spec §3.4.
 *
 * THIS GUARDS THE SINGLE WRITE THAT CREATES MONEY. Approving a claim
 * sets `clients.referral_partner_id`, which is what makes $300 plus
 * twelve months of 5% payable. If that column already names a DIFFERENT
 * partner, approving would quietly move another partner's earnings to
 * whoever typed the company name — and the partner who lost them would
 * see his client vanish from his own roster with no notice at all. §3.4:
 * "must raise a conflict, not silently re-point the row."
 *
 * EVERY AMBIGUITY RESOLVES TO RAISE, including an id that differs only
 * by case and a claim whose own partner id is blank. The two errors are
 * not symmetric: a false conflict costs a human one look at two rows,
 * and a missed conflict moves money while reporting success.
 *
 * The message names no partner, no company and no id. It is staff-facing
 * today; it says THAT there is a conflict, and whose is on the queue
 * screen — which is staff-only by route, not by the wording of a string.
 */
export function approvalConflict(args: {
  claimPartnerId: string
  client: { id: string; referral_partner_id: string | null }
}): string | null {
  const claimant = args.claimPartnerId?.trim() ?? ''
  if (claimant.length === 0) {
    // The claim row lost its owner. Writing the attribution anyway
    // credits '' — or, through a `|| null` downstream, nobody — and
    // reports success.
    return 'This claim has no partner on it, so there is nobody to credit. Do not approve it; check the claim row.'
  }

  const current = args.client.referral_partner_id?.trim() ?? ''
  // Blank is UNATTRIBUTED, not a partner named ''. A uuid column cannot
  // hold '', but the value arrives here from a read and the distinction
  // is free to make.
  if (current.length === 0) return null

  // Exact comparison, deliberately. Postgres returns canonical
  // lower-case uuids, so a case difference cannot happen — which is why
  // normalising it here would only ever hide something unexpected.
  if (current === claimant) return null

  return 'This client is already attributed to another partner. Approving would move the commission. Resolve it by hand before deciding.'
}

/**
 * Whether this approval would STRAND an earlier one. Null when it would
 * not; otherwise a sentence for staff.
 *
 * WHAT approvalConflict CANNOT SEE. It is asked about the client staff
 * named this time, and that client is unattributed, so it says yes —
 * correctly, on the facts it has. What it is not given is the claim's own
 * history: that this claim was already approved against a DIFFERENT
 * client, whose `referral_partner_id` still holds this partner's id and
 * which nothing in the route ever clears.
 *
 * The outcome is two clients attributed to one referral — $300 plus
 * twelve months of 5% of net profit on an account the partner never
 * referred — produced by staff doing the obvious thing: noticing they
 * picked the wrong client and approving again against the right one.
 *
 * IT REFUSES RATHER THAN RE-POINTING. Clearing the old client's column
 * here would be a second money-moving write decided by a route that
 * cannot know whether that attribution is now independently correct (the
 * client may genuinely be this partner's, through another claim). §3.4's
 * rule for the ambiguous case is the same one as above: raise it.
 *
 * SAME CLIENT IS NOT A CONFLICT, and that case is load-bearing — the
 * route's own 500 message tells staff "approve it again to finish" when
 * the attribution landed and the status write did not. Refusing that
 * would strand the claim in the state the message promises is
 * recoverable.
 */
export function reattributionConflict(args: {
  status: ClaimStatus
  /** `client_id` as stored on the claim, which may never have been set. */
  existingClientId: string | null
  /** The client staff chose this time. */
  clientId: string
}): string | null {
  // Only an APPROVED claim can have attributed anything. A rejection and
  // a duplicate wrote a status and a note; changing your mind about one
  // leaves nothing stale behind.
  if (args.status !== 'approved') return null

  const existing = args.existingClientId?.trim() ?? ''
  // Approved with no client recorded is the half-written state the
  // route's 500 message describes. Nothing is attributed through this
  // claim, so the next approval completes it rather than moving it.
  if (existing.length === 0) return null

  if (existing === args.clientId?.trim()) return null

  return 'This claim was already approved against a different client, and that client is still attributed to this partner. Approving now would credit both. Un-attribute the first one by hand, then decide this again.'
}

/**
 * Whether `clients.referral_partner_id` still needs writing.
 *
 * FAILS TOWARDS WRITING. False means "the column already names exactly
 * this partner" and nothing else; every other case answers true. The
 * write itself carries `.is('referral_partner_id', null)`, so an attempt
 * against a client somebody else has taken matches no rows and becomes a
 * 409 instead of a silent overwrite.
 *
 * The inverse default is the dangerous one: answering false for a client
 * attributed to another partner would skip the write, mark the claim
 * approved, and report success over an attribution naming somebody else.
 *
 * The false case exists for the idempotent recovery path — re-approving a
 * claim whose attribution already landed must not depend on a write that
 * the `.is(..., null)` guard would now correctly refuse.
 */
export function needsAttribution(
  claimPartnerId: string,
  client: { referral_partner_id: string | null },
): boolean {
  const current = client.referral_partner_id?.trim() ?? ''
  if (current.length === 0) return true
  return current !== (claimPartnerId?.trim() ?? '')
}

/**
 * Words that are a company's legal wrapper, not its name. Stripped from
 * both sides before comparing, so "Acme Widgets, LLC." and "Acme Widgets"
 * are recognised as one request rather than offered as two candidates.
 */
const COMPANY_SUFFIXES = new Set([
  'llc',
  'l',
  'inc',
  'incorporated',
  'ltd',
  'limited',
  'corp',
  'corporation',
  'co',
  'company',
  'lp',
  'llp',
  'plc',
  'gmbh',
  'bv',
  'nv',
  'sa',
  'srl',
  'pty',
  'the',
])

/** Shortest normalised name allowed to match by containment. */
const MATCH_MIN = 3

/** Most candidates the hint will offer at once. */
const MATCH_CAP = 8

/**
 * Fold a typed or stored company name to the part worth comparing.
 *
 * Lowercase, punctuation to spaces, then trailing legal-wrapper words
 * removed REPEATEDLY ("Acme Inc Co" -> "acme"). A name that is nothing
 * but wrappers folds to '', which is the point: 'LLC' is not a company
 * anyone typed on purpose, and treating it as a searchable fragment is
 * what would put the whole client table on screen.
 */
function foldCompany(value: string): string {
  const words = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0)

  while (words.length > 0 && COMPANY_SUFFIXES.has(words[words.length - 1])) {
    words.pop()
  }
  while (words.length > 0 && COMPANY_SUFFIXES.has(words[0])) {
    words.shift()
  }

  return words.join(' ')
}

/** One candidate the staff queue may offer for a typed company name. */
export interface ClientMatch {
  id: string
  name: string
  referral_partner_id: string | null
  /** True when the folded names are equal, not merely one inside the other. */
  exact: boolean
}

/**
 * Clients whose names resemble the one a partner typed. Spec §3.4.
 *
 * STAFF-ONLY, AND A HINT RATHER THAN A CHOICE. This is the one piece of
 * this feature that answers "is this company already a Shipo client" —
 * the exact question §3.2 forbids answering to a partner. It is called
 * from the queue screen and from nowhere under /partner or /api/partner,
 * and the route still requires `client_id` explicitly: approving never
 * reads this function's answer (see approvalConflict's caller).
 *
 * THE TWO ERRORS ARE NOT SYMMETRIC, and the thresholds are set by that.
 * A missed candidate costs an employee a search. A wrong candidate
 * offered first, next to an Approve button, is how somebody else's
 * client gets attributed — so containment needs MATCH_MIN characters of
 * real name, a name that is only a legal suffix matches nothing, and
 * exact matches always sort above partial ones.
 *
 * Returns at most MATCH_CAP, closest first. A null stored name is
 * SKIPPED rather than coerced: `String(null)` would put a client called
 * "null" on the screen.
 */
export function clientMatches(
  companyName: string,
  clients: readonly { id: string; name: string | null; referral_partner_id: string | null }[],
): ClientMatch[] {
  const needle = foldCompany(typeof companyName === 'string' ? companyName : '')
  if (needle.length < MATCH_MIN) return []

  const hits: ClientMatch[] = []

  for (const c of clients) {
    if (typeof c.name !== 'string') continue
    const hay = foldCompany(c.name)
    if (hay.length < MATCH_MIN) continue

    if (hay === needle) {
      hits.push({ id: c.id, name: c.name, referral_partner_id: c.referral_partner_id, exact: true })
      continue
    }
    if (hay.includes(needle) || needle.includes(hay)) {
      hits.push({
        id: c.id,
        name: c.name,
        referral_partner_id: c.referral_partner_id,
        exact: false,
      })
    }
  }

  // Exact first, then the shortest folded name — the closest thing to
  // what he typed — then alphabetically so the order is stable across
  // renders rather than following whatever order the read came back in.
  hits.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1
    const la = foldCompany(a.name).length
    const lb = foldCompany(b.name).length
    if (la !== lb) return la - lb
    return a.name.localeCompare(b.name)
  })

  return hits.slice(0, MATCH_CAP)
}

/**
 * True when the submission must be refused. FAILS CLOSED on a null count.
 *
 * §3.2, verbatim: *"The cap fails closed — if the count query errors,
 * refuse the submission. (`/api/referrals/intake`'s ceiling fails open on
 * a failed COUNT. Do not copy that.)"*
 *
 * `src/app/api/referrals/intake/route.ts` is the route NOT to copy. There,
 * failing open is a judgement call about a public WordPress form that
 * would otherwise 401 real leads. Here the thing being counted is a claim
 * on $300 plus twelve months of commission, and an unreadable count is an
 * unknown — so the honest answer is a refusal, and the refusal is
 * indistinguishable from acceptance anyway (§3.2), so it costs the
 * partner a retry rather than an answer.
 */
export function overDailyCap(countToday: number | null): boolean {
  if (countToday === null) return true
  return countToday >= CLAIM_DAILY_CAP
}

/** What to do with a claim that has just arrived. */
export type ClaimAdmission = 'accept' | 'flag' | 'discard'

/**
 * Three outcomes, because the cap was doing two jobs with one answer and
 * the discard only ever served one of them.
 *
 *   §3.2's CONCEALMENT is done by the identical response. That is what
 *   stops the form being read as a lookup against Shipo's client list,
 *   and it is entirely unaffected by whether we keep the row.
 *
 *   FLOOD PROTECTION is what dropping the row was for. It bounds how many
 *   rows one partner can write in a day.
 *
 * Throwing the claim away buys nothing for the first and everything for
 * the second — so the ceiling does the second, and everything between the
 * cap and the ceiling is STORED AND FLAGGED. A partner's sixth claim in a
 * day is a person with six clients, and until now it vanished while he
 * read "Received." and his claims panel told him, verbatim, that nothing
 * he submitted had been discarded and not to re-send it. Same harm as the
 * unreadable-count bug, by a different cause.
 *
 * A NULL COUNT FLAGS RATHER THAN DISCARDS. `overDailyCap(null)` stays
 * true — an unmeasurable ceiling must refuse to treat the claim as
 * ordinary — but "we could not count his claims" was never a reason to
 * destroy one. The insert then answers for itself: it works, or it is the
 * 500 this route already owes him. (In the route the unreadable count is
 * a 500 before this function is reached; this branch is for a supabase
 * answer carrying neither an error nor a number.)
 *
 * The caller must keep the RESPONSE identical across all three. `flag`
 * and `discard` are facts for staff and for the log, never for the body.
 */
export function claimAdmission(countToday: number | null): ClaimAdmission {
  if (countToday === null) return 'flag'
  if (countToday >= CLAIM_STORE_CEILING) return 'discard'
  if (overDailyCap(countToday)) return 'flag'
  return 'accept'
}
