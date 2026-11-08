import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as XLSX from 'xlsx'
import { createFakeSupabase, type FakeDb } from '@/lib/ledger/fake-supabase'

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  requireStaff: vi.fn(),
}))

vi.mock('@/lib/supabase', () => ({
  get supabaseAdmin() { return h.db.client },
}))
vi.mock('@/lib/require-staff', () => ({ requireStaff: h.requireStaff }))

const { GET } = await import('@/app/api/reports/download/route')

function parcel(over: Record<string, unknown>) {
  return {
    carrier: 'ups',
    service: 'ground',
    tracking_number: '1Z',
    recipient_name: 'A',
    recipient_city: 'Dover',
    recipient_state: 'DE',
    weight: 1,
    actual_cost: 4,
    client_rate: 9,
    profit_loss: 5,
    is_loss: false,
    source: 'shipstation',
    client_id: 'c1',
    clients: { name: 'Nayax' },
    ...over,
  }
}

beforeEach(() => {
  h.requireStaff.mockResolvedValue(null)
  h.db = createFakeSupabase({
    shipments: [
      parcel({
        id: 'raw',
        order_number: 'SO601061446',
        ship_date: '2026-10-09T00:00:00.000Z',
        raw_data: { shipDate: '2026-10-09', secretCost: 'secret-cost-87873' },
        tracking_number: '1ZRAW',
      }),
      parcel({
        id: 'gate',
        order_number: 'SO-GATE',
        ship_date: '2026-10-01T00:00:00.000Z',
        raw_data: { shipDate: '2026-10-01' },
        tracking_number: '1ZGATE',
        is_loss: true,
        profit_loss: -2,
      }),
      parcel({
        id: 'instant',
        order_number: 'SO-INSTANT',
        ship_date: '2026-10-01T00:00:00.000Z',
        raw_data: { shipDate: '2026-10-01T00:00:00.000Z' },
        tracking_number: '1ZINSTANT',
        is_loss: true,
        profit_loss: -3,
      }),
      parcel({
        id: 'late',
        order_number: 'SO-LATE',
        ship_date: '2026-11-01T03:30:00.000Z',
        raw_data: {},
        tracking_number: '1ZLATE',
      }),
    ],
  })
})

function url(type: string, dateFrom: string, dateTo: string) {
  const qs = new URLSearchParams({ type, dateFrom, dateTo })
  return new Request(`http://localhost/api/reports/download?${qs}`)
}

async function rowsOf(res: Response) {
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: 'buffer' })
  const sheet = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[]
}

describe('GET /api/reports/download ship dates', () => {
  it('prints the carrier calendar day and keeps the stored instant in its period', async () => {
    const october = await rowsOf(await GET(url('shipments', '2026-10-01', '2026-10-31')))
    const byOrder = new Map(october.map((row) => [row['Order #'], row]))
    expect(byOrder.get('SO601061446')).toMatchObject({
      'Ship Date': '2026-10-09',
      'Stored ship day': '2026-10-08',
    })
    expect(byOrder.get('SO-LATE')).toMatchObject({ 'Ship Date': '2026-10-31' })
    expect(byOrder.get('SO-LATE')?.['Stored ship day'] ?? '').toBe('')
    expect(byOrder.has('SO-GATE')).toBe(false)
    expect(byOrder.has('SO-INSTANT')).toBe(false)
    expect(JSON.stringify(october)).not.toContain('secret-cost-87873')

    const september = await rowsOf(await GET(url('shipments', '2026-09-01', '2026-09-30')))
    const earlier = new Map(september.map((row) => [row['Order #'], row]))
    expect(earlier.get('SO-GATE')).toMatchObject({
      'Ship Date': '2026-10-01',
      'Stored ship day': '2026-09-30',
    })
    expect(earlier.get('SO-INSTANT')).toMatchObject({ 'Ship Date': '2026-09-30' })
    expect(earlier.get('SO-INSTANT')?.['Stored ship day'] ?? '').toBe('')
    expect(earlier.has('SO601061446')).toBe(false)
  })

  it('uses the same dates on the loss export without pulling September rows into October', async () => {
    const october = await rowsOf(await GET(url('loss-shipments', '2026-10-01', '2026-10-31')))
    expect(october.map((row) => row['Order #'])).not.toContain('SO-GATE')
    const september = await rowsOf(await GET(url('loss-shipments', '2026-09-01', '2026-09-30')))
    const byOrder = new Map(september.map((row) => [row['Order #'], row]))
    expect(byOrder.get('SO-GATE')).toMatchObject({
      'Ship Date': '2026-10-01',
      'Stored ship day': '2026-09-30',
    })
    expect(byOrder.get('SO-INSTANT')).toMatchObject({ 'Ship Date': '2026-09-30' })
  })
})
