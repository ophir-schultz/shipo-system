// Whether a physical serial may be stored again.
//
// Zenventory keeps scanned serials on one order line, which is one
// client and one SKU. The same text on another client, or on another
// SKU, is a different line. A second scan of the same client and SKU
// is a second pick of the same unit, so it is refused.
//
// A retry of the same scan — same client, SKU, order, scan type, and
// the same set of serials — is the original event, not a new one.
//
// This does not delete or rewrite a scan that is already stored.

export interface RecordedScan {
  scanEventId: string
  clientId: string
  sku: string | null
  orderRef: string | null
  scanType: string
  serials: string[]
}

export interface ClaimSubmission {
  clientId: string
  sku: string | null
  orderRef: string | null
  scanType: string
  serials: string[]
}

export type ClaimDecision =
  | { action: 'record' }
  | { action: 'idempotent'; scanEventId: string }
  | { action: 'reject'; serials: string[]; message: string }

export const CLAIM_RPC = 'record_scan_claimed'
export const CLAIM_VERSION = 'client-sku-v1'

/** True only for the catalog probe of record_scan_claimed. A bare true is not enough. */
export function claimProbeOk(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const row = data as Record<string, unknown>
  const checks = row.checks
  if (!checks || typeof checks !== 'object') return false
  const listed = checks as Record<string, unknown>
  return row.ready === true
    && row.rpc === CLAIM_RPC
    && row.version === CLAIM_VERSION
    && row.old_record_scan === 'unchanged'
    && row.old_has_claim_safety === false
    && listed.advisory_lock === true
    && listed.unique_claim === true
    && listed.idempotent_retry === true
    && listed.invoker === true
    && listed.old_signature === '10-arg'
    && listed.duplicate_serials_shape === 'client_ids'
}

export function serialKey(value: string): string {
  return value.trim().toLowerCase()
}

export function skuKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function orderKey(value: string | null | undefined): string {
  return (value ?? '').trim()
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const have = new Set(right)
  return left.every((key) => have.has(key))
}

export function repeatedSerialKeys(serials: readonly string[]): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const serial of serials) {
    const key = serialKey(serial)
    if (!key) continue
    if (seen.has(key)) dupes.add(key)
    seen.add(key)
  }
  return [...dupes]
}

function domain(scan: RecordedScan, clientId: string, sku: string): boolean {
  return scan.clientId === clientId && skuKey(scan.sku) === sku
}

export function duplicateSerialMessage(serials: readonly string[]): string {
  const list = [...serials]
  const noun = list.length === 1 ? 'Serial' : 'Serials'
  return `${noun} ${list.join(', ')} was already scanned for this client and SKU. Nothing else was recorded.`
}

export function decideSerialClaim(
  submission: ClaimSubmission,
  recorded: readonly RecordedScan[],
): ClaimDecision {
  const folded = repeatedSerialKeys(submission.serials)
  if (folded.length > 0) {
    return {
      action: 'reject',
      serials: folded,
      message: `The same serial was scanned twice: ${folded.join(', ')}. That is a double-read or a bad split — rescan the carton.`,
    }
  }
  const keys = submission.serials.map(serialKey).filter((key) => key !== '')
  const sku = skuKey(submission.sku)
  const order = orderKey(submission.orderRef)
  const mine = recorded.filter((scan) => domain(scan, submission.clientId, sku))
  const idempotent = mine.find((scan) => {
    return scan.scanType === submission.scanType
      && orderKey(scan.orderRef) === order
      && sameSet(scan.serials.map(serialKey), keys)
  })
  if (idempotent) return { action: 'idempotent', scanEventId: idempotent.scanEventId }
  const overlapping = keys.filter((key) => mine.some((scan) => scan.serials.some((serial) => serialKey(serial) === key)))
  if (overlapping.length > 0) {
    const shown = submission.serials.filter((serial) => overlapping.includes(serialKey(serial)))
    return { action: 'reject', serials: shown, message: duplicateSerialMessage(shown) }
  }
  return { action: 'record' }
}

/** What the second submission sees after the first has committed. */
export function settleInLockOrder(
  first: ClaimSubmission,
  second: ClaimSubmission,
  recorded: readonly RecordedScan[] = [],
): { first: ClaimDecision; second: ClaimDecision } {
  const earlier = decideSerialClaim(first, recorded)
  const after = earlier.action === 'record'
    ? [...recorded, {
      scanEventId: 'committed-first',
      clientId: first.clientId,
      sku: first.sku,
      orderRef: first.orderRef,
      scanType: first.scanType,
      serials: first.serials,
    }]
    : recorded
  return { first: earlier, second: decideSerialClaim(second, after) }
}

export interface StoredSerialRow {
  serial: string
  scan_event_id?: string
  scan_events: {
    id: string
    client_id: string
    sku: string | null
    order_ref: string | null
    scan_type: string
  } | Array<{
    id: string
    client_id: string
    sku: string | null
    order_ref: string | null
    scan_type: string
  }> | null
}

function eventOf(row: StoredSerialRow): {
  id: string
  client_id: string
  sku: string | null
  order_ref: string | null
  scan_type: string
} | null {
  const nested = row.scan_events
  if (!nested) return null
  return Array.isArray(nested) ? nested[0] ?? null : nested
}

/** Groups stored rows into scans. A row for another client is dropped. */
export function recordedScansFromRows(clientId: string, rows: readonly StoredSerialRow[]): RecordedScan[] {
  const byEvent = new Map<string, RecordedScan>()
  for (const row of rows) {
    const event = eventOf(row)
    if (!event || event.client_id !== clientId) continue
    const id = event.id || row.scan_event_id || ''
    if (!id) continue
    const scan = byEvent.get(id) ?? {
      scanEventId: id,
      clientId,
      sku: event.sku,
      orderRef: event.order_ref,
      scanType: event.scan_type,
      serials: [],
    }
    if (row.serial && !scan.serials.includes(row.serial)) scan.serials.push(row.serial)
    byEvent.set(id, scan)
  }
  return [...byEvent.values()]
}
