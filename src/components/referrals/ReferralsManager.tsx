'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { showError, showSuccess } from '@/components/ui/Toast'
import { REFERRAL_TERMS, FOUNDING_PARTNER_TERMS, netProfit, totalCosts, commissionOn } from '@/lib/referrals'
import type { OwedLine, FbaInvoice } from '@/lib/referrals'

const PCT = `${(REFERRAL_TERMS.COMMISSION_RATE * 100).toFixed(0)}%`

interface Partner {
  id: string
  name: string
  company: string | null
  email: string | null
  phone: string | null
  partner_type: string | null
  refer_method: string | null
  status: string | null
  notes: string | null
  source: string | null
  portal_last_seen_at?: string | null
  founding_partner?: boolean | null
}
interface Client {
  id: string
  name: string
  active: boolean | null
  referral_partner_id: string | null
  referral_signup_date: string | null
  referral_first_payment_date: string | null
}
interface Invoice extends FbaInvoice {
  notes: string | null
}
interface Totals {
  owed: number
  pending: number
  approved: number
  paid: number
}

const fmt = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

export default function ReferralsManager({
  partners,
  clients,
  invoices,
  owed,
  totals,
}: {
  partners: Partner[]
  clients: Client[]
  invoices: Invoice[]
  owed: OwedLine[]
  totals: Totals
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  const partnerName = (id: string | null) => partners.find((p) => p.id === id)?.name ?? '—'
  const clientName = (id: string) => clients.find((c) => c.id === id)?.name ?? '—'

  async function call(url: string, body: unknown, method: string = 'POST', tag = url) {
    setBusy(tag)
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Request failed')
      router.refresh()
      return true
    } catch (err: any) {
      showError('Something went wrong', err?.message ?? 'Request failed')
      return false
    } finally {
      setBusy(null)
    }
  }

  // ---- payout ledger actions ----
  async function payoutAction(line: OwedLine, action: 'approve' | 'paid' | 'pending' | 'unrecord') {
    const ok = await call('/api/referrals/payouts', {
      action,
      dedupe_key: line.dedupeKey,
      referral_partner_id: line.partnerId,
      client_id: line.clientId,
      kind: line.kind,
      period: line.period,
      amount: line.amount,
      fba_invoice_id: line.fbaInvoiceId ?? null,
    }, 'POST', line.dedupeKey)
    if (ok) {
      if (action === 'approve') showSuccess('Payout approved', `${fmt(line.amount)} to ${line.partnerName}`)
      else if (action === 'paid') showSuccess('Marked paid', `${fmt(line.amount)} to ${line.partnerName}`)
    }
  }

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="Owed (unpaid)" value={fmt(totals.owed)} sub="Everything not yet paid" color="blue" />
        <StatCard label="Pending Approval" value={fmt(totals.pending)} sub="Waiting on you" color="yellow" />
        <StatCard label="Approved" value={fmt(totals.approved)} sub="Cleared to pay" color="gray" />
        <StatCard label="Paid" value={fmt(totals.paid)} sub="Settled" color="green" />
      </div>

      {/* ---- Payouts Owed ---- */}
      <Section title="Payouts Owed" subtitle="Auto-computed — approve each line to clear it for payment">
        {owed.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No payouts yet. Link a client to a partner and add a monthly account below, and the $
            {REFERRAL_TERMS.SIGNUP_BONUS} bonus + {PCT} commissions will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                  <th className="pb-2 pr-3">Partner</th>
                  <th className="pb-2 pr-3">Client</th>
                  <th className="pb-2 pr-3">Type</th>
                  <th className="pb-2 pr-3">Period</th>
                  <th className="pb-2 pr-3 text-right">Amount</th>
                  <th className="pb-2 pr-3">Status</th>
                  <th className="pb-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {owed.map((l) => {
                  const notYetOwed = l.kind === 'signup_bonus' && l.period === 'awaiting'
                  return (
                    <tr key={l.dedupeKey} className="border-b border-gray-700/40 hover:bg-gray-700/20">
                      <td className="py-2.5 pr-3 text-gray-200">{l.partnerName}</td>
                      <td className="py-2.5 pr-3 text-gray-300">{l.clientName}</td>
                      <td className="py-2.5 pr-3">
                        <span className={`px-1.5 py-0.5 rounded text-xs ${l.kind === 'signup_bonus' ? 'bg-purple-900/40 text-purple-300' : 'bg-sky-900/30 text-sky-300'}`}>
                          {/* Reads the line's own amount, not a constant — a
                              Founding Partner's bonus is $500 and a badge
                              hardcoded to $300 would misstate the money
                              sitting next to it in the very same row. */}
                          {l.kind === 'signup_bonus' ? `${fmt(l.amount)} bonus` : `${PCT} of net profit`}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 text-gray-400">{l.period === 'awaiting' ? '—' : l.period}</td>
                      <td className="py-2.5 pr-3 text-right text-gray-200">{fmt(l.amount)}</td>
                      <td className="py-2.5 pr-3">
                        <StatusBadge status={notYetOwed ? 'awaiting' : l.status} />
                        {l.note && <span className="block text-[10px] text-gray-500 mt-0.5">{l.note}</span>}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap">
                        {notYetOwed ? (
                          <span className="text-xs text-gray-600">—</span>
                        ) : (
                          <div className="inline-flex gap-1.5">
                            {(l.status === 'computed' || l.status === 'pending') && (
                              <button
                                onClick={() => payoutAction(l, 'approve')}
                                disabled={busy === l.dedupeKey}
                                className="px-2 py-1 rounded text-xs bg-[#00AAFF]/15 text-[#00AAFF] hover:bg-[#00AAFF]/25 disabled:opacity-50"
                              >
                                Approve
                              </button>
                            )}
                            {l.status === 'approved' && (
                              <button
                                onClick={() => payoutAction(l, 'paid')}
                                disabled={busy === l.dedupeKey}
                                className="px-2 py-1 rounded text-xs bg-green-900/40 text-green-300 hover:bg-green-900/60 disabled:opacity-50"
                              >
                                Mark paid
                              </button>
                            )}
                            {(l.status === 'approved' || l.status === 'paid' || l.status === 'pending') && (
                              <button
                                onClick={() => payoutAction(l, 'unrecord')}
                                disabled={busy === l.dedupeKey}
                                className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-400 hover:bg-gray-600 disabled:opacity-50"
                                title="Revert to computed"
                              >
                                Revert
                              </button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* ---- Partners ---- */}
      <PartnersPanel partners={partners} busy={busy} call={call} />

      {/* ---- Referred clients linking ---- */}
      <ClientsPanel clients={clients} partners={partners} busy={busy} call={call} />

      {/* ---- FBA invoices ---- */}
      <InvoicesPanel invoices={invoices} clients={clients} busy={busy} call={call} clientName={clientName} />
    </div>
  )
}

// ============================================================
// Partners
// ============================================================
function PartnersPanel({
  partners,
  busy,
  call,
}: {
  partners: Partner[]
  busy: string | null
  call: (url: string, body: unknown, method?: string, tag?: string) => Promise<boolean>
}) {
  const empty = {
    name: '', company: '', email: '', phone: '', partner_type: '', refer_method: '', notes: '',
    founding_partner: false,
  }
  const [form, setForm] = useState(empty)
  const [open, setOpen] = useState(false)

  const pending = partners.filter((p) => p.status === 'pending')
  const foundingTaken = partners.filter((p) => p.founding_partner).length
  const foundingLeft = Math.max(0, FOUNDING_PARTNER_TERMS.CAP - foundingTaken)

  async function addPartner() {
    if (!form.name.trim()) {
      showError('Name required', 'Give the partner a name.')
      return
    }
    const ok = await call('/api/referrals/partners', { ...form, status: 'active' }, 'POST', 'add-partner')
    if (ok) {
      showSuccess('Partner added', form.name)
      setForm(empty)
      setOpen(false)
    }
  }

  async function setStatus(p: Partner, status: string) {
    await call('/api/referrals/partners', { id: p.id, name: p.name, status }, 'POST', p.id)
  }

  // ---- portal access ----
  // Partners sign in themselves: their email, then a 6-digit code we
  // mail them. There is no link to hand out and nothing to copy.
  // "Send invite" only tells them where the portal is.
  // To cut a partner off entirely, set them inactive — that blocks
  // every future login and kills every live session at once.
  async function sendInvite(p: Partner) {
    if (!p.email) {
      showError('No email on file', `Add an email address for ${p.name} first — the portal login is by email.`)
      return
    }
    const ok = await call('/api/referrals/portal-access', { partner_id: p.id, action: 'invite' }, 'POST', `link-${p.id}`)
    if (ok) showSuccess('Invite sent', `${p.email} can now sign in at /partner/login.`)
  }

  async function signOutEverywhere(p: Partner) {
    const ok = await call('/api/referrals/portal-access', { partner_id: p.id, action: 'signout' }, 'POST', `link-${p.id}`)
    if (ok) showSuccess('Signed out everywhere', `${p.name} will need a new code to get back in.`)
  }

  return (
    <Section
      title="Referral Partners"
      subtitle={`${partners.length} total${pending.length ? ` · ${pending.length} awaiting review` : ''}`}
      action={
        <button
          onClick={() => setOpen((o) => !o)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-[#00AAFF] text-white hover:opacity-90"
        >
          {open ? 'Close' : '+ Add partner'}
        </button>
      }
    >
      {open && (
        <div className="mb-4 grid grid-cols-2 gap-3 rounded-lg border border-gray-700 bg-gray-900/40 p-4">
          <Input label="Name *" value={form.name} onChange={(v) => setForm({ ...form, name: v })} />
          <Input label="Company" value={form.company} onChange={(v) => setForm({ ...form, company: v })} />
          <Input label="Email" value={form.email} onChange={(v) => setForm({ ...form, email: v })} />
          <Input label="Phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
          <Input label="Partner type" value={form.partner_type} onChange={(v) => setForm({ ...form, partner_type: v })} />
          <Input label="How they refer" value={form.refer_method} onChange={(v) => setForm({ ...form, refer_method: v })} />

          {/* The launch offer. A checkbox and not three number fields
              on purpose: the amounts are stamped server-side from
              FOUNDING_PARTNER_TERMS, so there is no way to typo a
              partner into a $5,000 bonus. */}
          <label className="col-span-2 flex items-start gap-3 rounded-lg border border-gray-700 bg-gray-900/60 p-3 cursor-pointer">
            <input
              type="checkbox"
              checked={form.founding_partner}
              disabled={foundingLeft === 0}
              onChange={(e) => setForm({ ...form, founding_partner: e.target.checked })}
              className="mt-0.5 h-4 w-4 accent-[#00AAFF] disabled:opacity-40"
            />
            <span className="text-sm">
              <span className={foundingLeft === 0 ? 'text-gray-500' : 'text-gray-200'}>
                Founding Partner — ${FOUNDING_PARTNER_TERMS.BONUS} bonus instead of ${REFERRAL_TERMS.SIGNUP_BONUS}
              </span>
              <span className="block text-xs text-gray-500 mt-1">
                {foundingLeft === 0 ? (
                  <>All {FOUNDING_PARTNER_TERMS.CAP} places are taken. New partners join on the standing terms.</>
                ) : (
                  <>
                    {foundingLeft} of {FOUNDING_PARTNER_TERMS.CAP} left. Their referred client has to bill $
                    {FOUNDING_PARTNER_TERMS.MIN_REVENUE.toLocaleString()} or ship more than{' '}
                    {FOUNDING_PARTNER_TERMS.MIN_UNITS.toLocaleString()} units in one calendar month — either one
                    counts, so DTC and FBA referrals both qualify.
                  </>
                )}
              </span>
            </span>
          </label>

          <div className="col-span-2 flex justify-end">
            <button
              onClick={addPartner}
              disabled={busy === 'add-partner'}
              className="px-4 py-2 rounded-lg text-sm bg-[#00AAFF] text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === 'add-partner' ? 'Saving…' : 'Save partner'}
            </button>
          </div>
        </div>
      )}

      {partners.length === 0 ? (
        <p className="text-gray-500 text-sm">No partners yet. Website sign-ups land here as “pending” for you to review.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                <th className="pb-2 pr-3">Name</th>
                <th className="pb-2 pr-3">Company</th>
                <th className="pb-2 pr-3">Contact</th>
                <th className="pb-2 pr-3">Type</th>
                <th className="pb-2 pr-3">Source</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2 pr-3">Portal</th>
                <th className="pb-2 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {partners.map((p) => (
                <tr key={p.id} className={`border-b border-gray-700/40 ${p.status === 'pending' ? 'bg-yellow-950/20' : ''}`}>
                  <td className="py-2.5 pr-3 text-gray-200">{p.name}</td>
                  <td className="py-2.5 pr-3 text-gray-400">{p.company ?? '—'}</td>
                  <td className="py-2.5 pr-3 text-gray-400">
                    <div>{p.email ?? '—'}</div>
                    {p.phone && <div className="text-xs text-gray-500">{p.phone}</div>}
                  </td>
                  <td className="py-2.5 pr-3 text-gray-400">{p.partner_type ?? '—'}</td>
                  <td className="py-2.5 pr-3 text-gray-500 text-xs">{p.source === 'website_form' ? 'website' : 'manual'}</td>
                  <td className="py-2.5 pr-3"><StatusBadge status={p.status ?? 'active'} /></td>
                  <td className="py-2.5 pr-3 whitespace-nowrap">
                    {p.email ? (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          onClick={() => sendInvite(p)}
                          disabled={busy === `link-${p.id}` || p.status === 'inactive'}
                          className="px-2 py-1 rounded text-xs bg-[#00AAFF]/15 text-[#00AAFF] hover:bg-[#00AAFF]/25 disabled:opacity-40"
                          title="Email them the portal address. No code and no link that works on its own."
                        >
                          Send invite
                        </button>
                        {p.portal_last_seen_at && (
                          <button
                            onClick={() => signOutEverywhere(p)}
                            disabled={busy === `link-${p.id}`}
                            className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-400 hover:bg-red-900/40 hover:text-red-300 disabled:opacity-50"
                            title="End every open session. They can sign in again with a new code."
                          >
                            Sign out
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-gray-600">Needs an email</span>
                    )}
                    {p.portal_last_seen_at && (
                      <span className="block text-[10px] text-gray-600 mt-0.5">
                        last opened {p.portal_last_seen_at.slice(0, 10)}
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 text-right whitespace-nowrap">
                    {p.status === 'pending' ? (
                      <button
                        onClick={() => setStatus(p, 'active')}
                        disabled={busy === p.id}
                        className="px-2 py-1 rounded text-xs bg-[#00AAFF]/15 text-[#00AAFF] hover:bg-[#00AAFF]/25 disabled:opacity-50"
                      >
                        Approve partner
                      </button>
                    ) : p.status === 'inactive' ? (
                      <button onClick={() => setStatus(p, 'active')} disabled={busy === p.id} className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-50">
                        Reactivate
                      </button>
                    ) : (
                      <button onClick={() => setStatus(p, 'inactive')} disabled={busy === p.id} className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-400 hover:bg-gray-600 disabled:opacity-50">
                        Deactivate
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// ============================================================
// Referred clients linking
// ============================================================
function ClientsPanel({
  clients,
  partners,
  busy,
  call,
}: {
  clients: Client[]
  partners: Partner[]
  busy: string | null
  call: (url: string, body: unknown, method?: string, tag?: string) => Promise<boolean>
}) {
  const [draft, setDraft] = useState<Record<string, Partial<Client>>>({})

  const value = (c: Client, field: keyof Client) =>
    (draft[c.id]?.[field] as string | null | undefined) ?? (c[field] as string | null) ?? ''

  const setField = (id: string, field: keyof Client, v: string) =>
    setDraft((d) => ({ ...d, [id]: { ...d[id], [field]: v } }))

  async function save(c: Client) {
    const d = draft[c.id] ?? {}
    const ok = await call(
      '/api/referrals/link',
      {
        client_id: c.id,
        referral_partner_id: value(c, 'referral_partner_id') || null,
        referral_signup_date: value(c, 'referral_signup_date') || null,
        referral_first_payment_date: value(c, 'referral_first_payment_date') || null,
      },
      'POST',
      c.id,
    )
    if (ok) {
      showSuccess('Client updated', c.name)
      setDraft((prev) => {
        const next = { ...prev }
        delete next[c.id]
        return next
      })
    }
    void d
  }

  const activePartners = partners.filter((p) => p.status !== 'inactive')

  return (
    <Section
      title="Referred Clients"
      subtitle="Link a client to the partner who referred them. The first-payment date is what starts the 12-month clock — without it nothing is owed."
    >
      {clients.length === 0 ? (
        <p className="text-gray-500 text-sm">No clients yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                <th className="pb-2 pr-3">Client</th>
                <th className="pb-2 pr-3">Referred by</th>
                <th className="pb-2 pr-3">Signup date <span className="normal-case text-gray-600">(record only)</span></th>
                <th className="pb-2 pr-3">
                  1st payment <span className="normal-case text-gray-600">($300 trigger + {PCT} clock)</span>
                </th>
                <th className="pb-2 text-right">Save</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => {
                const dirty = !!draft[c.id]
                return (
                  <tr key={c.id} className="border-b border-gray-700/40">
                    <td className="py-2 pr-3 text-gray-200">{c.name}</td>
                    <td className="py-2 pr-3">
                      <select
                        value={value(c, 'referral_partner_id') as string}
                        onChange={(e) => setField(c.id, 'referral_partner_id', e.target.value)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 w-44"
                      >
                        <option value="">— none —</option>
                        {activePartners.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="date"
                        value={value(c, 'referral_signup_date') as string}
                        onChange={(e) => setField(c.id, 'referral_signup_date', e.target.value)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input
                        type="date"
                        value={value(c, 'referral_first_payment_date') as string}
                        onChange={(e) => setField(c.id, 'referral_first_payment_date', e.target.value)}
                        className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200"
                      />
                    </td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => save(c)}
                        disabled={!dirty || busy === c.id}
                        className="px-3 py-1 rounded text-xs bg-[#00AAFF] text-white hover:opacity-90 disabled:opacity-30"
                      >
                        {busy === c.id ? '…' : 'Save'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

// ============================================================
// FBA invoices
// ============================================================
function InvoicesPanel({
  invoices,
  clients,
  busy,
  call,
  clientName,
}: {
  invoices: Invoice[]
  clients: Client[]
  busy: string | null
  call: (url: string, body: unknown, method?: string, tag?: string) => Promise<boolean>
  clientName: (id: string) => string
}) {
  const emptyForm = {
    clientId: '',
    month: '',
    amount: '',
    units: '',
    cost_freight: '',
    cost_materials: '',
    cost_storage: '',
    cost_processing: '',
  }
  const [f, setF] = useState(emptyForm)
  const set = (k: keyof typeof emptyForm, v: string) => setF((p) => ({ ...p, [k]: v }))

  const referred = clients.filter((c) => c.referral_partner_id)

  // live preview of what the partner will see
  const n = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const previewCosts = n(f.cost_freight) + n(f.cost_materials) + n(f.cost_storage) + n(f.cost_processing)
  const previewProfit = Math.max(0, n(f.amount) - previewCosts)
  const previewShare = previewProfit * REFERRAL_TERMS.COMMISSION_RATE
  const costsExceed = n(f.amount) > 0 && previewCosts > n(f.amount)

  async function add() {
    if (!f.clientId || !f.month || !f.amount) {
      showError('Missing fields', 'Client, month and amount invoiced are all required.')
      return
    }
    if (costsExceed) {
      showError('Costs exceed the invoice', 'Check the figures — this would compute a negative profit.')
      return
    }
    const ok = await call(
      '/api/referrals/invoices',
      {
        client_id: f.clientId,
        month: f.month,
        amount: f.amount,
        units_shipped: f.units || 0,
        cost_freight: f.cost_freight || 0,
        cost_materials: f.cost_materials || 0,
        cost_storage: f.cost_storage || 0,
        cost_processing: f.cost_processing || 0,
      },
      'POST',
      'add-invoice',
    )
    if (ok) {
      showSuccess('Month saved', `${clientName(f.clientId)} · ${f.month}`)
      setF({ ...emptyForm, clientId: f.clientId, month: f.month })
    }
  }

  async function remove(id: string) {
    await call('/api/referrals/invoices', { id }, 'DELETE', id)
  }

  return (
    <Section
      title="Monthly Account Figures"
      subtitle={`Net profit = invoiced less these four direct costs. Warehouse labor is NOT deducted. ${PCT} of the result is the partner's.`}
    >
      <div className="mb-4 rounded-lg border border-gray-700 bg-gray-900/40 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Referred client</label>
            <select
              value={f.clientId}
              onChange={(e) => set('clientId', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 w-52"
            >
              <option value="">— select —</option>
              {referred.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Month</label>
            <input
              type="month"
              value={f.month}
              onChange={(e) => set('month', e.target.value)}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200"
            />
          </div>
          <Num label="Units shipped" value={f.units} onChange={(v) => set('units', v)} step="1" width="w-28" />
          <Num label="Total invoiced ($)" value={f.amount} onChange={(v) => set('amount', v)} width="w-32" />
        </div>

        <div className="flex flex-wrap items-end gap-3 border-t border-gray-700/60 pt-3">
          <span className="text-xs text-gray-500 pb-2">Direct costs</span>
          <Num label="Freight &amp; carrier ($)" value={f.cost_freight} onChange={(v) => set('cost_freight', v)} />
          <Num label="Packaging &amp; materials ($)" value={f.cost_materials} onChange={(v) => set('cost_materials', v)} />
          <Num label="Storage ($)" value={f.cost_storage} onChange={(v) => set('cost_storage', v)} />
          <Num label="Payment processing ($)" value={f.cost_processing} onChange={(v) => set('cost_processing', v)} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-700/60 pt-3">
          <div className="text-sm">
            {costsExceed ? (
              <span className="text-red-400">Costs {fmt(previewCosts)} exceed the {fmt(n(f.amount))} invoiced.</span>
            ) : (
              <span className="text-gray-400">
                Net profit <span className="text-gray-200">{fmt(previewProfit)}</span> · partner gets{' '}
                <span className="text-sky-300">{fmt(previewShare)}</span>
              </span>
            )}
          </div>
          <button
            onClick={add}
            disabled={busy === 'add-invoice' || costsExceed}
            className="px-4 py-2 rounded-lg text-sm bg-[#00AAFF] text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy === 'add-invoice' ? 'Saving…' : 'Save month'}
          </button>
        </div>

        {referred.length === 0 && (
          <span className="block text-xs text-yellow-500/80">Link a client to a partner first (above) so it appears here.</span>
        )}
      </div>

      {invoices.length === 0 ? (
        <p className="text-gray-500 text-sm">Nothing logged yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-left border-b border-gray-700 text-xs uppercase">
                <th className="pb-2 pr-3">Client</th>
                <th className="pb-2 pr-3">Month</th>
                <th className="pb-2 pr-3 text-right">Units</th>
                <th className="pb-2 pr-3 text-right">Invoiced</th>
                <th className="pb-2 pr-3 text-right">Costs</th>
                <th className="pb-2 pr-3 text-right">Net profit</th>
                <th className="pb-2 pr-3 text-right">{PCT} owed</th>
                <th className="pb-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id} className="border-b border-gray-700/40">
                  <td className="py-2 pr-3 text-gray-200">{clientName(i.client_id)}</td>
                  <td className="py-2 pr-3 text-gray-400">{i.period.slice(0, 7)}</td>
                  <td className="py-2 pr-3 text-right text-gray-400">{(i.units_shipped ?? 0).toLocaleString('en-US')}</td>
                  <td className="py-2 pr-3 text-right text-gray-300">{fmt(i.amount)}</td>
                  <td className="py-2 pr-3 text-right text-gray-500">{fmt(totalCosts(i))}</td>
                  <td className="py-2 pr-3 text-right text-gray-200">{fmt(netProfit(i))}</td>
                  <td className="py-2 pr-3 text-right text-sky-300">{fmt(commissionOn(i))}</td>
                  <td className="py-2 text-right">
                    <button
                      onClick={() => remove(i.id)}
                      disabled={busy === i.id}
                      className="px-2 py-1 rounded text-xs bg-gray-700 text-gray-400 hover:bg-red-900/40 hover:text-red-300 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  )
}

function Num({
  label,
  value,
  onChange,
  step = '0.01',
  width = 'w-36',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  step?: string
  width?: string
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1" dangerouslySetInnerHTML={{ __html: label }} />
      <input
        type="number"
        min="0"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 ${width}`}
      />
    </div>
  )
}

// ============================================================
// Small shared UI
// ============================================================
function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-gray-800 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="font-semibold text-white">{title}</h3>
          {subtitle && <p className="text-xs text-gray-400 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  )
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  const colors: Record<string, string> = {
    yellow: 'border-yellow-800/50 bg-yellow-950/30',
    green: 'border-green-800/50 bg-green-950/40',
    blue: 'border-[#00AAFF]/20 bg-[#00AAFF]/5',
    gray: 'border-gray-700 bg-gray-800',
  }
  return (
    <div className={`rounded-xl p-5 border ${colors[color] ?? 'bg-gray-800 border-gray-700'}`}>
      <p className="text-gray-400 text-xs uppercase tracking-wider mb-2">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      <p className="text-gray-500 text-xs mt-1">{sub}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    paid: 'bg-green-900/50 text-green-400',
    approved: 'bg-[#00AAFF]/15 text-[#00AAFF]',
    pending: 'bg-yellow-900/40 text-yellow-400',
    computed: 'bg-gray-700 text-gray-300',
    awaiting: 'bg-gray-700/60 text-gray-500',
    active: 'bg-green-900/40 text-green-400',
    inactive: 'bg-gray-700 text-gray-500',
  }
  const label: Record<string, string> = { computed: 'not recorded', awaiting: 'awaiting 1st payment' }
  return <span className={`px-1.5 py-0.5 rounded text-xs ${map[status] ?? 'bg-gray-700 text-gray-300'}`}>{label[status] ?? status}</span>
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200"
      />
    </div>
  )
}
