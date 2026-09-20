import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { requireStaff } from '@/lib/require-staff'
import { FOUNDING_PARTNER_TERMS } from '@/lib/referrals'

// Create or update a referral partner (manual entry / review of a
// website-form sign-up). No money moves here.
export async function POST(req: Request) {
  const denied = await requireStaff()
  if (denied) return denied

  const body = await req.json()
  const { id, name, company, email, phone, partner_type, refer_method, status, notes, founding_partner } = body

  if (!id && !name) {
    return NextResponse.json({ error: 'Partner name is required.' }, { status: 400 })
  }

  // ---- Founding Partner admission -------------------------------
  // The caller sends a BOOLEAN, never the numbers. The three frozen
  // figures are derived here from FOUNDING_PARTNER_TERMS, so a
  // mistyped form field cannot admit someone at $5,000 and the only
  // way to change the offer is to change the constant.
  let foundingFields: Record<string, unknown> = {}
  if (founding_partner !== undefined) {
    if (founding_partner) {
      // The cap is real money — 10 × ($500 − $300) = $2,000 — so it is
      // checked against the table rather than trusting the UI to have
      // hidden the control. Excluding this row's own id keeps re-saving
      // an existing Founding Partner idempotent instead of tripping the
      // cap on itself.
      let q = supabaseAdmin
        .from('referral_partners')
        .select('id', { count: 'exact', head: true })
        .eq('founding_partner', true)
      if (id) q = q.neq('id', id)
      const { count, error: countError } = await q

      if (countError) {
        return NextResponse.json(
          { error: `Could not verify the Founding Partner cap: ${countError.message}` },
          { status: 500 },
        )
      }
      if ((count ?? 0) >= FOUNDING_PARTNER_TERMS.CAP) {
        return NextResponse.json(
          {
            error:
              `The Founding Partner offer is capped at ${FOUNDING_PARTNER_TERMS.CAP} and all ` +
              `${FOUNDING_PARTNER_TERMS.CAP} are taken. This partner can still be admitted on the ` +
              `standing terms — untick Founding Partner and save again.`,
          },
          { status: 409 },
        )
      }

      foundingFields = {
        founding_partner: true,
        signup_bonus_amount: FOUNDING_PARTNER_TERMS.BONUS,
        bonus_min_units: FOUNDING_PARTNER_TERMS.MIN_UNITS,
        bonus_min_revenue: FOUNDING_PARTNER_TERMS.MIN_REVENUE,
      }
    } else {
      // Un-ticking clears the frozen terms back to the standing ones.
      // Only on an explicit false: `undefined` means the caller never
      // mentioned it, and must not wipe an admitted partner's terms as
      // a side effect of editing their phone number.
      foundingFields = {
        founding_partner: false,
        signup_bonus_amount: null,
        bonus_min_units: null,
        bonus_min_revenue: null,
      }
    }
  }

  const fields: Record<string, unknown> = {
    ...foundingFields,
    name,
    company: company ?? null,
    email: email ?? null,
    phone: phone ?? null,
    partner_type: partner_type ?? null,
    refer_method: refer_method ?? null,
    status: status ?? 'active',
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  }
  // strip undefined so a partial edit doesn't null out columns
  Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k])

  if (id) {
    const { error } = await supabaseAdmin.from('referral_partners').update(fields).eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, id })
  }

  const { data, error } = await supabaseAdmin.from('referral_partners').insert(fields).select('id').single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, id: data?.id })
}
