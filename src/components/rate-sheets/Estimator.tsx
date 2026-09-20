'use client'

import { useMemo, useState } from 'react'
import { estimateMonthly, type RateLine, type SheetProfile } from '@/lib/rate-sheets'

// The one interactive element on the sheet. A prospect's first question
// is always "what would this cost me", and a static card makes them do
// arithmetic they will get wrong in our favour or theirs. Letting them
// move their own numbers is both more useful and more honest — including
// when it shows the monthly minimum biting.
//
// Everything is computed in the browser from the card already on the
// page. No request is made as they type, so moving these numbers is not
// reported back to us as intent.

// Orders, pallets and units are whole things, so they step by 1. Average
// items per order is not — it is 1.8 or 2.3 far more often than it is a
// round number — so it steps by 'any' and gets a decimal keypad on phones.
const FIELDS: {
  key: keyof SheetProfile
  label: string
  step: number | 'any'
  inputMode: 'numeric' | 'decimal'
}[] = [
  { key: 'monthly_orders', label: 'Orders per month', step: 1, inputMode: 'numeric' },
  { key: 'items_per_order', label: 'Average items per order', step: 'any', inputMode: 'decimal' },
  { key: 'pallets_stored', label: 'Pallets stored', step: 1, inputMode: 'numeric' },
  { key: 'pallets_inbound', label: 'Pallets received per month', step: 1, inputMode: 'numeric' },
  { key: 'fba_units', label: 'FBA prep units per month', step: 1, inputMode: 'numeric' },
]

function money(n: number) {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

export default function Estimator({
  card,
  profile,
  minimum,
}: {
  card: RateLine[]
  profile: SheetProfile
  minimum: number
}) {
  const [values, setValues] = useState<SheetProfile>(profile)

  const estimate = useMemo(
    () => estimateMonthly(card, values, minimum),
    [card, values, minimum]
  )

  // Only offer a field the card can actually price. A sheet with no FBA
  // prep line should not ask for FBA units and then ignore the answer.
  const drivers = new Set(card.filter((l) => l.driver).map((l) => l.driver))
  const fields = FIELDS.filter(
    (f) => f.key === 'items_per_order' || drivers.has(f.key as never)
  )

  const dirty = FIELDS.some((f) => values[f.key] !== profile[f.key])

  return (
    <section className="rounded-2xl border border-slate-200 overflow-hidden print:break-inside-avoid">
      <div className="px-6 py-5 border-b border-slate-200 bg-slate-50">
        <h2 className="text-lg font-semibold">Estimate your monthly cost</h2>
        <p className="mt-1 text-sm text-slate-600">
          Pre-filled with the volumes you gave us. Change anything to see how it moves.
        </p>
      </div>

      <div className="grid md:grid-cols-2">
        <div className="p-6 space-y-4 border-b md:border-b-0 md:border-r border-slate-200">
          {fields.map((f) => (
            <label key={f.key} className="block">
              <span className="text-sm font-medium text-slate-700">{f.label}</span>
              <input
                type="number"
                min={0}
                step={f.step}
                inputMode={f.inputMode}
                value={(values[f.key] as number | undefined) ?? ''}
                onChange={(e) =>
                  setValues((v) => ({
                    ...v,
                    [f.key]: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)),
                  }))
                }
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm
                           focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-100"
              />
            </label>
          ))}

          {dirty && (
            <button
              type="button"
              onClick={() => setValues(profile)}
              className="text-sm text-sky-700 underline underline-offset-2 hover:text-sky-900"
            >
              Reset to the numbers you gave us
            </button>
          )}
        </div>

        <div className="p-6">
          {estimate.empty ? (
            <p className="text-sm text-slate-600">
              Enter your volumes on the left and the monthly estimate will appear here.
            </p>
          ) : (
            <>
              <dl className="space-y-3">
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

              <div className="mt-5 pt-4 border-t border-slate-200 space-y-2">
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

                <div className="flex items-baseline justify-between gap-4 pt-2">
                  <span className="font-semibold">Estimated monthly total</span>
                  <span className="text-xl font-semibold tabular-nums" style={{ color: '#0090DD' }}>
                    {money(estimate.billed)}
                  </span>
                </div>
              </div>

              {estimate.minimumApplied && (
                <p className="mt-3 text-xs text-slate-600 leading-relaxed">
                  At these volumes your fulfillment charges come to{' '}
                  {money(estimate.subtotal)}, which is below the {money(estimate.minimum)} monthly
                  minimum, so the month bills at {money(estimate.minimum)}. The minimum is a floor,
                  not an additional fee.
                </p>
              )}

              <p className="mt-3 text-xs text-slate-500 leading-relaxed">
                An estimate, not an invoice. It covers the fulfillment lines on this sheet only —
                postage is billed separately at carrier rates, and pallet counts vary with how much
                stock you hold through the month.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
