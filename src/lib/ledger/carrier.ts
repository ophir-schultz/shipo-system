/**
 * ShipStation carrier code -> the `source` we record on a shipment.
 *
 * This exists because src/lib/sync/shipstation.ts hardcoded `source: 'stamps'`
 * for every row while a `carrierCode: 'stamps_com'` filter made that
 * accidentally true. Removing the filter (see the ledger spec §5.5) makes it
 * false for 80% of shipments, so the value has to be derived.
 *
 * `ups_walleted` is ShipStation's own UPS account, not a direct UPS account.
 * It reconciles against the ShipStation invoice, so it gets its own source
 * rather than a generic 'ups'.
 */
export interface CarrierSource {
  /** Value stored in `shipments.source`. */
  source: string
  /** False means: report this, do not trust downstream reconciliation on it. */
  known: boolean
}

const KNOWN: Record<string, string> = {
  stamps_com: 'stamps',
  ups_walleted: 'shipstation_ups',
}

export function sourceForCarrier(carrierCode: string | null | undefined): CarrierSource {
  const code = (carrierCode ?? '').trim().toLowerCase()
  if (!code) return { source: 'unknown', known: false }

  const mapped = KNOWN[code]
  if (mapped) return { source: mapped, known: true }

  // Verbatim, never coerced. An unknown carrier is a reportable finding
  // (spec §7), not a row to quietly file under Stamps.com.
  return { source: code, known: false }
}
