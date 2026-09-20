import { notFound } from 'next/navigation'
import { after } from 'next/server'
import type { Metadata } from 'next'
import { getSheetByToken, recordView } from '@/lib/rate-sheets-db'
import { estimateMonthly } from '@/lib/rate-sheets'
import Estimator from '@/components/rate-sheets/Estimator'
import SheetActions from '@/components/rate-sheets/SheetActions'

// The prospect-facing rate sheet. Public by way of the token in the
// URL — see the note in src/proxy.ts for how this segment is opened up
// without opening the rest of the app.
//
// Every figure below is either from the sheet row itself or from the
// published rate card and the company facts register. Nothing on this
// page may be a number someone approximated: a prospect can rely on it.

// Rendered per request: the sheet must reflect the current row the
// moment staff edit it, and a cached copy of one prospect's pricing is
// exactly the wrong thing to serve to the next.
export const dynamic = 'force-dynamic'

type Params = Promise<{ slug: string; id: string; token: string }>

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { id, token } = await params
  const sheet = await getSheetByToken(Number(id), token)
  if (!sheet) return { title: 'Rate sheet not found — Shipo LLC' }
  return {
    title: `Fulfillment Rate Sheet — ${sheet.company_name} — Shipo LLC`,
    robots: { index: false, follow: false, nocache: true },
  }
}

const LONG_DATE: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
}

function formatDate(value: string | null): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', LONG_DATE)
}

function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default async function RateSheetPage({ params }: { params: Params }) {
  const { id, token } = await params
  const sheet = await getSheetByToken(Number(id), token)

  // A bad token and a non-existent sheet both land here, so the URL
  // never confirms which one it was.
  if (!sheet) notFound()

  // Analytics only, and deliberately after the response — a prospect
  // waiting on our view counter would be absurd.
  after(() => recordView(sheet))

  const prepared = formatDate(sheet.created_at)
  const validUntil = formatDate(sheet.valid_until)
  const estimate = estimateMonthly(sheet.rate_card, sheet.profile, sheet.monthly_minimum)
  const p = sheet.profile

  const profileRows: [string, string][] = []
  if (p.monthly_orders) profileRows.push(['Orders per month', p.monthly_orders.toLocaleString()])
  if (p.items_per_order) profileRows.push(['Average items per order', String(p.items_per_order)])
  if (p.pallets_stored) profileRows.push(['Pallets stored', p.pallets_stored.toLocaleString()])
  if (p.pallets_inbound)
    profileRows.push(['Pallets received per month', p.pallets_inbound.toLocaleString()])
  if (p.fba_units) profileRows.push(['FBA prep units per month', p.fba_units.toLocaleString()])
  if (p.channels?.length) profileRows.push(['Channels', p.channels.join(', ')])

  return (
    <div className="mx-auto max-w-4xl px-6 py-10 print:py-0">
      {/* Header */}
      <header className="flex items-start justify-between gap-6 pb-6 border-b border-slate-200">
        <div>
          <div className="text-lg font-semibold tracking-tight">Shipo LLC</div>
          <div className="text-xs uppercase tracking-widest text-slate-500 mt-0.5">
            Fulfillment Rate Sheet
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <SheetActions />
          <span className="text-xs text-slate-400 tabular-nums">Sheet #{sheet.public_id}</span>
        </div>
      </header>

      {/* Title block */}
      <section className="pt-8">
        <p className="text-sm text-slate-500">Prepared for</p>
        <h1 className="text-3xl font-semibold tracking-tight mt-1">{sheet.company_name}</h1>
        <p className="mt-2 text-sm text-slate-600">
          {sheet.contact_name ? `${sheet.contact_name} · ` : ''}
          {prepared ? `Prepared ${prepared}` : null}
          {validUntil ? ` · Rates held until ${validUntil}` : null}
        </p>
      </section>

      {/* Opening */}
      <section className="mt-6 text-[15px] leading-relaxed text-slate-700 space-y-4">
        {sheet.intro ? (
          sheet.intro.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)
        ) : (
          <p>
            Below is our published fulfillment rate card, priced against the volumes you gave us.
            These are the same rates our team quotes and the same ones this sheet will still show
            next month. If a line does not apply to how you ship, it is not billed.
          </p>
        )}
      </section>

      {/* Key facts */}
      <section className="mt-8 grid grid-cols-1 sm:grid-cols-3 gap-4 print:break-inside-avoid">
        {[
          ['Ships from', 'Wilmington, Delaware'],
          ['Same-day cutoff', '3 PM Eastern'],
          [
            'Monthly minimum',
            sheet.monthly_minimum.toLocaleString('en-US', {
              style: 'currency',
              currency: 'USD',
              minimumFractionDigits: 0,
            }),
          ],
        ].map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-200 px-4 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
            <div className="mt-1 font-semibold">{value}</div>
          </div>
        ))}
      </section>

      {/* What we priced against */}
      {profileRows.length > 0 && (
        <section className="mt-10 print:break-inside-avoid">
          <h2 className="text-lg font-semibold">What we priced against</h2>
          <p className="mt-1 text-sm text-slate-600">
            The profile you gave us. If any of it is wrong, tell us and we will reissue the sheet —
            the rates do not change, but your estimate will.
          </p>
          <dl className="mt-4 grid sm:grid-cols-2 gap-x-8 gap-y-2">
            {profileRows.map(([label, value]) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-1.5"
              >
                <dt className="text-sm text-slate-600">{label}</dt>
                <dd className="text-sm font-medium tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          {p.notes && <p className="mt-4 text-sm text-slate-600 leading-relaxed">{p.notes}</p>}
        </section>
      )}

      {/* Rate card */}
      <section className="mt-10 print:break-inside-avoid">
        <h2 className="text-lg font-semibold">Fulfillment rate card</h2>
        <p className="mt-1 text-sm text-slate-600">
          2026 list rates. Volume pricing lowers the per-order and per-pallet numbers as you scale.
        </p>
        <div className="mt-4 rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              {sheet.rate_card.map((line, i) => (
                <tr key={line.id} className={i > 0 ? 'border-t border-slate-200' : ''}>
                  <th scope="row" className="text-left align-top px-5 py-4 font-medium w-1/3">
                    {line.label}
                  </th>
                  <td className="px-5 py-4 align-top">
                    <div className="font-medium text-slate-900">{line.price}</div>
                    {line.note && (
                      <div className="mt-1 text-slate-600 leading-relaxed">{line.note}</div>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="border-t border-slate-200 bg-slate-50">
                <th scope="row" className="text-left align-top px-5 py-4 font-medium">
                  Monthly minimum
                </th>
                <td className="px-5 py-4 align-top">
                  <div className="font-medium text-slate-900">
                    {sheet.monthly_minimum.toLocaleString('en-US', {
                      style: 'currency',
                      currency: 'USD',
                      minimumFractionDigits: 0,
                    })}{' '}
                    per month
                  </div>
                  <div className="mt-1 text-slate-600 leading-relaxed">
                    A floor, not an added fee. You are billed the greater of your actual monthly
                    fulfillment charges or this figure. Postage is separate.
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* Estimator.
          Screen only. The prospect can type any volumes they like into it, and
          those numbers live in browser state the server never sees — so a
          printed copy showing them would read as though Shipo had quoted them.
          The printed sheet carries the estimate as issued instead, below. */}
      <div className="mt-10 print:hidden">
        <Estimator
          card={sheet.rate_card}
          profile={sheet.profile}
          minimum={sheet.monthly_minimum}
        />
      </div>

      {/* The estimate as issued — the print counterpart of the estimator.
          Computed on the server from the stored profile, so it matches the
          "What we priced against" block above and nothing else. */}
      {!estimate.empty && (
        <section className="mt-10 hidden print:block print:break-inside-avoid">
          <h2 className="text-lg font-semibold">Estimated monthly cost</h2>
          <p className="mt-1 text-sm text-slate-600">
            The rate card applied to the profile above.
          </p>
          <dl className="mt-4 space-y-2">
            {estimate.lines.map((line) => (
              <div key={line.id} className="flex items-baseline justify-between gap-4">
                <dt className="text-sm">
                  <span className="font-medium text-slate-800">{line.label}</span>
                  <span className="block text-xs text-slate-500">{line.detail}</span>
                </dt>
                <dd className="text-sm font-medium tabular-nums whitespace-nowrap">
                  {money(line.amount)}
                </dd>
              </div>
            ))}
          </dl>
          <div className="mt-4 pt-3 border-t border-slate-200 space-y-1.5">
            <div className="flex items-baseline justify-between gap-4 text-sm">
              <span className="text-slate-600">Fulfillment subtotal</span>
              <span className="tabular-nums">{money(estimate.subtotal)}</span>
            </div>
            {estimate.minimumApplied && (
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span className="text-slate-600">Monthly minimum applies</span>
                <span className="tabular-nums">{money(estimate.minimum)}</span>
              </div>
            )}
            <div className="flex items-baseline justify-between gap-4 pt-1.5">
              <span className="font-semibold">Estimated monthly total</span>
              <span className="text-lg font-semibold tabular-nums">{money(estimate.billed)}</span>
            </div>
          </div>
          {estimate.minimumApplied && (
            <p className="mt-3 text-xs text-slate-600 leading-relaxed">
              At these volumes your fulfillment charges come to {money(estimate.subtotal)}, which is
              below the {money(estimate.minimum)} monthly minimum, so the month bills at{' '}
              {money(estimate.minimum)}. The minimum is a floor, not an additional fee.
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500 leading-relaxed">
            An estimate, not an invoice. It covers the fulfillment lines on this sheet only —
            postage is billed separately at carrier rates, and pallet counts vary with how much
            stock you hold through the month.
          </p>
        </section>
      )}

      {/* What is not on this sheet */}
      <section className="mt-10 print:break-inside-avoid">
        <h2 className="text-lg font-semibold">What this sheet does not cover</h2>
        <ul className="mt-3 space-y-2 text-sm text-slate-700 leading-relaxed list-disc pl-5">
          <li>
            <span className="font-medium">Postage.</span> Parcel charges are billed separately at
            carrier rates and are quoted against your own weights and destinations.
          </li>
          <li>
            <span className="font-medium">Non-standard packaging.</span> Standard materials are
            included in pick and pack. Branded inserts, custom boxes and gift wrap are quoted
            against the materials you choose.
          </li>
          <li>
            <span className="font-medium">Work we have not seen yet.</span> If your product needs
            handling that is not described above, we will price it before it is done, not after.
          </li>
        </ul>
      </section>

      {/* Credibility */}
      <section className="mt-10 rounded-2xl bg-slate-50 border border-slate-200 px-6 py-6 print:break-inside-avoid">
        <h2 className="text-lg font-semibold">The building you would be moving into</h2>
        <p className="mt-3 text-sm text-slate-700 leading-relaxed">
          One 55,000 sq ft floor at 310 Cornell Dr, Suite B4, Wilmington, Delaware 19801. Shipo LLC
          has been fulfilling from this address since 2017, has processed 4.1 million packages, and
          runs at 99.8% order accuracy. Orders released by 3 PM Eastern ship the same day.
        </p>
        <p className="mt-3 text-sm text-slate-700 leading-relaxed">
          Shipo&rsquo;s Wilmington, Delaware warehouse reaches about 20% of the US population
          overnight and about 48% within two-day ground shipping.
        </p>
        <p className="mt-2 text-xs text-slate-500 leading-relaxed">
          Those coverage figures are Shipo&rsquo;s own estimates, derived from ground transit bands
          out of Wilmington, DE and U.S. Census population data (341.8M, July 2025). They are not
          carrier-published figures.
        </p>
        <p className="mt-3 text-xs text-slate-500 leading-relaxed">
          FDA-registered food facility, U.S. FDA Reg. No. 15630823908. Registration is not FDA
          approval or endorsement.
        </p>
      </section>

      {/* CTA */}
      <section className="mt-10 print:break-inside-avoid">
        <h2 className="text-lg font-semibold">Questions about any line on this sheet</h2>
        <p className="mt-2 text-sm text-slate-700 leading-relaxed">
          Call{' '}
          <a href="tel:+13024001698" className="font-medium underline underline-offset-2">
            302-400-1698
          </a>{' '}
          Monday to Friday, 9:00 to 17:00 Eastern, or email{' '}
          <a
            href="mailto:Support@shipousa.com"
            className="font-medium underline underline-offset-2"
          >
            Support@shipousa.com
          </a>
          .
          {sheet.prepared_by ? ` This sheet was prepared by ${sheet.prepared_by}.` : ''}
        </p>
      </section>

      {/* Footer */}
      <footer className="mt-12 pt-6 border-t border-slate-200 text-xs text-slate-500 leading-relaxed">
        <p>
          Shipo LLC, trading as Shipo USA · 310 Cornell Dr, Suite B4, Wilmington, DE 19801 ·
          302-400-1698 · Support@shipousa.com ·{' '}
          <a href="https://shipousa.com/" className="underline">
            shipousa.com
          </a>
        </p>
        <p className="mt-2">
          Rate sheet #{sheet.public_id}
          {prepared ? `, prepared ${prepared}` : ''}
          {validUntil ? `. Rates held until ${validUntil}.` : '.'} Prepared for{' '}
          {sheet.company_name} and not for redistribution.
        </p>
      </footer>
    </div>
  )
}
