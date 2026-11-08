import { easternCalendarDay, rawShipDate, shipCalendarDay } from '@/lib/ledger/eastern-day'

// How a shipment date is shown. The list and the export keep filtering on the
// stored ship instant. The printed ship date can be the carrier's calendar
// day. Those two are named apart when they disagree, and a row is not moved
// into another period to make them match. The statement charge date is a
// different stored column and is not read here.

export const SHIP_DATE_FILTER_NOTE =
  'Filtered by the stored ship instant in Eastern time. Ship date is the carrier calendar day. The statement charge date is not used and is not changed.'

export interface PresentedShipDay {
  /** Carrier calendar day. A date-only source keeps that day. */
  shipDate: string
  /** Eastern day of the stored ship instant. This is the day the filter uses. */
  storedShipDay: string
  differs: boolean
}

export function presentShipDay(
  stored: string | null | undefined,
  raw: unknown,
): PresentedShipDay {
  const storedShipDay = easternCalendarDay(stored)
  const shipDate = shipCalendarDay(stored, rawShipDate(raw)) || storedShipDay
  return {
    shipDate,
    storedShipDay,
    differs: shipDate !== '' && storedShipDay !== '' && shipDate !== storedShipDay,
  }
}

/** The two date cells on a shipments export. Blank stored day means the days agree. */
export function shipmentDateColumns(
  stored: string | null | undefined,
  raw: unknown,
): { 'Ship Date': string; 'Stored ship day': string } {
  const day = presentShipDay(stored, raw)
  return {
    'Ship Date': day.shipDate,
    'Stored ship day': day.differs ? day.storedShipDay : '',
  }
}

/**
 * The shipments screen's date filter. Same comparison it already made:
 * the Eastern day of the stored instant, not the carrier calendar day.
 */
export function shipmentMatchesStoredRange(
  stored: string | null | undefined,
  from: string,
  to: string,
): boolean {
  const day = easternCalendarDay(stored)
  if (from && day < from) return false
  if (to && day > to) return false
  return true
}
