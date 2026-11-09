import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  requireStaff: vi.fn(),
  partnerReads: 0,
  partner: {
    data: {
      id: 'p1',
      name: 'Dana',
      company: null as string | null,
      status: 'active',
      w9_received_at: '2026-11-01T00:00:00.000Z' as string | null,
      agreement_status: 'signed' as string | null,
      agreement_signed_at: '2026-10-23T23:38:42Z' as string | null,
      signup_bonus_amount: null as number | null,
    } as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  client: {
    data: {
      id: 'c1',
      name: 'Acme',
      referral_partner_id: 'p1',
      referral_signup_date: '2026-01-02',
      referral_first_payment_date: '2026-01-15',
    } as Record<string, unknown> | null,
    error: null as { message: string } | null,
  },
  upserts: [] as unknown[],
}))

vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

vi.mock('@/lib/supabase', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'referral_partners') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                h.partnerReads += 1
                return h.partner
              },
            }),
          }),
        }
      }
      if (table === 'clients') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => h.client,
            }),
          }),
        }
      }
      return {
        upsert: async (row: unknown) => {
          h.upserts.push(row)
          return { error: null }
        },
        delete: () => ({ eq: async () => ({ error: null }) }),
      }
    },
  },
}))

const { POST } = await import('./route')

function post(body: Record<string, unknown>) {
  return POST(new Request('http://localhost/api/referrals/payouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

const paid = {
  action: 'paid',
  dedupe_key: 'c1:commission:2026-11',
  referral_partner_id: 'p1',
  client_id: 'c1',
  kind: 'commission',
  period: '2026-11',
  amount: 12.5,
}

beforeEach(() => {
  h.requireStaff.mockReset().mockResolvedValue(null)
  h.partnerReads = 0
  h.partner = {
    data: {
      id: 'p1',
      name: 'Dana',
      company: null,
      status: 'active',
      w9_received_at: '2026-11-01T00:00:00.000Z',
      agreement_status: 'signed',
      agreement_signed_at: '2026-10-23T23:38:42Z',
      signup_bonus_amount: null,
    },
    error: null,
  }
  h.client = {
    data: {
      id: 'c1',
      name: 'Acme',
      referral_partner_id: 'p1',
      referral_signup_date: '2026-01-02',
      referral_first_payment_date: '2026-01-15',
    },
    error: null,
  }
  h.upserts.length = 0
})

describe('POST /api/referrals/payouts', () => {
  it('does not record a payout for a caller who is not staff', async () => {
    h.requireStaff.mockResolvedValue(NextResponse.json({ error: 'Not authorised.' }, { status: 401 }))
    const res = await post(paid)
    expect(res.status).toBe(401)
    expect(h.upserts).toEqual([])
    expect(h.partnerReads).toBe(0)
  })

  it('does not mark a payout paid when the W-9 is missing', async () => {
    h.partner = {
      data: {
        id: 'p1',
        name: 'Dana',
        company: null,
        status: 'active',
        w9_received_at: null,
        agreement_status: 'signed',
        agreement_signed_at: '2026-10-23T23:38:42Z',
        signup_bonus_amount: null,
      },
      error: null,
    }
    const res = await post(paid)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/W-9/) })
    expect(h.upserts).toEqual([])
  })

  it('does not mark a payout paid when the W-9 cannot be read', async () => {
    h.partner = { data: null, error: { message: 'timeout' } }
    const res = await post(paid)
    expect(res.status).toBe(503)
    expect(h.upserts).toEqual([])
  })

  it('marks paid only after the W-9 is on file, and does not store a missing amount as zero', async () => {
    const missing = await post({ ...paid, amount: undefined })
    expect(missing.status).toBe(400)
    expect(h.upserts).toEqual([])
    expect(h.partnerReads).toBe(0)

    const res = await post(paid)
    expect(res.status).toBe(200)
    expect(h.upserts).toEqual([expect.objectContaining({
      status: 'paid',
      amount: 12.5,
      referral_partner_id: 'p1',
    })])
  })

  it('does not record a signup bonus when the agreement was only sent', async () => {
    h.partner = {
      data: {
        id: 'p1',
        name: 'Dana',
        company: null,
        status: 'active',
        w9_received_at: '2026-11-01T00:00:00.000Z',
        agreement_status: 'sent',
        agreement_signed_at: null,
        signup_bonus_amount: null,
      },
      error: null,
    }
    const res = await post({
      action: 'approve',
      dedupe_key: 'c1:signup_bonus:2026-01',
      referral_partner_id: 'p1',
      client_id: 'c1',
      kind: 'signup_bonus',
      period: '2026-01',
      amount: 300,
    })
    expect(res.status).toBe(409)
    expect(h.upserts).toEqual([])
  })

  it('approves the standing $300 signup bonus once the agreement is signed', async () => {
    const res = await post({
      action: 'approve',
      dedupe_key: 'c1:signup_bonus:2026-01',
      referral_partner_id: 'p1',
      client_id: 'c1',
      kind: 'signup_bonus',
      period: '2026-01',
      amount: 500,
    })
    expect(res.status).toBe(200)
    expect(h.upserts).toEqual([expect.objectContaining({
      status: 'approved',
      kind: 'signup_bonus',
      amount: 300,
    })])
  })
})
