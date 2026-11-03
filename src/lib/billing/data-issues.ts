import { priceOf } from '@/lib/billing/unpriced'
import { isVoidedShipment } from '@/lib/billing/voided-shipment'

// Staff-only. A shipment with no client cannot be billed to anyone. A
// shipment with a client and no zone price cannot be put on a statement as
// a dollar amount. A voided label is neither: it is not billed at all.

export type DataIssueKind = 'no_client' | 'no_price'

export function shipmentIssue(row: {
  client_id: string | null
  client_rate: unknown
  raw_data?: unknown
}): DataIssueKind | null {
  if (isVoidedShipment(row.raw_data)) return null
  if (!row.client_id) return 'no_client'
  if (priceOf(row.client_rate) === null) return 'no_price'
  return null
}

export function issueLabel(kind: DataIssueKind): string {
  return kind === 'no_client' ? 'No client assigned' : 'No price'
}
