import { priceOf } from '@/lib/billing/unpriced'
import { isVoidedShipment } from '@/lib/billing/voided-shipment'
import { decidePickRate, type PickCardRow } from '@/lib/billing/statement-source'

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

export interface AmbiguousPickCard {
  clientId: string
  clientName: string
  reason: string
}

/**
 * Clients whose card has two live pick rates. Kivema is the case: $1.20 and
 * $1.75. Orcam is the same kind of warning when two different pick services
 * are both live at different prices. The statement skips the line on purpose.
 * This list does not delete those rate rows.
 */
export function ambiguousPickCards(
  rows: readonly (PickCardRow & { client_id: string | null; client_name: string | null })[],
  onDate: string,
): AmbiguousPickCard[] {
  const byClient = new Map<string, { name: string; rows: PickCardRow[] }>()
  for (const row of rows) {
    if (!row.client_id) continue
    const current = byClient.get(row.client_id) ?? { name: row.client_name?.trim() || 'Unknown client', rows: [] }
    current.rows.push(row)
    byClient.set(row.client_id, current)
  }
  const issues: AmbiguousPickCard[] = []
  for (const [clientId, card] of byClient) {
    const decision = decidePickRate(card.rows, onDate)
    if (decision.billed || !decision.reason.includes('more than one live rate')) continue
    issues.push({ clientId, clientName: card.name, reason: decision.reason })
  }
  issues.sort((a, b) => a.clientName.localeCompare(b.clientName) || a.clientId.localeCompare(b.clientId))
  return issues
}
