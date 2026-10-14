'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'
import { CLAIM_NOTE_MAX, clientMatches } from '@/lib/partner-claims'

// ============================================================
// The staff claims queue. Spec §3.4.
//
// A partner typed a company name and asked to be credited for it.
// Approving that is the single write that creates money: it sets
// `clients.referral_partner_id`, and that column is what makes $300 plus
// twelve months of 5% of net profit payable.
//
// THIS SCREEN IS STAFF-ONLY, AND IT IS THE ONE PLACE THE §3.2 ANSWER
// EXISTS. It says whether the typed company resembles a client Shipo
// already has, and whose that client is. That is exactly the question
// the partner-facing form refuses to answer — a partner who could read
// it could enumerate the customer base one guess at a time. It is
// reachable only from /referrals, which `src/proxy.ts` gates, and
// `clientMatches` is imported here and nowhere under /partner.
//
// THE HINT NEVER PRE-SELECTS. The dropdown opens on "Choose a client",
// every time, including when there is exactly one obvious candidate.
// §3.1: the typed name is a request, the foreign key is the decision —
// and a decision that was already made for you is not one. A wrong
// pre-selection next to an Approve button is how somebody else's client
// gets attributed by a single click.
//
// A CONFLICT STAYS ON SCREEN. Every other outcome is a toast. A 409 is
// written next to the claim and left there, because it is the one answer
// that requires a human to go and look at two rows, and a toast that
// has faded is indistinguishable from an approval that worked.
// ============================================================

interface Claim {
  id: string
  referral_partner_id: string | null
  company_name: string | null
  website: string | null
  contact_name: string | null
  contact_email: string | null
  note: string | null
  status: string | null
  client_id: string | null
  decided_by: string | null
  decided_at: string | null
  decision_note: string | null
  /**
   * This claim arrived past the partner's daily allowance. The submission
   * route stores those flagged rather than discarding them, so this is
   * the only place a human finds out — nullable because a row written
   * before the column existed carries null, which is not the same fact as
   * false and is rendered as neither.
   */
  over_cap: boolean | null
  created_at: string | null
}

interface QueueClient {
  id: string
  name: string | null
  referral_partner_id: string | null
}

interface QueuePartner {
  id: string
  name: string | null
  company: string | null
}

/**
 * A day from a timestamp, by SLICING. `new Date(s)` on a bare date
 * string is parsed as UTC midnight and then rendered in local time,
 * which shows the day before for anybody west of Greenwich.
 *
 * This renders the UTC day of a timestamptz, so a claim filed late in
 * the evening Pacific shows tomorrow's date here. Known, and left
 * alone: the alternative is a business-timezone policy that would have
 * to be applied to every stamped column on the screen at once.
 */
function prettyDay(value: string | null): string {
  if (typeof value !== 'string' || value.length < 10) return '—'
  const [y, m, d] = value.slice(0, 10).split('-')
  if (!y || !m || !d) return '—'
  return `${m}/${d}/${y}`
}

/** What the partner left blank, said as an absence rather than a gap. */
function said(value: string | null): { text: string; given: boolean } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { text: 'he did not say', given: false }
  }
  return { text: value, given: true }
}

const DECIDED_LABEL: Record<string, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  duplicate: 'Duplicate',
}

export default function ClaimsQueue({
  claims,
  clients,
  partners,
  readFailed = false,
  clientsUnreadable = false,
}: {
  claims: Claim[]
  clients: QueueClient[]
  partners: QueuePartner[]
  readFailed?: boolean
  /**
   * The CLIENT list could not be read. Separate from `readFailed` because
   * it fails differently: the claims are still here and still readable,
   * but there is nothing to compare a typed name against — so the hint
   * must say that rather than "no client of ours has a name like that",
   * which is the same sentence an empty client table would produce and
   * reads as a reason to reject.
   */
  clientsUnreadable?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [stuck, setStuck] = useState<Record<string, string>>({})

  // Partner id -> something a human recognises. An unknown id is shown
  // AS the id rather than as blank: a claim whose partner row has gone
  // is a thing staff need to see, not a nameless card.
  const partnerLabel = (id: string | null): string => {
    if (!id) return 'no partner on this claim'
    const p = partners.find((x) => x.id === id)
    if (!p) return `unknown partner (${id})`
    return p.company ? `${p.name ?? 'unnamed'} — ${p.company}` : (p.name ?? `partner ${id}`)
  }

  async function decide(claim: Claim, decision: 'approve' | 'reject' | 'duplicate') {
    const clientId = picked[claim.id] ?? ''
    if (decision === 'approve' && clientId.length === 0) {
      setStuck((s) => ({
        ...s,
        [claim.id]: 'Choose which client this claim refers to before approving it.',
      }))
      return
    }

    setBusy(claim.id)
    setStuck((s) => {
      const next = { ...s }
      delete next[claim.id]
      return next
    })

    try {
      const res = await fetch('/api/referrals/claims', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          claim_id: claim.id,
          decision,
          client_id: decision === 'approve' ? clientId : undefined,
          decision_note: notes[claim.id] ?? undefined,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }

      if (!res.ok) {
        // A conflict is PINNED, not toasted. Everything else is a toast:
        // a 400 or a 500 is retried from the same screen, a 409 means
        // two rows need looking at before anybody decides anything.
        const message = json.error ?? 'Could not record that decision.'
        if (res.status === 409) {
          setStuck((s) => ({ ...s, [claim.id]: message }))
        } else {
          showError(message)
        }
        return
      }

      showSuccess(
        decision === 'approve'
          ? 'Approved. The client is attributed and the commission window has started.'
          : 'Recorded.',
      )
      router.refresh()
    } catch {
      showError('Could not reach the server. Nothing was decided.')
    } finally {
      setBusy(null)
    }
  }

  if (readFailed) {
    return (
      <section className="rounded-xl p-4 border border-yellow-700/50 bg-yellow-950/30">
        <p className="text-yellow-300 text-sm font-medium">⚠ Could not read the claims queue</p>
        <p className="text-yellow-500/80 text-xs mt-1">
          Partners may have claimed clients that are not shown here. An empty queue and an
          unreadable one look identical, so this says which it is. If this persists, run{' '}
          <span className="font-mono">supabase/partner_client_claims.sql</span> in the Supabase SQL
          editor.
        </p>
      </section>
    )
  }

  const open = claims.filter((c) => (c.status ?? 'submitted') === 'submitted')
  const decided = claims.filter((c) => (c.status ?? 'submitted') !== 'submitted')

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-white">
          Client claims{' '}
          {open.length > 0 && (
            <span className="text-yellow-400 text-sm font-normal">
              — {open.length} waiting on you
            </span>
          )}
        </h3>
        <p className="text-gray-400 text-xs mt-1">
          A partner typed a company name and asked to be credited for it. Approving sets the
          client&apos;s referral partner, which is what makes the $300 and the twelve-month share
          payable — so pick the client yourself rather than trusting the name he typed.
        </p>
      </div>

      {claims.length === 0 && (
        <p className="text-gray-500 text-sm">No partner has claimed a client yet.</p>
      )}

      {open.map((claim) => {
        const hits = clientMatches(claim.company_name ?? '', clients)
        const site = said(claim.website)
        const who = said(claim.contact_name)
        const mail = said(claim.contact_email)
        const note = said(claim.note)
        const working = busy === claim.id

        return (
          <div
            key={claim.id}
            className="rounded-xl border border-gray-700 bg-gray-900/50 p-4 space-y-3"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-white font-medium">{claim.company_name ?? '(no name given)'}</p>
                <p className="text-gray-400 text-xs">
                  claimed by {partnerLabel(claim.referral_partner_id)} ·{' '}
                  {prettyDay(claim.created_at)}
                </p>
              </div>
              {/*
                NOT A WARNING ABOUT THE CLAIM — a note about how it
                arrived. The partner was told "Received." like everyone
                else and knows nothing about a cap, so this is a prompt to
                look rather than a reason to refuse: six real clients in a
                day is unusual and legitimate, and a script is unusual and
                is not. Only `=== true` renders it; a null from a row
                written before the column existed says nothing either way.
              */}
              {claim.over_cap === true && (
                <span
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300"
                  title="This arrived after the partner's daily claim allowance was used up. It was kept rather than dropped — worth a look at his other claims from the same day before deciding."
                >
                  over daily allowance
                </span>
              )}
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs">
              {[
                ['Website', site],
                ['Contact', who],
                ['Contact email', mail],
              ].map(([label, v]) => {
                const val = v as { text: string; given: boolean }
                return (
                  <div key={label as string} className="flex gap-2">
                    <dt className="text-gray-500 shrink-0">{label as string}</dt>
                    <dd className={val.given ? 'text-gray-300 break-all' : 'text-gray-600 italic'}>
                      {val.text}
                    </dd>
                  </div>
                )
              })}
            </dl>

            <div className="text-xs">
              <p className="text-gray-500">What he did for this referral</p>
              <p
                className={
                  note.given ? 'text-gray-300 whitespace-pre-wrap' : 'text-gray-600 italic'
                }
              >
                {note.text}
              </p>
            </div>

            {/* The §3.4 hint. Staff-only, and advisory — the dropdown
                below still opens on "Choose a client". */}
            <div className="text-xs rounded-lg border border-gray-700/70 bg-gray-950/40 p-2">
              <p className={clientsUnreadable ? 'text-yellow-400' : 'text-gray-500'}>
                {clientsUnreadable
                  ? 'Could not read the client list, so there is nothing to compare this name against. Do not read this as "we have no such client".'
                  : hits.length === 0
                    ? 'No client of ours has a name like that.'
                    : 'Clients with a name like that:'}
              </p>
              {hits.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {hits.map((h) => (
                    <li key={h.id} className="flex flex-wrap gap-2">
                      <span className="text-gray-200">{h.name}</span>
                      <span className="text-gray-600">{h.exact ? 'same name' : 'similar'}</span>
                      {h.referral_partner_id ? (
                        h.referral_partner_id === claim.referral_partner_id ? (
                          <span className="text-green-400">
                            already attributed to this same partner
                          </span>
                        ) : (
                          <span className="text-yellow-400">
                            already attributed to {partnerLabel(h.referral_partner_id)} — approving
                            would move that commission
                          </span>
                        )
                      ) : (
                        <span className="text-gray-500">not attributed to anyone</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {stuck[claim.id] && (
              <p className="rounded-lg border border-red-700/60 bg-red-950/40 text-red-300 text-xs p-2">
                {stuck[claim.id]}
              </p>
            )}

            <div className="space-y-2">
              <label className="block">
                <span className="text-gray-500 text-xs">Which client is this?</span>
                <select
                  value={picked[claim.id] ?? ''}
                  onChange={(e) => setPicked((p) => ({ ...p, [claim.id]: e.target.value }))}
                  disabled={working}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white"
                >
                  <option value="">Choose a client…</option>
                  {hits.length > 0 && (
                    <optgroup label="Name looks like this one">
                      {hits.map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                          {h.referral_partner_id ? ' (already attributed)' : ''}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Every client">
                    {clients
                      .filter((c) => typeof c.name === 'string' && c.name.length > 0)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.referral_partner_id ? ' (already attributed)' : ''}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>

              <label className="block">
                <span className="text-gray-500 text-xs">
                  Why (staff only — the partner never sees this)
                </span>
                <textarea
                  value={notes[claim.id] ?? ''}
                  onChange={(e) => setNotes((n) => ({ ...n, [claim.id]: e.target.value }))}
                  maxLength={CLAIM_NOTE_MAX}
                  rows={2}
                  disabled={working}
                  className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white"
                />
              </label>

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => decide(claim, 'approve')}
                  disabled={working}
                  className="px-3 py-1.5 rounded-lg bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white text-sm font-medium"
                >
                  {working ? 'Working…' : 'Approve'}
                </button>
                <button
                  type="button"
                  onClick={() => decide(claim, 'reject')}
                  disabled={working}
                  className="px-3 py-1.5 rounded-lg border border-gray-600 hover:bg-gray-800 disabled:opacity-50 text-gray-200 text-sm"
                >
                  Not approved
                </button>
                <button
                  type="button"
                  onClick={() => decide(claim, 'duplicate')}
                  disabled={working}
                  className="px-3 py-1.5 rounded-lg border border-gray-600 hover:bg-gray-800 disabled:opacity-50 text-gray-200 text-sm"
                >
                  Duplicate
                </button>
              </div>
              <p className="text-gray-600 text-xs">
                &quot;Not approved&quot; and &quot;Duplicate&quot; are kept apart here because you
                need the difference. The partner is told the same thing either way — naming
                &quot;duplicate&quot; to him would tell him the company is already somebody&apos;s.
              </p>
            </div>
          </div>
        )
      })}

      {decided.length > 0 && (
        <details className="rounded-xl border border-gray-800 bg-gray-900/30 p-3">
          <summary className="text-gray-400 text-sm cursor-pointer">
            {decided.length} already decided
          </summary>
          <ul className="mt-2 space-y-2">
            {decided.map((c) => (
              <li key={c.id} className="text-xs border-t border-gray-800 pt-2">
                <p className="text-gray-200">
                  {c.company_name ?? '(no name given)'}{' '}
                  <span
                    className={
                      c.status === 'approved' ? 'text-green-400' : 'text-gray-500'
                    }
                  >
                    {DECIDED_LABEL[c.status ?? ''] ?? c.status ?? 'unknown status'}
                  </span>
                </p>
                <p className="text-gray-500">
                  claimed by {partnerLabel(c.referral_partner_id)} · decided by{' '}
                  {c.decided_by ?? 'nobody recorded'} on {prettyDay(c.decided_at)}
                </p>
                {c.decision_note && (
                  <p className="text-gray-400 whitespace-pre-wrap">{c.decision_note}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
