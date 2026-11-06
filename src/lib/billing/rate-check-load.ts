import { supabaseAdmin } from '@/lib/supabase'
import { readAllPages } from '@/lib/db/page'
import { withoutVoided } from '@/lib/billing/voided-shipment'
import { easternAddDays, easternMidnightIso, easternToday, easternWeekStart } from '@/lib/ledger/eastern-day'
import { profitInstants } from '@/lib/pricing/profit-view'
import { checkShipment, summarizeRateCheck, type RateCheckShipment, type RateCheckSummary } from './rate-check'
import { DEFAULT_RATE_CHECK_FLAGS, loadRateSheet, type RateCheckFlags } from './rate-sheet'

// Read-only. Billing and statements do not use this.

export interface RateCheckReport {
  from: string
  to: string
  flags: RateCheckFlags
  summaries: RateCheckSummary[]
  shipments: RateCheckShipment[]
  note: string
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

export function rateCheckWeek(day: string): { from: string; to: string; error: string | null } {
  const date = day.trim() || easternToday()
  if (!ISO.test(date)) return { from: '', to: '', error: 'Week needs a date as YYYY-MM-DD.' }
  const from = easternWeekStart(date)
  return { from, to: easternAddDays(from, 6), error: null }
}

interface ShipmentRow {
  id: string
  client_id: string | null
  order_number: string | null
  ship_date: string | null
  weight: number | null
  weight_unit: string | null
  length: number | null
  width: number | null
  height: number | null
  dim_weight: number | null
  zone: number | null
  service: string | null
  carrier: string | null
  client_rate: number | null
  raw_data?: unknown
  clients: { name: string | null } | { name: string | null }[] | null
}

function clientName(value: ShipmentRow['clients']): string | null {
  if (!value) return null
  return Array.isArray(value) ? value[0]?.name ?? null : value.name
}

export async function loadRateCheck(input: {
  week: string
  clientId: string | null
  flags?: RateCheckFlags
}): Promise<{ report: RateCheckReport | null; error: string | null }> {
  const week = rateCheckWeek(input.week)
  if (week.error) return { report: null, error: week.error }
  const flags = input.flags ?? DEFAULT_RATE_CHECK_FLAGS
  const window = profitInstants(week.from, week.to)
  const loaded = await readAllPages<ShipmentRow>((start, end) => {
    let query = supabaseAdmin
      .from('shipments')
      .select('id, client_id, order_number, ship_date, weight, weight_unit, length, width, height, dim_weight, zone, service, carrier, client_rate, raw_data, clients(name)')
      .gte('ship_date', window.start)
      .lt('ship_date', window.end)
      .order('ship_date')
      .order('id')
      .range(start, end)
    if (input.clientId) query = query.eq('client_id', input.clientId)
    return query
  })
  if (loaded.error) return { report: null, error: loaded.error.message }
  const sheet = loadRateSheet()
  const shipments = withoutVoided(loaded.data ?? []).map((row) => checkShipment(sheet, {
    id: row.id,
    clientName: clientName(row.clients),
    orderNumber: row.order_number,
    shipDate: row.ship_date,
    weight: row.weight,
    weightUnit: row.weight_unit,
    length: row.length,
    width: row.width,
    height: row.height,
    dimWeight: row.dim_weight,
    carrier: row.carrier,
    zone: row.zone,
    raw: row.raw_data,
    service: row.service,
    clientRate: row.client_rate,
  }, flags))
  return {
    report: {
      from: week.from,
      to: week.to,
      flags,
      summaries: summarizeRateCheck(shipments),
      shipments,
      note: 'ICL (regular, 2nd day, next day) is a client price list in the sheet. It is not linked to a dashboard client yet, so no shipment is priced from it.',
    },
    error: null,
  }
}
