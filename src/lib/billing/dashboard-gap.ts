// One staff warning for the shipments a dashboard margin leaves out.
//
// The period card used to say the same rows three times. `reconcile` called
// them unrated (carrier cost known, client_rate null). `invoiceableRevenue`
// called those same null rates unpriced. The card printed both notes, plus
// the exclusion sentence that listed the unrated bucket again. On the live
// book those three counts are one cohort: every excluded row has a cost and
// no stored rate. A second sentence does not find a second shipment.
//
// The rows stay out of the reconciled triple. Nothing here prices them.
// A missing rate is not $0, and a store id on the label is not a client.
// Heavy freight and a zone cell for the wrong carrier are not labeled from
// the shipment alone: the card maximum and the carrier match are not columns
// on the row, and guessing either one would invent a rate-card fact.

import { priceOf } from '@/lib/billing/unpriced'
import { excludedCount, type Reconciled } from '@/lib/billing/profit-rollup'
import { storeIdOf } from '@/lib/sync/store-attribution'
import { zoneFromSources } from '@/lib/billing/zones'

export interface GapShipment {
  client_id?: string | null
  client_rate?: unknown
  actual_cost?: unknown
  zone?: unknown
  raw_data?: unknown
}

/** Why a costed shipment with no stored rate is still out of the margin. */
export type GapReason = 'unmapped' | 'international' | 'no_rate'

export interface UnmappedStore {
  /** ShipStation store id from the label, or null when the payload has none. */
  storeId: string | null
  count: number
}

export interface GapSummary {
  /** No client_id. Named by store id only. Not attributed to a client. */
  unmapped: UnmappedStore[]
  /** Destination country is recorded and is not US, and no zone is on the row. */
  international: number
  /**
   * A client is assigned, and the row does not say why the rate is missing.
   * Overweight freight and a wrong-carrier cell land here. The shipment does
   * not carry the card's max weight or a usable cell, so this does not guess.
   */
  noRate: number
}

const EMPTY_GAPS: GapSummary = { unmapped: [], international: 0, noRate: 0 }

/**
 * The destination country as the ShipStation payload spells it, or null.
 *
 * The same rule as the zone lookup: null means not recorded, which is not
 * "foreign". A missing country must not be called international.
 */
function recordedCountry(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const shipTo = record.shipTo
  const nested = shipTo && typeof shipTo === 'object'
    ? (shipTo as Record<string, unknown>).country
    : undefined
  const country = nested ?? record.country
  if (typeof country !== 'string') return null
  const trimmed = country.trim().toUpperCase()
  return trimmed === '' ? null : trimmed
}

function zoneOnRow(zone: unknown): number | null {
  if (typeof zone === 'number' && Number.isFinite(zone)) return zone
  if (typeof zone === 'string' && zone.trim() !== '') {
    const n = Number(zone)
    if (Number.isFinite(n)) return n
  }
  return null
}

function hasZone(row: GapShipment): boolean {
  return zoneFromSources({
    zone: zoneOnRow(row.zone),
    raw_data: row.raw_data,
  }).kind === 'resolved'
}

/** Cost is known and the stored client rate is not. The reconciled bucket. */
export function isCostedWithoutRate(row: GapShipment): boolean {
  return priceOf(row.client_rate) === null && priceOf(row.actual_cost) !== null
}

/**
 * One reason, so the warning's counts partition the costed-but-unrated rows.
 *
 * No client wins over country. An unmapped store is fixed by a mapping, and
 * calling it international as well would count the same label twice.
 * A recorded non-US country with no zone is the international gap. Anything
 * else, including a heavy parcel and a foreign parcel that already has a
 * zone, stays "no agreed zone rate".
 */
export function gapReason(row: GapShipment): GapReason | null {
  if (!isCostedWithoutRate(row)) return null
  if (!row.client_id) return 'unmapped'
  const country = recordedCountry(row.raw_data)
  if (country !== null && country !== 'US' && country !== 'USA' && !hasZone(row)) {
    return 'international'
  }
  return 'no_rate'
}

export function summarizeRateGaps(rows: readonly GapShipment[] | null | undefined): GapSummary {
  if (!rows || rows.length === 0) return { unmapped: [], international: 0, noRate: 0 }
  const stores = new Map<string | null, number>()
  let international = 0
  let noRate = 0
  for (const row of rows) {
    const reason = gapReason(row)
    if (reason === 'unmapped') {
      const storeId = storeIdOf(row.raw_data)
      stores.set(storeId, (stores.get(storeId) ?? 0) + 1)
    } else if (reason === 'international') {
      international++
    } else if (reason === 'no_rate') {
      noRate++
    }
  }
  const unmapped = [...stores.entries()]
    .map(([storeId, count]) => ({ storeId, count }))
    .sort((a, b) => b.count - a.count || (a.storeId ?? '').localeCompare(b.storeId ?? ''))
  return { unmapped, international, noRate }
}

function shipmentWord(count: number, counted: number): string {
  return count === 1 && counted === 1 ? 'shipment' : 'shipments'
}

function unmappedPhrase(groups: readonly UnmappedStore[]): string {
  const total = groups.reduce((sum, group) => sum + group.count, 0)
  const noun = total === 1 ? 'store' : 'stores'
  if (groups.length === 1) {
    const only = groups[0]
    const who = only.storeId ? `store ${only.storeId}` : 'store with no store id on the label'
    return `${total} from unmapped ${who}. No client is assigned`
  }
  const listed = groups.map((group) => {
    const name = group.storeId ?? 'no store id'
    return `${name} (${group.count})`
  }).join(', ')
  return `${total} from unmapped ${noun} ${listed}. No client is assigned`
}

function gapDetail(r: Reconciled, gaps: GapSummary): string {
  const unmappedCount = gaps.unmapped.reduce((sum, group) => sum + group.count, 0)
  const classified = unmappedCount + gaps.international + gaps.noRate
  const uncovered = Math.max(0, r.unrated - classified)
  const noRate = gaps.noRate + uncovered
  const finer = unmappedCount > 0 || gaps.international > 0 || r.uncosted > 0 || r.unmeasured > 0
  if (!finer) return ''
  const parts: string[] = []
  if (unmappedCount > 0) parts.push(unmappedPhrase(gaps.unmapped))
  if (gaps.international > 0) {
    const noun = gaps.international === 1 ? 'shipment' : 'shipments'
    parts.push(`${gaps.international} international ${noun} with no zone`)
  }
  if ((unmappedCount > 0 || gaps.international > 0) && noRate > 0) {
    parts.push(`${noRate} with no agreed zone rate`)
  }
  if (r.uncosted > 0) parts.push(`${r.uncosted} awaiting carrier cost`)
  if (r.unmeasured > 0) parts.push(`${r.unmeasured} with neither a rate nor a carrier cost`)
  return parts.length === 0 ? '' : `${parts.join('. ')}.`
}

/**
 * The only margin warning the dashboard renders for left-out shipments.
 *
 * Empty when nothing was left out. It never says the same rows are both
 * unrated and unpriced, and it never prints a price for a row that has none.
 */
export function staffMarginWarning(r: Reconciled, gaps: GapSummary = EMPTY_GAPS): string {
  const excluded = excludedCount(r)
  if (excluded <= 0) return ''
  const word = shipmentWord(excluded, r.counted)
  const lead = r.unrated > 0
    ? `${excluded} of ${r.counted} ${word} left out of these figures. `
      + 'The carrier cost on shipments with no agreed rate is left out of the margin. It is not $0.'
    : `${excluded} of ${r.counted} ${word} left out of these figures, not counted as $0.`
  const detail = gapDetail(r, gaps)
  return detail === '' ? lead : `${lead} ${detail}`
}
