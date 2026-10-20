import { NextResponse } from 'next/server'
import { getPartnerFromSession } from '@/lib/partner-auth'
import { supabaseAdmin } from '@/lib/supabase'
import { loadPartnerLedger } from '@/lib/partner-ledger'
import { buildPartnerReport, reportFilename } from '@/lib/partner-report'
import { fbaActivity } from '@/lib/partner-activity'
import { rosterRows } from '@/lib/partner-roster'
import { bonusStateFor, type BonusState } from '@/lib/partner-bonus-state'
import { holdsW9 } from '@/lib/partner-w9'
import { buildStatement, computeOwed, isoDay, type PayoutRecord, type ReferralPartner } from '@/lib/referrals'

export const dynamic = 'force-dynamic'

// ============================================================
// The partner downloads his own numbers. Spec §5.
//
// "Every figure here is already on his screen, so the export adds no
// disclosure." That sentence is only true if this route derives its
// figures the SAME WAY the screen does, which is why it calls
// loadPartnerLedger → computeOwed → buildStatement → rosterRows rather
// than querying for what a CSV happens to need. A second derivation path
// would eventually disagree with the statement, and the partner would be
// holding two documents about his own money that do not match.
//
// THREE GATES, IN THIS ORDER, and the order is the design:
//
//   1. Is there a session, and may this person still use the portal?
//      getPartnerFromSession re-asks portalAccessBlock on every request,
//      so a partner deactivated since login cannot download.
//   2. Did every read succeed? A failed read degrades to an empty
//      ledger, and an empty ledger serialises to a tidy, plausible
//      "Nothing to report yet." — a written assurance to a partner that
//      he has earned nothing, in a file he can keep and forward to his
//      accountant. This is the single worst output this route can
//      produce, so it answers 503 instead.
//   3. Does he hold a W-9? If not, `statement: null` and
//      buildPartnerReport writes the withheld sentence where the money
//      would be. Zeros are not an acceptable substitute: a 0.00 is a
//      statement about his earnings and we are not making one.
//
// THE QUERY STRING IS IGNORED, DELIBERATELY. The spec writes the path as
// `GET /api/partner/report?format=csv`, but CSV is the only format — PDF
// is listed under what is explicitly not being built — so there is no
// switch for a param to throw. Reading it and branching on one value
// would advertise a second format that does not exist; the next reader
// would then add `?format=pdf` and get a CSV named .pdf. If a second
// format ever lands, this is the line that has to change.
//
// NOTHING IS FILTERED IN THIS FILE. `loadPartnerLedger(partner.id)`
// applies the partner id inside every query it runs (§5: "the partner's
// id is applied in the SQL predicate, not by filtering in the app"), and
// the payouts read below carries its own `.eq`. A filter that lives in
// the handler is one refactor away from being a leak; a filter that
// lives in the query is not.
// ============================================================

export async function GET() {
  const partner = await getPartnerFromSession()
  if (!partner) {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 })
  }

  // ASKED BEFORE THE READ, not before the render — the same ordering
  // Statement.tsx uses and src/lib/partner-w9.test.ts pins. A payout read
  // performed unconditionally is one serialiser away from being written
  // into the file, and the check above it becomes decoration.
  const showMoney = holdsW9(partner)

  const [ledger, payoutsRes] = await Promise.all([
    loadPartnerLedger(partner.id),
    showMoney
      ? supabaseAdmin
          .from('referral_payouts')
          .select('id, dedupe_key, status, amount, approved_at, paid_at')
          .eq('referral_partner_id', partner.id)
      : Promise.resolve({ data: [] as PayoutRecord[], error: null }),
  ])

  if (ledger.readFailed || payoutsRes.error) {
    console.error('[partner/report] read failed', ledger.readFailed, payoutsRes.error)
    return NextResponse.json(
      {
        error:
          'We could not build your report right now. This is a problem on our side, not a report ' +
          'showing nothing owed — your earnings are unaffected. Please try again shortly.',
      },
      { status: 503 },
    )
  }

  const { clients, invoices, manualInvoices } = ledger
  const payouts = (payoutsRes.data ?? []) as PayoutRecord[]

  // `clients` is ONE partner's clients, and computeOwed is safe on a
  // slice: every figure it derives is per-client. (It was NOT safe while
  // the founding-client offer existed, because places were ranked
  // globally — see the note in Statement.tsx.)
  const lines = showMoney ? computeOwed([partner as ReferralPartner], clients, invoices, payouts) : null
  const statement = lines ? buildStatement(partner.id, clients, lines, invoices) : null

  // Re-voiced from computeOwed's own line rather than recomputed. A
  // second qualification rule here would eventually promise a bonus the
  // payout does not pay. There is exactly one signup_bonus line per
  // client, so last-wins is a no-op.
  const bonuses = lines
    ? new Map<string, BonusState>(
        lines.filter((l) => l.kind === 'signup_bonus').map((l) => [l.clientId, bonusStateFor(l)]),
      )
    : null

  const csv = buildPartnerReport({
    statement,
    roster: rosterRows(clients, new Date()),
    bonuses,
    orders: ledger.orderUnits,
    ordersTruncated: ledger.orderUnitsTruncated,
    // manualInvoices, NOT invoices. The merge sets `units_shipped:
    // manual?.units_shipped ?? null` on every ledger month, so the merged
    // array would manufacture a "not recorded yet" FBA row for every
    // month of every purely DTC client. Only a hand-typed row means FBA
    // prep happened.
    //
    // `?? null` and never `?? 0`: undefined means the column was absent,
    // null means it was present and nobody typed a figure, and both mean
    // "not recorded yet". A 0 would tell him his client shipped nothing.
    fba: fbaActivity(
      manualInvoices.map((i) => ({
        client_id: i.client_id,
        period: i.period,
        units_shipped: i.units_shipped ?? null,
      })),
      clients,
    ),
  })

  const filename = reportFilename(partner, isoDay(new Date()))

  // A BOM, because the audience is Excel. Without it Excel reads the file
  // as the local code page and a client name with an accent or a curly
  // apostrophe arrives mangled in the accountant's copy.
  return new NextResponse('﻿' + csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // His own money. Never a shared cache, and never a stored copy on
      // a machine he may not own.
      'Cache-Control': 'no-store, private',
    },
  })
}
