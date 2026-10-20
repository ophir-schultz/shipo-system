// Planning a pasted list of companies into claims. Spec §3.1-§3.4.
//
// A partner onboarding an existing book pastes ~100 company names at
// once. Each one is a claim on $300 plus twelve months of 5% of net
// profit, so the failure that matters here is not a crash — it is a
// company he believes he filed that was never stored.
//
// TWO OUTCOMES, NEVER A THIRD. The whole list is planned or nothing is.
// §3.2: *"What must never happen is a partial accept. Taking the first
// 150 of 203 and answering 'Received' is Finding 1 wearing a different
// hat — he believes 203 are filed and 53 are gone."* Every refusal below
// returns no rows at all, so there is no object a later edit can reach
// into to store "the good ones".
//
// THE REFUSALS ARE ALLOWED TO BE SPECIFIC, and that is not a crack in the
// concealment rule of the 2026-10-13 spec (§3.2: never confirm or deny
// that a company is known to Shipo). The existing route already drew this
// line for the empty-form case: a refusal about the SHAPE of the request
// — too long, empty, a line that is not a company — tells a partner
// nothing about any company. What stays identical is every answer that
// depends on what Shipo knows.
//
// NOT A SPREAD, SAME AS claimRow. These rows are built field by field
// from the partner's own text. A row object here that carried `client_id`
// or `status` would be the key somebody later fills in, and approving a
// claim is the only write in the system that creates money.

import { CLAIM_FIELD_MAX } from './partner-claims'

/**
 * Companies one paste may contain. §3.2: "Covers 'close to 100' with
 * headroom."
 */
export const BATCH_MAX_ROWS = 150

/**
 * Batches one partner may submit per rolling 24 hours.
 *
 * PER BATCH, NOT PER ROW. §3.2 is explicit that the batch path must not
 * consult `CLAIM_DAILY_CAP` or `CLAIM_STORE_CEILING`: those bound how
 * many times a partner can fill in the single-claim form, and a batch is
 * one submission. Running a 100-row paste through a 5-per-day cap would
 * flag or discard 95 rows of a legitimate first upload.
 */
export const BATCH_MAX_PER_DAY = 3

/**
 * The legal wrappers a trailing word may be, and nothing more.
 *
 * DELIBERATELY NARROWER than COMPANY_SUFFIXES in partner-claims.ts. That
 * list serves the staff match hint, where folding hard costs at most a
 * search. Folding hard HERE collapses two different companies into one
 * key and the second one is never filed — the partial accept again, by a
 * different route. "Acme GmbH" and "Acme BV" are two companies in two
 * countries; filing both and letting a human notice is the recoverable
 * error, dropping one is not.
 *
 * The five the spec names: §3.3, "a trailing legal suffix (`inc`, `llc`,
 * `ltd`, `corp`, `co`) ignored".
 */
const BATCH_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'corp', 'co'])

/**
 * The key two spellings of one company must share.
 *
 * NFKC first, because a paste out of a spreadsheet or a non-Latin layout
 * brings full-width characters in and they are a different byte string:
 * "ＡＣＭＥ" and "Acme" would be two claims for one company. Then
 * lowercase, punctuation to spaces, whitespace collapsed, and ONE
 * trailing legal wrapper removed.
 *
 * One, not repeatedly: see BATCH_SUFFIXES. Every extra fold is another
 * pair of real companies that can collide.
 *
 * Returns '' for a line that is nothing but a wrapper or punctuation.
 * planBatch treats that as unusable rather than as a company, because
 * '' as a dedupe key would fold every such line onto one another.
 */
export function batchFold(value: string): string {
  if (typeof value !== 'string') return ''
  const words = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0)

  if (words.length > 1 && BATCH_SUFFIXES.has(words[words.length - 1])) {
    words.pop()
  } else if (words.length === 1 && BATCH_SUFFIXES.has(words[0])) {
    // "LLC" on a line of its own. Not a company; fold to nothing so the
    // caller refuses it by name.
    return ''
  }

  return words.join(' ')
}

/** A planned row: the partner's own text, and nothing else. */
export interface BatchRow {
  company_name: string
  website?: string
  contact_name?: string
  contact_email?: string
}

export type BatchPlan =
  | {
      ok: true
      /** What to insert. Empty when every row was already filed. */
      rows: BatchRow[]
      /** Lines he pasted, before the fold. The honest number to echo. */
      rawCount: number
    }
  | {
      ok: false
      reason: 'empty' | 'too_many' | 'unusable_row'
      /** Partner-facing, about his paste and never about any company. */
      message: string
    }

/** Header words that mean "this column is the company". */
const HEADER_COMPANY = new Set([
  'company',
  'company name',
  'client',
  'client name',
  'business',
  'business name',
  'name',
])

const HEADER_WEBSITE = new Set(['website', 'web site', 'url', 'site', 'domain', 'web'])

const HEADER_CONTACT = new Set([
  'contact',
  'contact name',
  'contact person',
  'who you dealt with',
  'person',
])

const HEADER_EMAIL = new Set(['email', 'e mail', 'e-mail', 'contact email', 'email address'])

/**
 * Split one CSV line, honouring double quotes.
 *
 * A real export writes `"Acme, LLC",acme.com`. Splitting on every comma
 * would file a company called "Acme" with a website called "LLC" — a
 * claim the partner never typed, on his own roster.
 */
function cells(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((c) => c.trim())
}

/** Column positions read off a header line. -1 for absent. */
interface Columns {
  company: number
  website: number
  contact: number
  email: number
}

/**
 * Column positions if this line is a header, else null.
 *
 * REQUIRES A COMMA. A single-column list whose first company happens to
 * be called "Business" must not lose its first row to a header guess —
 * and a one-column CSV whose header reads "Company" instead files one
 * junk claim that staff reject in a second. Those two errors are not
 * symmetric, so the rule is the one that never loses a real company.
 */
function headerColumns(line: string): Columns | null {
  const parts = cells(line)
  if (parts.length < 2) return null
  const lower = parts.map((p) =>
    p
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
  )
  const company = lower.findIndex((p) => HEADER_COMPANY.has(p))
  if (company === -1) return null
  return {
    company,
    website: lower.findIndex((p) => HEADER_WEBSITE.has(p)),
    contact: lower.findIndex((p) => HEADER_CONTACT.has(p)),
    email: lower.findIndex((p) => HEADER_EMAIL.has(p)),
  }
}

/** Trimmed and capped, or undefined when the partner left it blank. */
function field(parts: string[], index: number): string | undefined {
  if (index < 0 || index >= parts.length) return undefined
  const value = parts[index].trim()
  if (value.length === 0) return undefined
  return value.slice(0, CLAIM_FIELD_MAX)
}

/** Strip the quotes off a line that is one quoted field. */
function unwrap(line: string): string {
  const t = line.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/""/g, '"').trim()
  }
  return t
}

/**
 * Plan a paste into rows, or refuse the whole thing.
 *
 * `existingFolded` is `batchFold` applied to the company names this
 * partner has already claimed — his own submissions, so comparing
 * against them tells him nothing about Shipo's clients. Deduping against
 * it stops the second upload of an overlapping list from filing every
 * company twice.
 *
 * Checks run in the order a partner is best served by: too-long before
 * unusable-line, because a 203-row paste needs splitting whether or not
 * line 40 is junk.
 */
export function planBatch(raw: string, existingFolded: readonly string[]): BatchPlan {
  const lines = typeof raw === 'string' ? raw.split(/\r?\n/) : []

  // Line numbers are the ones HE can count in his own paste, blanks
  // included. Numbering the lines we kept would point him at the wrong
  // one.
  const content: { text: string; line: number }[] = []
  let columns: Columns | null = null

  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i]
    if (text.trim().length === 0) continue
    if (content.length === 0 && columns === null) {
      const header = headerColumns(text)
      if (header !== null) {
        columns = header
        continue
      }
    }
    content.push({ text, line: i + 1 })
  }

  if (content.length === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: 'That was empty. Paste one company per line and send it again.',
    }
  }

  if (content.length > BATCH_MAX_ROWS) {
    return {
      ok: false,
      reason: 'too_many',
      message: `We can take ${BATCH_MAX_ROWS} companies at a time. You pasted ${content.length} — please split it.`,
    }
  }

  const rows: BatchRow[] = []
  // Seeded with his existing claims so the fold spans both.
  const seen = new Set(existingFolded.map((k) => k).filter((k) => k.length > 0))

  for (const { text, line } of content) {
    let company: string | undefined
    let website: string | undefined
    let contactName: string | undefined
    let contactEmail: string | undefined

    if (columns !== null) {
      const parts = cells(text)
      company = field(parts, columns.company)
      website = field(parts, columns.website)
      contactName = field(parts, columns.contact)
      contactEmail = field(parts, columns.email)
    } else {
      // No header: the WHOLE line is the name, commas and all. "Acme,
      // LLC" is one company, not a company and a website.
      const whole = unwrap(text)
      company = whole.length > 0 ? whole.slice(0, CLAIM_FIELD_MAX) : undefined
    }

    const key = company === undefined ? '' : batchFold(company)
    if (key.length === 0) {
      // Refuse the batch rather than file "LLC" as a claim or drop the
      // line. Dropping it is the partial accept §3.2 forbids outright.
      const shown = (company ?? text).trim().slice(0, 60)
      return {
        ok: false,
        reason: 'unusable_row',
        message: `Line ${line} reads "${shown}", which is not a company name. Fix that line and send the list again.`,
      }
    }

    if (seen.has(key)) continue
    seen.add(key)

    const row: BatchRow = { company_name: company as string }
    if (website !== undefined) row.website = website
    if (contactName !== undefined) row.contact_name = contactName
    if (contactEmail !== undefined) row.contact_email = contactEmail
    rows.push(row)
  }

  return { ok: true, rows, rawCount: content.length }
}

/**
 * What the partner reads after a batch is stored. §3.3: "The response
 * reports both numbers."
 *
 * Both counts are facts about his own submission. Neither says anything
 * about whether any company is known to Shipo, and like CLAIM_RECEIVED
 * the sentence promises no decision and no date — the next thing he
 * reads about these claims is a human's.
 */
export function batchReceivedMessage(rawCount: number, keptCount: number): string {
  if (keptCount === 0) {
    return `Received your list of ${rawCount}. You had already sent us every one of them, so nothing new was added. Nothing more is needed from you.`
  }
  if (keptCount === rawCount) {
    return `Received ${rawCount} ${rawCount === 1 ? 'company' : 'companies'}. We will review these and come back to you.`
  }
  return `Received: ${rawCount} pasted, ${keptCount} after removing duplicates. We will review these and come back to you.`
}

/**
 * True when this batch must be refused on the rolling-24h count. FAILS
 * CLOSED on a null count.
 *
 * Same discipline as overDailyCap, and for the same stated reason:
 * `/api/referrals/intake`'s ceiling fails OPEN on a failed COUNT and
 * §3.2 says in as many words not to copy that. An unreadable count is an
 * unknown, and what is being counted is a claim on twelve months of
 * commission.
 *
 * In the route an ERRORING count is a 500 before this is reached — a
 * write we could not verify must never be reported as received. This
 * branch covers an answer carrying neither an error nor a number.
 */
export function overBatchDailyCap(countToday: number | null): boolean {
  if (countToday === null) return true
  return countToday >= BATCH_MAX_PER_DAY
}

// ============================================================
// THE STAFF SIDE OF A PASTE. Spec §3.5.
//
// A list of a hundred companies arrives as a hundred ordinary claim
// rows, each needing its own client picked and its own Approve. What
// the batch gives the queue is the HEADING: whose list, when it
// arrived, how much of it is still waiting. Without it the queue shows
// a hundred unrelated rows filed in the same second and the only way
// back to "what did he actually send us" is to eyeball timestamps.
//
// A GROUP IS A HEADING, NOT A DECISION. Approving is the single write
// that creates money, so every claim inside a group keeps its own
// dropdown and its own button. §3.5 leaves bulk approve out of scope on
// purpose, and this function deliberately returns no shape that would
// make one convenient: there is no "all client ids" and no "approve
// these" — only the rows, which the caller renders one at a time.
// ============================================================

/** The columns grouping needs. The queue's row type is a superset. */
export interface GroupableClaim {
  id: string
  batch_id?: string | null
  referral_partner_id: string | null
  status: string | null
  created_at: string | null
}

export type ClaimGroup<T> =
  | { kind: 'single'; claim: T }
  | {
      kind: 'batch'
      batchId: string
      /**
       * Null when the group's claims disagree about whose they are. One
       * insert carries one partner id so the route cannot produce that,
       * but if it ever happens the failure mode is a heading naming
       * partner A over partner B's claim and a human approving under it
       * — so this says "I do not know" rather than guessing the first.
       */
      partnerId: string | null
      partnerMismatch: boolean
      /** Earliest created_at in the group. One insert, so normally all equal. */
      submittedAt: string | null
      /** The ones still waiting, in the order they were read. */
      claims: T[]
      /** Already decided and therefore NOT in `claims`. A count only. */
      decidedCount: number
    }

/** The queue reads a missing status as waiting; so does this. */
const isOpen = (status: string | null): boolean => (status ?? 'submitted') === 'submitted'

/**
 * Group the claims queue for rendering: one entry per single claim, one
 * per batch, in the order the rows arrived.
 *
 * ORDER IS PRESERVED, and the batch sits where its FIRST row sat. The
 * page reads newest first; a grouping that re-sorted would move an old
 * list above this morning's claim and quietly change what a human looks
 * at first.
 *
 * DECIDED CLAIMS ARE COUNTED, NOT RENDERED. Putting one back in front of
 * a human is an invitation to approve it twice, and the second approval
 * of a rejected claim is a commission nobody meant to grant. A batch
 * with nothing left waiting yields no entry at all — those rows are in
 * the decided section, and an empty collapsible headed "0 waiting" is a
 * thing to click for nothing.
 */
export function groupOpenClaims<T extends GroupableClaim>(claims: readonly T[]): ClaimGroup<T>[] {
  const out: ClaimGroup<T>[] = []
  // batch id -> index in `out`, so a later row of the same list lands in
  // the group that is already placed rather than opening a second one.
  const at = new Map<string, number>()

  for (const claim of claims) {
    // An empty string is a column written wrong, not a list. Grouping on
    // it would file every such claim, from every partner, under one
    // heading — and that heading would name one of them.
    const batchId =
      typeof claim.batch_id === 'string' && claim.batch_id.length > 0 ? claim.batch_id : null

    if (batchId === null) {
      if (isOpen(claim.status)) out.push({ kind: 'single', claim })
      continue
    }

    let index = at.get(batchId)
    if (index === undefined) {
      index = out.length
      at.set(batchId, index)
      out.push({
        kind: 'batch',
        batchId,
        partnerId: claim.referral_partner_id,
        partnerMismatch: false,
        submittedAt: claim.created_at,
        claims: [],
        decidedCount: 0,
      })
    }

    const group = out[index]
    if (group.kind !== 'batch') continue

    if (group.partnerId !== claim.referral_partner_id) {
      group.partnerId = null
      group.partnerMismatch = true
    }

    if (
      typeof claim.created_at === 'string' &&
      (group.submittedAt === null || claim.created_at < group.submittedAt)
    ) {
      group.submittedAt = claim.created_at
    }

    if (isOpen(claim.status)) group.claims.push(claim)
    else group.decidedCount += 1
  }

  return out.filter((g) => g.kind === 'single' || g.claims.length > 0)
}
